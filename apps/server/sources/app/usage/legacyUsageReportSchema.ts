import { z } from "zod";

export const LegacyUsageReportRouteBodySchema = z.object({
    key: z.string(),
    sessionId: z.string(),
    tokens: z.object({ total: z.number() }).catchall(z.number()),
    cost: z.object({ total: z.number() }).catchall(z.number()),
});
