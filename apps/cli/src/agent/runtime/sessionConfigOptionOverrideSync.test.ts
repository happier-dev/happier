import { describe, expect, it, vi } from 'vitest';

import type { RuntimeConfigUpdateOutcomeV1 } from '@happier-dev/agents';
import type { AgentRuntimeFactory, AgentSessionConfigurationSnapshot, AgentSessionModelsSource, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginAgentContributionV2Schema, ProviderConnectionIdSchema } from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createSessionConfigOptionOverrideSynchronizer, resolveApplicableSessionConfigOptionOverridesFromMetadataSnapshot, resolveSessionConfigOptionOverridesFromMetadataSnapshot } from './sessionConfigOptionOverrideSync';
import { createNativeAgentSessionInteractionOperations } from './registry/engineRegistry/nativeAgentSession';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { createRuntimeOverrideTarget } from './createRuntimeOverrideSynchronizers';
import { createSessionRuntimeModelsPublisher } from './controls/sessionRuntimeModelsPublisher';
import { createSessionOwnerMetadataV1, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { mergeSessionMetadataForStartup } from './mergeSessionMetadataForStartup';

describe('createSessionConfigOptionOverrideSynchronizer', () => {
  it('omits another model’s controls while preserving session controls and unsupported values on a supported model', async () => {
    const catalogPath = '../../../../../packages/plugins/claude/src/agent/models.ts';
    const { CLAUDE_STATIC_MODELS } = await import(catalogPath);
    const metadata = createTestMetadata({
      flavor: 'claude',
      modelOverrideV1: { v: 1, modelId: 'claude-haiku-4-5', updatedAt: 1 },
      sessionModelsV1: { v: 1, agentId: 'claude', updatedAt: 2,
        currentModelId: 'claude-haiku-4-5-20251001', availableModels: CLAUDE_STATIC_MODELS },
      sessionConfigOptionOverridesV1: { v: 1, updatedAt: 3, overrides: {
        reasoning_effort: { updatedAt: 3, value: 'low' }, telemetry: { updatedAt: 3, value: true },
      } },
    });
    expect(resolveApplicableSessionConfigOptionOverridesFromMetadataSnapshot({ metadata }))
      .toEqual([{ configId: 'telemetry', valueId: true, updatedAt: 3 }]);
    expect(resolveSessionConfigOptionOverridesFromMetadataSnapshot({ metadata })).toHaveLength(2);
    expect(metadata.sessionConfigOptionOverridesV1?.overrides.reasoning_effort?.value).toBe('low');
    expect(mergeSessionMetadataForStartup({ current: metadata, next: createTestMetadata({ flavor: 'claude' }),
      mode: 'attach', nowMs: 4,
    }).sessionConfigOptionOverridesV1?.overrides.reasoning_effort?.value).toBe('low');

    const supported = { ...metadata, modelOverrideV1: { v: 1 as const, modelId: 'claude-sonnet-4-6', updatedAt: 4 },
      sessionConfigOptionOverridesV1: { v: 1 as const, updatedAt: 4, overrides: { reasoning_effort: { updatedAt: 4, value: 'invalid' } } } };
    expect(resolveApplicableSessionConfigOptionOverridesFromMetadataSnapshot({ metadata: supported }))
      .toEqual([{ configId: 'reasoning_effort', valueId: 'invalid', updatedAt: 4 }]);
    expect(resolveApplicableSessionConfigOptionOverridesFromMetadataSnapshot({ metadata: supported,
      modelSelection: { modelId: 'claude-haiku-4-5', providerConnectionId: null },
    }))
      .toEqual([]);
    expect(resolveApplicableSessionConfigOptionOverridesFromMetadataSnapshot({ metadata,
      modelSelection: { modelId: 'claude-haiku-4-5', providerConnectionId: ProviderConnectionIdSchema.parse('pc_exact') },
    })).toHaveLength(2);
    // A session-wide declaration owns its option independently of model scope.
    expect(resolveApplicableSessionConfigOptionOverridesFromMetadataSnapshot({ metadata: { ...metadata,
      sessionConfigOptionsV1: { v: 1, agentId: 'claude', updatedAt: 4,
        configOptions: [{ id: 'reasoning_effort', name: 'Session effort', type: 'select', currentValue: 'low' }] },
    } })).toHaveLength(2);
    // An unknown model (or a selected-only catalog with no controls) supplies no negative fact.
    for (const availableModels of [[], [{ id: 'claude-haiku-4-5', name: 'Haiku' }]]) {
      expect(resolveApplicableSessionConfigOptionOverridesFromMetadataSnapshot({ metadata: { ...metadata,
        sessionModelsV1: { ...metadata.sessionModelsV1!, availableModels },
      } })).toHaveLength(2);
    }
    expect(resolveApplicableSessionConfigOptionOverridesFromMetadataSnapshot({ metadata: { ...metadata,
      sessionModelsV1: { ...metadata.sessionModelsV1!, agentId: 'codex' },
    } })).toHaveLength(2);
    const { sessionModelsV1: catalog, ...withoutCanonicalCatalog } = metadata;
    expect(resolveApplicableSessionConfigOptionOverridesFromMetadataSnapshot({ metadata: {
      ...withoutCanonicalCatalog, acpSessionModelsV1: catalog,
    } })).toEqual([{ configId: 'telemetry', valueId: true, updatedAt: 3 }]);
    expect(resolveApplicableSessionConfigOptionOverridesFromMetadataSnapshot({ metadata: { ...metadata,
      modelOverrideV1: undefined, modelSelectionIntentV2: { v: 2, updatedAt: 4,
        ref: { source: 'native', agentTargetKey: 'backend:claude', modelId: 'claude-haiku-4-5' } },
    } })).toEqual([{ configId: 'telemetry', valueId: true, updatedAt: 3 }]);
  });

  it('withdraws an inapplicable queued model control when the startup catalog arrives, then applies it on a supported model', async () => {
    const catalogPath = '../../../../../packages/plugins/claude/src/agent/models.ts';
    const { CLAUDE_STATIC_MODELS } = await import(catalogPath);
    let started = false;
    let metadata = createTestMetadata({ flavor: 'claude',
      modelOverrideV1: { v: 1, modelId: 'claude-haiku-4-5', updatedAt: 1 },
      sessionConfigOptionOverridesV1: { v: 1, updatedAt: 2, overrides: { reasoning_effort: { updatedAt: 2, value: 'low' } } },
    });
    const applied: unknown[] = [];
    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: { getMetadataSnapshot: () => metadata }, isStarted: () => started,
      runtime: { setSessionConfigOption: async (id, value) => { applied.push([id, value]); return { status: 'applied' }; } },
    });
    sync.syncFromMetadata();
    metadata = { ...metadata, sessionModelsV1: { v: 1, agentId: 'claude', updatedAt: 3,
      currentModelId: 'claude-haiku-4-5-20251001', availableModels: CLAUDE_STATIC_MODELS } };
    sync.syncFromMetadata();
    started = true;
    await sync.flushPendingAfterStart();
    expect(applied).toEqual([]);
    metadata = { ...metadata, modelOverrideV1: { v: 1, modelId: 'claude-sonnet-4-6', updatedAt: 4 } };
    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();
    expect(applied).toEqual([['reasoning_effort', 'low']]);
  });

  it.each([true, false])('reconciles Haiku metadata through the real native Claude configuration consumer without an unsupported diagnostic (persisted catalog: %s)', async (hasPersistedCatalog) => {
    const runtimePath = '../../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime.ts';
    const testkitPath = '../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit.ts';
    const manifestPath = '../../../../../packages/plugins/claude/src/manifest.ts';
    const { PLUGIN_MANIFEST } = await import(manifestPath);
    const capabilities = readAgentSessionCapabilities(PluginAgentContributionV2Schema.parse(PLUGIN_MANIFEST.contributes.agents?.[0]));
    if (!capabilities) throw new Error('Claude Session capability declaration is unavailable');
    const { createClaudeAgentRuntime }: { createClaudeAgentRuntime: AgentRuntimeFactory } = await import(runtimePath);
    const { createPluginContextFixture, createTerminalHostFixture, createEventsFixture } = await import(testkitPath);
    const fixture = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service);
    let modelSource: AgentSessionModelsSource | undefined;
    const signal = new AbortController().signal;
    // Canonical plugin host-port fixtures substitute OS/native services only.
    const context = {
      signal, agent: { id: 'claude' }, services: { logger: fixture.logger, settings: fixture.settings, storage: fixture.storage,
        exec: { systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'claude-cli' }, executablePath: '/managed/claude' }) },
          run: async () => ({ termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
            stdout: new TextEncoder().encode('--effort <level>'), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false }) } },
      session: { services: { features: fixture.features, terminalHost: fixture.agentRuntime.terminalHost,
        sessionHooks: fixture.agentRuntime.sessionHooks, transcripts: fixture.agentRuntime.transcripts,
        accountUsage: fixture.agentRuntime.accountUsage, workflowActivity: fixture.session.workflowActivity,
        activeInput: { bind: () => ({ dispose() {} }) },
        models: { bind: (source: AgentSessionModelsSource) => { modelSource = source; return { dispose() {} }; } } } },
      workState: { publisher: () => ({ publish: async () => undefined }) },
    } as unknown as AgentSessionRuntimeContext;
    const factory = await createClaudeAgentRuntime({ plugin: { id: 'happier.agent.claude', version: '0.0.0' }, agent: { id: 'claude' }, signal });
    if (!factory.sessions) throw new Error('Claude Session factory is unavailable');
    const configuration: AgentSessionConfigurationSnapshot = {
      mode: { value: null, updatedAtMs: 0 }, model: { value: 'claude-haiku-4-5', updatedAtMs: 0 },
      permissionIntent: { value: 'default', updatedAtMs: 0 }, options: { reasoning_effort: { value: 'low', updatedAtMs: 0 } },
    };
    const native = await factory.sessions.open({ kind: 'resume', sessionId: 'haiku-effort-replay', cwd: '/tmp/project',
      providerSessionId: 'native-haiku', configuration }, context);
    const readModelSource = () => modelSource;
    let metadataSession: ReturnType<typeof createMutableApiSessionClientFixture> | undefined;
    let publisher: ReturnType<typeof createSessionRuntimeModelsPublisher> | undefined;
    try {
      const operations = createNativeAgentSessionInteractionOperations({ session: native, sessionId: 'haiku-effort-replay',
        cwd: '/tmp/project', context, capabilities, initialConfiguration: configuration });
      const source = readModelSource();
      const availableModels = source?.read().models;
      if (!availableModels || !source) throw new Error('The native model owner did not publish its catalog');
      const metadata = createTestMetadata({ flavor: 'claude',
        modelOverrideV1: { v: 1, modelId: 'claude-haiku-4-5', updatedAt: 1 },
        ...(hasPersistedCatalog ? { sessionModelsV1: { v: 1 as const, agentId: 'claude', updatedAt: 1, currentModelId: 'claude-haiku-4-5-20251001', availableModels: [...availableModels] } } : {}),
        sessionConfigOptionOverridesV1: { v: 1, updatedAt: 1, overrides: { reasoning_effort: { updatedAt: 1, value: 'low' } } },
      });
      metadataSession = createMutableApiSessionClientFixture({ sessionId: 'haiku-effort-replay', metadata });
      publisher = createSessionRuntimeModelsPublisher({ agentId: 'claude', session: metadataSession, source });
      await publisher.flush();
      // Exercise the current-only runtime merge over an existing catalog, then
      // read the exact persisted consumer schema rather than the binding input.
      const owner = createSessionOwnerMetadataV1({ metadata: metadataSession.getMetadataSnapshot() });
      if (!owner.ok) throw new Error(`The persisted model projection is invalid: ${owner.unsupportedFields.join(',')}`);
      const published = SessionOwnerMetadataV1Schema.parse(owner.ownerMetadata).runtime?.sessionModelsV1;
      if (hasPersistedCatalog) {
        expect(published?.availableModels.some(model => model.modelOptions?.some(option => option.id === 'reasoning_effort'))).toBe(true);
      } else {
        // A fresh runtime has catalog declarations before it observes a current
        // native model. Publishing a configured model as current would fabricate evidence.
        expect(published).toBeUndefined();
      }
      const rejected: RuntimeConfigUpdateOutcomeV1[] = [];
      const sync = createSessionConfigOptionOverrideSynchronizer({ session: metadataSession, models: source,
        runtime: createRuntimeOverrideTarget({ runtime: operations, transitionModelSelection: async () => { throw new Error('This replay does not transition models'); } }),
        isStarted: () => true, onConfigOptionRejected: ({ outcome }) => { rejected.push(outcome); },
      });
      for (let refresh = 0; refresh < 3; refresh += 1) { sync.syncFromMetadata(); await sync.flushPendingAfterStart(); }
      expect(rejected).toEqual([]);
      // Direct invalid requests keep their native typed refusal; omission belongs to metadata production.
      await expect(native.updateConfiguration({ ...configuration,
        options: { reasoning_effort: { value: 'low', updatedAtMs: 2 } },
      })).resolves.toMatchObject({ status: 'unsupported', diagnostic: { code: 'claude_model_option_unsupported' } });
      await metadataSession.updateMetadataAsCurrentPublisher(current => ({ ...current,
        sessionConfigOptionOverridesV1: { v: 1, updatedAt: 3, overrides: {
          reasoning_effort: { value: null, updatedAt: 3 },
        } },
      }));
      sync.syncFromMetadata();
      await sync.flushPendingAfterStart();
      expect(metadataSession.getMetadataSnapshot()?.sessionConfigOptionOverridesV1?.overrides.reasoning_effort?.value).toBeNull();
      expect(rejected).toEqual([]);
      // A real metadata change still reaches the native refusal boundary; the
      // quiet replay cannot pass because the override adapter is disconnected.
      await metadataSession.updateMetadataAsCurrentPublisher(current => ({ ...current,
        sessionConfigOptionOverridesV1: { v: 1, updatedAt: 4, overrides: {
          ...current.sessionConfigOptionOverridesV1?.overrides, unsupported_control: { value: true, updatedAt: 4 },
        } },
      }));
      sync.syncFromMetadata();
      await sync.flushPendingAfterStart();
      expect(rejected).toEqual([expect.objectContaining({ status: 'unsupported' })]);
    } finally {
      publisher?.dispose();
      await metadataSession?.close();
      await native.dispose();
      await factory.dispose?.();
    }
  });

  it('settles a definitive rejection once, clears its intent and keeps newer edits runnable', async () => {
    // fx 0.0.14 wire capture: E-fx-live-probe.md §3, 2026-10-27, provider=gateway / -32600.
    const reason = 'fx needs access to Vercel AI Gateway. Run fx login to sign in, fx setup to use an API key, or set AI_GATEWAY_API_KEY.';
    let metadata = createTestMetadata({ sessionConfigOptionOverridesV1: { v: 1, updatedAt: 30,
      overrides: { provider: { updatedAt: 30, value: 'gateway' }, effort: { updatedAt: 20, value: 'high' } } } });
    const rejected: string[] = [];
    const applied: Array<readonly [string, string | number | boolean | null]> = [];
    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: { getMetadataSnapshot: () => metadata,
        updateMetadataAsCurrentPublisher: async update => { metadata = update(metadata); } },
      runtime: { setSessionConfigOption: async (id, value) => {
        applied.push([id, value]);
        return id === 'provider' && value === 'gateway' ? { status: 'failed', reason } : { status: 'applied' };
      } },
      isStarted: () => true,
      onConfigOptionRejected: async ({ outcome }) => { rejected.push(outcome.reason ?? ''); },
    });
    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();
    expect(metadata.sessionConfigOptionOverridesV1?.overrides).toEqual({ effort: { updatedAt: 20, value: 'high' } });
    for (let i = 0; i < 3; i += 1) { sync.syncFromMetadata(); await sync.flushPendingAfterStart(); }
    expect(applied.filter(([id]) => id === 'provider')).toEqual([['provider', 'gateway']]);
    expect(rejected).toEqual([reason]);
    metadata = { ...metadata, sessionConfigOptionOverridesV1: { v: 1, updatedAt: 31,
      overrides: { provider: { updatedAt: 31, value: 'codex' } } } };
    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();
    expect(applied.at(-1)).toEqual(['provider', 'codex']);
  });

  it.each([' selected ', '', ' '])('keeps exact opaque config ids and value %j through metadata reconciliation', async value => {
    const setSessionConfigOption = vi.fn(async (_id: string, _value: string | number | boolean | null) => {});
    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: { getMetadataSnapshot: () => createTestMetadata({ sessionConfigOptionOverridesV1: { v: 1, updatedAt: 1,
        overrides: { ' custom ': { updatedAt: 1, value } } } }) },
      runtime: { setSessionConfigOption }, isStarted: () => true,
    });
    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();
    expect(setSessionConfigOption).toHaveBeenCalledWith(' custom ', value);
  });

  it('preserves an edit arriving during a rejected setter and applies the newer value', async () => {
    let metadata = createTestMetadata({ sessionConfigOptionOverridesV1: { v: 1, updatedAt: 1,
      overrides: { provider: { updatedAt: 1, value: 'gateway' } } } });
    let rejectCandidate!: (outcome: RuntimeConfigUpdateOutcomeV1) => void;
    const first = new Promise<RuntimeConfigUpdateOutcomeV1>(resolve => { rejectCandidate = resolve; });
    const values: Array<string | number | boolean | null> = [];
    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: { getMetadataSnapshot: () => metadata,
        updateMetadataAsCurrentPublisher: async update => { metadata = update(metadata); } },
      runtime: { setSessionConfigOption: async (_id, value) => {
        values.push(value);
        return value === 'gateway' ? first : { status: 'applied' };
      } }, isStarted: () => true,
    });
    sync.syncFromMetadata();
    metadata = { ...metadata, sessionConfigOptionOverridesV1: { v: 1, updatedAt: 2,
      overrides: { provider: { updatedAt: 2, value: 'codex' } } } };
    sync.syncFromMetadata();
    rejectCandidate({ status: 'failed', reason: 'Sign in required' });
    await sync.flushPendingAfterStart();
    await sync.flushPendingAfterStart();
    expect(metadata.sessionConfigOptionOverridesV1?.overrides.provider).toEqual({ updatedAt: 2, value: 'codex' });
    expect(values).toEqual(['gateway', 'codex']);
  });

  it.each(['failed', 'unsupported'] as const)('does not retry a %s candidate even when its metadata publication fails', async status => {
    const metadata = createTestMetadata({ sessionConfigOptionOverridesV1: { v: 1, updatedAt: 1,
      overrides: { provider: { updatedAt: 1, value: 'gateway' } } } });
    const attempted: string[] = [];
    const reported: string[] = [];
    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: { getMetadataSnapshot: () => metadata,
        updateMetadataAsCurrentPublisher: async () => { throw new Error('offline'); } },
      runtime: { setSessionConfigOption: async id => {
        attempted.push(id);
        return { status, reason: 'Native configuration refused' };
      } }, isStarted: () => true,
      onConfigOptionRejected: ({ outcome }) => { reported.push(outcome.reason ?? ''); },
    });
    for (let i = 0; i < 3; i += 1) { sync.syncFromMetadata(); await sync.flushPendingAfterStart(); }
    expect(attempted).toEqual(['provider']);
    expect(reported).toEqual(['Native configuration refused']);
  });

  it('queues pending overrides before runtime start and applies after start', async () => {
    let started = false;
    const setSessionConfigOption = vi.fn(async (_configId: string, _value: any) => {});

    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () =>
          ({
            acpConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 20,
              overrides: {
                telemetry: { updatedAt: 10, value: true },
                mode: { updatedAt: 20, value: 'ask' },
              },
            },
          }) as any,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => started,
    });

    sync.syncFromMetadata();
    expect(setSessionConfigOption).not.toHaveBeenCalled();

    started = true;
    await sync.flushPendingAfterStart();

    expect(setSessionConfigOption).toHaveBeenCalledWith('telemetry', true);
    expect(setSessionConfigOption).toHaveBeenCalledWith('mode', 'ask');
  });

  it('applies overrides immediately once started', async () => {
    const setSessionConfigOption = vi.fn(async (_configId: string, _value: any) => {});

    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () =>
          ({
            acpConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 21,
              overrides: {
                telemetry: { updatedAt: 21, value: false },
              },
            },
          }) as any,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    expect(setSessionConfigOption).toHaveBeenCalledWith('telemetry', false);
  });

  it('reads generic sessionConfigOptionOverridesV1 metadata', async () => {
    const setSessionConfigOption = vi.fn(async (_configId: string, _value: any) => {});

    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () =>
          ({
            sessionConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 22,
              overrides: {
                speed: { updatedAt: 22, value: 'fast' },
              },
            },
          }) as any,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    expect(setSessionConfigOption).toHaveBeenCalledWith('speed', 'fast');
  });

  it('retries immediate apply on next sync when setSessionConfigOption fails', async () => {
    const setSessionConfigOption = vi
      .fn<(_configId: string, _value: any) => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(undefined);

    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () =>
          ({
            acpConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 30,
              overrides: {
                telemetry: { updatedAt: 30, value: true },
              },
            },
          }) as any,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setSessionConfigOption).toHaveBeenCalledTimes(1);

    sync.syncFromMetadata();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setSessionConfigOption).toHaveBeenCalledTimes(2);
    expect(setSessionConfigOption).toHaveBeenNthCalledWith(2, 'telemetry', true);
  });

  it('keeps an override pending (re-attempts) when the runtime reports a non-applied outcome', async () => {
    // gap 27: a plugin that swallows/defers the override (e.g. unified terminal already running)
    // returns a non-applied outcome. The synchronizer must NOT mark it applied, so a later sync
    // re-attempts it at the next safe boundary instead of swallowing it forever.
    const setSessionConfigOption = vi
      .fn<(_configId: string, _value: any) => Promise<RuntimeConfigUpdateOutcomeV1 | void>>()
      .mockResolvedValue({ status: 'requires_interactive_control' });

    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () =>
          ({
            sessionConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 40,
              overrides: {
                reasoning_effort: { updatedAt: 40, value: 'high' },
              },
            },
          }) as any,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setSessionConfigOption).toHaveBeenCalledTimes(1);

    sync.syncFromMetadata();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setSessionConfigOption).toHaveBeenCalledTimes(2);
    expect(setSessionConfigOption).toHaveBeenLastCalledWith('reasoning_effort', 'high');
  });

  it.each<RuntimeConfigUpdateOutcomeV1>([
    { status: 'applied' },
    { status: 'unsupported', timing: 'skipped_already_effective' },
  ])('settles an effective outcome %j without reporting rejection', async outcome => {
    const rejected: string[] = [];
    const setSessionConfigOption = vi
      .fn<(_configId: string, _value: any) => Promise<RuntimeConfigUpdateOutcomeV1 | void>>()
      .mockResolvedValue(outcome);

    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () =>
          ({
            sessionConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 41,
              overrides: {
                reasoning_effort: { updatedAt: 41, value: 'medium' },
              },
            },
          }) as any,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => true,
      onConfigOptionRejected: ({ outcome }) => { rejected.push(outcome.status); },
    });

    sync.syncFromMetadata();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setSessionConfigOption).toHaveBeenCalledTimes(1);

    sync.syncFromMetadata();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setSessionConfigOption).toHaveBeenCalledTimes(1);
    expect(rejected).toEqual([]);
  });

  it('applies the newest config option value across canonical and legacy aliases', async () => {
    const setSessionConfigOption = vi.fn(async (_configId: string, _value: any) => {});

    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () =>
          ({
            sessionConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 10,
              overrides: {
                effort: { updatedAt: 10, value: 'medium' },
              },
            },
            acpConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 20,
              overrides: {
                effort: { updatedAt: 20, value: 'high' },
              },
            },
          }) as any,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    expect(setSessionConfigOption).toHaveBeenCalledWith('effort', 'high');
  });

  it('applies canonical alias tie values after legacy value was applied at the same timestamp', async () => {
    let started = false;
    let metadata: Metadata = {
      path: '/tmp/session',
      host: 'localhost',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happier',
      happyLibDir: '/tmp/.happier/lib',
      happyToolsDir: '/tmp/.happier/tools',
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 20,
        overrides: {
          effort: { updatedAt: 20, value: 'legacy' },
        },
      },
    };
    const setSessionConfigOption = vi.fn(async (_configId: string, _value: string | number | boolean | null) => {});

    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => metadata,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => started,
    });

    sync.syncFromMetadata();
    expect(setSessionConfigOption).not.toHaveBeenCalled();

    started = true;
    await sync.flushPendingAfterStart();
    expect(setSessionConfigOption).toHaveBeenCalledTimes(1);
    expect(setSessionConfigOption).toHaveBeenLastCalledWith('effort', 'legacy');

    metadata = {
      ...metadata,
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 20,
        overrides: {
          effort: { updatedAt: 20, value: 'canonical' },
        },
      },
    };

    sync.syncFromMetadata();
    await Promise.resolve();
    expect(setSessionConfigOption).toHaveBeenCalledTimes(2);
    expect(setSessionConfigOption).toHaveBeenLastCalledWith('effort', 'canonical');

    sync.syncFromMetadata();
    await Promise.resolve();
    expect(setSessionConfigOption).toHaveBeenCalledTimes(2);
  });

  it('applies config option entries that exist only in one alias root', async () => {
    const setSessionConfigOption = vi.fn(async (_configId: string, _value: any) => {});

    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () =>
          ({
            sessionConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 10,
              overrides: {
                effort: { updatedAt: 10, value: 'medium' },
              },
            },
            acpConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 20,
              overrides: {
                speed: { updatedAt: 20, value: 'fast' },
              },
            },
          }) as any,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    expect(setSessionConfigOption).toHaveBeenCalledWith('effort', 'medium');
    expect(setSessionConfigOption).toHaveBeenCalledWith('speed', 'fast');
  });

  it('applies null config option tombstones instead of dropping them', async () => {
    const setSessionConfigOption = vi.fn(async (_configId: string, _value: any) => {});

    const sync = createSessionConfigOptionOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () =>
          ({
            sessionConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 10,
              overrides: {
                effort: { updatedAt: 10, value: null },
              },
            },
          }) as any,
      },
      runtime: { setSessionConfigOption },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    expect(setSessionConfigOption).toHaveBeenCalledWith('effort', null);
  });
});
