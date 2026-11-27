import { z } from 'zod';

import { serverFetch } from '@/sync/http/client';

/**
 * `GET /v2/sessions/retention-summary` (plan 02 U5), read once when Plans & Supporter opens.
 *
 * Mirrors the route's response schema in `registerSessionLeavingRoutes.ts`; the route declares it
 * inline, so this is the client's only reader. Open objects: an older client drops new fields.
 */
const SessionRetentionSummarySchema = z.object({
    rule: z.object({
        retentionDays: z.number().int(),
        noticeDays: z.number().int(),
        floorAt: z.number().int(),
    }).nullable(),
    windowDays: z.number().int(),
    sessions: z.number().int(),
    ticks: z.array(z.object({
        atMs: z.number().int(),
        messages: z.number().int(),
        pinned: z.boolean(),
        leaving: z.boolean(),
    })),
    pinnedOlderThanCutoff: z.number().int(),
});

export type SessionRetentionSummary = z.infer<typeof SessionRetentionSummarySchema>;

export async function fetchSessionRetentionSummary(signal?: AbortSignal): Promise<SessionRetentionSummary> {
    const response = await serverFetch('/v2/sessions/retention-summary', { method: 'GET', signal, responseSizeBounded: true });
    if (!response.ok) throw new Error(`/v2/sessions/retention-summary answered ${response.status}`);
    return SessionRetentionSummarySchema.parse(await response.json());
}
