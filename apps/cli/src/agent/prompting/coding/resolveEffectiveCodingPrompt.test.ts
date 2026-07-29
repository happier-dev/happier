import { describe, expect, it } from 'vitest';

import { deriveBoxPublicKeyFromSeed, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';

import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import type { Credentials } from '@/persistence';

import {
  resolveEffectiveCodingPromptPlan,
  resolveEffectiveCodingPromptText,
  type PromptArtifactRecord,
} from './resolveEffectiveCodingPrompt';

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

type DataKeyCredentials = Credentials & {
  encryption: Extract<Credentials['encryption'], { type: 'dataKey' }>;
};

function createCredentials(): DataKeyCredentials {
  const machineKey = new Uint8Array(32).fill(9);
  return {
    token: 'token',
    encryption: {
      type: 'dataKey',
      machineKey,
      publicKey: deriveBoxPublicKeyFromSeed(machineKey),
    },
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
      agentId: 'codex',
      fetchPromptArtifactRecord: async () => null,
    });

    expect(out).toContain('BASE');
    expect(out).toContain('Tool execution ordering');
    expect(out.indexOf('BASE')).toBeLessThan(out.indexOf('Tool execution ordering'));
  });

  it('appends plugin tool prompt snippets and guidelines to the effective coding prompt', async () => {
    const credentials = createCredentials();

    const out = await resolveEffectiveCodingPromptText({
      credentials,
      settings: {},
      profileId: null,
      baseOverride: 'BASE',
      executionRunsFeatureEnabled: false,
      fetchPromptArtifactRecord: async () => null,
      toolPromptContributions: [
        {
          id: 'acme.audit',
          name: 'acme_audit',
          title: 'Acme Audit',
          promptSnippet: 'Use acme_audit when the user requests an Acme compliance scan.',
          promptGuidelines: [
            'Do not call acme_audit for ordinary file search.',
            'Summarize only stable findings returned by the tool.',
          ],
        },
      ],
    });

    expect(out).toContain('BASE');
    expect(out).toContain('Acme Audit');
    expect(out).toContain('Use acme_audit when the user requests an Acme compliance scan.');
    expect(out).toContain('Do not call acme_audit for ordinary file search.');
    expect(out).toContain('Summarize only stable findings returned by the tool.');
    expect(out.indexOf('BASE')).toBeLessThan(out.indexOf('Use acme_audit'));
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
      agentId: 'codex',
      toolDelivery: 'shell_bridge',
      toolDeliverySessionId: 's1',
      toolDeliveryDirectory: '/tmp/worktree',
      fetchPromptArtifactRecord: async () => null,
    });

    expect(out).not.toContain('You are an AI assistant');
    expect(out).toContain('Tool execution ordering');
    expect(out).toContain('Happier tools are available through the CLI bridge');
  });

  it('omits title-tool guidance when the provider has no supported Happier tool delivery', async () => {
    const credentials = createCredentials();

    const out = await resolveEffectiveCodingPromptText({
      credentials,
      settings: {},
      profileId: null,
      executionRunsFeatureEnabled: false,
      toolDelivery: 'unsupported',
      fetchPromptArtifactRecord: async () => null,
    });

    expect(out).toContain('# Attachments');
    expect(out).not.toContain('# Session title');
    expect(out).not.toContain('change_title');
    expect(out).not.toContain('rename the session');
  });

  it('omits shell-bridge title guidance when coding prompt title updates are disabled', async () => {
    const credentials = createCredentials();

    const out = await resolveEffectiveCodingPromptText({
      credentials,
      settings: {
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates: 'disabled',
          responseOptions: 'agent',
        },
      },
      profileId: null,
      executionRunsFeatureEnabled: false,
      toolDelivery: 'shell_bridge',
      toolDeliverySessionId: 's1',
      toolDeliveryDirectory: '/tmp/worktree',
      fetchPromptArtifactRecord: async () => null,
    });

    expect(out).toContain('Happier tools are available through the CLI bridge');
    expect(out).toContain('when you need to discover the available built-in Happier tools');
    expect(out).toContain('plugin-action-or-tool-id');
    expect(out).not.toContain('change_title');
    expect(out).not.toContain('rename the session');
    expect(out).not.toContain('# Session title');
  });

  it('uses start-only shell-bridge title guidance for initial title updates', async () => {
    const credentials = createCredentials();

    const out = await resolveEffectiveCodingPromptText({
      credentials,
      settings: {
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates: 'initial',
          responseOptions: 'disabled',
        },
      },
      profileId: null,
      executionRunsFeatureEnabled: false,
      toolDelivery: 'shell_bridge',
      toolDeliverySessionId: 's1',
      toolDeliveryDirectory: '/tmp/worktree',
      fetchPromptArtifactRecord: async () => null,
    });

    expect(out).toContain('rename the session before replying');
    expect(out).not.toContain('# Session title');
    expect(out).not.toContain('MUST call the change_title tool once');
    expect(out).not.toContain('Prefer "mcp__happier__change_title"');
    expect(out).not.toContain('again if the task changes significantly');
  });

  it('applies prompt personalization settings to the effective coding prompt', async () => {
    const credentials = createCredentials();

    const out = await resolveEffectiveCodingPromptText({
      credentials,
      settings: {
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates: 'disabled',
          responseOptions: 'disabled',
        },
      },
      profileId: null,
      executionRunsFeatureEnabled: false,
      fetchPromptArtifactRecord: async () => null,
    });

    expect(out).toContain('# Attachments');
    expect(out).not.toContain('# Session title');
    expect(out).not.toContain('change_title');
    expect(out).not.toContain('# Options');
    expect(out).not.toContain('# Plan mode with options');
    expect(out).not.toContain('<options>');
  });

  it('consumes generation-bound plugin prompt-asset blocks in the canonical prompt plan', async () => {
    const resolved = await resolveEffectiveCodingPromptPlan({
      credentials: createCredentials(),
      settings: {},
      profileId: null,
      memoryRecallGuidanceEnabled: false,
      fetchPromptArtifactRecord: async () => null,
      promptAssetBlocks: [{
        id: 'plugin_prompt_asset.acme.prompts/instructions',
        scope: 'session',
        text: 'Use the Acme project conventions.',
      }],
    });

    expect(resolved.text).toContain('Use the Acme project conventions.');
    expect(resolved.diagnostics.blockIds).toContain('plugin_prompt_asset.acme.prompts/instructions');
  });
});
