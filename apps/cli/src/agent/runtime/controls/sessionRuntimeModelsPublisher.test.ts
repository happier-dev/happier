import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { applyActiveModelFacts } from '@/providers/sessions/applyActiveModelFacts';
import type { AuthorizedSessionModelTransitionTarget } from '@/providers/sessions/sessionModelTransitionCoordinator';
import {
  createSessionRuntimeModelsPublisher,
} from './sessionRuntimeModelsPublisher';
import type { AgentSessionHostServices } from '@happier-dev/plugin-sdk/agents/runtime';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

type AgentSessionModelsSnapshot = ReturnType<
  Parameters<AgentSessionHostServices['models']['bind']>[0]['read']
>;

function createSource() {
  let snapshot: AgentSessionModelsSnapshot = { models: null };
  const listeners = new Set<(value: AgentSessionModelsSnapshot) => void>();
  return {
    read: () => snapshot,
    subscribe(listener: (value: AgentSessionModelsSnapshot) => void) {
      listeners.add(listener);
      listener(snapshot);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    publish(value: AgentSessionModelsSnapshot) {
      snapshot = value;
      for (const listener of listeners) listener(value);
    },
  };
}

function createSession(initial: Metadata) {
  let metadata = initial;
  const listeners = new Set<() => void>();
  let updateCount = 0;
  const updateMetadata = async (
    updater: (current: Metadata) => Metadata,
  ) => {
    updateCount += 1;
    metadata = updater(metadata);
    for (const listener of listeners) listener();
  };
  return {
    getMetadataSnapshot: () => metadata,
    updateMetadata,
    updateMetadataAsCurrentPublisher: updateMetadata,
    on(event: string, listener: () => void) {
      if (event === 'metadata-updated') listeners.add(listener);
      return this;
    },
    off(event: string, listener: () => void) {
      if (event === 'metadata-updated') listeners.delete(listener);
      return this;
    },
    listenerCount: () => listeners.size,
    updateCount: () => updateCount,
  };
}

function sessionRunnerRuntime(
  runtimeId: string,
  daemonId = 'daemon-1',
  runner = { pid: 123, processStartTimeMs: 1_000 },
) {
  return {
    v: 1 as const,
    sessionId: 'session-1',
    machineId: 'machine-1',
    daemonId,
    observedAtMs: 1,
    runner: {
      ...runner,
      runtimeId,
      cliVersion: '1.0.0',
      entrypointVersion: '1.0.0',
      processCommandHash: 'command-hash',
      entrypointSource: 'launch_spec' as const,
      startedBy: 'daemon' as const,
      startingMode: 'remote' as const,
    },
    daemon: {
      cliVersion: '1.0.0',
      startedWithCliVersion: '1.0.0',
      currentEntrypointVersion: runtimeId,
      currentEntrypointSource: 'launch_spec' as const,
    },
    versionState: 'current' as const,
    statusSource: 'daemon_tracking' as const,
    plannedRestart: {
      supported: true,
      eligible: true,
      disabledReason: null,
    },
  };
}

describe('createSessionRuntimeModelsPublisher', () => {
  it('preserves a same-process startup active fact over the first lagging runtime publication', async () => {
    const source = createSource();
    source.publish({
      currentModelId: 'old-model',
      models: [
        { id: 'old-model', name: 'Old model' },
        { id: 'next-model', name: 'Next model' },
      ],
    });
    const activeSelectionV1 = {
      v: 1 as const,
      selection: {
        agentTargetKey: 'backend:qwen' as const,
        providerConnectionId: null,
        modelId: 'next-model',
      },
      source: 'runtime_apply' as const,
      runner: {
        pid: 123,
        processStartTimeMs: 1_000,
      },
    };
    const session = createSession(createTestMetadata({
      sessionModelsV1: {
        v: 1,
        agentId: 'qwen',
        updatedAt: 1,
        currentModelId: 'next-model',
        availableModels: [
          { id: 'old-model', name: 'Old model' },
          { id: 'next-model', name: 'Next model' },
        ],
      },
    }));

    const publisher = createSessionRuntimeModelsPublisher({
      agentId: 'qwen',
      agentTargetKey: 'backend:qwen',
      runnerProcessIdentity: activeSelectionV1.runner,
      initialActiveSelection: activeSelectionV1,
      session,
      source,
    });
    await publisher.flush();

    expect(session.getMetadataSnapshot().sessionModelsV1).toMatchObject({
      currentModelId: 'next-model',
    });
    publisher.dispose();
  });

  it('preserves a producer-declared option override rule carried by the persisted catalog', async () => {
    const source = createSource();
    const session = createSession(createTestMetadata({
      sessionModelsV1: {
        v: 1,
        agentId: 'claude',
        updatedAt: 1,
        currentModelId: 'claude-opus-5',
        availableModels: [{
          id: 'claude-opus-5',
          name: 'Opus 5',
          extendedContextModelId: 'claude-opus-5[1m]',
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
        }],
      },
    }));
    // The runtime republishes the same model without the rule (an ACP snapshot cannot carry
    // producer-declared facts); the merge must not use that as licence to drop it.
    source.publish({
      currentModelId: 'claude-opus-5',
      models: [{
        id: 'claude-opus-5',
        name: 'Opus 5',
        modelOptions: [{
          id: 'reasoning_effort',
          name: 'Thinking',
          type: 'select',
          currentValue: 'high',
          options: [{ value: 'xhigh', name: 'XHigh' }],
        }],
      }],
    });
    const publisher = createSessionRuntimeModelsPublisher({
      agentId: 'claude',
      agentTargetKey: 'backend:claude',
      runnerProcessIdentity: { pid: 123, processStartTimeMs: 1_000 },
      session,
      source,
    });
    await publisher.flush();

    const published = session.getMetadataSnapshot().sessionModelsV1;
    expect(published?.availableModels[0]?.extendedContextModelId).toBe('claude-opus-5[1m]');
    expect(published?.availableModels[0]?.modelOptions?.find(
      (option) => option.id === 'ultracode',
    )?.overridesWhenOn).toEqual({ optionIds: ['reasoning_effort'], forcedValue: 'xhigh' });
    publisher.dispose();
  });

  it('serializes transition truth over lagging runtime publication and retains it across daemon replacement', async () => {
    const source = createSource();
    const session = createSession(createTestMetadata({
      sessionRunnerRuntimeV1: sessionRunnerRuntime('runner-generation-1'),
      sessionModelsV1: {
        v: 1,
        agentId: 'qwen',
        updatedAt: 1,
        currentModelId: 'old-model',
        availableModels: [
          { id: 'old-model', name: 'Old model' },
          { id: 'next-model', name: 'Next model' },
        ],
      },
    }));
    source.publish({
      currentModelId: 'old-model',
      models: [
        { id: 'old-model', name: 'Old model' },
        { id: 'next-model', name: 'Next model' },
      ],
    });
    const publisher = createSessionRuntimeModelsPublisher({
      agentId: 'qwen',
      agentTargetKey: 'backend:qwen',
      runnerProcessIdentity: { pid: 123, processStartTimeMs: 1_000 },
      session,
      source,
    });
    await publisher.flush();

    await publisher.publishActiveSelection({
      selection: {
        agentTargetKey: 'backend:qwen',
        providerConnectionId: null,
        modelId: 'next-model',
      },
      activeSelectionV1: {
        v: 1,
        selection: {
          agentTargetKey: 'backend:qwen',
          providerConnectionId: null,
          modelId: 'next-model',
        },
        source: 'runtime_apply',
        runner: {
          pid: 123,
          processStartTimeMs: 1_000,
        },
      },
      publishActive: async () => {
        await session.updateMetadata((metadata) => ({
          ...metadata,
          sessionModelsV1: {
            ...metadata.sessionModelsV1!,
            updatedAt: 2,
            currentModelId: 'next-model',
          },
        }));
      },
    });

    expect(session.getMetadataSnapshot().sessionModelsV1).toMatchObject({
      currentModelId: 'next-model',
    });

    await session.updateMetadata((metadata) => ({
      ...metadata,
      sessionRunnerRuntimeV1: sessionRunnerRuntime(
        'runner-generation-1',
        'replacement-daemon',
      ),
    }));
    await publisher.flush();
    expect(session.getMetadataSnapshot().sessionModelsV1).toMatchObject({
      currentModelId: 'next-model',
    });

    source.publish({
      currentModelId: 'next-model',
      models: [
        { id: 'old-model', name: 'Old model' },
        { id: 'next-model', name: 'Next model' },
      ],
    });
    await publisher.flush();
    expect(session.getMetadataSnapshot().sessionModelsV1).toMatchObject({
      currentModelId: 'next-model',
    });

    source.publish({
      currentModelId: 'old-model',
      models: [
        { id: 'old-model', name: 'Old model' },
        { id: 'next-model', name: 'Next model' },
      ],
    });
    await publisher.flush();
    expect(session.getMetadataSnapshot().sessionModelsV1).toMatchObject({
      currentModelId: 'next-model',
      activeSelectionV1: {
        selection: {
          modelId: 'next-model',
        },
        source: 'runtime_apply',
      },
    });

    await publisher.releaseActiveSelectionAuthority({
      selection: {
        agentTargetKey: 'backend:qwen',
        providerConnectionId: null,
        modelId: 'old-model',
      },
    });
    expect(session.getMetadataSnapshot().sessionModelsV1).toMatchObject({
      currentModelId: 'next-model',
      activeSelectionV1: {
        selection: {
          modelId: 'next-model',
        },
        source: 'runtime_apply',
      },
    });
    publisher.dispose();
  });

  it('does not promote a catalog fallback to exact runtime readback', async () => {
    const source = createSource();
    const session = createSession({
      sessionModelsV1: {
        v: 1,
        agentId: 'qwen',
        updatedAt: 1,
        currentModelId: 'fallback-model',
        availableModels: [{
          id: 'fallback-model',
          name: 'Fallback model',
        }],
      },
    } as Metadata);
    const publisher = createSessionRuntimeModelsPublisher({
      agentId: 'qwen',
      agentTargetKey: 'backend:qwen',
      runnerProcessIdentity: {
        pid: 123,
        processStartTimeMs: 1_000,
      },
      session,
      source,
    });

    source.publish({
      currentModelId: null,
      models: [{
        id: 'fallback-model',
        name: 'Fallback model',
      }],
    });
    await publisher.flush();

    expect(
      session.getMetadataSnapshot().sessionModelsV1?.activeSelectionV1,
    ).toBeUndefined();
    publisher.dispose();
  });

  it('merges one runtime slice with canonical evidence, preserves selection, and restores base on clear', async () => {
    const source = createSource();
    const session = createSession({
      sessionModelsV1: {
        v: 1,
        agentId: 'cursor',
        updatedAt: 1,
        currentModelId: 'standard',
        availableModels: [{ id: 'standard', name: 'Standard' }],
      },
    } as Metadata);
    const publisher = createSessionRuntimeModelsPublisher({ agentId: 'cursor', session, source });

    source.publish({
      models: [{
        id: 'runtime',
        name: 'Runtime',
        contextWindowTokens: 400_000,
        modelOptions: [{
          id: 'effort',
          name: 'Effort',
          type: 'select',
          currentValue: 'high',
          options: [{ value: 'high', name: 'High' }],
        }],
      }],
    });
    await publisher.flush();

    expect(session.getMetadataSnapshot().sessionModelsV1).toMatchObject({
      currentModelId: 'standard',
      availableModels: [
        { id: 'runtime', name: 'Runtime', contextWindowTokens: 400_000 },
        { id: 'standard', name: 'Standard' },
      ],
    });

    source.publish({ models: null });
    await publisher.flush();
    expect(session.getMetadataSnapshot().sessionModelsV1).toEqual({
      v: 1,
      agentId: 'cursor',
      updatedAt: 1,
      currentModelId: 'standard',
      availableModels: [{ id: 'standard', name: 'Standard' }],
    });
    publisher.dispose();
  });

  it('uses the latest runtime snapshot and recomputes when standard evidence changes', async () => {
    const source = createSource();
    const session = createSession({} as Metadata);
    const publisher = createSessionRuntimeModelsPublisher({ agentId: 'cursor', session, source });
    source.publish({ models: [{ id: 'runtime', name: 'Runtime' }] });
    await publisher.flush();
    source.publish({ models: [{ id: 'latest', name: 'Latest' }] });
    await publisher.flush();
    expect(session.getMetadataSnapshot().sessionModelsV1?.availableModels.map((model) => model.id)).toEqual(['latest']);

    await session.updateMetadata((current) => ({
      ...current,
      acpSessionModelsV1: {
        v: 1,
        agentId: 'cursor',
        updatedAt: 5,
        currentModelId: 'standard',
        availableModels: [{ id: 'standard', name: 'Standard' }],
      },
    }));
    await publisher.flush();
    expect(session.getMetadataSnapshot().sessionModelsV1?.availableModels.map((model) => model.id)).toEqual([
      'latest',
      'standard',
    ]);

    source.publish({ models: null });
    await publisher.flush();
    expect(session.getMetadataSnapshot().sessionModelsV1).toEqual({
      v: 1,
      agentId: 'cursor',
      updatedAt: 5,
      currentModelId: 'standard',
      availableModels: [{ id: 'standard', name: 'Standard' }],
    });
    publisher.dispose();
  });

  it('prefers a valid provider current model over stale previous and base selections', async () => {
    const source = createSource();
    const session = createSession({
      sessionModelsV1: {
        v: 1,
        agentId: 'grok',
        updatedAt: 1,
        currentModelId: 'stale-base',
        availableModels: [{
          id: 'stale-base',
          name: 'Stale base',
          modelOptions: [{
            id: 'base-only',
            name: 'Base only',
            type: 'boolean',
            currentValue: 'false',
          }],
        }],
      },
    } as Metadata);
    const publisher = createSessionRuntimeModelsPublisher({ agentId: 'grok', session, source });

    source.publish({
      currentModelId: 'provider-current',
      models: [
        {
          id: 'provider-current',
          name: 'Provider current',
          modelOptions: [{
            id: 'effort',
            name: 'Effort',
            type: 'select',
            currentValue: 'high',
            options: [{ value: 'high', name: 'High' }],
          }],
        },
        { id: 'stale-base', name: 'Stale base' },
      ],
    });
    await publisher.flush();

    expect(session.getMetadataSnapshot().sessionModelsV1?.currentModelId).toBe('provider-current');
    expect(session.getMetadataSnapshot().sessionModelsV1?.availableModels).toEqual([
      expect.objectContaining({
        id: 'provider-current',
        modelOptions: [expect.objectContaining({ id: 'effort', currentValue: 'high' })],
      }),
      expect.objectContaining({
        id: 'stale-base',
        modelOptions: [expect.objectContaining({ id: 'base-only', currentValue: 'false' })],
      }),
    ]);
    publisher.dispose();
  });

  it('preserves richer authorized facts when the runtime reports the same model shallowly', async () => {
    const source = createSource();
    const session = createSession({
      sessionModelsV1: {
        v: 1,
        agentId: 'opencode',
        updatedAt: 1,
        currentModelId: 'provider-current',
        availableModels: [{
          id: 'provider-current',
          name: 'Authorized model',
          description: 'Authorized Provider descriptor',
          contextWindowTokens: 200_000,
          modelOptions: [{
            id: 'reasoning',
            name: 'Reasoning',
            type: 'select',
            currentValue: 'high',
            options: [{ value: 'high', name: 'High' }],
          }],
        }],
      },
    } as Metadata);
    const publisher = createSessionRuntimeModelsPublisher({
      agentId: 'opencode',
      session,
      source,
    });

    source.publish({
      currentModelId: 'provider-current',
      models: [{
        id: 'provider-current',
        name: 'Runtime model',
      }],
    });
    await publisher.flush();

    expect(
      session.getMetadataSnapshot().sessionModelsV1?.availableModels,
    ).toEqual([{
      id: 'provider-current',
      name: 'Runtime model',
      description: 'Authorized Provider descriptor',
      contextWindowTokens: 200_000,
      modelOptions: [{
        id: 'reasoning',
        name: 'Reasoning',
        type: 'select',
        currentValue: 'high',
        options: [{ value: 'high', name: 'High' }],
      }],
    }]);
    publisher.dispose();
  });

  it('honors runtime option suppression after active Provider facts are applied', async () => {
    const connectionId = ProviderConnectionIdSchema.parse('pc_runtime_suppression');
    const target = {
      selection: {
        agentTargetKey: 'backend:generic-agent',
        providerConnectionId: connectionId,
        modelId: 'provider-current',
      },
      policy: 'live',
      providerBinding: {
        connectionId,
        upstream: {
          protocol: 'openai-responses',
          normalizedUrl: 'https://provider.example/v1',
          credential: 'apiKey',
        },
        model: {
          id: 'provider-current',
          name: 'Authorized Provider model',
          description: 'Provider-authored description',
          contextWindowTokens: 200_000,
          modelOptions: [
            {
              id: 'reasoning_effort',
              name: 'Reasoning effort',
              type: 'select',
              currentValue: 'high',
              options: [{ value: 'high', name: 'High' }],
            },
            {
              id: 'ultracode',
              name: 'Ultracode',
              type: 'boolean',
              currentValue: 'false',
            },
            {
              id: 'provider_only',
              name: 'Provider-only fact',
              type: 'boolean',
              currentValue: 'true',
            },
          ],
        },
        materialization: { v: 1, kind: 'spawnEnv' },
      },
      sessionBindingMetadata: null,
      runtimeBindingBasis: null,
      revalidateBeforeEffect: async () => true,
    } satisfies AuthorizedSessionModelTransitionTarget;
    const withActiveFacts = applyActiveModelFacts(
      createTestMetadata({}),
      target,
      'generic-agent',
    );
    const source = createSource();
    source.publish({
      currentModelId: 'provider-current',
      models: [{
        id: 'provider-current',
        name: 'Runtime model',
        suppressedModelOptionIds: ['reasoning_effort', 'ultracode'],
      }],
    });
    const session = createSession(withActiveFacts);
    const publisher = createSessionRuntimeModelsPublisher({
      agentId: 'generic-agent',
      session,
      source,
    });

    await publisher.flush();

    expect(session.getMetadataSnapshot().sessionModelsV1?.availableModels).toEqual([{
      id: 'provider-current',
      name: 'Runtime model',
      description: 'Provider-authored description',
      contextWindowTokens: 200_000,
      modelOptions: [{
        id: 'provider_only',
        name: 'Provider-only fact',
        type: 'boolean',
        currentValue: 'true',
      }],
    }]);
    publisher.dispose();
  });

  it('does not restore stale legacy options omitted by canonical model facts', async () => {
    const source = createSource();
    const session = createSession({
      sessionModelsV1: {
        v: 1,
        agentId: 'opencode',
        updatedAt: 2,
        currentModelId: 'provider-current',
        availableModels: [{
          id: 'provider-current',
          name: 'Canonical Provider model',
        }],
      },
      acpSessionModelsV1: {
        v: 1,
        agentId: 'opencode',
        updatedAt: 1,
        currentModelId: 'provider-current',
        availableModels: [{
          id: 'provider-current',
          name: 'Legacy Provider model',
          modelOptions: [{
            id: 'stale-option',
            name: 'Stale option',
            type: 'select',
            currentValue: 'stale',
          }],
        }],
      },
    } as Metadata);
    const publisher = createSessionRuntimeModelsPublisher({
      agentId: 'opencode',
      session,
      source,
    });

    await publisher.flush();

    expect(session.getMetadataSnapshot().sessionModelsV1).toEqual({
      v: 1,
      agentId: 'opencode',
      updatedAt: 2,
      currentModelId: 'provider-current',
      availableModels: [{
        id: 'provider-current',
        name: 'Canonical Provider model',
      }],
    });
    publisher.dispose();
  });

  it('removes a replaced standard ACP contribution without deleting the runtime contribution', async () => {
    const source = createSource();
    const session = createSession({} as Metadata);
    const publisher = createSessionRuntimeModelsPublisher({ agentId: 'cursor', session, source });
    source.publish({ models: [{ id: 'runtime', name: 'Runtime' }] });
    await publisher.flush();
    await session.updateMetadata((current) => ({
      ...current,
      acpSessionModelsV1: {
        v: 1,
        agentId: 'cursor',
        updatedAt: 2,
        currentModelId: 'standard',
        availableModels: [{ id: 'standard', name: 'Standard' }],
      },
    }));
    await publisher.flush();
    expect(session.getMetadataSnapshot().sessionModelsV1?.availableModels.map((model) => model.id)).toEqual([
      'runtime',
      'standard',
    ]);

    await session.updateMetadata(({ acpSessionModelsV1: _removed, ...current }) => current);
    await publisher.flush();

    expect(session.getMetadataSnapshot().sessionModelsV1?.availableModels.map((model) => model.id)).toEqual(['runtime']);
    publisher.dispose();
  });

  it('disposes both subscriptions and prevents later runtime or metadata writes', async () => {
    const source = createSource();
    const session = createSession({} as Metadata);
    const publisher = createSessionRuntimeModelsPublisher({ agentId: 'cursor', session, source });
    source.publish({ models: [{ id: 'runtime', name: 'Runtime' }] });
    await publisher.flush();
    const writesBeforeDispose = session.updateCount();
    expect(session.listenerCount()).toBe(1);

    publisher.dispose();
    const stoppedPublication = publisher.publishActiveSelection({
      selection: {
        agentTargetKey: 'backend:cursor',
        providerConnectionId: null,
        modelId: 'runtime',
      },
      activeSelectionV1: {
        v: 1,
        selection: {
          agentTargetKey: 'backend:cursor',
          providerConnectionId: null,
          modelId: 'runtime',
        },
        source: 'runtime_apply',
        runner: {
          pid: 123,
          processStartTimeMs: 1_000,
        },
      },
      publishActive: async () => undefined,
    });
    await expect(stoppedPublication).rejects.toMatchObject({
      code: 'session_publisher_authority_lost',
      retryable: false,
    });
    expect(session.listenerCount()).toBe(0);
    source.publish({ models: [{ id: 'later', name: 'Later' }] });
    await session.updateMetadata((current) => ({ ...current, custom: 'external' } as Metadata));
    await expect(publisher.flush()).rejects.toMatchObject({
      code: 'session_publisher_authority_lost',
    });

    expect(session.updateCount()).toBe(writesBeforeDispose + 1);
    expect(session.getMetadataSnapshot().sessionModelsV1?.availableModels.map((model) => model.id)).toEqual([
      'runtime',
    ]);
  });

  it('stops new publications and drains a publication already writing metadata', async () => {
    const source = createSource();
    let releaseMetadataWrite!: () => void;
    const metadataWriteReleased = new Promise<void>((resolve) => {
      releaseMetadataWrite = resolve;
    });
    let notifyMetadataWriteStarted!: () => void;
    const metadataWriteStarted = new Promise<void>((resolve) => {
      notifyMetadataWriteStarted = resolve;
    });
    const session = createSession({} as Metadata);
    const updateMetadataAsCurrentPublisher =
      session.updateMetadataAsCurrentPublisher;
    session.updateMetadataAsCurrentPublisher = async (updater) => {
      notifyMetadataWriteStarted();
      await metadataWriteReleased;
      await updateMetadataAsCurrentPublisher(updater);
    };
    const publisher = createSessionRuntimeModelsPublisher({ agentId: 'cursor', session, source });

    source.publish({ models: [{ id: 'runtime', name: 'Runtime' }] });
    await metadataWriteStarted;

    let stopped = false;
    const stop = publisher.stopAndDrain().then(() => {
      stopped = true;
    });
    source.publish({ models: [{ id: 'later', name: 'Later' }] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);

    releaseMetadataWrite();
    await stop;
    await publisher.flush();

    expect(session.getMetadataSnapshot().sessionModelsV1?.availableModels.map((model) => model.id)).toEqual([
      'runtime',
    ]);
  });

  it('stops runtime readback publication after exact publisher authority is lost', async () => {
    const source = createSource();
    const session = createSession({} as Metadata);
    let publicationAttempts = 0;
    session.updateMetadataAsCurrentPublisher = async () => {
      publicationAttempts += 1;
      throw Object.assign(new Error('publisher superseded'), {
        code: 'session_publisher_authority_lost' as const,
        retryable: false as const,
      });
    };
    const publisher = createSessionRuntimeModelsPublisher({
      agentId: 'cursor',
      session,
      source,
    });
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (error: unknown) => {
      unhandledRejections.push(error);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      source.publish({
        currentModelId: 'runtime',
        models: [{ id: 'runtime', name: 'Runtime' }],
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
      await expect(publisher.flush()).rejects.toMatchObject({
        code: 'session_publisher_authority_lost',
        retryable: false,
      });
      expect(publicationAttempts).toBe(1);
      expect(session.listenerCount()).toBe(0);

      source.publish({
        currentModelId: 'later',
        models: [{ id: 'later', name: 'Later' }],
      });
      await session.updateMetadata((current) => ({
        ...current,
        custom: 'external',
      } as Metadata));
      await expect(publisher.flush()).rejects.toMatchObject({
        code: 'session_publisher_authority_lost',
      });
      expect(publicationAttempts).toBe(1);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('never relabels, merges, or restores another Agent model catalog', async () => {
    const source = createSource();
    const session = createSession({
      sessionModelsV1: {
        v: 1,
        agentId: 'stale-agent',
        updatedAt: 1,
        currentModelId: 'stale-canonical',
        availableModels: [{ id: 'stale-canonical', name: 'Stale canonical' }],
      },
      acpSessionModelsV1: {
        v: 1,
        agentId: 'stale-agent',
        updatedAt: 2,
        currentModelId: 'stale-legacy',
        availableModels: [{ id: 'stale-legacy', name: 'Stale legacy' }],
      },
    } as Metadata);
    const publisher = createSessionRuntimeModelsPublisher({
      agentId: 'cursor',
      session,
      source,
    });

    await publisher.flush();
    expect(session.getMetadataSnapshot().sessionModelsV1).toBeUndefined();

    source.publish({
      currentModelId: 'runtime',
      models: [{ id: 'runtime', name: 'Runtime' }],
    });
    await publisher.flush();
    expect(session.getMetadataSnapshot().sessionModelsV1).toMatchObject({
      agentId: 'cursor',
      currentModelId: 'runtime',
      availableModels: [{ id: 'runtime', name: 'Runtime' }],
    });

    source.publish({ models: null });
    await publisher.flush();
    expect(session.getMetadataSnapshot().sessionModelsV1).toBeUndefined();
    publisher.dispose();
  });
});
