import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { buildOpenCodeRequestAuthMarker } from '../auth/services/requestAuth/source.js';

const { openOpenCodeServerSession } = vi.hoisted(() => ({
  openOpenCodeServerSession: vi.fn(),
}));

vi.mock('./server/nativeSession.js', () => ({
  openOpenCodeServerSession,
}));

import { createOpenCodeAgentRuntime } from './nativeRuntime.js';

function createSession(): AgentSessionRuntime {
  return {
    send: vi.fn(async () => ({ status: 'admitted' as const })),
    cancel: vi.fn(async ({ turnId }) => ({
      status: 'requested' as const,
      turnId,
    })),
    watch: () => ({ dispose: () => undefined }),
    dispose: vi.fn(async () => undefined),
  };
}

const OPEN_CODE_CONNECTED_ACCOUNT_PURPOSES = [
  'anthropic-model-request',
  'openai-codex-model-request',
  'openai-api-key',
  'anthropic-api-key',
] as const;

type OpenCodePurpose = typeof OPEN_CODE_CONNECTED_ACCOUNT_PURPOSES[number];

function createConnectedAccountsHarness(input: Readonly<{
  bindings?: Readonly<Partial<Record<OpenCodePurpose, Readonly<{
    pluginId: string;
    localId: string;
  }>>>>;
  materialize?: (
    purpose: string,
    request: Readonly<Record<string, unknown>>,
  ) => unknown | Promise<unknown>;
  emitInitial?: boolean;
}> = {}) {
  const listeners = new Map<string, (event: { kind: 'resync' }) => unknown>();
  const watcherDisposals = new Map<string, ReturnType<typeof vi.fn>>();
  const connectedAccounts = {
    getBinding: vi.fn(async (purpose: string) => {
      const service = input.bindings?.[purpose as OpenCodePurpose];
      return service
        ? {
            purpose,
            service,
            account: { service, accountId: `${service.localId}-account` },
            target: { kind: 'account' as const, displayName: `${service.localId} account` },
          }
        : null;
    }),
    requestSelection: vi.fn(),
    materialize: vi.fn(async (purpose: string, request: Readonly<Record<string, unknown>>) => {
      if (!input.materialize) throw new Error(`Unexpected materialization for ${purpose}`);
      return await input.materialize(purpose, request);
    }),
    watch: vi.fn((purpose: string, listener: (event: { kind: 'resync' }) => unknown) => {
      listeners.set(purpose, listener);
      const dispose = vi.fn();
      watcherDisposals.set(purpose, dispose);
      if (input.emitInitial !== false) listener({ kind: 'resync' });
      return { dispose };
    }),
  };
  return { connectedAccounts, listeners, watcherDisposals };
}

