import { z } from 'zod';

import { SessionSyncProtocolVersionSchema } from './primitives.js';

export const SessionSyncCompatibilityDecisionSchema = z.enum([
  'missing',
  'malformed',
  'older',
  'exact',
  'future',
]);

export type SessionSyncCompatibilityDecision = z.infer<typeof SessionSyncCompatibilityDecisionSchema>;

export function classifySessionSyncProtocolCompatibility(
  declaredVersion: unknown,
  minimumVersion: number,
): SessionSyncCompatibilityDecision {
  if (declaredVersion === undefined || declaredVersion === null) return 'missing';
  const declared = SessionSyncProtocolVersionSchema.safeParse(declaredVersion);
  const minimum = SessionSyncProtocolVersionSchema.safeParse(minimumVersion);
  if (!declared.success || !minimum.success) return 'malformed';
  if (declared.data < minimum.data) return 'older';
  if (declared.data === minimum.data) return 'exact';
  return 'future';
}
