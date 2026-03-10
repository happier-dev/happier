import axios from 'axios';

import {
  PromptStacksV1Schema,
  buildAppendSystemPromptBaseV1,
  openEncryptedDataKeyEnvelopeV1,
  resolvePromptStackSystemAppendBlocksV1,
} from '@happier-dev/protocol';

import { decodeBase64, decryptWithDataKey } from '@/api/encryption';
import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';
import { configuration } from '@/configuration';
import type { Credentials } from '@/persistence';
import { deriveKey } from '@/utils/deriveKey';
import { resolveCliMemoryRecallGuidanceEnabled } from './resolveCliMemoryRecallGuidanceEnabled';

export type PromptArtifactRecord = Readonly<{
  id: string;
  body?: string | null;
  dataEncryptionKey: string;
}>;

type FetchPromptArtifactRecord = (artifactId: string) => Promise<PromptArtifactRecord | null>;

function resolveServerHttpBaseUrl(): string {
  return resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
}

async function openPromptArtifactDataEncryptionKey(params: Readonly<{
  credentials: Credentials;
  encryptedDataEncryptionKeyBase64: string;
}>): Promise<Uint8Array | null> {
  const recipientSecretKeyOrSeed = params.credentials.encryption.type === 'dataKey'
    ? params.credentials.encryption.machineKey
    : await deriveKey(params.credentials.encryption.secret, 'Happy EnCoder', ['content']);

  return openEncryptedDataKeyEnvelopeV1({
    envelope: decodeBase64(params.encryptedDataEncryptionKeyBase64),
    recipientSecretKeyOrSeed,
  });
}

async function fetchPromptArtifactRecordFromApi(params: Readonly<{
  credentials: Credentials;
  artifactId: string;
}>): Promise<PromptArtifactRecord | null> {
  try {
    const response = await axios.get(`${resolveServerHttpBaseUrl()}/v1/artifacts/${encodeURIComponent(params.artifactId)}`, {
      headers: {
        Authorization: `Bearer ${params.credentials.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
      validateStatus: () => true,
    });

    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) return null;

    const record = response.data as Record<string, unknown>;
    return {
      id: typeof record.id === 'string' ? record.id : params.artifactId,
      body: typeof record.body === 'string' ? record.body : null,
      dataEncryptionKey: typeof record.dataEncryptionKey === 'string' ? record.dataEncryptionKey : '',
    };
  } catch {
    return null;
  }
}

export async function resolveCliSessionAppendSystemPrompt(args: Readonly<{
  credentials: Credentials;
  settings: Record<string, unknown> | null | undefined;
  profileId: string | null | undefined;
  base?: string;
  executionRunsFeatureEnabled?: boolean;
  memoryRecallGuidanceEnabled?: boolean;
  cache?: Map<string, string | null>;
  fetchPromptArtifactRecord?: FetchPromptArtifactRecord;
}>): Promise<string> {
  const settings = args.settings && typeof args.settings === 'object' && !Array.isArray(args.settings)
    ? args.settings
    : {};
  const promptStacksV1 = PromptStacksV1Schema.parse(settings.promptStacksV1);
  const cache = args.cache ?? new Map<string, string | null>();
  const fetchPromptArtifactRecord = args.fetchPromptArtifactRecord
    ? args.fetchPromptArtifactRecord
    : async (artifactId: string) => await fetchPromptArtifactRecordFromApi({
        credentials: args.credentials,
        artifactId,
      });
  const memoryRecallGuidanceEnabled =
    typeof args.memoryRecallGuidanceEnabled === 'boolean'
      ? args.memoryRecallGuidanceEnabled
      : await resolveCliMemoryRecallGuidanceEnabled();

  const base = buildAppendSystemPromptBaseV1({
    settings,
    base: args.base,
    executionRunsFeatureEnabled: args.executionRunsFeatureEnabled === true,
    memoryRecallGuidanceEnabled,
  });
  const stackBlocks = await resolvePromptStackSystemAppendBlocksV1({
    promptStacksV1,
    profileId: args.profileId,
    readArtifactBody: async (artifactId) => {
      if (cache.has(artifactId)) return cache.get(artifactId) ?? null;

      const artifact = await fetchPromptArtifactRecord(artifactId);
      if (!artifact?.body || !artifact.dataEncryptionKey) {
        cache.set(artifactId, null);
        return null;
      }

      const dataEncryptionKey = await openPromptArtifactDataEncryptionKey({
        credentials: args.credentials,
        encryptedDataEncryptionKeyBase64: artifact.dataEncryptionKey,
      });
      if (!dataEncryptionKey) {
        cache.set(artifactId, null);
        return null;
      }

      const decrypted = decryptWithDataKey(decodeBase64(artifact.body), dataEncryptionKey) as { body?: unknown } | null;
      const body = typeof decrypted?.body === 'string' ? decrypted.body : null;
      cache.set(artifactId, body);
      return body;
    },
  });

  return [base, ...stackBlocks]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}
