import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type {
  AgentAcpRuntimeOptions,
  AgentExecutionRunRuntime,
  AgentExecutionRunRuntimeContextV1,
  AgentSessionOpenRequest,
  AgentSessionConfigurationSnapshot,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES } from './agent/auth/services/accountPurposes.js';
import { AGENT_DEFINITION } from './agent/definition.js';
import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { claudeSubscriptionConnectedAccountRuntime } from '../../claude/src/connectedAccounts/claudeSubscriptionRuntime.js';

const privateHomes: string[] = [];
function privateHome() { const root = mkdtempSync(join(tmpdir(), 'n-omp-activation-')); privateHomes.push(root); return root; }
afterEach(() => { for (const root of privateHomes.splice(0)) rmSync(root, { recursive: true, force: true }); });

const explicitModelConfiguration = {
  model: { value: 'fixture-selected-model', updatedAtMs: 1 },
  mode: { value: null, updatedAtMs: 1 },
  permissionIntent: { value: null, updatedAtMs: 1 },
  options: {},
} satisfies AgentSessionConfigurationSnapshot;

function createUnboundConnectedAccounts() {
  return {
    getBinding: vi.fn(async () => null),
    requestSelection: vi.fn(),
    materialize: vi.fn(),
    watch: vi.fn((_purpose: string, listener: (event: { kind: 'resync'; authorityChanged: boolean }) => void) => {
      queueMicrotask(() => listener({ kind: 'resync', authorityChanged: true }));
      return { dispose() {} };
    }),
  };
}

