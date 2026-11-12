import { SessionRuntimeFailureCauseV1Schema, type SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

function readDataField(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

function readDataRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some(descriptor => !('value' in descriptor))) return undefined;
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
  } catch { return undefined; }
}

/** Read the existing runtime cause envelopes without evaluating foreign accessors. */
export function readSessionRuntimeFailureCause(error: unknown): SessionRuntimeIssueV1['failureCause'] {
  const cause = readDataRecord(readDataField(readDataField(error, 'details'), 'failureCause')
    ?? readDataField(error, 'failureCause'));
  const parsed = SessionRuntimeFailureCauseV1Schema.safeParse(cause && {
    ...cause,
    ...(Object.hasOwn(cause, 'preparationCause')
      ? { preparationCause: readDataRecord(cause.preparationCause) ?? null }
      : {}),
  });
  return parsed.success ? parsed.data : undefined;
}
