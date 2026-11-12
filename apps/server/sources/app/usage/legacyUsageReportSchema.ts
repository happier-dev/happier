import { z } from "zod/mini";
import type { Prisma } from "@prisma/client";

export const legacyUsageReportAgentId = 'legacy';

// Nullable Session uniqueness was not enforced on retained Account reports.
// Both reads and the existing write consolidation select the same survivor.
export const legacyUsageReportCanonicalOrder = [
    { updatedAt: "desc" },
    { createdAt: "desc" },
    { id: "desc" },
] satisfies Prisma.UsageReportOrderByWithRelationInput[];

export const LegacyUsageReportRouteBodySchema = z.object({
    key: z.string(),
    sessionId: z.string(),
    tokens: z.catchall(z.object({ total: z.number() }), z.number()),
    cost: z.catchall(z.object({ total: z.number() }), z.number()),
});

export const LegacyUsageReportDataSchema = z.pick(LegacyUsageReportRouteBodySchema, { tokens: true, cost: true });

/** Retained bridge metadata may be a Prisma object or its stored JSON string. */
export function readLegacyUsageReportKey(metadata: unknown): string | null {
    if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata); } catch { return null; }
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const key: unknown = Reflect.get(metadata, 'legacyKey');
    return typeof key === 'string' && key.trim() ? key : null;
}
