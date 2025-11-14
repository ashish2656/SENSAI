"use server";

import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { revalidatePath } from "next/cache";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: "gemini-2.5-flash",
  generationConfig: {
    temperature: 0.7,
    topP: 0.8,
    topK: 40,
    maxOutputTokens: 2048,
  },
  safetySettings: [
    {
      category: "HARM_CATEGORY_HARASSMENT",
      threshold: "BLOCK_NONE",
    },
    {
      category: "HARM_CATEGORY_HATE_SPEECH",
      threshold: "BLOCK_NONE",
    },
    {
      category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
      threshold: "BLOCK_NONE",
    },
    {
      category: "HARM_CATEGORY_DANGEROUS_CONTENT",
      threshold: "BLOCK_NONE",
    },
  ],
});

export async function saveResume(content) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  try {
    const resume = await db.resume.upsert({
      where: {
        userId: user.id,
      },
      update: {
        content,
      },
      create: {
        userId: user.id,
        content,
      },
    });

    revalidatePath("/resume");
    return resume;
  } catch (error) {
    console.error("Error saving resume:", error);
    throw new Error("Failed to save resume");
  }
}

export async function getResume() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  return await db.resume.findUnique({
    where: {
      userId: user.id,
    },
  });
}

export async function improveWithAI({ current, type }) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
    include: {
      industryInsight: true,
    },
  });

  if (!user) throw new Error("User not found");

  // Validate input
  if (!current || current.trim().length === 0) {
    throw new Error("Please provide content to improve");
  }

  const prompt = `
    As an expert resume writer, improve the writing quality of the following ${type} description for a ${user.industry} professional.
    
    IMPORTANT: Keep all the facts, experiences, and achievements from the original content. DO NOT add any information that wasn't present in the original. Only enhance the writing style and presentation.
    
    Current content: "${current}"

    Requirements:
    1. Preserve all factual information, dates, numbers, and specific details from the original
    2. Use strong action verbs to start sentences
    3. Rephrase for impact and clarity without changing the meaning
    4. Maintain the same experiences and accomplishments - only improve how they're expressed
    5. Make it more professional and concise
    6. Use industry-specific terminology relevant to ${user.industry}
    7. If metrics exist, keep them; if they don't exist, don't add fake ones
    
    Return ONLY the improved description without any additional text, explanations, or formatting markers.
  `;

  // Retry logic for intermittent failures
  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Attempt ${attempt} to improve content...`);
      
      const result = await model.generateContent(prompt);
      const response = result.response;
      
      // Check if response is blocked
      if (!response) {
        throw new Error("No response received from AI");
      }

      // Check for safety ratings that might have blocked the response
      const candidates = result.response.candidates;
      if (candidates && candidates[0]?.finishReason === "SAFETY") {
        throw new Error("Content was blocked by safety filters. Please try rephrasing.");
      }

      const improvedContent = response.text()?.trim();
      
      // Validate the response
      if (!improvedContent || improvedContent.length === 0) {
        throw new Error("AI returned empty response");
      }

      console.log("Content improved successfully");
      return improvedContent;
      
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt} failed:`, error.message);
      
      // If it's the last attempt, throw the error
      if (attempt === maxRetries) {
        break;
      }
      
      // Wait before retrying (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }

  // If all retries failed, throw a user-friendly error
  const errorMessage = lastError?.message || "Unknown error";
  console.error("All attempts failed. Last error:", errorMessage);
  
  if (errorMessage.includes("safety filters")) {
    throw new Error("Content was flagged by safety filters. Please rephrase your description.");
  } else if (errorMessage.includes("quota") || errorMessage.includes("rate limit")) {
    throw new Error("API rate limit reached. Please wait a moment and try again.");
  } else if (errorMessage.includes("network") || errorMessage.includes("fetch")) {
    throw new Error("Network error. Please check your connection and try again.");
  } else {
    throw new Error("Failed to improve content. Please try again.");
  }
}