describe('createOpenCodeAgentRuntime server dispatch', () => {
  it('publishes handoff and replay leaves through AgentRuntime surfaces', async () => {
    const runtime = createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });

    expect(runtime.surfaces?.handoff).toEqual({
      exportBundle: expect.any(Function),
      importBundle: expect.any(Function),
    });
    await expect(runtime.surfaces?.fork?.resolveReplayChildLaunch?.({
      parentSessionId: 'parent-session',
      parentMetadata: {
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:49196',
        opencodeServerBaseUrlExplicit: true,
      },
      directory: '/repo',
      forkPoint: { kind: 'latest' },
    }, {} as never)).resolves.toEqual({
      environmentVariables: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'server',
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:49196/',
        HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
      },
    });
  });

  it('declares its externally executed Agent tools as observable', () => {
    const runtime = createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });

    expect(runtime.toolExecution).toEqual({ capability: 'observable' });
  });

  it('routes the canonical configuration override through the common ACP composer', async () => {
    const session = createSession();
    const openAcp = vi.fn(async () => session);
    const runtime = createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });
    const request: AgentSessionOpenRequest = {
      kind: 'create',
      sessionId: 'happier-acp',
      cwd: '/repo',
      configuration: {
        mode: { value: null, updatedAtMs: 0 },
        model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: null, updatedAtMs: 0 },
        options: {
          opencodeBackendMode: { value: 'acp', updatedAtMs: 1 },
        },
      },
    };
    const context = {
      protocols: {
        acp: { open: openAcp },
      },
      services: { connectedAccounts: createConnectedAccountsHarness().connectedAccounts },
    } as unknown as AgentSessionRuntimeContext;

    await expect(runtime.sessions.open(request, context)).resolves.toMatchObject({
      send: session.send,
    });
    expect(openAcp).toHaveBeenCalledWith(request, expect.objectContaining({
      transport: expect.objectContaining({
        kind: 'stdio',
        executable: { kind: 'systemTool', id: 'opencode-cli' },
        args: ['acp'],
      }),
    }));
    expect(openOpenCodeServerSession).not.toHaveBeenCalled();
  });

  it('projects the host-materialized Provider config into the ACP launch environment', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-opencode-acp-provider-'));
    const relativePath = 'opencode/opencode.json';
    const configContent = '{"model":"happier_test/gateway-model"}';
    await mkdir(join(rootPath, 'opencode'));
    await writeFile(join(rootPath, relativePath), configContent, 'utf8');

    const session = createSession();
    const openAcp = vi.fn(async () => session);
    const runtime = createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });
    const request: AgentSessionOpenRequest = {
      kind: 'create',
      sessionId: 'happier-acp-provider',
      cwd: '/repo',
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_PROVIDER_API_KEY: 'provider-secret' },
        unset: ['OPENCODE_CONFIG_CONTENT'],
      },
      configuration: {
        mode: { value: null, updatedAtMs: 0 },
        model: { value: 'gateway-model', updatedAtMs: 1 },
        permissionIntent: { value: null, updatedAtMs: 0 },
        options: {
          opencodeBackendMode: { value: 'acp', updatedAtMs: 1 },
        },
      },
      providerBinding: {
        connectionId: ProviderConnectionIdSchema.parse('pc_openrouter_work'),
        model: { id: 'gateway-model', name: 'Gateway model' },
        materialization: {
          v: 1,
          kind: 'configFile',
          rootPath,
          relativePaths: [relativePath],
        },
      },
    };

    try {
      await expect(runtime.sessions.open(request, {
        protocols: { acp: { open: openAcp } },
        services: { connectedAccounts: createConnectedAccountsHarness().connectedAccounts },
      } as unknown as AgentSessionRuntimeContext)).resolves.toMatchObject({
        send: session.send,
      });

      expect(openAcp).toHaveBeenCalledWith(
        expect.objectContaining({
          launchEnvironment: {
            values: {
              HAPPIER_OPENCODE_PROVIDER_API_KEY: 'provider-secret',
              OPENCODE_CONFIG_CONTENT: configContent,
            },
            unset: [],
          },
        }),
        expect.any(Object),
      );
      expect(openOpenCodeServerSession).not.toHaveBeenCalled();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('materializes a direct OpenAI purpose before ACP open with the exact binding and signal', async () => {
    const session = createSession();
    const openAcp = vi.fn(async () => session);
    const signal = new AbortController().signal;
    const harness = createConnectedAccountsHarness({
      bindings: {
        'openai-api-key': { pluginId: 'happier.voice.openai', localId: 'openai' },
      },
      materialize: async (purpose, request) => {
        expect(purpose).toBe('openai-api-key');
        expect(request).toEqual({ kind: 'environment', keys: ['OPENAI_API_KEY'] });
        return { kind: 'environment', env: { OPENAI_API_KEY: 'sk-openai-public' } };
      },
    });
    const runtime = createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal,
    });
    const request: AgentSessionOpenRequest = {
      kind: 'create',
      sessionId: 'happier-acp-openai',
      cwd: '/repo',
      launchEnvironment: {
        values: {
          HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
          HAPPIER_OPENCODE_PROVIDER_API_KEY: 'provider-secret',
          XDG_CONFIG_HOME: '/private/opencode',
          OPENCODE_CONFIG_CONTENT: '{"provider":"gateway"}',
          OPENCODE_AUTH_CONTENT: '{}',
          OPENAI_API_KEY: '',
          ANTHROPIC_API_KEY: '',
        },
        unset: [],
      },
    };

    await runtime.sessions.open(request, {
      protocols: { acp: { open: openAcp } },
      services: { connectedAccounts: harness.connectedAccounts },
      signal,
    } as unknown as AgentSessionRuntimeContext);

    expect(harness.connectedAccounts.materialize).toHaveBeenCalledWith(
      'openai-api-key',
      { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      {
        signal,
        expectedAccount: {
          service: { pluginId: 'happier.voice.openai', localId: 'openai' },
          accountId: 'openai-account',
        },
      },
    );
    expect(openAcp).toHaveBeenCalledWith(
      expect.objectContaining({
        launchEnvironment: expect.objectContaining({
          values: expect.objectContaining({
            OPENCODE_AUTH_CONTENT: JSON.stringify({
              openai: { type: 'api', key: 'sk-openai-public' },
            }),
            HAPPIER_OPENCODE_PROVIDER_API_KEY: 'provider-secret',
            OPENCODE_CONFIG_CONTENT: '{"provider":"gateway"}',
            OPENAI_API_KEY: '',
            ANTHROPIC_API_KEY: '',
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('does not open ACP after a qualified account invalidates after materialization', async () => {
    const session = createSession();
    const openAcp = vi.fn(async () => session);
    let harness!: ReturnType<typeof createConnectedAccountsHarness>;
    harness = createConnectedAccountsHarness({
      bindings: {
        'openai-api-key': { pluginId: 'happier.voice.openai', localId: 'openai' },
      },
      materialize: async () => {
        await harness.listeners.get('openai-api-key')?.({ kind: 'resync' });
        return { kind: 'environment', env: { OPENAI_API_KEY: 'sk-openai-public' } };
      },
    });
    const runtime = createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });

    await expect(runtime.sessions.open({
      kind: 'create',
      sessionId: 'happier-invalidated-before-open',
      cwd: '/repo',
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp', OPENCODE_AUTH_CONTENT: '{}' },
        unset: [],
      },
    }, {
      protocols: { acp: { open: openAcp } },
      services: { connectedAccounts: harness.connectedAccounts },
    } as unknown as AgentSessionRuntimeContext)).rejects.toThrow('invalidated before opening');

    expect(harness.connectedAccounts.materialize).toHaveBeenCalledWith(
      'openai-api-key',
      { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      expect.objectContaining({
        expectedAccount: {
          service: { pluginId: 'happier.voice.openai', localId: 'openai' },
          accountId: 'openai-account',
        },
      }),
    );
    expect(openAcp).not.toHaveBeenCalled();
  });

  it('preserves the other provider request-auth marker when direct and OAuth purposes are mixed', async () => {
    const session = createSession();
    const harness = createConnectedAccountsHarness({
      bindings: {
        'anthropic-model-request': {
          pluginId: 'happier.agent.claude',
          localId: 'claude-subscription',
        },
        'openai-api-key': { pluginId: 'happier.voice.openai', localId: 'openai' },
      },
      materialize: async (purpose) => {
        if (purpose === 'anthropic-model-request') {
          throw new PluginError({
            code: 'plugin_connected_account_claude_subscription_oauth_request_auth_required',
          });
        }
        return { kind: 'environment', env: { OPENAI_API_KEY: 'sk-openai-mixed' } };
      },
    });
    openOpenCodeServerSession.mockResolvedValueOnce(session);
    const runtime = createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });

    await runtime.sessions.open({
      kind: 'create',
      sessionId: 'happier-mixed-auth',
      cwd: '/repo',
      launchEnvironment: {
        values: {
          HAPPIER_OPENCODE_BACKEND_MODE: 'server',
          OPENCODE_AUTH_CONTENT: JSON.stringify({
            anthropic: {
              type: 'api',
              key: buildOpenCodeRequestAuthMarker('anthropic'),
            },
          }),
          OPENAI_API_KEY: '',
          ANTHROPIC_API_KEY: '',
        },
        unset: [],
      },
    }, {
      services: { connectedAccounts: harness.connectedAccounts },
      workState: { publish: vi.fn() },
    } as unknown as AgentSessionRuntimeContext);

    expect(openOpenCodeServerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        launchEnvironment: expect.objectContaining({
          values: expect.objectContaining({
            OPENCODE_AUTH_CONTENT: JSON.stringify({
              anthropic: {
                type: 'api',
                key: buildOpenCodeRequestAuthMarker('anthropic'),
              },
              openai: { type: 'api', key: 'sk-openai-mixed' },
            }),
          }),
        }),
      }),
      expect.any(Object),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('does not reinterpret an unselected Claude materialization refusal as request auth', async () => {
    openOpenCodeServerSession.mockClear();
    const openAcp = vi.fn(async () => createSession());
    const harness = createConnectedAccountsHarness({
      bindings: {
        'anthropic-model-request': {
          pluginId: 'happier.agent.claude',
          localId: 'claude-subscription',
        },
      },
      materialize: async () => {
        throw new PluginError({
          code: 'plugin_connected_account_claude_subscription_environment_request_unsupported',
        });
      },
    });
    const runtime = createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });

    await expect(runtime.sessions.open({
      kind: 'create',
      sessionId: 'happier-unselected-claude-refusal',
      cwd: '/repo',
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp', OPENCODE_AUTH_CONTENT: '{}' },
        unset: [],
      },
    }, {
      protocols: { acp: { open: openAcp } },
      services: { connectedAccounts: harness.connectedAccounts },
    } as unknown as AgentSessionRuntimeContext)).rejects.toMatchObject({
      code: 'plugin_connected_account_claude_subscription_environment_request_unsupported',
    });

    expect(openAcp).not.toHaveBeenCalled();
    expect(openOpenCodeServerSession).not.toHaveBeenCalled();
    for (const dispose of harness.watcherDisposals.values()) {
      expect(dispose).toHaveBeenCalledTimes(1);
    }
  });

  it('maps a Claude setup-token environment materialization to direct Anthropic OpenCode auth', async () => {
    const session = createSession();
    const harness = createConnectedAccountsHarness({
      bindings: {
        'anthropic-model-request': {
          pluginId: 'happier.agent.claude',
          localId: 'claude-subscription',
        },
      },
      materialize: async () => ({
        kind: 'environment',
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-public-setup' },
      }),
    });
    openOpenCodeServerSession.mockResolvedValueOnce(session);
    const runtime = createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });

    await runtime.sessions.open({
      kind: 'create',
      sessionId: 'happier-setup-token',
      cwd: '/repo',
      launchEnvironment: {
        values: {
          HAPPIER_OPENCODE_BACKEND_MODE: 'server',
          OPENCODE_AUTH_CONTENT: '{}',
          OPENAI_API_KEY: '',
          ANTHROPIC_API_KEY: '',
        },
        unset: [],
      },
    }, {
      services: { connectedAccounts: harness.connectedAccounts },
      workState: { publish: vi.fn() },
    } as unknown as AgentSessionRuntimeContext);

    expect(harness.connectedAccounts.materialize).toHaveBeenCalledWith(
      'anthropic-model-request',
      { kind: 'environment', keys: ['CLAUDE_CODE_OAUTH_TOKEN'] },
      expect.objectContaining({
        expectedAccount: {
          service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
          accountId: 'claude-subscription-account',
        },
      }),
    );
    expect(openOpenCodeServerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        launchEnvironment: expect.objectContaining({
          values: expect.objectContaining({
            OPENCODE_AUTH_CONTENT: JSON.stringify({
              anthropic: { type: 'api', key: 'sk-ant-oat01-public-setup' },
            }),
          }),
        }),
      }),
      expect.any(Object),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('fails before ACP or server effects when a public materialization is malformed', async () => {
    openOpenCodeServerSession.mockClear();
    const session = createSession();
    const openAcp = vi.fn(async () => session);
    const harness = createConnectedAccountsHarness({
      bindings: {
        'anthropic-api-key': { pluginId: 'happier.agent.claude', localId: 'anthropic' },
      },
      materialize: async () => ({
        kind: 'environment',
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-public',
          UNDECLARED_SECRET: 'must-reject',
        },
      }),
    });
    const runtime = createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });

    await expect(runtime.sessions.open({
      kind: 'create',
      sessionId: 'happier-malformed-auth',
      cwd: '/repo',
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp', OPENCODE_AUTH_CONTENT: '{}' },
        unset: [],
      },
    }, {
      protocols: { acp: { open: openAcp } },
      services: { connectedAccounts: harness.connectedAccounts },
    } as unknown as AgentSessionRuntimeContext)).rejects.toThrow(/materialization/i);

    expect(harness.connectedAccounts.materialize).toHaveBeenCalledWith(
      'anthropic-api-key',
      { kind: 'environment', keys: ['ANTHROPIC_API_KEY'] },
      expect.objectContaining({
        expectedAccount: {
          service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
          accountId: 'anthropic-account',
        },
      }),
    );
    expect(openAcp).not.toHaveBeenCalled();
    expect(openOpenCodeServerSession).not.toHaveBeenCalled();
    for (const dispose of harness.watcherDisposals.values()) {
      expect(dispose).toHaveBeenCalledTimes(1);
    }
  });

  it('watches every public purpose and converts a later resync into session recovery disposal', async () => {
    const session = createSession();
    const openAcp = vi.fn(async () => session);
    const harness = createConnectedAccountsHarness();
    const runtime = createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });

    const opened = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'happier-watch-auth',
      cwd: '/repo',
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp' },
        unset: [],
      },
    }, {
      protocols: { acp: { open: openAcp } },
      services: { connectedAccounts: harness.connectedAccounts },
    } as unknown as AgentSessionRuntimeContext);

    expect(harness.connectedAccounts.watch.mock.calls.map(([purpose]) => purpose)).toEqual(
      OPEN_CODE_CONNECTED_ACCOUNT_PURPOSES,
    );
    expect(harness.connectedAccounts.materialize).not.toHaveBeenCalled();
    await harness.listeners.get('openai-api-key')?.({ kind: 'resync' });
    expect(session.dispose).toHaveBeenCalledWith('runtime_recovery');
    for (const dispose of harness.watcherDisposals.values()) {
      expect(dispose).toHaveBeenCalledTimes(1);
    }
    await opened.dispose();
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it('observes every initial purpose resync before reading the launch bindings', async () => {
    const session = createSession();
    const openAcp = vi.fn(async () => session);
    const harness = createConnectedAccountsHarness({ emitInitial: false });
    const runtime = createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });

    const opening = runtime.sessions.open({
      kind: 'create',
      sessionId: 'happier-watch-initial-auth',
      cwd: '/repo',
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp' },
        unset: [],
      },
    }, {
      protocols: { acp: { open: openAcp } },
      services: { connectedAccounts: harness.connectedAccounts },
    } as unknown as AgentSessionRuntimeContext);

    expect(harness.connectedAccounts.watch).toHaveBeenCalledTimes(4);
    expect(harness.connectedAccounts.getBinding).not.toHaveBeenCalled();
    expect(openAcp).not.toHaveBeenCalled();

    for (const purpose of OPEN_CODE_CONNECTED_ACCOUNT_PURPOSES) {
      await harness.listeners.get(purpose)?.({ kind: 'resync' });
    }
    const opened = await opening;

    expect(harness.connectedAccounts.getBinding).toHaveBeenCalledTimes(4);
    expect(openAcp).toHaveBeenCalledTimes(1);
    await opened.dispose();
  });

  it('exposes mode-aware native catalog, recovery, and continuation controls', async () => {
    const session = createSession();
    const readSkills = vi.fn(async () => [{
      name: 'reviewer',
      displayName: 'reviewer',
      description: 'Review code',
      path: '/repo/.agents/skills/reviewer/SKILL.md',
      enabled: true,
    }]);
    openOpenCodeServerSession.mockImplementationOnce(async (...args: unknown[]) => {
      const bindActiveSkillsReader = args[3] as
        | ((
          sessionId: string,
          reader: (options?: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>,
        ) => Readonly<{ dispose(): void }>)
        | undefined;
      if (!bindActiveSkillsReader) {
        throw new Error('expected explicit OpenCode active skills reader binding');
      }
      const binding = bindActiveSkillsReader('happier-session', readSkills);
      vi.mocked(session.dispose).mockImplementationOnce(async () => binding.dispose());
      return session;
    });
    const runtime = createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });
    await runtime.sessions.open({
      kind: 'create',
      sessionId: 'happier-session',
      cwd: '/repo',
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_BACKEND_MODE: 'server' },
        unset: [],
      },
    }, {
      services: { connectedAccounts: createConnectedAccountsHarness().connectedAccounts },
      workState: { publish: vi.fn() },
    } as unknown as AgentSessionRuntimeContext);
    const activeContext = {
      session: {
        id: 'happier-session',
        cwd: '/repo',
        activity: 'active',
        providerSessionId: 'provider-session',
        connectedAccounts: [],
      },
    } as unknown as Parameters<
      NonNullable<typeof runtime.sessions.catalog>['list']
    >[1];
    expect(activeContext.session).not.toHaveProperty('requestExtension');

    await expect(runtime.sessions.catalog?.list(
      { kind: 'skills' },
      activeContext,
    )).resolves.toEqual({
      status: 'ok',
      kind: 'skills',
      items: [{
        id: 'reviewer',
        name: 'reviewer',
        displayName: 'reviewer',
        description: 'Review code',
        path: '/repo/.agents/skills/reviewer/SKILL.md',
        enabled: true,
      }],
    });
    await expect(runtime.sessions.catalog?.list(
      { kind: 'skills' },
      {
        ...activeContext,
        session: {
          ...activeContext.session,
          activity: 'inactive',
        },
      },
    )).resolves.toMatchObject({
      status: 'unsupported',
      diagnostic: { code: 'opencode_catalog_inactive_unsupported' },
    });
    await session.dispose();
    await expect(runtime.sessions.catalog?.list(
      { kind: 'skills' },
      activeContext,
    )).resolves.toMatchObject({
      status: 'unsupported',
      diagnostic: { code: 'opencode_catalog_inactive_unsupported' },
    });
    await expect(runtime.sessions.usageLimitRecovery?.execute(
      { kind: 'checkNow' },
      activeContext,
    )).resolves.toEqual({
      status: 'waiting',
      retryAfterMs: 600_000,
    });
    await expect(runtime.sessions.continuation?.verify(
      {
        kind: 'resume',
        sessionId: 'happier-session',
        providerSessionId: 'provider-session',
        cwd: '/repo',
      },
      activeContext,
    )).resolves.toMatchObject({
      status: 'unsupported',
      diagnostic: { code: 'opencode_continuation_probe_unsupported' },
    });
  });

  it.each([
    {
      kind: 'create',
      sessionId: 'happier-create',
      cwd: '/repo',
    },
    {
      kind: 'resume',
      sessionId: 'happier-resume',
      providerSessionId: 'provider-resume',
      cwd: '/repo',
    },
    {
      kind: 'fork',
      sessionId: 'happier-fork',
      cwd: '/repo-child',
      source: {
        sessionId: 'happier-parent',
        providerSessionId: 'provider-parent',
        cwd: '/repo',
        target: {
          turnId: 'turn-parent',
          providerCheckpoint: {
            kind: 'opencode_exclusive_message_id',
            messageId: 'provider-next-user',
          },
        },
      },
    },
  ] satisfies AgentSessionOpenRequest[])(
    'routes native $kind through the server session owner without a compatibility runtime',
    async (request) => {
      const session = createSession();
      openOpenCodeServerSession.mockResolvedValueOnce(session);
      const runtime = createOpenCodeAgentRuntime({
        plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
        agent: { id: 'opencode' },
        signal: new AbortController().signal,
      });
      const context = {
        services: { connectedAccounts: createConnectedAccountsHarness().connectedAccounts },
        workState: { publish: vi.fn() },
      } as unknown as AgentSessionRuntimeContext;

      await expect(runtime.sessions.open({
        ...request,
        launchEnvironment: {
          values: { HAPPIER_OPENCODE_BACKEND_MODE: 'server' },
          unset: [],
        },
      }, context)).resolves.toMatchObject({
        send: session.send,
      });

      expect(openOpenCodeServerSession).toHaveBeenCalledWith(
        expect.objectContaining(request),
        context,
        context.workState,
        expect.any(Function),
      );
    },
  );

  it('carries bounded Provider launch inputs into the server session owner', async () => {
    const session = createSession();
    openOpenCodeServerSession.mockResolvedValueOnce(session);
    const runtime = createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });
    const context = {
      services: { connectedAccounts: createConnectedAccountsHarness().connectedAccounts },
    } as unknown as AgentSessionRuntimeContext;
    const providerConnectionId = ProviderConnectionIdSchema.parse('pc_opencode');
    const configuration = {
      mode: { value: null, updatedAtMs: 0 },
      model: { value: 'openai/gpt-5.1', updatedAtMs: 5 },
      permissionIntent: { value: 'default' as const, updatedAtMs: 5 },
      options: { reasoning_effort: { value: 'high', updatedAtMs: 5 } },
    };
    const providerBinding = {
      connectionId: providerConnectionId,
      model: { id: 'openai/gpt-5.1', name: 'GPT-5.1' },
      materialization: {
        v: 1 as const,
        kind: 'engineConfig' as const,
        engineConfig: { provider: 'openai' },
      },
    };

    const run = await runtime.executionRuns!.open({
      kind: 'create',
      runId: 'run-provider-opencode',
      cwd: '/repo',
      profile: {
        pluginId: 'happier.agent.opencode',
        contributionType: 'agents',
        contributionId: 'opencode',
      },
      input: { text: 'Run it' },
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_BACKEND_MODE: 'server' },
        unset: [],
      },
      modelSelection: {
        agentTargetKey: 'backend:opencode',
        providerConnectionId,
        modelId: 'openai/gpt-5.1',
      },
      configuration,
      providerBinding,
    }, context);

    expect(openOpenCodeServerSession).toHaveBeenCalledWith(
      expect.objectContaining({ configuration, providerBinding }),
      context,
    );
    await run.dispose();
  });

  it.each(['rejected', 'unavailable'] as const)(
    'returns terminal run evidence when the initial execution input is %s',
    async (status) => {
      const session = createSession();
      vi.mocked(session.send).mockResolvedValueOnce({
        status,
        diagnostic: { code: `opencode_${status}`, severity: 'error' },
        ...(status === 'rejected' ? { retryable: false } : { retryable: true }),
      });
      openOpenCodeServerSession.mockResolvedValueOnce(session);
      const runtime = createOpenCodeAgentRuntime({
        plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
        agent: { id: 'opencode' },
        signal: new AbortController().signal,
      });

      const run = await runtime.executionRuns!.open({
        kind: 'create',
        runId: `run-${status}`,
        cwd: '/repo',
        profile: {
          pluginId: 'happier.agent.opencode',
          contributionType: 'agents',
          contributionId: 'opencode',
        },
        input: { text: 'Run it' },
        launchEnvironment: {
          values: { HAPPIER_OPENCODE_BACKEND_MODE: 'server' },
          unset: [],
        },
      }, {
        plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
        contribution: {
          id: 'opencode',
          qualifiedId: 'happier.agent.opencode/agents/opencode',
        },
        agent: { id: 'opencode' },
        signal: new AbortController().signal,
        services: { connectedAccounts: createConnectedAccountsHarness().connectedAccounts },
      } as unknown as AgentSessionRuntimeContext);
      const events: Array<{ kind: string; diagnostic?: { code: string } }> = [];
      run.watch((event) => events.push(event));

      expect(events).toEqual([
        expect.objectContaining({ kind: 'run-start' }),
        expect.objectContaining({
          kind: 'run-failed',
          diagnostic: expect.objectContaining({ code: `opencode_${status}` }),
        }),
      ]);
      await expect(run.stop()).resolves.toEqual({ status: 'notRunning' });
    },
  );

  it('clears run activity and emits failure when a later send is rejected', async () => {
    const session = createSession();
    vi.mocked(session.send)
      .mockResolvedValueOnce({ status: 'admitted' })
      .mockResolvedValueOnce({
        status: 'rejected',
        diagnostic: { code: 'opencode_later_rejected', severity: 'error' },
        retryable: false,
      });
    openOpenCodeServerSession.mockResolvedValueOnce(session);
    const runtime = createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });
    const run = await runtime.executionRuns!.open({
      kind: 'create',
      runId: 'run-later-rejected',
      cwd: '/repo',
      profile: {
        pluginId: 'happier.agent.opencode',
        contributionType: 'agents',
        contributionId: 'opencode',
      },
      input: { text: 'First' },
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_BACKEND_MODE: 'server' },
        unset: [],
      },
    }, {
      services: { connectedAccounts: createConnectedAccountsHarness().connectedAccounts },
    } as unknown as AgentSessionRuntimeContext);
    const events: Array<{ kind: string }> = [];
    run.watch((event) => events.push(event));

    await expect(run.send({ text: 'Second' })).resolves.toMatchObject({
      status: 'rejected',
    });

    expect(events.at(-1)).toMatchObject({ kind: 'run-failed' });
    await expect(run.stop()).resolves.toEqual({ status: 'notRunning' });
  });
});
