"use server";

import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: "gemini-2.5-flash",
});

// Retry helper function with exponential backoff
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      const isLastRetry = i === maxRetries - 1;
      const isOverloaded = error.message?.includes('overloaded') || error.message?.includes('503');
      
      if (isLastRetry || !isOverloaded) {
        throw error;
      }
      
      // Exponential backoff: wait longer between each retry
      const delay = baseDelay * Math.pow(2, i);
      console.log(`Retry ${i + 1}/${maxRetries} after ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Fallback data for when API is unavailable
function getFallbackInsights(industry) {
  return {
    salaryRanges: [
      { role: "Entry Level", min: 40000, max: 60000, median: 50000, location: "Global" },
      { role: "Mid Level", min: 60000, max: 90000, median: 75000, location: "Global" },
      { role: "Senior Level", min: 90000, max: 130000, median: 110000, location: "Global" },
      { role: "Lead/Manager", min: 110000, max: 160000, median: 135000, location: "Global" },
      { role: "Director/VP", min: 140000, max: 200000, median: 170000, location: "Global" },
    ],
    growthRate: 5.0,
    demandLevel: "MEDIUM",
    topSkills: ["Communication", "Problem Solving", "Technical Skills", "Teamwork", "Adaptability"],
    marketOutlook: "POSITIVE",
    keyTrends: ["Digital Transformation", "Remote Work", "AI Integration", "Sustainability", "Data-Driven Decision Making"],
    recommendedSkills: ["Leadership", "Project Management", "Data Analysis", "Cloud Computing", "Agile Methodologies"],
  };
}

export const generateAIInsights = async (industry) => {
  const prompt = `
          Analyze the current state of the ${industry} industry and provide insights in ONLY the following JSON format without any additional notes or explanations:
          {
            "salaryRanges": [
              { "role": "string", "min": number, "max": number, "median": number, "location": "string" }
            ],
            "growthRate": number,
            "demandLevel": "HIGH" | "MEDIUM" | "LOW",
            "topSkills": ["skill1", "skill2"],
            "marketOutlook": "POSITIVE" | "NEUTRAL" | "NEGATIVE",
            "keyTrends": ["trend1", "trend2"],
            "recommendedSkills": ["skill1", "skill2"]
          }
          
          IMPORTANT: Return ONLY the JSON. No additional text, notes, or markdown formatting.
          Include at least 5 common roles for salary ranges.
          Growth rate should be a percentage.
          Include at least 5 skills and trends.
        `;

  try {
    return await retryWithBackoff(async () => {
      const result = await model.generateContent(prompt);
      const response = result.response;
      const text = response.text();
      const cleanedText = text.replace(/```(?:json)?\n?/g, "").trim();
      return JSON.parse(cleanedText);
    });
  } catch (error) {
    console.error("Failed to generate AI insights after retries:", error.message);
    console.log("Using fallback insights for industry:", industry);
    return getFallbackInsights(industry);
  }
};

export async function getIndustryInsights() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
    include: {
      industryInsight: true,
    },
  });

  if (!user) throw new Error("User not found");

  // If no insights exist, generate them
  if (!user.industryInsight) {
    const insights = await generateAIInsights(user.industry);

    const industryInsight = await db.industryInsight.create({
      data: {
        industry: user.industry,
        ...insights,
        nextUpdate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return industryInsight;
  }

  return user.industryInsight;
}
