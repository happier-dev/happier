export type RuntimeAuthRecoveryKeyParts = Readonly<{
  sessionId: string;
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  failingAccessTokenFingerprint?: string | null;
}>;

const RUNTIME_AUTH_RECOVERY_KEY_PREFIX = 'runtime-auth:v1:';

function canonicalizeRuntimeAuthRecoveryKeyParts(parts: RuntimeAuthRecoveryKeyParts): RuntimeAuthRecoveryKeyParts {
  return parts.groupId
    ? {
      ...parts,
      profileId: null,
    }
    : parts;
}

function encodeKeyPayload(parts: RuntimeAuthRecoveryKeyParts): string {
  const canonical = canonicalizeRuntimeAuthRecoveryKeyParts(parts);
  return Buffer.from(JSON.stringify([
    canonical.sessionId,
    canonical.serviceId,
    canonical.profileId,
    canonical.groupId,
    canonical.failingAccessTokenFingerprint ?? null,
  ]), 'utf8').toString('base64url');
}

export function buildRuntimeAuthRecoveryKey(parts: RuntimeAuthRecoveryKeyParts): string {
  return `${RUNTIME_AUTH_RECOVERY_KEY_PREFIX}${encodeKeyPayload(parts)}`;
}
