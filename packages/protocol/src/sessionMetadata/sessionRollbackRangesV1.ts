import { z } from 'zod';

import { SessionRollbackTargetSchema } from '../sessionRollback.js';

export function createSessionRollbackRangeV1Schema(zod: typeof z) {
  return zod
    .object({
      target: SessionRollbackTargetSchema,
      startSeqInclusive: zod.number().int().nonnegative(),
      endSeqInclusive: zod.number().int().nonnegative(),
      rolledBackAt: zod.number().finite(),
    })
    .refine((value) => value.endSeqInclusive >= value.startSeqInclusive, {
      message: 'endSeqInclusive must be greater than or equal to startSeqInclusive',
      path: ['endSeqInclusive'],
    })
    .passthrough();
}

export const SessionRollbackRangeV1Schema = createSessionRollbackRangeV1Schema(z);
export type SessionRollbackRangeV1 = z.infer<typeof SessionRollbackRangeV1Schema>;

export function createSessionRollbackRangesV1Schema(zod: typeof z) {
  return zod.object({
    v: zod.literal(1),
    updatedAt: zod.number().finite(),
    ranges: zod.array(createSessionRollbackRangeV1Schema(zod)),
  }).passthrough();
}

export const SessionRollbackRangesV1Schema = createSessionRollbackRangesV1Schema(z);
export type SessionRollbackRangesV1 = z.infer<typeof SessionRollbackRangesV1Schema>;

export function buildSessionRollbackRangesV1(params: Readonly<{
  updatedAt: number;
  ranges: ReadonlyArray<SessionRollbackRangeV1>;
}>): SessionRollbackRangesV1 {
  return {
    v: 1,
    updatedAt: params.updatedAt,
    ranges: [...params.ranges],
  };
}

export function readSessionRollbackRangesV1FromMetadata(metadata: unknown): SessionRollbackRangesV1 | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).sessionRollbackRangesV1;
  const parsed = SessionRollbackRangesV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
