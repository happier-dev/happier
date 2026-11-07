import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

/** Host-observed Git registration, independent of the session's execution cwd. */
export function createSessionRepositoryV1Schema(zod: typeof z) {
  const nonBlankString = () => zod.string().refine((value) => value.trim().length > 0 && !value.includes('\0'));
  return zod.object({
    v: zod.literal(1),
    machineId: nonBlankString(),
    rootPath: nonBlankString(),
    worktreePath: nonBlankString(),
  }).passthrough();
}

export const SessionRepositoryV1Schema = lazySchema(() => createSessionRepositoryV1Schema(z));
export type SessionRepositoryV1 = z.infer<typeof SessionRepositoryV1Schema>;

export function readSessionRepositoryV1FromMetadata(metadata: unknown): SessionRepositoryV1 | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  const parsed = SessionRepositoryV1Schema.safeParse(record.sessionRepositoryV1);
  return parsed.success && parsed.data.machineId === record.machineId ? parsed.data : null;
}
