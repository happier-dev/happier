import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';

import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import {
  assertCurrentAccountStoredContentServerCompatibility,
} from '@/api/clientCompatibility/accountStoredContentActivation';

export type DesiredSessionCreateEncryptionModeResult = Readonly<{
  desiredSessionEncryptionMode: 'e2ee' | 'plain';
  accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
  serverSupportsFeatureSnapshot: boolean;
  storagePolicy: 'required_e2ee' | 'optional' | 'plaintext_only';
}>;

export async function resolveSessionCreateEncryptionMode(params: Readonly<{
  token: string;
  serverBaseUrl: string;
  featuresTimeoutMs?: number;
  accountTimeoutMs?: number;
  accountEncryptionCurrentness?: AccountEncryptionCurrentnessResponse;
}>): Promise<DesiredSessionCreateEncryptionModeResult> {
  const featuresTimeoutMs = typeof params.featuresTimeoutMs === 'number' && params.featuresTimeoutMs > 0 ? params.featuresTimeoutMs : 800;
  const accountTimeoutMs = typeof params.accountTimeoutMs === 'number' && params.accountTimeoutMs > 0 ? params.accountTimeoutMs : 10_000;

  const featuresSnapshot = await fetchServerFeaturesSnapshot({ serverUrl: params.serverBaseUrl, timeoutMs: featuresTimeoutMs });
  assertCurrentAccountStoredContentServerCompatibility(featuresSnapshot);
  const serverSupportsFeatureSnapshot = featuresSnapshot.status === 'ready';
  const storagePolicy: 'required_e2ee' | 'optional' | 'plaintext_only' =
    featuresSnapshot.status === 'ready'
      ? featuresSnapshot.features.capabilities.encryption.storagePolicy
      : 'required_e2ee';

  const accountEncryptionCurrentness = params.accountEncryptionCurrentness
    ?? await fetchAccountEncryptionCurrentness({
      token: params.token,
      serverBaseUrl: params.serverBaseUrl,
      timeoutMs: accountTimeoutMs,
    });
  const desiredSessionEncryptionMode = storagePolicy === 'plaintext_only'
    ? 'plain'
    : storagePolicy === 'optional'
      ? accountEncryptionCurrentness.mode
      : 'e2ee';
  return {
    desiredSessionEncryptionMode,
    accountEncryptionCurrentness,
    serverSupportsFeatureSnapshot,
    storagePolicy,
  };
}
