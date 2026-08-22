import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type {
  AgentAcpRuntimeOptions,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { AGENT_DEFINITION } from './agent/definition.js';
import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';

function createUnboundConnectedAccounts() {
  return {
    getBinding: vi.fn(async () => null),
    requestSelection: vi.fn(),
    materialize: vi.fn(),
    watch: vi.fn((_purpose: string, listener: (event: { kind: 'resync' }) => void) => {
      queueMicrotask(() => listener({ kind: 'resync' }));
      return { dispose() {} };
    }),
  };
}

describe('OhMyPi plugin activation', () => {
  it('reexports the activation compiled by its canonical public plugin definition', async () => {
    expect(Object.keys(PLUGIN_MANIFEST.contributes).sort()).toEqual([
      'agents',
      'hooks',
      'settings',
      'systemTools',
      'ui',
    ]);
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

    expect(result).toMatchObject({
      decision: 'deny',
      reasonCode: 'ohmypi_models_unavailable',
    });
    await fixture.dispose();
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
    expect(open).toHaveBeenCalledWith(request, {
      transport: {
        kind: 'stdio',
        executable: { kind: 'systemTool', id: 'ohmypi-cli' },
        args: ['--mode', 'acp'],
      },
      definition: {
        acceptsVerifiedImageInput: true,
        modelConfigOptionId: 'model',
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

  it('materializes every bound qualified purpose into the ACP launch environment and restarts on resync', async () => {
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
      return {
        purpose,
        service: services.get(purpose)!,
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
      'claude-subscription': { CLAUDE_CODE_OAUTH_TOKEN: 'qualified-claude-setup-token' },
      anthropic: { ANTHROPIC_API_KEY: 'qualified-anthropic-key' },
      gemini: { GEMINI_API_KEY: 'qualified-gemini-key' },
    };
    const materialize = vi.fn(async (purpose: string) => ({
      kind: 'environment' as const,
      env: environmentByPurpose[purpose] ?? {},
    }));
    const listeners = new Map<string, (event: { kind: 'resync' }) => void>();
    const watchDisposers = new Map<string, ReturnType<typeof vi.fn>>();
    const watch = vi.fn((purpose: string, listener: (event: { kind: 'resync' }) => void) => {
      lifecycle.push(`watch:${purpose}`);
      listeners.set(purpose, listener);
      const dispose = vi.fn();
      watchDisposers.set(purpose, dispose);
      queueMicrotask(() => listener({ kind: 'resync' }));
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
      launchEnvironment: {
        values: {
          KEEP: 'caller-value',
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

    expect(getBinding.mock.calls).toEqual([
      ['openai-codex', { signal }],
      ['openai', { signal }],
      ['claude-subscription', { signal }],
      ['anthropic', { signal }],
      ['gemini', { signal }],
    ]);
    expect(lifecycle).toEqual([
      'watch:openai-codex',
      'watch:openai',
      'watch:claude-subscription',
      'watch:anthropic',
      'watch:gemini',
      'getBinding:openai-codex',
      'getBinding:openai',
      'getBinding:claude-subscription',
      'getBinding:anthropic',
      'getBinding:gemini',
    ]);
    expect(materialize.mock.calls).toEqual([
      ['openai-codex', { kind: 'environment', keys: ['OPENAI_CODEX_OAUTH_TOKEN'] }, { signal }],
      ['openai', { kind: 'environment', keys: ['OPENAI_API_KEY'] }, { signal }],
      ['claude-subscription', { kind: 'environment', keys: ['CLAUDE_CODE_OAUTH_TOKEN'] }, { signal }],
      ['anthropic', { kind: 'environment', keys: ['ANTHROPIC_API_KEY'] }, { signal }],
      ['gemini', { kind: 'environment', keys: ['GEMINI_API_KEY'] }, { signal }],
    ]);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      launchEnvironment: {
        values: {
          KEEP: 'caller-value',
          OPENAI_CODEX_OAUTH_TOKEN: 'qualified-codex-access',
          OPENAI_API_KEY: 'qualified-openai-key',
          ANTHROPIC_OAUTH_TOKEN: 'qualified-claude-setup-token',
          ANTHROPIC_API_KEY: 'qualified-anthropic-key',
          GEMINI_API_KEY: 'qualified-gemini-key',
        },
        unset: ['KEEP_UNSET'],
      },
    }), expect.any(Object));
    expect(open.mock.calls[0]?.[0].launchEnvironment?.values).not.toHaveProperty('REFRESH_TOKEN');
    expect(open.mock.calls[0]?.[0].launchEnvironment?.values).not.toHaveProperty('ID_TOKEN');
    expect(watch.mock.calls.map(([purpose]) => purpose)).toEqual([
      'openai-codex',
      'openai',
      'claude-subscription',
      'anthropic',
      'gemini',
    ]);
    expect(nativeDispose).not.toHaveBeenCalled();

    listeners.get('openai')?.({ kind: 'resync' });
    await vi.waitFor(() => expect(nativeDispose).toHaveBeenCalledWith('runtime_recovery'));
    for (const dispose of watchDisposers.values()) expect(dispose).toHaveBeenCalledTimes(1);
    await session.dispose();
    expect(nativeDispose).toHaveBeenCalledTimes(1);
    await fixture.dispose();
  });

  it('preserves native launch authentication while retaining unbound-purpose watches for restart', async () => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = fixture.registration('agents', 'ohmypi')?.factory;
    if (!factory) throw new Error('Expected OhMyPi Agent factory');
    const runtime = await factory({
      plugin: { id: 'happier.agent.ohmypi', version: '0.0.0' },
      agent: { id: 'ohmypi' },
      signal: new AbortController().signal,
    });
    const listeners = new Map<string, (event: { kind: 'resync' }) => void>();
    const watchDisposers = new Map<string, ReturnType<typeof vi.fn>>();
    const connectedAccounts = {
      getBinding: vi.fn(async () => null),
      requestSelection: vi.fn(),
      materialize: vi.fn(),
      watch: vi.fn((purpose: string, listener: (event: { kind: 'resync' }) => void) => {
        listeners.set(purpose, listener);
        const dispose = vi.fn();
        watchDisposers.set(purpose, dispose);
        queueMicrotask(() => listener({ kind: 'resync' }));
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

    expect(connectedAccounts.getBinding).toHaveBeenCalledTimes(5);
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
    expect(connectedAccounts.watch.mock.calls.map(([purpose]) => purpose)).toEqual([
      'openai-codex',
      'openai',
      'claude-subscription',
      'anthropic',
      'gemini',
    ]);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ launchEnvironment }), expect.any(Object));
    expect(nativeDispose).not.toHaveBeenCalled();
    listeners.get('openai-codex')?.({ kind: 'resync' });
    await vi.waitFor(() => expect(nativeDispose).toHaveBeenCalledWith('runtime_recovery'));
    for (const dispose of watchDisposers.values()) expect(dispose).toHaveBeenCalledTimes(1);
    await session.dispose();
    expect(nativeDispose).toHaveBeenCalledTimes(1);
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
          target: { kind: 'account' as const, displayName: 'Gemini account' },
        }
      : null);
    const materialize = vi.fn(async () => result);
    const watch = vi.fn((_purpose: string, listener: (event: { kind: 'resync' }) => void) => {
      const dispose = vi.fn();
      disposeWatches.push(dispose);
      queueMicrotask(() => listener({ kind: 'resync' }));
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
    }, {
      protocols: { acp: { open } },
      services: {
        connectedAccounts: { getBinding, requestSelection: vi.fn(), materialize, watch },
      },
      signal,
    } as unknown as AgentSessionRuntimeContext)).rejects.toThrow(/Gemini|environment materialization/i);

    expect(materialize).toHaveBeenCalledWith(
      'gemini',
      { kind: 'environment', keys: ['GEMINI_API_KEY'] },
      { signal },
    );
    expect(open).not.toHaveBeenCalled();
    expect(disposeWatches).toHaveLength(5);
    for (const dispose of disposeWatches) expect(dispose).toHaveBeenCalledTimes(1);
    await fixture.dispose();
  });

  it('passes direct activation-hook payloads through to the spawn prerequisite owner', async () => {
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

    expect(runSystemTool).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
    }));
    expect(result).toMatchObject({
      decision: 'deny',
      reasonCode: 'ohmypi_models_unavailable',
    });
    await fixture.dispose();
  });
});
