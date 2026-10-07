import { z } from 'zod';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

/** Presentation/routing only; never proves filesystem allocation ownership. */
export const SessionDirectoryV1Schema = z.object({
  v: z.literal(1),
  kind: z.literal('managed'),
}).strict();
export type SessionDirectoryV1 = z.infer<typeof SessionDirectoryV1Schema>;
export const SessionDirectoryV1ReadSchema = createStoredReadSchema(SessionDirectoryV1Schema);

export function readSessionDirectoryKind(metadata: unknown): 'path' | 'managed' {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'path';
  return SessionDirectoryV1ReadSchema.safeParse(
    (metadata as Record<string, unknown>).sessionDirectoryV1,
  ).success ? 'managed' : 'path';
}
