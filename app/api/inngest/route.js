import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { generateIndustryInsights } from "@/lib/inngest/function";

// Create an API that serves zero functions
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    /* your functions will be passed here later! */
    generateIndustryInsights,
    
  ],
});

// Ensure this route runs in the Node.js runtime; Prisma is not supported in Edge.
export const runtime = "nodejs";
// Prevent static optimization; this route must be evaluated at runtime.
export const dynamic = "force-dynamic";
