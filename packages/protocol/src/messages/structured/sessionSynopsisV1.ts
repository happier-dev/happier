import { z } from 'zod';

/**
 * Structured meta payload for a rolling "session so far" synopsis.
 *
 * Emitted under `meta.happier.kind='session_synopsis.v1'`.
 *
 * This is intentionally short and frequently updated so UIs and agents can quickly
 * understand session context without fetching large transcript windows.
 */
export const SessionSynopsisV1Schema = z.object({
  v: z.literal(1),
  seqTo: z.number().int().min(0),
  updatedAtMs: z.number().int().min(0),
  synopsis: z.string().min(1),
}).passthrough();

export type SessionSynopsisV1 = z.infer<typeof SessionSynopsisV1Schema>;

