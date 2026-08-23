import { describe, expect, it } from 'vitest';
import {
  ProviderConnectionIdSchema,
  type SessionModelSelectionIntentV1,
} from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import type { AuthorizedSessionModelTransitionTarget } from '@/providers/sessions/sessionModelTransitionCoordinator';
import { applyActiveModelFacts } from './applyActiveModelFacts';

const baseMetadata = {
  path: '/tmp/workspace',
  host: 'test-host',
  homeDir: '/tmp/home',
  happyHomeDir: '/tmp/home/.happier',
  happyLibDir: '/tmp/home/.happier/lib',
  happyToolsDir: '/tmp/home/.happier/tools',
  permissionMode: 'default',
} satisfies Metadata;

const providerBindingUpstream = {
  protocol: 'openai-responses' as const,
  normalizedUrl: 'https://provider.example/v1',
  credential: 'apiKey' as const,
};

describe('applyActiveModelFacts', () => {
  it('publishes an exact initial active model without replacing a newer durable intent', () => {
    const activeTarget = {
      selection: {
        agentTargetKey: 'backend:qwen',
        providerConnectionId: null,
        modelId: 'active-model',
      },
      policy: 'live',
      providerBinding: null,
      sessionBindingMetadata: null,
      runtimeBindingBasis: null,
      revalidateBeforeEffect: async () => true,
    } satisfies AuthorizedSessionModelTransitionTarget;
    const pendingSelection = {
      agentTargetKey: 'backend:qwen',
      providerConnectionId: null,
      modelId: 'pending-model',
    } as const;
    const metadata: Metadata & {
      modelSelectionIntentV1: SessionModelSelectionIntentV1;
    } = {
      ...baseMetadata,
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 2,
        selection: pendingSelection,
      },
    };

    expect(applyActiveModelFacts(metadata, activeTarget, 'qwen')).toMatchObject({
      modelSelectionIntentV1: {
        selection: pendingSelection,
      },
      sessionModelsV1: {
        v: 1,
        agentId: 'qwen',
        currentModelId: 'active-model',
        availableModels: [
          {
            id: 'active-model',
            name: 'active-model',
          },
        ],
      },
    });
  });

  it('replaces a stale model publisher identity with the current host agent', () => {
    const activeTarget = {
      selection: {
        agentTargetKey: 'backend:qwen',
        providerConnectionId: null,
        modelId: 'active-model',
      },
      policy: 'live',
      providerBinding: null,
      sessionBindingMetadata: null,
      runtimeBindingBasis: null,
      revalidateBeforeEffect: async () => true,
    } satisfies AuthorizedSessionModelTransitionTarget;
    const metadata = {
      ...baseMetadata,
      sessionModelsV1: {
        v: 1,
        agentId: 'stale-agent',
        updatedAt: 1,
        currentModelId: 'stale-model',
        availableModels: [
          {
            id: 'stale-model',
            name: 'Stale model',
          },
        ],
      },
    } satisfies Metadata;

    expect(applyActiveModelFacts(metadata, activeTarget, 'qwen')).toMatchObject({
      sessionModelsV1: {
        agentId: 'qwen',
        currentModelId: 'active-model',
        availableModels: [
          {
            id: 'active-model',
            name: 'active-model',
          },
        ],
      },
    });
  });

  it('publishes the producer-declared option override rule alongside the descriptor', () => {
    const activeTarget = {
      selection: {
        agentTargetKey: 'backend:claude',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
        modelId: 'claude-opus-5',
      },
      policy: 'live',
      providerBinding: {
        connectionId: ProviderConnectionIdSchema.parse('pc_work'),
        upstream: providerBindingUpstream,
        model: {
          id: 'claude-opus-5',
          name: 'Opus 5',
          modelOptions: [
            {
              id: 'reasoning_effort',
              name: 'Thinking',
              type: 'select',
              currentValue: 'high',
              options: [{ value: 'xhigh', name: 'XHigh' }],
            },
            {
              id: 'ultracode',
              name: 'Ultracode',
              type: 'boolean',
              currentValue: 'false',
              overridesWhenOn: { optionIds: ['reasoning_effort'], forcedValue: 'xhigh' },
            },
          ],
        },
        materialization: { v: 1, kind: 'spawnEnv' },
      },
      sessionBindingMetadata: null,
      runtimeBindingBasis: null,
      revalidateBeforeEffect: async () => true,
    } satisfies AuthorizedSessionModelTransitionTarget;

    const published = applyActiveModelFacts(baseMetadata, activeTarget, 'claude');
    expect(
      published.sessionModelsV1?.availableModels[0]?.modelOptions?.[1]?.overridesWhenOn,
    ).toEqual({ optionIds: ['reasoning_effort'], forcedValue: 'xhigh' });
  });

  it('publishes the complete authorized Provider model descriptor as active facts', () => {
    const activeTarget = {
      selection: {
        agentTargetKey: 'backend:qwen',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
        modelId: 'provider-model',
      },
      policy: 'live',
      providerBinding: {
        connectionId: ProviderConnectionIdSchema.parse('pc_work'),
        upstream: providerBindingUpstream,
        model: {
          id: 'provider-model',
          name: 'Provider model',
          description: 'Provider-backed model',
          contextWindowTokens: 200_000,
          extendedContextModelId: 'provider-model[1m]',
          modelOptions: [{
            id: 'reasoning',
            name: 'Reasoning',
            type: 'select',
            currentValue: 'high',
            options: [{ value: 'high', name: 'High' }],
          }],
        },
        materialization: { v: 1, kind: 'spawnEnv' },
      },
      sessionBindingMetadata: null,
      runtimeBindingBasis: null,
      revalidateBeforeEffect: async () => true,
    } satisfies AuthorizedSessionModelTransitionTarget;

    expect(
      applyActiveModelFacts(baseMetadata, activeTarget, 'qwen'),
    ).toMatchObject({
      sessionModelsV1: {
        currentModelId: 'provider-model',
        availableModels: [{
          id: 'provider-model',
          name: 'Provider model',
          description: 'Provider-backed model',
          contextWindowTokens: 200_000,
          extendedContextModelId: 'provider-model[1m]',
          modelOptions: [{
            id: 'reasoning',
            currentValue: 'high',
          }],
        }],
      },
    });
  });

  it('removes stale optional facts omitted by the refreshed Provider descriptor', () => {
    const activeTarget = {
      selection: {
        agentTargetKey: 'backend:qwen',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
        modelId: 'provider-model',
      },
      policy: 'live',
      providerBinding: {
        connectionId: ProviderConnectionIdSchema.parse('pc_work'),
        upstream: providerBindingUpstream,
        model: {
          id: 'provider-model',
          name: 'Refreshed Provider model',
        },
        materialization: { v: 1, kind: 'spawnEnv' },
      },
      sessionBindingMetadata: null,
      runtimeBindingBasis: null,
      revalidateBeforeEffect: async () => true,
    } satisfies AuthorizedSessionModelTransitionTarget;
    const metadata = {
      ...baseMetadata,
      sessionModelsV1: {
        v: 1,
        agentId: 'qwen',
        updatedAt: 1,
        currentModelId: 'provider-model',
        availableModels: [{
          id: 'provider-model',
          name: 'Stale Provider model',
          description: 'Stale description',
          contextWindowTokens: 200_000,
          modelOptions: [{
            id: 'reasoning',
            name: 'Reasoning',
            type: 'select',
            currentValue: 'high',
          }],
        }, {
          id: 'other-model',
          name: 'Other model',
        }],
      },
    } satisfies Metadata;

    expect(
      applyActiveModelFacts(metadata, activeTarget, 'qwen')
        .sessionModelsV1?.availableModels,
    ).toEqual([{
      id: 'provider-model',
      name: 'Refreshed Provider model',
    }, {
      id: 'other-model',
      name: 'Other model',
    }]);
  });
});
