import type { ConnectedServiceRefreshReason } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import type { ApiClient } from '@/api/api';
import { readConnectedServiceProfileHealths } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import type { BoundProfile } from './refreshTypes';

export type CredentialHealthReprobeState = Readonly<{
  credentialRevision: string;
  failureCount: number;
  nextProbeAt: number;
}>;

const CREDENTIAL_HEALTH_REPROBE_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
] as const;

export function isReconnectRequiredProfileStatus(status: unknown): boolean {
  return status === 'needs_reauth';
}

export function shouldBlockRefreshForCredentialHealth(reason: ConnectedServiceRefreshReason): boolean {
  return reason === 'scheduled'
    || reason === 'spawn_preflight'
    || reason === 'runtime_auth_failure'
    || reason === 'provider_auth_bridge'
    || reason === 'quota_bridge';
}

export function canReprobeCredentialHealth(
  reason: ConnectedServiceRefreshReason,
  options: Readonly<{ force: boolean }>,
): boolean {
  if (options.force) return true;
  return reason === 'scheduled' || reason === 'quota_bridge';
}

export function credentialHealthReprobeDelayMs(failureCount: number): number {
  const index = Math.max(0, Math.min(
    CREDENTIAL_HEALTH_REPROBE_BACKOFF_MS.length - 1,
    Math.trunc(failureCount),
  ));
  return CREDENTIAL_HEALTH_REPROBE_BACKOFF_MS[index]!;
}

export async function readCredentialHealthStatusForRefresh(input: Readonly<{
  api: ApiClient;
  binding: BoundProfile;
}>): Promise<unknown> {
  const { serviceId, profileId } = input.binding;
  const health = (await readConnectedServiceProfileHealths({
    api: input.api, serviceId, profileIds: [profileId],
  })).get(profileId);
  return health && 'status' in health ? health.status : null;
}
