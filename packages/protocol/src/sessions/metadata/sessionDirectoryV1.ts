import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

/** Presentation/routing only; never proves filesystem allocation ownership. */
export const SessionDirectoryV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  kind: z.literal('managed'),
}));
export type SessionDirectoryV1 = z.infer<typeof SessionDirectoryV1Schema>;
export const SessionDirectoryV1ReadSchema = createStoredReadSchema(SessionDirectoryV1Schema);

export function readSessionDirectoryKind(metadata: unknown): 'path' | 'managed' {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'path';
  const marker = (metadata as Record<string, unknown>).sessionDirectoryV1;
  // Most Sessions have no managed-directory marker. Absence is already a
  // complete classification and must not allocate a Zod failure per selector.
  if (marker === null || marker === undefined) return 'path';
  return SessionDirectoryV1ReadSchema.safeParse(marker).success ? 'managed' : 'path';
}
