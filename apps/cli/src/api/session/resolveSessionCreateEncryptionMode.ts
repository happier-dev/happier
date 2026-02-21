import axios from 'axios';

import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol';

import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

export type DesiredSessionCreateEncryptionModeResult = Readonly<{
  desiredSessionEncryptionMode: 'e2ee' | 'plain';
  serverSupportsFeatureSnapshot: boolean;
  storagePolicy: 'required_e2ee' | 'optional' | 'plaintext_only';
}>;

export async function resolveSessionCreateEncryptionMode(params: Readonly<{
  token: string;
  serverBaseUrl: string;
  featuresTimeoutMs?: number;
  accountTimeoutMs?: number;
}>): Promise<DesiredSessionCreateEncryptionModeResult> {
  const featuresTimeoutMs = typeof params.featuresTimeoutMs === 'number' && params.featuresTimeoutMs > 0 ? params.featuresTimeoutMs : 800;
  const accountTimeoutMs = typeof params.accountTimeoutMs === 'number' && params.accountTimeoutMs > 0 ? params.accountTimeoutMs : 10_000;

  const featuresSnapshot = await fetchServerFeaturesSnapshot({ serverUrl: params.serverBaseUrl, timeoutMs: featuresTimeoutMs });
  const serverSupportsFeatureSnapshot = featuresSnapshot.status === 'ready';
  const storagePolicy: 'required_e2ee' | 'optional' | 'plaintext_only' =
    featuresSnapshot.status === 'ready'
      ? featuresSnapshot.features.capabilities.encryption.storagePolicy
      : 'required_e2ee';

  if (storagePolicy === 'plaintext_only') {
    return { desiredSessionEncryptionMode: 'plain', serverSupportsFeatureSnapshot, storagePolicy };
  }
  if (storagePolicy !== 'optional') {
    return { desiredSessionEncryptionMode: 'e2ee', serverSupportsFeatureSnapshot, storagePolicy };
  }

  // storagePolicy === 'optional': follow the account's stored preference (fail-closed to e2ee).
  try {
    const response = await axios.get(`${params.serverBaseUrl.replace(/\/+$/, '')}/v1/account/encryption`, {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      timeout: accountTimeoutMs,
      validateStatus: () => true,
    });
    if (response.status !== 200) {
      return { desiredSessionEncryptionMode: 'e2ee', serverSupportsFeatureSnapshot, storagePolicy };
    }
    const parsed = AccountEncryptionModeResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      return { desiredSessionEncryptionMode: 'e2ee', serverSupportsFeatureSnapshot, storagePolicy };
    }
    return {
      desiredSessionEncryptionMode: parsed.data.mode,
      serverSupportsFeatureSnapshot,
      storagePolicy,
    };
  } catch {
    return { desiredSessionEncryptionMode: 'e2ee', serverSupportsFeatureSnapshot, storagePolicy };
  }
}
