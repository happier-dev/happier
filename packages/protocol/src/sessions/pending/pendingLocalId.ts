import { z } from 'zod';

export function isPendingLocalId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function readPendingLocalId(value: unknown): string | null {
  return isPendingLocalId(value) ? value : null;
}

export const PendingLocalIdSchema = z.string().refine(isPendingLocalId, {
  message: 'Pending localId must not be blank',
});

export type PendingLocalId = z.infer<typeof PendingLocalIdSchema>;
