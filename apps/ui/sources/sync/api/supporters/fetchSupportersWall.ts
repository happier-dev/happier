import { z } from 'zod';

import { serverFetch } from '@/sync/http/client';

/**
 * The public supporters wall, `supporters.json` on stats.happier.dev (plan 05 publishes it daily;
 * plan 04's Credits page reads it). A public file on another origin: no credential is sent.
 * `entries` holds opted-in supporters only; `since` is a year by design.
 */
export const SUPPORTERS_WALL_URL = 'https://stats.happier.dev/supporters.json';

const SupportersWallSchema = z.object({
    schemaVersion: z.number().int(),
    generatedAt: z.union([z.string(), z.number()]),
    total: z.number().int().nonnegative(),
    entries: z.array(z.object({
        number: z.number().int(),
        name: z.string(),
        link: z.string().url().optional(),
        since: z.union([z.string(), z.number()]),
    })),
});

export type SupportersWall = z.infer<typeof SupportersWallSchema>;
export type SupportersWallEntry = SupportersWall['entries'][number];

export async function fetchSupportersWall(signal?: AbortSignal): Promise<SupportersWall> {
    const response = await serverFetch(SUPPORTERS_WALL_URL, { method: 'GET', signal }, { includeAuth: false });
    if (!response.ok) throw new Error(`supporters.json answered ${response.status}`);
    return SupportersWallSchema.parse(await response.json());
}
