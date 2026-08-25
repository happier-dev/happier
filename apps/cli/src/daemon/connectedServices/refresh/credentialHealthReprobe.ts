import type { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';

import type { ConnectedServiceId } from '@happier-dev/protocol';
import { sanitizeConnectedServiceDiagnosticError } from '../runtimeAuth/sanitizeConnectedServiceDiagnosticString';

export type ConnectedServiceCredentialRefreshReason =
  | 'scheduled'
  | 'spawn_preflight'
  | 'runtime_auth_failure'
  | 'provider_auth_bridge'
  | 'quota_bridge';

export type CredentialHealthReprobeState = Readonly<{
  failureCount: number;
  nextProbeAt: number;
}>;

const CREDENTIAL_HEALTH_REPROBE_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
] as const;

export function shouldReadCredentialHealthForRefresh(reason: ConnectedServiceCredentialRefreshReason): boolean {
  return reason === 'scheduled'
    || reason === 'spawn_preflight'
    || reason === 'runtime_auth_failure'
    || reason === 'provider_auth_bridge'
    || reason === 'quota_bridge';
}

export function canReprobeCredentialHealth(
  reason: ConnectedServiceCredentialRefreshReason,
  options: Readonly<{ force?: boolean }>,
): boolean {
  if (options.force === true) return true;
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
  binding: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>;
  reason: ConnectedServiceCredentialRefreshReason;
}>): Promise<unknown> {
  const listProfiles = input.api.listConnectedServiceProfiles;
  if (typeof listProfiles !== 'function') return null;
  try {
    const result = await listProfiles.call(input.api, { serviceId: input.binding.serviceId });
    return result.profiles.find((profile) => profile.profileId === input.binding.profileId)?.status ?? null;
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to read connected-service profile health before refresh', {
      serviceId: input.binding.serviceId,
      reason: input.reason,
      error: sanitizeConnectedServiceDiagnosticError(error, {
        redactedValues: [input.binding.profileId],
      }),
    });
    return null;
  }
}
