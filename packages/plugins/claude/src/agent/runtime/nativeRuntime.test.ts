import { describe, expect, it, vi } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import type {
  AgentExecutionRunEvent,
  AgentRuntimeContext,
  AgentSessionOpenRequest,
  AgentSessionProviderBinding,
  AgentSessionRuntimeContext,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agent-runtime';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

import {
  createClaudeAgentRuntime,
  createClaudeNativeSessionOpener,
  createClaudeNativeRuntime,
  prepareClaudeQualifiedConnectedAccountLaunch,
  type ClaudeNativeSessionOperations,
  type ClaudeNativeSessionFactory,
} from './nativeRuntime.js';
import type { ClaudeUsageObservation } from '../usage/types.js';
import type { ClaudeProviderEvent } from './providerEvents.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createNativeOperations(sessionId: string): Readonly<{
  runtime: ClaudeNativeSessionOperations;
  publish(event: ClaudeProviderEvent): void;
  publishEffectiveModel(evidence: Readonly<{
    modelId: string;
    displayName?: string;
    contextWindowTokens?: number;
  }>): void;
  publishUsage(observation: ClaudeUsageObservation): void;
}> {
  const listeners = new Set<(event: ClaudeProviderEvent) => void>();
  const canonicalListeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
  const effectiveModelListeners = new Set<(evidence: Readonly<{
    modelId: string;
    displayName?: string;
    contextWindowTokens?: number;
  }>) => void>();
  const usageListeners = new Set<(observation: ClaudeUsageObservation) => void>();
  return {
    publish(event) {
      for (const listener of listeners) listener(event);
    },
    publishEffectiveModel(evidence) {
      for (const listener of effectiveModelListeners) listener(evidence);
    },
    publishUsage(observation) {
      for (const listener of usageListeners) listener(observation);
    },
    runtime: {
      subscribeEffectiveModel(listener) {
        effectiveModelListeners.add(listener);
        return () => effectiveModelListeners.delete(listener);
      },
      subscribeUsageObservation(listener) {
        usageListeners.add(listener);
        return () => usageListeners.delete(listener);
      },
      subscribeCanonicalAgentSessionEvents(listener) {
        canonicalListeners.add(listener);
        listener({
          kind: 'runtime-activity-snapshot',
          sessionId,
          emittedAtMs: 1,
          sequence: 1,
          state: 'idle',
          activeCount: 0,
        });
        return () => canonicalListeners.delete(listener);
      },
      subscribeProviderEvents(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      beginProviderTurn() {},
      async startProviderSession() {
        return 'claude-provider-session';
      },
      async sendProviderTurnPrompt() {
        for (const listener of listeners) {
          listener({
            kind: 'message-delta',
            sessionId,
            turnId: 'turn-1',
            emittedAtMs: 2,
            delta: { text: 'provider output' },
          });
        }
        for (const listener of canonicalListeners) {
          listener({
            kind: 'runtime-activity-snapshot',
            sessionId,
            emittedAtMs: 3,
            sequence: 1,
            state: 'active',
            activeCount: 2,
          });
        }
        return { kind: 'accepted' };
      },
      async steerProviderTurn() {
        return { kind: 'accepted' };
      },
      async waitForProviderTurnCompletion() {},
      async respondToProviderPermission() { return { status: 'applied' }; },
      async cancelProviderTurn() {},
      readProviderIdentity: () => ({ sessionId: 'claude-provider-session' }),
      async updateProviderConfiguration() {
        return { status: 'applied' };
      },
      async disposeProviderSession() {},
    },
  };
}

const context = {
  session: {
    services: {
      activeInput: {
        bind: () => ({ dispose() {} }),
      },
    },
  },
} as unknown as AgentRuntimeContext;

describe('createClaudeNativeRuntime', () => {
  it('does not wait for initial qualified-purpose observations after caller cancellation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    const dispose = vi.fn();

    await expect(prepareClaudeQualifiedConnectedAccountLaunch({
      request: { cwd: '/repo' },
      context: {
        signal: controller.signal,
        services: {
          connectedAccounts: {
            getBinding: vi.fn(),
            materialize: vi.fn(),
            requestSelection: vi.fn(),
            watch: vi.fn(() => ({ dispose })),
          },
        },
      } as unknown as AgentRuntimeContext,
    })).rejects.toThrow('caller cancelled');
    expect(dispose).toHaveBeenCalledTimes(2);
  }, 1_000);

  it('materializes the qualified Claude Subscription before create/resume and fences changes', async () => {
    const openSession = vi.fn<ClaudeNativeSessionFactory>(
      ({ request }) => createNativeOperations(request.sessionId).runtime,
    );
    const listeners = new Map<string, (event: { kind: 'resync' }) => unknown>();
    const disposeWatch = vi.fn();
    const connectedAccounts = {
      getBinding: vi.fn(async (purpose: string) => ({
        purpose,
        service: purpose === 'model_upstream'
          ? { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }
          : { pluginId: 'happier.agent.claude', localId: 'anthropic' },
        target: { kind: 'account' as const, displayName: 'Claude account' },
      })),
      materialize: vi.fn(async (purpose: string, request: { kind: string }) => {
        if (purpose !== 'model_upstream') throw new Error('Anthropic fallback must not materialize');
        return request.kind === 'environment'
          ? { kind: 'environment' as const, env: {} }
          : {
              kind: 'files' as const,
              files: {
                '.credentials.json': new TextEncoder().encode(JSON.stringify({
                  claudeAiOauth: { accessToken: 'setup-token', scopes: ['user:inference'] },
                })),
              },
            };
      }),
      requestSelection: vi.fn(),
      watch: vi.fn((purpose: string, listener: (event: { kind: 'resync' }) => unknown) => {
        listeners.set(purpose, listener);
        queueMicrotask(() => { void listener({ kind: 'resync' }); });
        return { dispose: disposeWatch };
      }),
    };
    const sessionContext = {
      signal: new AbortController().signal,
      services: { connectedAccounts },
      session: { services: { activeInput: { bind: () => ({ dispose() {} }) } } },
    } as unknown as AgentSessionRuntimeContext;
    const runtime = createClaudeNativeRuntime({
      openSession,
      prepareLaunchEnvironment: prepareClaudeQualifiedConnectedAccountLaunch,
    });

    const session = await runtime.sessions.open({
      kind: 'resume',
      sessionId: 'qualified-subscription',
      providerSessionId: 'claude-provider-session',
      cwd: '/repo',
      launchEnvironment: {
        values: { ANTHROPIC_API_KEY: 'legacy-key', KEEP: 'yes' },
        unset: [],
      },
    }, sessionContext);

    expect(connectedAccounts.getBinding).toHaveBeenCalledWith(
      'model_upstream',
      expect.objectContaining({ signal: sessionContext.signal }),
    );
    expect(connectedAccounts.getBinding).not.toHaveBeenCalledWith(
      'model_upstream_api_key',
      expect.anything(),
    );
    expect(connectedAccounts.materialize).toHaveBeenNthCalledWith(
      1,
      'model_upstream',
      { kind: 'files', fileIds: ['.credentials.json'] },
      expect.objectContaining({ signal: sessionContext.signal }),
    );
    expect(connectedAccounts.materialize).toHaveBeenCalledTimes(1);
    expect(openSession.mock.calls[0]?.[0].request.launchEnvironment?.values).toMatchObject({
      KEEP: 'yes',
      CLAUDE_CONFIG_DIR: expect.any(String),
    });
    expect(openSession.mock.calls[0]?.[0].request.launchEnvironment?.values)
      .not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(openSession.mock.calls[0]?.[0].request.launchEnvironment?.values)
      .not.toHaveProperty('ANTHROPIC_API_KEY');

    expect(disposeWatch).not.toHaveBeenCalled();
    await listeners.get('model_upstream')?.({ kind: 'resync' });
    await vi.waitFor(() => expect(disposeWatch).toHaveBeenCalledTimes(2));
    await session.dispose();
  });

  it('writes qualified Claude OAuth material for create and removes it on dispose', async () => {
    const openSession = vi.fn<ClaudeNativeSessionFactory>(
      ({ request }) => createNativeOperations(request.sessionId).runtime,
    );
    const credentialBytes = new TextEncoder().encode(JSON.stringify({
      claudeAiOauth: { accessToken: 'oauth-access', scopes: ['user:inference'] },
    }));
    const connectedAccounts = {
      getBinding: vi.fn(async (purpose: string) => purpose === 'model_upstream'
        ? {
            purpose,
            service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
            target: { kind: 'account' as const, displayName: 'Claude OAuth' },
          }
        : null),
      materialize: vi.fn(async (_purpose: string, request: { kind: string }) => (
        request.kind === 'environment'
          ? { kind: 'environment' as const, env: {} }
          : { kind: 'files' as const, files: { '.credentials.json': credentialBytes } }
      )),
      requestSelection: vi.fn(),
      watch: vi.fn((_purpose: string, listener: (event: { kind: 'resync' }) => unknown) => {
        queueMicrotask(() => { void listener({ kind: 'resync' }); });
        return { dispose() {} };
      }),
    };
    const sessionContext = {
      signal: new AbortController().signal,
      services: { connectedAccounts },
      session: { services: { activeInput: { bind: () => ({ dispose() {} }) } } },
    } as unknown as AgentSessionRuntimeContext;
    const runtime = createClaudeNativeRuntime({
      openSession,
      prepareLaunchEnvironment: prepareClaudeQualifiedConnectedAccountLaunch,
    });

    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'qualified-oauth',
      cwd: '/repo',
    }, sessionContext);
    const configDir = openSession.mock.calls[0]?.[0].request.launchEnvironment?.values.CLAUDE_CONFIG_DIR;
    if (!configDir) throw new Error('Expected a qualified Claude config directory');
    expect(await readFile(`${configDir}/.credentials.json`, 'utf8')).toBe(
      new TextDecoder().decode(credentialBytes),
    );
    expect((await stat(`${configDir}/.credentials.json`)).mode & 0o777).toBe(0o600);

    await session.dispose();
    await expect(stat(configDir)).rejects.toThrow();
  });

  it('uses qualified Anthropic only when Claude Subscription is unbound and preserves native auth otherwise', async () => {
    const openSession = vi.fn<ClaudeNativeSessionFactory>(
      ({ request }) => createNativeOperations(request.sessionId).runtime,
    );
    let bindAnthropic = true;
    const connectedAccounts = {
      getBinding: vi.fn(async (purpose: string) => {
        if (purpose === 'model_upstream') return null;
        return bindAnthropic
          ? {
              purpose,
              service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
              target: { kind: 'account' as const, displayName: 'Anthropic API key' },
            }
          : null;
      }),
      materialize: vi.fn(async () => ({
        kind: 'environment' as const,
        env: { ANTHROPIC_API_KEY: 'qualified-anthropic-key' },
      })),
      requestSelection: vi.fn(),
      watch: vi.fn((_purpose: string, listener: (event: { kind: 'resync' }) => unknown) => {
        queueMicrotask(() => { void listener({ kind: 'resync' }); });
        return { dispose() {} };
      }),
    };
    const sessionContext = {
      signal: new AbortController().signal,
      services: { connectedAccounts },
      session: { services: { activeInput: { bind: () => ({ dispose() {} }) } } },
    } as unknown as AgentSessionRuntimeContext;
    const runtime = createClaudeNativeRuntime({
      openSession,
      prepareLaunchEnvironment: prepareClaudeQualifiedConnectedAccountLaunch,
    });

    const anthropicSession = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'qualified-anthropic',
      cwd: '/repo',
      launchEnvironment: { values: { CLAUDE_CODE_OAUTH_TOKEN: 'legacy-token' }, unset: [] },
    }, sessionContext);
    expect(openSession.mock.calls[0]?.[0].request.launchEnvironment?.values).toMatchObject({
      ANTHROPIC_API_KEY: 'qualified-anthropic-key',
      CLAUDE_CONFIG_DIR: expect.any(String),
    });
    expect(openSession.mock.calls[0]?.[0].request.launchEnvironment?.values)
      .not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    await anthropicSession.dispose();

    bindAnthropic = false;
    const nativeSession = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'native-auth',
      cwd: '/repo',
      launchEnvironment: { values: { ANTHROPIC_API_KEY: 'native-key' }, unset: [] },
    }, sessionContext);
    expect(openSession.mock.calls[1]?.[0].request.launchEnvironment?.values).toEqual({
      ANTHROPIC_API_KEY: 'native-key',
    });
    await nativeSession.dispose();
  });

  it('materializes qualified Anthropic before execution-run open', async () => {
    const operations = createNativeOperations('qualified-execution').runtime;
    const openExecutionSession = vi.fn(() => operations);
    const connectedAccounts = {
      getBinding: vi.fn(async (purpose: string) => purpose === 'model_upstream'
        ? null
        : {
            purpose,
            service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
            target: { kind: 'account' as const, displayName: 'Anthropic API key' },
          }),
      materialize: vi.fn(async () => ({
        kind: 'environment' as const,
        env: { ANTHROPIC_API_KEY: 'execution-key' },
      })),
      requestSelection: vi.fn(),
      watch: vi.fn((_purpose: string, listener: (event: { kind: 'resync' }) => unknown) => {
        queueMicrotask(() => { void listener({ kind: 'resync' }); });
        return { dispose() {} };
      }),
    };
    const runtime = createClaudeNativeRuntime({
      openSession: vi.fn(),
      openExecutionSession,
      prepareLaunchEnvironment: prepareClaudeQualifiedConnectedAccountLaunch,
    });

    const run = await runtime.executionRuns?.open({
      kind: 'create',
      runId: 'qualified-execution',
      cwd: '/repo',
      input: { text: 'hello' },
    }, {
      signal: new AbortController().signal,
      services: { connectedAccounts },
    } as unknown as AgentRuntimeContext);

    expect(openExecutionSession.mock.calls[0]?.[0].request.launchEnvironment?.values).toMatchObject({
      ANTHROPIC_API_KEY: 'execution-key',
      CLAUDE_CONFIG_DIR: expect.any(String),
    });
    await run?.dispose();
  });

  it('opens the selected Unified Terminal implementation through the production native factory', async () => {
    const settingsGet = vi.fn(async (key: string) => key === 'claudeUnifiedTerminalEnabled');
    const terminalHost = {
      resolve: vi.fn(),
      createOrAttachHost: vi.fn(),
    };
    const sessionContext = {
      signal: new AbortController().signal,
      services: {
        settings: { get: settingsGet },
        storage: { session: { get: vi.fn(), set: vi.fn() } },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        exec: {},
        connectedAccounts: {
          getBinding: vi.fn(async () => null),
          materialize: vi.fn(),
          requestSelection: vi.fn(),
          watch: vi.fn((_purpose: string, listener: (event: { kind: 'resync' }) => unknown) => {
            queueMicrotask(() => { void listener({ kind: 'resync' }); });
            return { dispose() {} };
          }),
        },
      },
      ui: { askQuestions: vi.fn(), confirm: vi.fn() },
      session: {
        services: {
          features: { isEnabled: vi.fn(() => true) },
          terminalHost,
          activeInput: { bind: () => ({ dispose() {} }), publishStatus: vi.fn() },
          models: { bind: () => ({ dispose() {} }) },
          sessionHooks: {},
          transcripts: { fileFollow: {} },
          accountUsage: {},
          auth: {},
          systemRecords: {},
          workflowActivity: {},
        },
      },
      workState: {
        publisher: () => ({ publish: vi.fn(async () => undefined) }),
      },
    } as unknown as AgentSessionRuntimeContext;
    const runtime = createClaudeAgentRuntime({} as never);

    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'session-production-unified',
      cwd: '/repo',
    }, sessionContext);

    expect(settingsGet).toHaveBeenCalledWith('claudeUnifiedTerminalEnabled');
    expect(settingsGet).toHaveBeenCalledWith('claudeUnifiedTerminalHost');
    expect(terminalHost.resolve).not.toHaveBeenCalled();
    expect(terminalHost.createOrAttachHost).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('selects the Claude Unified Terminal opener only when both the feature and provider setting are enabled', async () => {
    const sdkOperations = createNativeOperations('session-sdk').runtime;
    const unifiedOperations = createNativeOperations('session-unified').runtime;
    const openAgentSdkSession = vi.fn<ClaudeNativeSessionFactory>(() => sdkOperations);
    const openUnifiedTerminalSession = vi.fn<ClaudeNativeSessionFactory>(() => unifiedOperations);
    const openSession = createClaudeNativeSessionOpener({
      openAgentSdkSession,
      openUnifiedTerminalSession,
    });
    const settingsGet = vi.fn(async () => true);
    const sessionContext = {
      services: {
        settings: { get: settingsGet },
      },
      session: {
        services: {
          features: { isEnabled: vi.fn(() => true) },
          activeInput: { bind: () => ({ dispose() {} }) },
        },
      },
    } as unknown as AgentSessionRuntimeContext;
    const runtime = createClaudeNativeRuntime({ openSession });

    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'session-unified',
      cwd: '/repo',
    }, sessionContext);

    expect(sessionContext.session.services.features.isEnabled).toHaveBeenCalledWith(
      'agents.claude.unifiedTerminal',
    );
    expect(settingsGet).toHaveBeenCalledWith('claudeUnifiedTerminalEnabled');
    expect(openUnifiedTerminalSession).toHaveBeenCalledTimes(1);
    expect(openAgentSdkSession).not.toHaveBeenCalled();
    await session.dispose();
  });

  it.each([
    { featureEnabled: false, setting: true, settingUnavailable: false, label: 'feature disabled' },
    { featureEnabled: true, setting: false, settingUnavailable: false, label: 'setting disabled' },
    { featureEnabled: true, setting: null, settingUnavailable: false, label: 'setting missing' },
    { featureEnabled: true, setting: 'true', settingUnavailable: false, label: 'setting malformed' },
    { featureEnabled: true, setting: true, settingUnavailable: true, label: 'setting unavailable' },
  ])('fails closed to the Agent SDK opener when $label', async ({ featureEnabled, setting, settingUnavailable }) => {
    const openAgentSdkSession = vi.fn<ClaudeNativeSessionFactory>(
      ({ request }) => createNativeOperations(request.sessionId).runtime,
    );
    const openUnifiedTerminalSession = vi.fn<ClaudeNativeSessionFactory>(
      ({ request }) => createNativeOperations(request.sessionId).runtime,
    );
    const settingsGet = vi.fn(async () => {
      if (settingUnavailable) throw new Error('settings unavailable');
      return setting;
    });
    const sessionContext = {
      services: { settings: { get: settingsGet } },
      session: {
        services: {
          features: { isEnabled: vi.fn(() => featureEnabled) },
          activeInput: { bind: () => ({ dispose() {} }) },
        },
      },
    } as unknown as AgentSessionRuntimeContext;
    const runtime = createClaudeNativeRuntime({
      openSession: createClaudeNativeSessionOpener({
        openAgentSdkSession,
        openUnifiedTerminalSession,
      }),
    });

    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: `session-${String(setting)}`,
      cwd: '/repo',
    }, sessionContext);

    expect(openAgentSdkSession).toHaveBeenCalledTimes(1);
    expect(openUnifiedTerminalSession).not.toHaveBeenCalled();
    if (featureEnabled) {
      expect(settingsGet).toHaveBeenCalledWith('claudeUnifiedTerminalEnabled');
    } else {
      expect(settingsGet).not.toHaveBeenCalled();
    }
    await session.dispose();
  });

  it('does not silently fall back after the Unified Terminal opener is selected', async () => {
    const openAgentSdkSession = vi.fn<ClaudeNativeSessionFactory>(
      ({ request }) => createNativeOperations(request.sessionId).runtime,
    );
    const openUnifiedTerminalSession = vi.fn<ClaudeNativeSessionFactory>(async () => {
      throw new Error('terminal host unavailable');
    });
    const sessionContext = {
      services: { settings: { get: vi.fn(async () => true) } },
      session: {
        services: {
          features: { isEnabled: vi.fn(() => true) },
          activeInput: { bind: () => ({ dispose() {} }) },
        },
      },
    } as unknown as AgentSessionRuntimeContext;
    const runtime = createClaudeNativeRuntime({
      openSession: createClaudeNativeSessionOpener({
        openAgentSdkSession,
        openUnifiedTerminalSession,
      }),
    });

    await expect(runtime.sessions.open({
      kind: 'create',
      sessionId: 'session-open-failure',
      cwd: '/repo',
    }, sessionContext)).rejects.toThrow('terminal host unavailable');
    expect(openAgentSdkSession).not.toHaveBeenCalled();
  });

  it('maps the existing Claude provider session into canonical native custody and runtime events', async () => {
    const native = createNativeOperations('session-1');
    const openSession = vi.fn<ClaudeNativeSessionFactory>(() => native.runtime);
    const runtime = createClaudeNativeRuntime({ openSession });
    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'session-1',
      cwd: '/repo',
    }, context);
    const events: AgentSessionRuntimeEvent[] = [];
    session.watch((event) => events.push(event));

    await expect(session.send({
      inputIds: ['input-1'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    })).resolves.toEqual({ status: 'admitted' });

    expect(openSession).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ sessionId: 'session-1' }),
    }));
    expect(events.map((event) => event.kind)).toEqual([
      'provider-session-id',
      'runtime-activity-snapshot',
      'input-accepted',
      'message-delta',
      'runtime-activity-snapshot',
    ]);
    expect(events[1]).toMatchObject({
      kind: 'runtime-activity-snapshot',
      state: 'idle',
      activeCount: 0,
    });
    expect(events[2]).toMatchObject({
      kind: 'input-accepted',
      inputIds: ['input-1'],
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    });
    expect(events[3]).toMatchObject({
      kind: 'message-delta',
      sessionId: 'session-1',
      turnId: 'turn-1',
      channel: 'assistant',
      text: 'provider output',
    });
    expect(events[4]).toMatchObject({
      kind: 'runtime-activity-snapshot',
      state: 'active',
      activeCount: 2,
    });
  });

  it('binds Claude active-input controls through the native session service and retires them with the session', async () => {
    const native = createNativeOperations('session-active-input');
    const clearTerminalComposer = vi.fn(async () => ({ ok: true as const, status: 'cleared' as const }));
    const disposeBinding = vi.fn();
    const bind = vi.fn(() => ({ dispose: disposeBinding }));
    const sessionContext = {
      session: {
        services: {
          activeInput: { bind, publishStatus: vi.fn() },
        },
      },
    } as unknown as AgentSessionRuntimeContext;
    const runtime = createClaudeNativeRuntime({
      openSession: () => ({
        ...native.runtime,
        isTurnInFlight: () => true,
        canSteerPrompt: () => true,
        notifyPromptQueuedDuringTurn: vi.fn(),
        applyConfigDeltaInFlight: vi.fn(async () => ({ status: 'applied' as const })),
        clearTerminalComposer,
      }),
    });

    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'session-active-input',
      cwd: '/repo',
    }, sessionContext);

    expect(bind).toHaveBeenCalledTimes(1);
    const binding = bind.mock.calls[0]?.[0];
    expect(binding?.isTurnInFlight()).toBe(true);
    expect(binding?.canSteer()).toBe(true);
    await expect(binding?.applyPermissionIntentDuringTurn('acceptEdits')).resolves.toEqual({ status: 'applied' });
    await expect(binding?.clearTerminalComposer({ expectedStateAtMs: 123 })).resolves.toEqual({
      ok: true,
      status: 'cleared',
    });
    expect(clearTerminalComposer).toHaveBeenCalledWith({
      sessionId: 'session-active-input',
      expectedStateAtMs: 123,
    });

    await session.dispose();
    expect(disposeBinding).toHaveBeenCalledTimes(1);
  });

  it('binds the native model source and publishes applied model configuration', async () => {
    const native = createNativeOperations('session-models');
    const modelListeners = new Set<(snapshot: { currentModelId?: string | null }) => void>();
    const disposeModels = vi.fn();
    const bindModels = vi.fn((source: {
      read(): { currentModelId?: string | null };
      subscribe(listener: (snapshot: { currentModelId?: string | null }) => void): { dispose(): void };
    }) => {
      source.subscribe((snapshot) => {
        for (const listener of modelListeners) listener(snapshot);
      });
      return { dispose: disposeModels };
    });
    const sessionContext = {
      session: {
        services: {
          activeInput: { bind: () => ({ dispose() {} }), publishStatus: vi.fn() },
          models: { bind: bindModels },
        },
      },
    } as unknown as AgentSessionRuntimeContext;
    const runtime = createClaudeNativeRuntime({ openSession: () => native.runtime });
    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'session-models',
      cwd: '/repo',
      configuration: {
        mode: { value: null, updatedAtMs: 1 },
        model: { value: 'claude-sonnet-4-6', updatedAtMs: 1 },
        permissionIntent: { value: 'default', updatedAtMs: 1 },
        options: {},
      },
    }, sessionContext);

    expect(bindModels).toHaveBeenCalledTimes(1);
    const source = bindModels.mock.calls[0]?.[0];
    expect(source?.read()).toMatchObject({ currentModelId: 'claude-sonnet-4-6' });
    const snapshots: Array<{ currentModelId?: string | null }> = [];
    const subscription = source?.subscribe((snapshot) => snapshots.push(snapshot));

    await expect(session.updateConfiguration?.({
      mode: { value: null, updatedAtMs: 2 },
      model: { value: 'claude-opus-4-8', updatedAtMs: 2 },
      permissionIntent: { value: 'default', updatedAtMs: 2 },
      options: {},
    })).resolves.toMatchObject({ status: 'applied' });
    expect(snapshots.at(-1)).toMatchObject({ currentModelId: 'claude-opus-4-8' });
    const configurationSnapshot = snapshots.at(-1) as Readonly<{
      currentModelId?: string | null;
      models?: readonly Readonly<{ id: string }>[];
    }>;

    native.publishEffectiveModel({
      modelId: 'claude-runtime-observed',
      displayName: 'Claude Runtime Observed',
      contextWindowTokens: 400_000,
    });
    expect(snapshots.at(-1)).toMatchObject({
      currentModelId: 'claude-runtime-observed',
      models: expect.arrayContaining([
        expect.objectContaining({
          id: 'claude-runtime-observed',
          name: 'Claude Runtime Observed',
          contextWindowTokens: 400_000,
        }),
      ]),
    });
    expect(configurationSnapshot.currentModelId).toBe('claude-opus-4-8');
    expect(configurationSnapshot.models?.some((model) => model.id === 'claude-runtime-observed')).toBe(false);

    await session.dispose();
    expect(disposeModels).toHaveBeenCalledTimes(1);
    const snapshotCountAfterDispose = snapshots.length;
    native.publishEffectiveModel({ modelId: 'claude-after-dispose' });
    expect(snapshots).toHaveLength(snapshotCountAfterDispose);
    subscription?.dispose();
  });

  it.each(['create', 'resume', 'fork'] as const)(
    'publishes only exact Provider model facts for a Provider-bound Claude %s session',
    async (kind) => {
      const native = createNativeOperations('session-provider-model');
      const bindModels = vi.fn((source: {
        read(): {
          currentModelId?: string | null;
          models?: readonly Readonly<{
            id: string;
            name: string;
            contextWindowTokens?: number;
            extendedContextModelId?: string;
          }>[];
        };
      }) => ({ dispose() {} }));
      const sessionContext = {
        session: {
          services: {
            activeInput: { bind: () => ({ dispose() {} }), publishStatus: vi.fn() },
            models: { bind: bindModels },
          },
        },
      } as unknown as AgentSessionRuntimeContext;
      const runtime = createClaudeNativeRuntime({ openSession: () => native.runtime });
      const baseRequest = {
        sessionId: 'session-provider-model',
        cwd: '/repo',
        configuration: {
          mode: { value: null, updatedAtMs: 1 },
          model: { value: 'deepseek-ai/DeepSeek-V3.1', updatedAtMs: 1 },
          permissionIntent: { value: 'default', updatedAtMs: 1 },
          options: {},
        },
        providerBinding: {
          connectionId: ProviderConnectionIdSchema.parse('pc_deepseek'),
          model: {
            id: 'deepseek-ai/DeepSeek-V3.1',
            name: 'DeepSeek V3.1',
            capabilities: {
              toolRoundTrips: 'supported',
              reasoningControls: 'unknown',
            },
          },
          materialization: { v: 1, kind: 'spawnEnv' },
        },
      };
      const request: AgentSessionOpenRequest = kind === 'resume'
        ? { ...baseRequest, kind, providerSessionId: 'provider-session-resume' }
        : kind === 'fork'
          ? {
              ...baseRequest,
              kind,
              source: {
                sessionId: 'source-session',
                providerSessionId: 'provider-session-source',
                cwd: '/source-repo',
              },
            }
          : { ...baseRequest, kind };
      const session = await runtime.sessions.open(request, sessionContext);

      const source = bindModels.mock.calls[0]?.[0];
      expect(source?.read()).toEqual({
        currentModelId: 'deepseek-ai/DeepSeek-V3.1',
        models: [{
          id: 'deepseek-ai/DeepSeek-V3.1',
          name: 'DeepSeek V3.1',
          capabilities: {
            toolRoundTrips: 'supported',
            reasoningControls: 'unknown',
          },
        }],
      });
      expect(source?.read().models?.[0]).not.toHaveProperty('extendedContextModelId');
      expect(source?.read().models?.[0]).not.toHaveProperty('contextWindowTokens');

      await session.dispose();
    },
  );

  it('forwards only explicitly supported Provider reasoning values', async () => {
    const native = createNativeOperations('session-provider-reasoning');
    const updateProviderConfiguration = vi.fn(async () => ({ status: 'applied' as const }));
    const runtime = createClaudeNativeRuntime({
      openSession: () => ({ ...native.runtime, updateProviderConfiguration }),
    });
    const providerBinding = {
      connectionId: ProviderConnectionIdSchema.parse('pc_deepseek'),
      model: {
        id: 'deepseek-ai/DeepSeek-V3.1',
        name: 'DeepSeek V3.1',
        capabilities: { reasoningControls: 'supported' as const },
        modelOptions: [{
          id: 'reasoning_effort',
          name: 'Reasoning',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        }],
      },
      materialization: { v: 1 as const, kind: 'spawnEnv' as const },
    };
    const baseConfiguration = {
      mode: { value: null, updatedAtMs: 1 },
      model: { value: providerBinding.model.id, updatedAtMs: 1 },
      permissionIntent: { value: 'default' as const, updatedAtMs: 1 },
      options: {},
    };
    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'session-provider-reasoning',
      cwd: '/repo',
      configuration: baseConfiguration,
      providerBinding,
    }, context as unknown as AgentSessionRuntimeContext);

    await expect(session.updateConfiguration?.({
      ...baseConfiguration,
      options: {
        reasoning_effort: { value: 'high', updatedAtMs: 2 },
      },
    })).resolves.toMatchObject({ status: 'applied' });
    expect(updateProviderConfiguration).toHaveBeenLastCalledWith(expect.objectContaining({
      configOption: { id: 'reasoning_effort', value: 'high' },
    }));

    updateProviderConfiguration.mockClear();
    await expect(session.updateConfiguration?.({
      ...baseConfiguration,
      options: {
        reasoning_effort: { value: 'xhigh', updatedAtMs: 3 },
      },
    })).resolves.toMatchObject({ status: 'unsupported' });
    expect(updateProviderConfiguration).not.toHaveBeenCalled();

    await session.dispose();
  });

  it('commits exact Provider model facts only after the live runtime applies the authorized binding', async () => {
    const native = createNativeOperations('session-provider-switch');
    const updateProviderConfiguration = vi.fn()
      .mockResolvedValueOnce({ status: 'applied' as const })
      .mockResolvedValueOnce({ status: 'applied' as const, timing: 'next_idle' as const })
      .mockResolvedValueOnce({ status: 'requires_restart' as const });
    let modelSource: {
      read(): Readonly<{
        currentModelId?: string | null;
        models?: readonly Readonly<{ id: string; name: string; contextWindowTokens?: number }>[];
      }>;
    } | null = null;
    const sessionContext = {
      session: {
        services: {
          activeInput: { bind: () => ({ dispose() {} }), publishStatus: vi.fn() },
          models: {
            bind(source: NonNullable<typeof modelSource>) {
              modelSource = source;
              return { dispose() {} };
            },
          },
        },
      },
    } as unknown as AgentSessionRuntimeContext;
    const currentBinding = {
      connectionId: ProviderConnectionIdSchema.parse('pc_deepseek'),
      model: {
        id: 'deepseek-ai/DeepSeek-V3.1',
        name: 'DeepSeek V3.1',
        contextWindowTokens: 128_000,
        capabilities: { reasoningControls: 'unknown' as const },
      },
      materialization: { v: 1 as const, kind: 'spawnEnv' as const },
    } satisfies AgentSessionProviderBinding;
    const nextBinding = {
      ...currentBinding,
      model: {
        id: 'deepseek-ai/DeepSeek-V3.2',
        name: 'DeepSeek V3.2',
        contextWindowTokens: 256_000,
        capabilities: { reasoningControls: 'supported' as const },
        modelOptions: [{
          id: 'reasoning_effort',
          name: 'Reasoning',
          type: 'select',
          currentValue: 'medium',
          options: [{ value: 'high', name: 'High' }],
        }],
      },
    } satisfies AgentSessionProviderBinding;
    const rejectedBinding = {
      ...currentBinding,
      model: {
        id: 'deepseek-ai/DeepSeek-V4',
        name: 'DeepSeek V4',
        contextWindowTokens: 512_000,
      },
    } satisfies AgentSessionProviderBinding;
    const deferredBinding = {
      ...currentBinding,
      model: {
        id: 'deepseek-ai/DeepSeek-V3.3',
        name: 'DeepSeek V3.3',
        contextWindowTokens: 384_000,
      },
    } satisfies AgentSessionProviderBinding;
    const baseConfiguration = {
      mode: { value: null, updatedAtMs: 1 },
      model: { value: currentBinding.model.id, updatedAtMs: 1 },
      permissionIntent: { value: 'default' as const, updatedAtMs: 1 },
      options: {},
    };
    const runtime = createClaudeNativeRuntime({
      openSession: () => ({ ...native.runtime, updateProviderConfiguration }),
    });
    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'session-provider-switch',
      cwd: '/repo',
      configuration: baseConfiguration,
      providerBinding: currentBinding,
    }, sessionContext);

    await expect(session.updateConfiguration?.({
      ...baseConfiguration,
      model: { value: nextBinding.model.id, updatedAtMs: 2 },
      options: {
        reasoning_effort: { value: 'high', updatedAtMs: 2 },
      },
      providerBinding: nextBinding,
    })).resolves.toMatchObject({ status: 'applied' });
    expect(updateProviderConfiguration).toHaveBeenLastCalledWith(expect.objectContaining({
      modelId: nextBinding.model.id,
      providerBinding: nextBinding,
      configOption: { id: 'reasoning_effort', value: 'high' },
    }));
    expect(modelSource?.read()).toEqual({
      currentModelId: nextBinding.model.id,
      models: [nextBinding.model],
    });

    await expect(session.updateConfiguration?.({
      ...baseConfiguration,
      model: { value: 'deepseek-ai/DeepSeek-V3.3', updatedAtMs: 3 },
    })).resolves.toMatchObject({ status: 'rejected' });
    expect(updateProviderConfiguration).toHaveBeenCalledTimes(1);
    expect(modelSource?.read()).toEqual({
      currentModelId: nextBinding.model.id,
      models: [nextBinding.model],
    });

    await expect(session.updateConfiguration?.({
      ...baseConfiguration,
      model: { value: deferredBinding.model.id, updatedAtMs: 4 },
      providerBinding: deferredBinding,
    })).resolves.toMatchObject({ status: 'rejected' });
    expect(modelSource?.read()).toEqual({
      currentModelId: nextBinding.model.id,
      models: [nextBinding.model],
    });

    await expect(session.updateConfiguration?.({
      ...baseConfiguration,
      model: { value: rejectedBinding.model.id, updatedAtMs: 5 },
      providerBinding: rejectedBinding,
    })).resolves.toMatchObject({ status: 'rejected' });
    expect(modelSource?.read()).toEqual({
      currentModelId: nextBinding.model.id,
      models: [nextBinding.model],
    });

    await session.dispose();
  });

  it('publishes leaf usage through the canonical AgentRuntime usage event', async () => {
    const native = createNativeOperations('session-provider-usage');
    const runtime = createClaudeNativeRuntime({ openSession: () => native.runtime });
    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'session-provider-usage',
      cwd: '/repo',
    }, context as unknown as AgentSessionRuntimeContext);
    const events: AgentSessionRuntimeEvent[] = [];
    session.watch((event) => events.push(event));

    native.publishUsage({
      provider: 'claude',
      source: 'claude-sdk-result',
      scope: 'session_final',
      key: 'claude-session',
      modelId: 'deepseek-ai/DeepSeek-V3.1',
      tokens: {
        input: 10,
        output: 5,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 15,
      },
      cost: null,
      contextUsedTokens: null,
      contextWindowTokens: null,
    });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'usage-observed',
        observationId: 'claude-usage-1',
        source: 'claude-sdk-result',
        scope: 'session_final',
        modelId: 'deepseek-ai/DeepSeek-V3.1',
        tokens: {
          input: 10,
          output: 5,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 15,
        },
      }),
    ]));

    await session.dispose();
  });

  it('routes declared active goal mutations to the live Claude operation and retires the binding on dispose', async () => {
    const native = createNativeOperations('session-goals');
    const setGoal = vi.fn(async () => undefined);
    const clearGoal = vi.fn(async () => undefined);
    const runtime = createClaudeNativeRuntime({
      openSession: () => ({
        ...native.runtime,
        setGoal,
        clearGoal,
      }),
    });
    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'session-goals',
      cwd: '/repo',
    }, context as unknown as AgentSessionRuntimeContext);
    const goalSource = {
      publish: vi.fn(async () => ({
        status: 'applied' as const,
        revision: 'goal-revision-1',
        sourceSequence: 1,
      })),
    };
    const controlContext = {
      session: {
        id: 'session-goals',
        cwd: '/repo',
        activity: 'active',
        connectedAccounts: [],
      },
      goalSource,
    } as never;

    await expect(runtime.sessions.goals?.set(
      { objective: 'Ship native Claude goals' },
      controlContext,
    )).resolves.toMatchObject({ status: 'pending' });
    await expect(runtime.sessions.goals?.clear(controlContext)).resolves.toMatchObject({
      status: 'pending',
    });
    expect(setGoal).toHaveBeenCalledWith('Ship native Claude goals', undefined);
    expect(clearGoal).toHaveBeenCalledTimes(1);

    await session.dispose();
    await expect(runtime.sessions.goals?.set(
      { objective: 'Must not reach a retired runtime' },
      controlContext,
    )).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'claude_goal_live_session_unavailable' },
    });
  });

  it('publishes declared inactive goal mutations through the canonical goal work-state source', async () => {
    const runtime = createClaudeNativeRuntime({
      openSession: ({ request }) => createNativeOperations(request.sessionId).runtime,
    });
    const publish = vi.fn(async () => ({
      status: 'applied' as const,
      revision: 'goal-revision-inactive',
      sourceSequence: 1,
    }));
    const controlContext = {
      session: {
        id: 'session-goals-inactive',
        cwd: '/repo',
        activity: 'inactive',
        connectedAccounts: [],
      },
      goalSource: { publish },
    } as never;

    await expect(runtime.sessions.goals?.set(
      { objective: 'Resume with this goal' },
      controlContext,
    )).resolves.toEqual({
      status: 'applied',
      revision: 'goal-revision-inactive',
    });
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
      items: [expect.objectContaining({
        kind: 'goal',
        localId: 'goal:claude',
        status: 'active',
        title: 'Resume with this goal',
      })],
      primaryLocalId: 'goal:claude',
    }), expect.anything());

    await expect(runtime.sessions.goals?.clear(controlContext)).resolves.toEqual({
      status: 'applied',
      revision: 'goal-revision-inactive',
    });
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
      items: [],
      primaryLocalId: null,
    }), expect.anything());
  });

  it('declares a host-owned terminal launch plan without launching a process in the plugin', async () => {
    const runtime = createClaudeNativeRuntime({
      openSession: ({ request }) => createNativeOperations(request.sessionId).runtime,
    });

    await expect(Promise.resolve(runtime.surfaces?.terminal?.resolveLaunch({
      sessionId: 'session-1',
      cwd: '/repo',
      metadata: {
        claudeArgs: ['--model', 'stale', '--permission-mode=acceptEdits', 'prompt'],
        model: 'claude-opus-4-8',
      },
    }))).resolves.toEqual({
      argv: [
        '--model',
        'claude-opus-4-8',
        'prompt',
        '--permission-mode',
        'acceptEdits',
      ],
      process: { stdio: 'inherit', windowsHide: true },
      presentation: {
        onLaunch: { target: 'local', reason: 'claude_terminal_runtime_launcher_start' },
        onExit: { target: 'remote', reason: 'claude_terminal_runtime_launcher_exit' },
      },
    });
  });

  it('publishes input rejection when Claude proves spawn failed before prompt transport', async () => {
    const native = createNativeOperations('session-rejected');
    const runtime = createClaudeNativeRuntime({
      openSession: () => ({
        ...native.runtime,
        async sendProviderTurnPrompt() {
          return {
            kind: 'rejected_before_effect',
            reason: 'Claude process spawn failed before prompt transport.',
          };
        },
      }),
    });
    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'session-rejected',
      cwd: '/repo',
    }, context);
    const events: AgentSessionRuntimeEvent[] = [];
    session.watch((event) => events.push(event));

    await expect(session.send({
      inputIds: ['input-rejected'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-rejected' },
    })).resolves.toMatchObject({ status: 'rejected' });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'input-rejected',
      inputIds: ['input-rejected'],
    }));
  });

  it('does not synthesize provider acceptance from a turn failure before prompt transport', async () => {
    const native = createNativeOperations('session-provider-evidence');
    const runtime = createClaudeNativeRuntime({
      openSession: () => ({
        ...native.runtime,
        async sendProviderTurnPrompt() {
          native.publish({
            kind: 'turn-failed',
            sessionId: 'session-provider-evidence',
            turnId: 'turn-provider-evidence',
            emittedAtMs: 10,
            issue: {
              code: 'claude_failed_before_transport',
              source: 'provider_error',
              agentId: 'claude',
              sanitizedPreview: 'Claude failed before prompt transport.',
            },
          });
          return {
            kind: 'rejected_before_effect',
            reason: 'Claude failed before prompt transport.',
          };
        },
      }),
    });
    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'session-provider-evidence',
      cwd: '/repo',
    }, context);
    const events: AgentSessionRuntimeEvent[] = [];
    session.watch((event) => events.push(event));

    await expect(session.send({
      inputIds: ['input-provider-evidence'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-provider-evidence' },
    })).resolves.toMatchObject({ status: 'rejected' });
    expect(events.some((event) => event.kind === 'input-accepted')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'input-rejected',
      inputIds: ['input-provider-evidence'],
    }));

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'turn-failed',
      turnId: 'turn-provider-evidence',
    }));
  });

  it('waits for exact prompt transport before accepting and publishes acceptance before buffered output', async () => {
    const native = createNativeOperations('session-exact-transport');
    const transport = deferred<Readonly<{ kind: 'accepted' }>>();
    const runtime = createClaudeNativeRuntime({
      openSession: () => ({
        ...native.runtime,
        async sendProviderTurnPrompt() {
          return await transport.promise;
        },
      }),
    });
    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'session-exact-transport',
      cwd: '/repo',
    }, context);
    const events: AgentSessionRuntimeEvent[] = [];
    session.watch((event) => events.push(event));

    const send = session.send({
      inputIds: ['input-exact-transport'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-exact-transport' },
    });
    native.publish({
      kind: 'turn-failed',
      sessionId: 'session-exact-transport',
      turnId: 'turn-exact-transport',
      emittedAtMs: 10,
      issue: {
        code: 'claude_failed_while_transport_blocked',
        source: 'provider_error',
        agentId: 'claude',
        sanitizedPreview: 'Claude failed while transport was blocked.',
      },
    });
    await Promise.resolve();
    expect(events.some((event) => event.kind === 'input-accepted')).toBe(false);

    transport.resolve({ kind: 'accepted' });
    await expect(send).resolves.toEqual({ status: 'admitted' });
    const decisiveKinds = events
      .map((event) => event.kind)
      .filter((kind) => kind === 'input-accepted' || kind === 'turn-failed');
    expect(decisiveKinds).toEqual(['input-accepted', 'turn-failed']);
  });

  it('keeps exact transport acceptance monotonic across a later turn failure', async () => {
    const native = createNativeOperations('session-accepted-then-failed');
    const runtime = createClaudeNativeRuntime({ openSession: () => native.runtime });
    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'session-accepted-then-failed',
      cwd: '/repo',
    }, context);
    const events: AgentSessionRuntimeEvent[] = [];
    session.watch((event) => events.push(event));

    await expect(session.send({
      inputIds: ['input-accepted-then-failed'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-accepted-then-failed' },
    })).resolves.toEqual({ status: 'admitted' });
    native.publish({
      kind: 'turn-failed',
      sessionId: 'session-accepted-then-failed',
      turnId: 'turn-accepted-then-failed',
      emittedAtMs: 10,
      issue: {
        code: 'claude_failed_after_transport',
        source: 'provider_error',
        agentId: 'claude',
        sanitizedPreview: 'Claude failed after prompt transport.',
      },
    });

    expect(events.filter((event) => event.kind === 'input-accepted')).toHaveLength(1);
    expect(events.some((event) => (
      event.kind === 'input-rejected' || event.kind === 'input-custody-unknown'
    ))).toBe(false);
  });

  it('preserves Unified terminal acceptance through its exact provider callback', async () => {
    const native = createNativeOperations('session-unified-provider-acceptance');
    let publishProviderAcceptance:
      ((info: Readonly<{ localIds?: readonly string[] }>) => void) | null = null;
    const runtime = createClaudeNativeRuntime({
      openSession: () => ({
        ...native.runtime,
        promptCustody: 'unified_terminal' as const,
        async sendProviderTurnPrompt() {
          return { kind: 'custody_observed' as const };
        },
        setOnPromptAcceptedByProvider(handler) {
          publishProviderAcceptance = handler;
        },
        setOnPromptTerminallyRejectedBeforeProvider() {},
        setOnPromptDeliveryOutcome() {},
      }),
    });
    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'session-unified-provider-acceptance',
      cwd: '/repo',
    }, context);
    const events: AgentSessionRuntimeEvent[] = [];
    session.watch((event) => events.push(event));

    await expect(session.send({
      inputIds: ['input-unified-provider-acceptance'],
      input: { text: 'hello from terminal' },
      delivery: { kind: 'newTurn', turnId: 'turn-unified-provider-acceptance' },
    })).resolves.toEqual({ status: 'admitted' });
    expect(events.some((event) => event.kind === 'input-accepted')).toBe(false);

    publishProviderAcceptance?.({ localIds: ['input-unified-provider-acceptance'] });

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'input-accepted',
      inputIds: ['input-unified-provider-acceptance'],
    }));
  });

  it('projects a provider session identity published after native session startup', async () => {
    const native = createNativeOperations('session-late-provider-identity');
    const runtime = createClaudeNativeRuntime({ openSession: () => native.runtime });
    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'session-late-provider-identity',
      cwd: '/repo',
    }, context);
    const events: AgentSessionRuntimeEvent[] = [];
    session.watch((event) => events.push(event));

    native.publish({
      kind: 'session-id-publish',
      sessionId: 'session-late-provider-identity',
      emittedAtMs: 10,
      publishedSessionId: 'claude-provider-late',
      source: 'claude-native',
    });

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'provider-session-id',
      providerSessionId: 'claude-provider-late',
    }));
  });

  it('delivers declared follow-up input as the next Claude turn while preserving native custody', async () => {
    const native = createNativeOperations('session-follow-up');
    const send = vi.fn(native.runtime.sendProviderTurnPrompt);
    const runtime = createClaudeNativeRuntime({
      openSession: () => ({ ...native.runtime, sendProviderTurnPrompt: send }),
    });
    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'session-follow-up',
      cwd: '/repo',
    }, context);
    const events: AgentSessionRuntimeEvent[] = [];
    session.watch((event) => events.push(event));

    await expect(session.send({
      inputIds: ['input-follow-up'],
      input: { text: 'continue' },
      delivery: { kind: 'followUp', turnId: 'turn-2', afterTurnId: 'turn-1' },
    })).resolves.toEqual({ status: 'admitted' });

    expect(send).toHaveBeenCalledWith('continue', expect.objectContaining({
      localId: 'input-follow-up',
      localIds: ['input-follow-up'],
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'input-accepted',
      delivery: { kind: 'followUp', turnId: 'turn-2' },
    }));
  });

  it('publishes the Claude provider session identity as the declared execution-run checkpoint', async () => {
    const native = createNativeOperations('execution-run-checkpoint');
    const sendProviderTurnPrompt = vi.fn(async () => {
      native.publish({
        kind: 'session-id-publish',
        sessionId: 'execution-run-checkpoint',
        emittedAtMs: 10,
        publishedSessionId: 'claude-checkpoint-1',
        source: 'claude-native',
      });
      return { kind: 'accepted' } as const;
    });
    const runtime = createClaudeNativeRuntime({
      openSession: ({ request }) => createNativeOperations(request.sessionId).runtime,
      openExecutionSession: () => ({
        ...native.runtime,
        sendProviderTurnPrompt,
      }),
    });

    const run = await runtime.executionRuns?.open({
      kind: 'create',
      runId: 'execution-run-checkpoint',
      cwd: '/repo',
      profile: { pluginId: 'claude', contributionId: 'claude' },
      input: { text: 'run this' },
    }, context);
    const events: AgentExecutionRunEvent[] = [];
    run?.watch((event) => events.push(event));

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'checkpoint',
      checkpointId: 'claude-checkpoint-1',
    }));
    await run?.dispose();
  });

  it('uses the same exact transport outcome for execution-run input', async () => {
    const native = createNativeOperations('execution-run-transport-unknown');
    const transport = deferred<Readonly<{ kind: 'accepted' }>>();
    const runtime = createClaudeNativeRuntime({
      openSession: ({ request }) => createNativeOperations(request.sessionId).runtime,
      openExecutionSession: () => ({
        ...native.runtime,
        async sendProviderTurnPrompt() {
          return await transport.promise;
        },
      }),
    });
    const open = runtime.executionRuns?.open({
      kind: 'create',
      runId: 'execution-run-exact-transport',
      cwd: '/repo',
      profile: { pluginId: 'claude', contributionId: 'claude' },
      input: { text: 'run this' },
    }, context);
    let didOpen = false;
    void open?.then(() => {
      didOpen = true;
    });

    await Promise.resolve();
    expect(didOpen).toBe(false);
    transport.resolve({ kind: 'accepted' });
    const run = await open;
    expect(didOpen).toBe(true);
    await run?.dispose();
  });

  it('publishes unknown custody when Claude send throws after delivery may have begun', async () => {
    const native = createNativeOperations('session-unknown');
    const runtime = createClaudeNativeRuntime({
      openSession: () => ({
        ...native.runtime,
        async sendProviderTurnPrompt() {
          return {
            kind: 'effect_may_have_occurred',
            reason: 'transport disconnected after write attempt',
          };
        },
      }),
    });
    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'session-unknown',
      cwd: '/repo',
    }, context);
    const events: AgentSessionRuntimeEvent[] = [];
    session.watch((event) => events.push(event));

    await expect(session.send({
      inputIds: ['input-unknown'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-unknown' },
    })).resolves.toMatchObject({ status: 'unavailable', retryable: true });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'input-custody-unknown',
      inputIds: ['input-unknown'],
    }));
  });
});
