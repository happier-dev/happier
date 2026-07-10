function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function hasConnectedServiceRuntimeAuthRecoveryContext(classification: unknown): boolean {
  const record = readRecord(classification);
  if (!record) return false;

  const recovery = readString(record.connectedServiceRecovery);
  if (recovery === 'unavailable') return false;

  const serviceId = readString(record.serviceId);
  if (!serviceId) return false;

  const profileId = readString(record.profileId);
  const groupId = readString(record.groupId);
  return recovery === 'available' || Boolean(profileId || groupId);
}
