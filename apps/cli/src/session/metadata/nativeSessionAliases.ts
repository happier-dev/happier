import { NativeSessionAliasAssignmentV1Schema, NativeSessionAliasesV1Schema, type NativeSessionAliasAssignmentV1 } from '@happier-dev/protocol';

/** Shared live-registration/sanitised-snapshot boundary; preserve names exactly as assigned. */
export function parseNativeSessionAliasRegistration(value: unknown, providerId: string, observedAt: number): NativeSessionAliasAssignmentV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || observedAt > Date.now()) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.name !== 'string' || !row.name.trim() || typeof row.sessionId !== 'string' || !row.sessionId.trim()) return null;
  if (row.startedAt !== undefined && (typeof row.startedAt !== 'number' || !Number.isSafeInteger(row.startedAt)
    || row.startedAt <= 0 || typeof row.nameSince !== 'number' || row.startedAt > row.nameSince)) return null;
  const parsed = NativeSessionAliasAssignmentV1Schema.safeParse({
    providerId, providerSessionId: row.sessionId, alias: row.name, assignedAt: row.nameSince, observedAt,
  });
  return parsed.success ? parsed.data : null;
}

export function mergeNativeSessionAliases<T extends { nativeSessionAliasesV1?: unknown }>(metadata: T, observations: readonly NativeSessionAliasAssignmentV1[]): T {
  if (!observations.length) return metadata;
  const existing = metadata.nativeSessionAliasesV1 === undefined
    ? { v: 1 as const, assignments: [] }
    : NativeSessionAliasesV1Schema.safeParse(metadata.nativeSessionAliasesV1).data;
  // Never replace unknown/malformed history with a newly observed partial record.
  if (!existing) return metadata;
  const assignments = [...existing.assignments];
  let changed = false;
  for (const observation of observations) {
    const index = assignments.findIndex(value => value.providerId === observation.providerId
      && value.providerSessionId === observation.providerSessionId && value.alias === observation.alias && value.assignedAt === observation.assignedAt);
    if (index < 0) {
      assignments.push(observation);
      changed = true;
    } else if (assignments[index].observedAt < observation.observedAt) {
      assignments[index] = { ...assignments[index], observedAt: observation.observedAt };
      changed = true;
    }
  }
  return changed ? { ...metadata, nativeSessionAliasesV1: { v: 1, assignments } } : metadata;
}