describe('OhMyPi plugin activation', () => {
  it('reexports the activation compiled by its canonical public plugin definition', async () => {
    expect(await import('./manifest.js')).toEqual(expect.objectContaining({
      OH_MY_PI_PLUGIN: expect.objectContaining({ manifest: PLUGIN_MANIFEST, activate }),
    }));
  });

  it('registers the native primary runtime and auxiliary External Sessions independently', async () => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const agent = fixture.registration('agents', 'ohmypi');

    expect(agent).toEqual(expect.objectContaining({
      factory: expect.any(Function),
      externalSessions: expect.objectContaining({
        resolveSource: expect.any(Function),
        listCandidates: expect.any(Function),
        resolveLinkIdentity: expect.any(Function),
        resolveLinkedIdentity: expect.any(Function),
        pageTranscript: expect.any(Function),
        readAfterTranscript: expect.any(Function),
      }),
      externalSessionTakeover: {
        resolveLaunch: expect.any(Function),
      },
    }));
    expect(Object.keys(agent?.externalSessions ?? {}).sort()).toEqual([
      'listCandidates',
      'pageTranscript',
      'readAfterTranscript',
      'resolveLinkIdentity',
      'resolveLinkedIdentity',
      'resolveSource',
    ]);
    expect(Object.keys(
      agent?.externalSessionObservation ?? {},
    ).sort()).toEqual([
      'describeResource',
      'observeResource',
      'reconcileResource',
    ]);
    expect(Object.keys(
      agent?.externalSessionTakeover ?? {},
    )).toEqual(['resolveLaunch']);
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.id).toBe('ohmypi');
    expect(AGENT_DEFINITION.id).toBe('ohMyPi');
    expect(fixture.registrations()).toContainEqual({
      family: 'hooks',
      localId: 'resolve-prerequisites',
    });

    const registration = fixture.registration('hooks', 'resolve-prerequisites');
    const result = await registration?.({
      payload: {
        cwd: '/repo',
      },
    }, {
      tools: {
        runSystemTool: async () => ({
          ok: true,
          exitCode: 0,
          stdout: 'No models available. Set API keys in environment variables.\n',
          stderr: '',
        }),
      },
    });

    expect(result).toEqual({ decision: 'allow' });
    await fixture.dispose();
  });

  it('opens detached execution through the ACP Run composer without manufacturing a Session', async () => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = fixture.registration('agents', 'ohmypi')?.factory;
    if (!factory) throw new Error('Expected OhMyPi Agent factory');
    const runtime = await factory({
      plugin: { id: 'happier.agent.ohmypi', version: '0.0.0' },
      agent: { id: 'ohmypi' },
      signal: new AbortController().signal,
    });
    const run = {
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      stop: vi.fn(async () => ({ status: 'requested' as const })),
      watch: () => ({ dispose() {} }),
      dispose: vi.fn(async () => undefined),
    } satisfies AgentExecutionRunRuntime;
    const open = vi.fn();
    const openExecutionRunV1 = vi.fn(async () => run);
    const context = {
      protocols: { acp: { open, openExecutionRunV1 } },
      services: { connectedAccounts: createUnboundConnectedAccounts() },
      signal: new AbortController().signal,
      scope: { kind: 'execution_run', executionRunId: 'ohmypi-run-1' },
      executionRun: { id: 'ohmypi-run-1', services: {} },
    } as unknown as AgentExecutionRunRuntimeContextV1;

    const opened = await runtime.sessions.executionRunContextV1?.open({
      kind: 'create',
      runId: 'ohmypi-run-1',
      cwd: '/workspace',
      profile: { pluginId: 'happier.agent.ohmypi', localId: 'default' },
      input: { text: 'Run detached.' },
    }, context);

    expect(context).not.toHaveProperty('session');
    expect(open).not.toHaveBeenCalled();
    expect(openExecutionRunV1).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'create',
      runId: 'ohmypi-run-1',
    }), expect.objectContaining({
      transport: expect.objectContaining({ kind: 'stdio' }),
    }));
    expect(opened).toBeDefined();
    await opened?.dispose();
    await fixture.dispose();
  });

  it('registers the data-only state-sharing descriptor and host-custodied resume matcher before open', async () => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const launch = fixture.registration('agents', 'ohmypi')?.connectedAccountLaunch;

      expect(launch?.environmentUses).toEqual(expect.arrayContaining([{ purpose: 'openai', environmentKey: 'OPENAI_API_KEY' }]));
      expect(launch?.continuity?.verifyResumeReachable).toBeTypeOf('function');
      expect(launch?.stateSharingDescriptor).toMatchObject({
        nativeHome: { environmentKey: 'PI_CODING_AGENT_DIR' },
        authIsolation: { mode: 'materialized_home', secretEntries: [] },
      });
      expect(launch?.switchContinuity).toEqual({
        continuityMode: 'restart_shared_state_required',
        supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
      });
    } finally {
      await fixture.dispose();
    }
  });

  it.each([
    {
      name: 'create',
      request: {
        kind: 'create',
        sessionId: 'happier-ohmypi-create',
        cwd: '/workspace',
      },
    },
    {
      name: 'resume',
      request: {
        kind: 'resume',
        sessionId: 'happier-ohmypi-resume',
        providerSessionId: 'omp-provider-session',
        cwd: '/workspace',
      },
    },
    {
      name: 'fork',
      request: {
        kind: 'fork',
        sessionId: 'happier-ohmypi-fork',
        cwd: '/workspace-fork',
        source: {
          sessionId: 'happier-ohmypi-source',
          providerSessionId: 'omp-provider-session',
          cwd: '/workspace',
        },
      },
    },
  ] as const)('opens $name through the direct native ACP composer', async ({ request }) => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = fixture.registration('agents', 'ohmypi')?.factory;
    if (!factory) throw new Error('Expected OhMyPi Agent factory');
    const runtime = await factory({
      plugin: { id: 'happier.agent.ohmypi', version: '0.0.0' },
      agent: { id: 'ohmypi' },
      signal: new AbortController().signal,
    });
    const session = {
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      cancel: vi.fn(async ({ turnId }: { turnId: string }) => ({
        status: 'requested' as const,
        turnId,
      })),
      watch: () => ({ dispose: () => undefined }),
      dispose: vi.fn(),
    } satisfies AgentSessionRuntime;
    const open = vi.fn(async (
      _request: AgentSessionOpenRequest,
      _options: AgentAcpRuntimeOptions,
    ) => session);
    const signal = new AbortController().signal;

    const opened = await runtime.sessions.open(
      request,
      {
        protocols: { acp: { open } },
        services: { connectedAccounts: createUnboundConnectedAccounts() },
        signal,
      } as unknown as AgentSessionRuntimeContext,
    );

    expect(opened.send).toBe(session.send);
    expect(opened.runtimeCapabilities).toEqual({
      sessionCapabilities: {
        sessionListing: 'supported',
        sessionFork: {
          conversation: 'supported',
          fromMessage: 'unsupported',
        },
        sessionRollback: { conversation: 'unsupported' },
      },
    });
    expect(open).toHaveBeenCalledWith(request, {
      transport: {
        kind: 'stdio',
        executable: { kind: 'systemTool', id: 'ohmypi-cli' },
        args: ['acp'],
      },
      definition: {
        acceptsVerifiedImageInput: true,
        modelConfigOptionId: 'model',
        models: { catalogConfidence: 'account_unverified', projectModel: expect.any(Function) },
        mcp: { policy: 'pass_through' },
      },
    });
    await expect(opened.cancel?.({
      turnId: `${request.sessionId}-turn`,
      reason: 'user',
    })).resolves.toEqual({
      status: 'requested',
      turnId: `${request.sessionId}-turn`,
    });
    await opened.dispose();
    expect(session.dispose).toHaveBeenCalledTimes(1);
    await fixture.dispose();
  });

  it('materializes every bound qualified purpose and retains the opened Session across account resync', async () => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = fixture.registration('agents', 'ohmypi')?.factory;
    if (!factory) throw new Error('Expected OhMyPi Agent factory');
    const runtime = await factory({
      plugin: { id: 'happier.agent.ohmypi', version: '0.0.0' },
      agent: { id: 'ohmypi' },
      signal: new AbortController().signal,
    });
    const nativeDispose = vi.fn();
    const nativeSession = {
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      watch: () => ({ dispose() {} }),
      dispose: nativeDispose,
    } satisfies AgentSessionRuntime;
    const open = vi.fn(async () => nativeSession);
    const signal = new AbortController().signal;
    const lifecycle: string[] = [];
    const services = new Map([
      ['openai-codex', { pluginId: 'happier.agent.codex', localId: 'openai-codex' }],
      ['openai', { pluginId: 'happier.voice.openai', localId: 'openai' }],
      ['claude-subscription', { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }],
      ['anthropic', { pluginId: 'happier.agent.claude', localId: 'anthropic' }],
      ['gemini', { pluginId: 'happier.agent.gemini', localId: 'gemini-account' }],
    ] as const);
    const getBinding = vi.fn(async (purpose: string) => {
      lifecycle.push(`getBinding:${purpose}`);
      if (!services.has(purpose)) return null;
      return {
        purpose,
        service: services.get(purpose)!,
        account: { service: services.get(purpose)!, accountId: `${purpose}-account` },
        target: { kind: 'account' as const, displayName: `${purpose} account` },
      };
    });
    const environmentByPurpose: Readonly<Record<string, Readonly<Record<string, string>>>> = {
      'openai-codex': {
        OPENAI_CODEX_OAUTH_TOKEN: 'qualified-codex-access',
        REFRESH_TOKEN: 'must-not-reach-child',
        ID_TOKEN: 'must-not-reach-child',
      },
      openai: { OPENAI_API_KEY: 'qualified-openai-key' },
      'claude-subscription': { ANTHROPIC_OAUTH_TOKEN: 'qualified-claude-setup-token' },
      anthropic: { ANTHROPIC_API_KEY: 'qualified-anthropic-key' },
      gemini: { GEMINI_API_KEY: 'qualified-gemini-key' },
    };
    const materialize = vi.fn(async (purpose: string) => ({
      kind: 'environment' as const,
      env: environmentByPurpose[purpose] ?? {},
    }));
    const listeners = new Map<string, (event: { kind: 'resync'; authorityChanged: boolean }) => void>();
    const watchDisposers = new Map<string, ReturnType<typeof vi.fn>>();
    const watch = vi.fn((purpose: string, listener: (event: { kind: 'resync'; authorityChanged: boolean }) => void) => {
      lifecycle.push(`watch:${purpose}`);
      listeners.set(purpose, listener);
      const dispose = vi.fn();
      watchDisposers.set(purpose, dispose);
      queueMicrotask(() => listener({ kind: 'resync', authorityChanged: true }));
      return { dispose };
    });
    const context = {
      protocols: { acp: { open } },
      services: {
        connectedAccounts: { getBinding, requestSelection: vi.fn(), materialize, watch },
      },
      signal,
    } as unknown as AgentSessionRuntimeContext;

    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'qualified-ohmypi',
      cwd: '/workspace',
      configuration: explicitModelConfiguration,
      launchEnvironment: {
        values: {
          KEEP: 'caller-value',
          PI_CODING_AGENT_DIR: privateHome(),
          OPENAI_CODEX_OAUTH_TOKEN: 'caller-codex',
          OPENAI_API_KEY: 'caller-openai',
          ANTHROPIC_OAUTH_TOKEN: 'caller-claude',
          ANTHROPIC_API_KEY: 'caller-anthropic',
          GEMINI_API_KEY: 'caller-gemini',
        },
        unset: [
          'OPENAI_CODEX_OAUTH_TOKEN',
          'ANTHROPIC_OAUTH_TOKEN',
          'GEMINI_API_KEY',
          'KEEP_UNSET',
        ],
      },
    }, context);

    expect(getBinding).toHaveBeenCalledTimes(OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES.length);
    expect(watch).toHaveBeenCalledTimes(OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES.length);
    expect(materialize).toHaveBeenCalledTimes(services.size);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      launchEnvironment: expect.objectContaining({
        values: expect.objectContaining({
          KEEP: 'caller-value',
          OPENAI_CODEX_OAUTH_TOKEN: 'qualified-codex-access',
          OPENAI_API_KEY: 'qualified-openai-key',
          ANTHROPIC_OAUTH_TOKEN: 'qualified-claude-setup-token',
          ANTHROPIC_API_KEY: 'qualified-anthropic-key',
          GEMINI_API_KEY: 'qualified-gemini-key',
        }),
        unset: expect.arrayContaining(['KEEP_UNSET', 'OMP_PROFILE', 'PI_PROFILE']),
      }),
    }), expect.any(Object));
    expect(open.mock.calls[0]?.[0].launchEnvironment?.values).not.toHaveProperty('REFRESH_TOKEN');
    expect(open.mock.calls[0]?.[0].launchEnvironment?.values).not.toHaveProperty('ID_TOKEN');
    expect(nativeDispose).not.toHaveBeenCalled();

    listeners.get('openai')?.({ kind: 'resync', authorityChanged: true });
    expect(nativeDispose).not.toHaveBeenCalled();
    for (const dispose of watchDisposers.values()) expect(dispose).not.toHaveBeenCalled();
    await session.dispose();
    for (const dispose of watchDisposers.values()) expect(dispose).toHaveBeenCalledTimes(1);
    expect(nativeDispose).toHaveBeenCalledTimes(1);
    await fixture.dispose();
  });

  it('preserves native launch authentication and host-owned account recovery watches', async () => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = fixture.registration('agents', 'ohmypi')?.factory;
    if (!factory) throw new Error('Expected OhMyPi Agent factory');
    const runtime = await factory({
      plugin: { id: 'happier.agent.ohmypi', version: '0.0.0' },
      agent: { id: 'ohmypi' },
      signal: new AbortController().signal,
    });
    const listeners = new Map<string, (event: { kind: 'resync'; authorityChanged: boolean }) => void>();
    const watchDisposers = new Map<string, ReturnType<typeof vi.fn>>();
    const connectedAccounts = {
      getBinding: vi.fn(async () => null),
      requestSelection: vi.fn(),
      materialize: vi.fn(),
      watch: vi.fn((purpose: string, listener: (event: { kind: 'resync'; authorityChanged: boolean }) => void) => {
        listeners.set(purpose, listener);
        const dispose = vi.fn();
        watchDisposers.set(purpose, dispose);
        queueMicrotask(() => listener({ kind: 'resync', authorityChanged: true }));
        return { dispose };
      }),
    };
    const nativeDispose = vi.fn();
    const open = vi.fn(async () => ({
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      watch: () => ({ dispose() {} }),
      dispose: nativeDispose,
    } satisfies AgentSessionRuntime));
    const signal = new AbortController().signal;
    const launchEnvironment = {
      values: { OPENAI_API_KEY: 'native-openai-key', KEEP: 'yes' },
      unset: ['GEMINI_API_KEY'],
    };

    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'native-ohmypi',
      cwd: '/workspace',
      launchEnvironment,
    }, {
      protocols: { acp: { open } },
      services: { connectedAccounts },
      signal,
    } as unknown as AgentSessionRuntimeContext);

    expect(connectedAccounts.getBinding).toHaveBeenCalledTimes(OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES.length);
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
    expect(connectedAccounts.watch.mock.calls.map(([purpose]) => purpose)).toEqual(
      OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES.map(row => row.purpose),
    );
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ launchEnvironment }), expect.any(Object));
    expect(nativeDispose).not.toHaveBeenCalled();
    listeners.get('openai-codex')?.({ kind: 'resync', authorityChanged: true });
    expect(nativeDispose).not.toHaveBeenCalled();
    for (const dispose of watchDisposers.values()) expect(dispose).not.toHaveBeenCalled();
    await session.dispose();
    for (const dispose of watchDisposers.values()) expect(dispose).toHaveBeenCalledTimes(1);
    expect(nativeDispose).toHaveBeenCalledTimes(1);
    await fixture.dispose();
  });

  it('does not open Oh My Pi after a qualified account invalidates between materialization and ACP open', async () => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = fixture.registration('agents', 'ohmypi')?.factory;
    if (!factory) throw new Error('Expected OhMyPi Agent factory');
    const runtime = await factory({
      plugin: { id: 'happier.agent.ohmypi', version: '0.0.0' },
      agent: { id: 'ohmypi' },
      signal: new AbortController().signal,
    });
    const service = { pluginId: 'happier.voice.openai', localId: 'openai' };
    const listeners = new Map<string, (event: { kind: 'resync'; authorityChanged: boolean }) => void>();
    const watch = vi.fn((purpose: string, listener: (event: { kind: 'resync'; authorityChanged: boolean }) => void) => {
      listeners.set(purpose, listener);
      queueMicrotask(() => listener({ kind: 'resync', authorityChanged: true }));
      return { dispose() {} };
    });
    const getBinding = vi.fn(async (purpose: string) => purpose === 'openai'
      ? {
          purpose,
          service,
          account: { service, accountId: 'account-a' },
          target: { kind: 'account' as const, displayName: 'OpenAI account' },
        }
      : null);
    const materialize = vi.fn(async () => {
      listeners.get('openai')?.({ kind: 'resync', authorityChanged: true });
      return { kind: 'environment' as const, env: { OPENAI_API_KEY: 'qualified-key' } };
    });
    const open = vi.fn();
    const signal = new AbortController().signal;

    await expect(runtime.sessions.open({
      kind: 'create',
      sessionId: 'qualified-ohmypi-invalidated-before-open',
      cwd: '/workspace',
      launchEnvironment: { values: { PI_CODING_AGENT_DIR: privateHome() }, unset: [] },
      configuration: explicitModelConfiguration,
    }, {
      protocols: { acp: { open } },
      services: { connectedAccounts: { getBinding, requestSelection: vi.fn(), materialize, watch } },
      signal,
    } as unknown as AgentSessionRuntimeContext)).rejects.toThrow(
      /qualified Connected Account launch was invalidated before opening/i,
    );

    expect(materialize).toHaveBeenCalledWith(
      'openai',
      { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      { signal, expectedAccount: { service, accountId: 'account-a' } },
    );
    expect(open).not.toHaveBeenCalled();
    await fixture.dispose();
  });

  it.each([
    { kind: 'create', accessToken: 'sk-ant-oat01-fixture-access' },
    { kind: 'resume', accessToken: 'sk-ant-oat01-fixture-access' },
    { kind: 'create', accessToken: null },
    { kind: 'resume', accessToken: null },
  ] as const)('opens or refuses $kind with the real Claude OAuth materializer (access=$accessToken)', async ({ kind, accessToken }) => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = fixture.registration('agents', 'ohmypi')?.factory;
    if (!factory) throw new Error('Expected OhMyPi Agent factory');
    const runtime = await factory({
      plugin: { id: 'happier.agent.ohmypi', version: '0.0.0' },
      agent: { id: 'ohmypi' },
      signal: new AbortController().signal,
    });
    const watchDisposers: Array<ReturnType<typeof vi.fn>> = [];
    const watch = vi.fn((_purpose: string, listener: (event: { kind: 'resync'; authorityChanged: boolean }) => void) => {
      const dispose = vi.fn();
      watchDisposers.push(dispose);
      queueMicrotask(() => listener({ kind: 'resync', authorityChanged: true }));
      return { dispose };
    });
    const getBinding = vi.fn(async (purpose: string) => purpose === 'claude-subscription'
      ? {
          purpose,
          service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
          account: {
            service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
            accountId: 'claude-account',
          },
          target: { kind: 'account' as const, displayName: 'Claude OAuth account' },
        }
      : null);
    const signal = new AbortController().signal;
    const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
    const account = { service, accountId: 'claude-account' };
    const credentials = new Map([['accessToken', 'sk-ant-oat01-fixture-access'], ['refreshToken', 'host-only-refresh']]);
    if (accessToken === null) credentials.delete('accessToken');
    const readCredential = vi.fn(async (key: string) => credentials.get(key) ?? null);
    const claudeContext = {
      account,
      configuration: { target: { kind: 'account', account, modeId: 'oauth' }, revision: 'fixture-1', values: {}, async getSecret() { return null; } },
      credentials: { get: readCredential, async set() {}, async delete() {} },
      signal,
      services: {},
    } as unknown as Parameters<typeof claudeSubscriptionConnectedAccountRuntime.materialize>[1];
    // This is the Connected Accounts service transport boundary; retain the real
    // credential decoder and materialization writer beneath it.
    const materialize = vi.fn(async (_purpose: string, request: Parameters<typeof claudeSubscriptionConnectedAccountRuntime.materialize>[0]) =>
      claudeSubscriptionConnectedAccountRuntime.materialize(request, claudeContext));
    const session = { send: vi.fn(), watch: () => ({ dispose() {} }), dispose: vi.fn() } satisfies AgentSessionRuntime;
    const open = vi.fn(async () => session);

    const opening = runtime.sessions.open({
      kind,
      sessionId: 'oauth-access-only',
      launchEnvironment: { values: { PI_CODING_AGENT_DIR: privateHome() }, unset: [] },
      configuration: explicitModelConfiguration,
      ...(kind === 'resume' ? { providerSessionId: 'existing-native-session' } : {}),
      cwd: '/workspace',
    }, {
      protocols: { acp: { open } },
      services: {
        connectedAccounts: { getBinding, requestSelection: vi.fn(), materialize, watch },
      },
      signal,
    } as unknown as AgentSessionRuntimeContext);

    if (accessToken === null) {
      await expect(opening).rejects.toMatchObject({ code: 'plugin_connected_account_claude_subscription_credentials_unavailable' });
      expect(open).not.toHaveBeenCalled();
      expect(readCredential.mock.calls.map(([key]) => key)).not.toContain('refreshToken');
      for (const dispose of watchDisposers) expect(dispose).toHaveBeenCalledTimes(1);
      await fixture.dispose();
      return;
    }
    const opened = await opening;

    expect(materialize).toHaveBeenCalledWith(
      'claude-subscription',
      { kind: 'environment', keys: ['ANTHROPIC_OAUTH_TOKEN'] },
      {
        signal,
        expectedAccount: {
          service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
          accountId: 'claude-account',
        },
      },
    );
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      kind,
      launchEnvironment: expect.objectContaining({ values: expect.objectContaining({ ANTHROPIC_OAUTH_TOKEN: 'sk-ant-oat01-fixture-access' }) }),
    }), expect.anything());
    expect(readCredential.mock.calls.map(([key]) => key)).not.toContain('refreshToken');
    await opened.dispose();
    expect(watchDisposers).toHaveLength(OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES.length);
    for (const dispose of watchDisposers) expect(dispose).toHaveBeenCalledTimes(1);
    await fixture.dispose();
  });

  it.each([
    {
      name: 'wrong materialization kind',
      result: { kind: 'files' as const, files: {} },
    },
    {
      name: 'missing requested environment value',
      result: { kind: 'environment' as const, env: {} },
    },
  ])('fails before ACP process open for $name', async ({ result }) => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = fixture.registration('agents', 'ohmypi')?.factory;
    if (!factory) throw new Error('Expected OhMyPi Agent factory');
    const runtime = await factory({
      plugin: { id: 'happier.agent.ohmypi', version: '0.0.0' },
      agent: { id: 'ohmypi' },
      signal: new AbortController().signal,
    });
    const disposeWatches: Array<ReturnType<typeof vi.fn>> = [];
    const getBinding = vi.fn(async (purpose: string) => purpose === 'gemini'
      ? {
          purpose,
          service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' },
          account: {
            service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' },
            accountId: 'gemini-account',
          },
          target: { kind: 'account' as const, displayName: 'Gemini account' },
        }
      : null);
    const materialize = vi.fn(async () => result);
    const watch = vi.fn((_purpose: string, listener: (event: { kind: 'resync'; authorityChanged: boolean }) => void) => {
      const dispose = vi.fn();
      disposeWatches.push(dispose);
      queueMicrotask(() => listener({ kind: 'resync', authorityChanged: true }));
      return { dispose };
    });
    const open = vi.fn(async () => ({
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      watch: () => ({ dispose() {} }),
      dispose: vi.fn(),
    } satisfies AgentSessionRuntime));
    const signal = new AbortController().signal;

    await expect(runtime.sessions.open({
      kind: 'create',
      sessionId: 'invalid-qualified-ohmypi',
      cwd: '/workspace',
      configuration: explicitModelConfiguration,
    }, {
      protocols: { acp: { open } },
      services: {
        connectedAccounts: { getBinding, requestSelection: vi.fn(), materialize, watch },
      },
      signal,
    } as unknown as AgentSessionRuntimeContext)).rejects.toThrow(/Gemini|environment materialization/i);

    expect(materialize).toHaveBeenCalledWith(
      'gemini',
      { kind: 'environment', keys: ['GEMINI_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'] },
      {
        signal,
        expectedAccount: {
          service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' },
          accountId: 'gemini-account',
        },
      },
    );
    expect(open).not.toHaveBeenCalled();
    expect(disposeWatches).toHaveLength(OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES.length);
    for (const dispose of disposeWatches) expect(dispose).toHaveBeenCalledTimes(1);
    await fixture.dispose();
  });

  it('leaves model readiness to qualified account preparation for direct activation hooks', async () => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const runSystemTool = vi.fn(async () => ({
      ok: true,
      exitCode: 0,
      stdout: 'No models available. Set API keys in environment variables.\n',
      stderr: '',
    }));

    const registration = fixture.registration('hooks', 'resolve-prerequisites');
    const result = await registration?.({
      cwd: '/repo',
      directory: '/repo',
    }, {
      tools: {
        runSystemTool,
      },
    });

    expect(runSystemTool).not.toHaveBeenCalled();
    expect(result).toEqual({ decision: 'allow' });
    await fixture.dispose();
  });
});
