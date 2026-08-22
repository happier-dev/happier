import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deriveBoxPublicKeyFromSeed,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';

import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import type { StoredCredentials } from '@/persistence';
import {
  ARTIFACT_ENCRYPTION_MATERIAL_UNAVAILABLE,
  ArtifactEncryptionMaterialUnavailableError,
} from '@/session/actions/approvals/artifactStore';

import {
  resolveCliPromptStackSystemAppendBlocks,
  type PromptArtifactRecord,
} from './resolveCliPromptStackSystemAppendBlocks';

const { mockAxiosGet } = vi.hoisted(() => ({
  mockAxiosGet: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    get: mockAxiosGet,
  },
}));

vi.mock('@/configuration', () => ({
  configuration: {
    apiServerUrl: 'http://127.0.0.1:24599',
  },
}));

function promptStackSettings(enabled = true) {
  return {
    promptStacksV1: {
      v: 1,
      surfaces: {
        coding: [{
          id: 'coding-prompt',
          ref: { kind: 'doc' as const, artifactId: 'prompt-artifact' },
          enabled,
          placement: 'system_append' as const,
          editPolicy: 'user_only' as const,
        }],
        voice: [],
        profilesById: {},
      },
    },
  };
}

function createEncryptedPromptArtifact(
  recipientPublicKey: Uint8Array,
): PromptArtifactRecord {
  const dataEncryptionKey = new Uint8Array(32).fill(7);
  return {
    id: 'prompt-artifact',
    body: encodeBase64(encryptWithDataKey({
      body: JSON.stringify({
        v: 1,
        markdown: 'Retained private instructions',
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    }, dataEncryptionKey)),
    dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: dataEncryptionKey,
      recipientPublicKey,
      randomBytes: (size) => new Uint8Array(size).fill(3),
    })),
  };
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

describe('resolveCliPromptStackSystemAppendBlocks', () => {
  beforeEach(() => {
    mockAxiosGet.mockReset();
  });

  it('fails typed instead of omitting a retained encrypted Prompt Artifact for token-only credentials', async () => {
    const artifactRecipientKey = new Uint8Array(32).fill(9);
    const artifact = createEncryptedPromptArtifact(
      deriveBoxPublicKeyFromSeed(artifactRecipientKey),
    );
    const credentials: StoredCredentials = {
      token: 'token-only',
      encryption: null,
    };
    const cache = new Map<string, string | null>();

    const error = await captureError(async () =>
      await resolveCliPromptStackSystemAppendBlocks({
        surface: 'coding',
        credentials,
        settings: promptStackSettings(),
        cache,
        fetchPromptArtifactRecord: async () => artifact,
      }));

    expect(error).toBeInstanceOf(ArtifactEncryptionMaterialUnavailableError);
    expect(error).toMatchObject({
      code: ARTIFACT_ENCRYPTION_MATERIAL_UNAVAILABLE,
    });
    expect(cache.has(artifact.id)).toBe(false);
  });

  it('fails with the same typed contract when the retained Prompt Artifact data-key envelope cannot open', async () => {
    const artifactRecipientKey = new Uint8Array(32).fill(9);
    const artifact = createEncryptedPromptArtifact(
      deriveBoxPublicKeyFromSeed(artifactRecipientKey),
    );
    const callerMachineKey = new Uint8Array(32).fill(5);
    const credentials: StoredCredentials = {
      token: 'wrong-recipient',
      encryption: {
        type: 'dataKey',
        machineKey: callerMachineKey,
        publicKey: deriveBoxPublicKeyFromSeed(callerMachineKey),
      },
    };
    const cache = new Map<string, string | null>();

    const error = await captureError(async () =>
      await resolveCliPromptStackSystemAppendBlocks({
        surface: 'coding',
        credentials,
        settings: promptStackSettings(),
        cache,
        fetchPromptArtifactRecord: async () => artifact,
      }));

    expect(error).toBeInstanceOf(ArtifactEncryptionMaterialUnavailableError);
    expect(error).toMatchObject({
      code: ARTIFACT_ENCRYPTION_MATERIAL_UNAVAILABLE,
    });
    expect(cache.has(artifact.id)).toBe(false);
  });

  it('fails typed without caching absence when a retained plain Prompt Artifact envelope is malformed', async () => {
    const credentials: StoredCredentials = {
      token: 'token-only',
      encryption: null,
    };
    const cache = new Map<string, string | null>();
    const malformedPlainEnvelope = encodeBase64(
      new TextEncoder().encode(JSON.stringify({ t: 'plain' })),
      'base64',
    );

    const error = await captureError(async () =>
      await resolveCliPromptStackSystemAppendBlocks({
        surface: 'coding',
        credentials,
        settings: promptStackSettings(),
        cache,
        fetchPromptArtifactRecord: async () => ({
          id: 'prompt-artifact',
          body: malformedPlainEnvelope,
          dataEncryptionKey: encodeBase64(
            new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null })),
            'base64',
          ),
        }),
      }));

    expect(error).toBeInstanceOf(ArtifactEncryptionMaterialUnavailableError);
    expect(error).toMatchObject({
      code: ARTIFACT_ENCRYPTION_MATERIAL_UNAVAILABLE,
    });
    expect(cache.has('prompt-artifact')).toBe(false);
  });

  it('fails typed without caching absence when the Artifact API cannot open retained Prompt content', async () => {
    const credentials: StoredCredentials = {
      token: 'token-only',
      encryption: null,
    };
    const cache = new Map<string, string | null>();
    mockAxiosGet.mockResolvedValueOnce({
      status: 500,
      data: { error: 'Failed to get artifact' },
    });

    const error = await captureError(async () =>
      await resolveCliPromptStackSystemAppendBlocks({
        surface: 'coding',
        credentials,
        settings: promptStackSettings(),
        cache,
      }));

    expect(error).toBeInstanceOf(ArtifactEncryptionMaterialUnavailableError);
    expect(error).toMatchObject({
      code: ARTIFACT_ENCRYPTION_MATERIAL_UNAVAILABLE,
    });
    expect(cache.has('prompt-artifact')).toBe(false);
  });

  it('preserves genuinely missing and disabled Prompt Artifact semantics', async () => {
    const credentials: StoredCredentials = {
      token: 'token-only',
      encryption: null,
    };
    const missingCache = new Map<string, string | null>();
    mockAxiosGet.mockResolvedValueOnce({
      status: 404,
      data: { error: 'Artifact not found' },
    });

    await expect(resolveCliPromptStackSystemAppendBlocks({
      surface: 'coding',
      credentials,
      settings: promptStackSettings(),
      cache: missingCache,
    })).resolves.toEqual([]);
    expect(missingCache.get('prompt-artifact')).toBeNull();

    const disabledFetch = vi.fn(async () => {
      throw new Error('disabled Prompt Artifact must not be fetched');
    });
    await expect(resolveCliPromptStackSystemAppendBlocks({
      surface: 'coding',
      credentials,
      settings: promptStackSettings(false),
      fetchPromptArtifactRecord: disabledFetch,
    })).resolves.toEqual([]);
    expect(disabledFetch).not.toHaveBeenCalled();
  });
});
