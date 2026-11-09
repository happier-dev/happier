import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';

import { fetchServerFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import {
  AccountEncryptionCurrentnessUnavailableError,
  fetchAccountEncryptionCurrentness,
} from '@/api/client/connectedServiceCredentialApi';
import { assertSessionEncryptionModeAllowedByEffectiveClientRequirement } from '@/settings/accountSettings/resolveEffectiveClientEncryptionRequirement';

export type DesiredSessionCreateEncryptionModeResult = Readonly<{
  desiredSessionEncryptionMode: 'e2ee' | 'plain';
  accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
  serverSupportsFeatureSnapshot: boolean;
  serverFeaturesSnapshot: CliServerFeaturesSnapshot;
  storagePolicy: 'required_e2ee' | 'optional' | 'plaintext_only';
}>;

/**
 * The preflight either resolves the Session mode or reports that the Account
 * currentness read could not be served. Client encryption-requirement
 * refusals still throw: they are decisions, not
 * transport outcomes. Callers retain this phase and cause separately from
 * Session creation while preserving stable authentication refusals.
 */
export type SessionCreateEncryptionModeResolution =
  | (Readonly<{ status: 'resolved' }> & DesiredSessionCreateEncryptionModeResult)
  | Readonly<{
      status: 'currentness_unavailable';
      error: AccountEncryptionCurrentnessUnavailableError;
    }>;

export async function resolveSessionCreateEncryptionMode(params: Readonly<{
  token: string;
  serverBaseUrl: string;
  accountEncryptionCurrentness?: AccountEncryptionCurrentnessResponse;
  signal?: AbortSignal;
}>): Promise<SessionCreateEncryptionModeResolution> {
  params.signal?.throwIfAborted();
  // Both observations belong to this creation preflight, but neither consumes
  // the other. Join their lifetimes before deciding the mode or exposing failure.
  const [featuresResult, accountResult] = await Promise.allSettled([
    fetchServerFeaturesSnapshot({ serverUrl: params.serverBaseUrl,
      ...(params.signal ? { signal: params.signal } : {}) }),
    params.accountEncryptionCurrentness
      ? Promise.resolve(params.accountEncryptionCurrentness)
      : fetchAccountEncryptionCurrentness({ token: params.token, serverBaseUrl: params.serverBaseUrl,
        ...(params.signal ? { signal: params.signal } : {}) }),
  ]);
  params.signal?.throwIfAborted();
  if (featuresResult.status === 'rejected') throw featuresResult.reason;
  if (accountResult.status === 'rejected') {
    if (accountResult.reason instanceof AccountEncryptionCurrentnessUnavailableError) {
      return { status: 'currentness_unavailable', error: accountResult.reason };
    }
    throw accountResult.reason;
  }
  const featuresSnapshot = featuresResult.value;
  const serverSupportsFeatureSnapshot = featuresSnapshot.status === 'ready';
  const storagePolicy: 'required_e2ee' | 'optional' | 'plaintext_only' =
    featuresSnapshot.status === 'ready'
      ? featuresSnapshot.features.capabilities.encryption.storagePolicy
      : 'required_e2ee';

  const accountEncryptionCurrentness = accountResult.value;
  const desiredSessionEncryptionMode = storagePolicy === 'plaintext_only'
    ? 'plain'
    : storagePolicy === 'optional'
      ? accountEncryptionCurrentness.mode
      : 'e2ee';
  assertSessionEncryptionModeAllowedByEffectiveClientRequirement(desiredSessionEncryptionMode);
  return {
    status: 'resolved',
    desiredSessionEncryptionMode,
    accountEncryptionCurrentness,
    serverSupportsFeatureSnapshot,
    serverFeaturesSnapshot: featuresSnapshot,
    storagePolicy,
  };
}
