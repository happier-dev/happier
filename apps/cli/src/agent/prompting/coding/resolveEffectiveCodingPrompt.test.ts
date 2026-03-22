import { describe, expect, it } from 'vitest';

import { deriveBoxPublicKeyFromSeed, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';

import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import type { Credentials } from '@/persistence';

import { resolveEffectiveCodingPromptText, type PromptArtifactRecord } from './resolveEffectiveCodingPrompt';

function createPromptDocArtifactRecord(params: Readonly<{
  artifactId: string;
  markdown: string;
  recipientPublicKey: Uint8Array;
}>): PromptArtifactRecord {
  const dataKey = new Uint8Array(32).fill(7);
  const encryptedDataKey = sealEncryptedDataKeyEnvelopeV1({
    dataKey,
    recipientPublicKey: params.recipientPublicKey,
    randomBytes: (size) => new Uint8Array(size).fill(3),
  });

  return {
    id: params.artifactId,
    body: encodeBase64(encryptWithDataKey({
      body: JSON.stringify({
        v: 1,
        markdown: params.markdown,
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    }, dataKey)),
    dataEncryptionKey: encodeBase64(encryptedDataKey),
  };
}

describe('resolveEffectiveCodingPromptText', () => {
  it('decrypts referenced prompt docs and caches artifact bodies across calls', async () => {
    const machineKey = new Uint8Array(32).fill(9);
    const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
    const credentials: Credentials = {
      token: 'token',
      encryption: {
        type: 'dataKey',
        machineKey,
        publicKey,
      },
    };

    const artifactById: Record<string, PromptArtifactRecord> = {
      d1: createPromptDocArtifactRecord({
        artifactId: 'd1',
        markdown: 'Hello from coding',
        recipientPublicKey: publicKey,
      }),
      d2: createPromptDocArtifactRecord({
        artifactId: 'd2',
        markdown: 'Hello from profile',
        recipientPublicKey: publicKey,
      }),
    };

    let fetchCount = 0;
    const cache = new Map<string, string | null>();
    const settings = {
      promptStacksV1: {
        v: 1,
        surfaces: {
          coding: [
            {
              id: 'e1',
              ref: { kind: 'doc', artifactId: 'd1' },
              enabled: true,
              placement: 'system_append',
              editPolicy: 'user_only',
            },
          ],
          voice: [],
          profilesById: {
            p1: [
              {
                id: 'e2',
                ref: { kind: 'doc', artifactId: 'd2' },
                enabled: true,
                placement: 'system_append',
                editPolicy: 'user_only',
              },
            ],
          },
        },
      },
      executionRunsGuidanceEnabled: false,
    };

    const first = await resolveEffectiveCodingPromptText({
      credentials,
      settings,
      profileId: 'p1',
      baseOverride: 'BASE',
      cache,
      fetchPromptArtifactRecord: async (artifactId: string) => {
        fetchCount += 1;
        return artifactById[artifactId] ?? null;
      },
      executionRunsFeatureEnabled: false,
    });

    const second = await resolveEffectiveCodingPromptText({
      credentials,
      settings,
      profileId: 'p1',
      baseOverride: 'BASE',
      cache,
      fetchPromptArtifactRecord: async (artifactId: string) => {
        fetchCount += 1;
        return artifactById[artifactId] ?? null;
      },
      executionRunsFeatureEnabled: false,
    });

    expect(first).toBe('BASE\n\nHello from coding\n\nHello from profile');
    expect(second).toBe(first);
    expect(fetchCount).toBe(2);
  });

  it('appends memory recall guidance when explicitly enabled', async () => {
    const machineKey = new Uint8Array(32).fill(9);
    const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
    const credentials: Credentials = {
      token: 'token',
      encryption: {
        type: 'dataKey',
        machineKey,
        publicKey,
      },
    };

    const out = await resolveEffectiveCodingPromptText({
      credentials,
      settings: {},
      profileId: null,
      baseOverride: 'BASE',
      executionRunsFeatureEnabled: false,
      memoryRecallGuidanceEnabled: true,
      fetchPromptArtifactRecord: async () => null,
    });

    expect(out).toContain('BASE');
    expect(out).toContain('If the user asks you to remember or find something from past conversations');
    expect(out).toContain('use `memory_search` first');
    expect(out).toContain('use `memory_get_window`');
  });

  it('appends provider behavior blocks after the shared base and prompt library blocks', async () => {
    const machineKey = new Uint8Array(32).fill(9);
    const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
    const credentials: Credentials = {
      token: 'token',
      encryption: {
        type: 'dataKey',
        machineKey,
        publicKey,
      },
    };

    const out = await resolveEffectiveCodingPromptText({
      credentials,
      settings: {},
      profileId: null,
      baseOverride: 'BASE',
      executionRunsFeatureEnabled: false,
      providerId: 'codex',
      fetchPromptArtifactRecord: async () => null,
    });

    expect(out).toContain('BASE');
    expect(out).toContain('Tool execution ordering');
    expect(out.indexOf('BASE')).toBeLessThan(out.indexOf('Tool execution ordering'));
  });

  it('treats a null base override as dropping the shared base while preserving provider and shell-bridge blocks', async () => {
    const machineKey = new Uint8Array(32).fill(9);
    const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
    const credentials: Credentials = {
      token: 'token',
      encryption: {
        type: 'dataKey',
        machineKey,
        publicKey,
      },
    };

    const out = await resolveEffectiveCodingPromptText({
      credentials,
      settings: {},
      profileId: null,
      baseOverride: null,
      executionRunsFeatureEnabled: false,
      providerId: 'codex',
      toolDelivery: 'shell_bridge',
      toolDeliverySessionId: 's1',
      toolDeliveryDirectory: '/tmp/worktree',
      fetchPromptArtifactRecord: async () => null,
    });

    expect(out).not.toContain('You are an AI assistant');
    expect(out).toContain('Tool execution ordering');
    expect(out).toContain('Happier tools are available through the CLI bridge');
  });
});
