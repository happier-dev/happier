import type { Metadata } from '@/api/types';

const SESSION_RUNTIME_IDENTITY_KEYS = [
  'path',
  'host',
  'homeDir',
  'happyHomeDir',
  'machineId',
  'hostPid',
] as const satisfies ReadonlyArray<keyof Metadata>;

export function hasPublishedSessionRuntimeIdentityForAttach(
  snapshot: Metadata | null,
  runtimeMetadata: Metadata,
): boolean {
  if (!snapshot) return false;

  for (const key of SESSION_RUNTIME_IDENTITY_KEYS) {
    const expectedValue = runtimeMetadata[key];
    if (expectedValue === undefined || expectedValue === null) continue;
    if (snapshot[key] !== expectedValue) {
      return false;
    }
  }

  return snapshot.lifecycleState === 'running';
}
