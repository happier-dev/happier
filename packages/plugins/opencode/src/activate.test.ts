import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type {
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentExecutionRunRuntimeContextV1,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { activate } from './activate.js';
import { OPENCODE_PROVIDER_BINDING_ADAPTER_V1 } from './agent/providerBinding/adapter.js';
import { PLUGIN_MANIFEST } from './manifest.js';

function createUnboundConnectedAccounts() {
  return {
    getBinding: vi.fn(async () => null),
    requestSelection: vi.fn(),
    materialize: vi.fn(async () => {
      throw new Error('Unbound OpenCode activation test must not materialize credentials');
    }),
    watch: vi.fn((_purpose: string, listener: (event: { kind: 'resync' }) => void) => {
      listener({ kind: 'resync' });
      return { dispose: vi.fn() };
    }),
  };
}

describe('activate', () => {
  it('reexports the activation compiled by its canonical public plugin definition', async () => {
    expect(Object.keys(PLUGIN_MANIFEST.contributes).sort()).toEqual([
      'agents',
      'mcp',
      'settings',
      'systemTools',
    ]);
    expect(await import('./manifest.js')).toEqual(expect.objectContaining({
      OPENCODE_PLUGIN: expect.objectContaining({ manifest: PLUGIN_MANIFEST, activate }),
    }));
  });

  it('registers the static Connected Account launch facts without retaining a private aggregate', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      expect(activation.registration('agents', 'opencode')?.connectedAccountLaunch).toEqual({
        environmentUses: expect.arrayContaining([
          { purpose: 'kimi-api-key', environmentKey: 'KIMI_API_KEY' },
          { purpose: 'xai-api-key', environmentKey: 'XAI_API_KEY' },
          { purpose: 'gemini', environmentKey: 'GOOGLE_APPLICATION_CREDENTIALS' },
          { purpose: 'github-copilot', environmentKey: 'COPILOT_GITHUB_TOKEN' },
        ]),
        requestAuthUses: [{
          purpose: 'anthropic-model-request',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://api.anthropic.com',
            headerNames: ['authorization'],
          },
        }, {
          purpose: 'openai-codex-model-request',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://chatgpt.com',
            headerNames: ['authorization', 'chatgpt-account-id'],
          },
        }],
        stateSharingDescriptor: expect.objectContaining({
          providerSupportStatus: 'unsupported',
          authIsolation: {
            mode: 'process_env',
            secretEntries: ['OPENCODE_AUTH_CONTENT', 'auth.json'],
          },
        }),
        switchContinuity: {
          continuityMode: 'restart_same_home',
          supportedTransitions: [
            'native_to_connected',
            'connected_to_native',
            'connected_to_connected',
          ],
        },
        continuity: { verifyResumeReachable: expect.any(Function) },
      });
      const verify = activation.registration('agents', 'opencode')?.connectedAccountLaunch?.continuity?.verifyResumeReachable;
      expect(verify).toBeTypeOf('function');
      expect(await verify?.({ vendorResumeId: 'native-session', sessionFiles: {
        async findDeclaredCandidate() { throw new Error('OpenCode has no declared shared session files'); },
      } })).toEqual({ ok: false, reason: 'opencode_state_not_shared' });
      expect(activation.registration('agents', 'opencode')?.connectedAccountLaunch?.stateSharingDescriptor)
        .not.toHaveProperty('providerId');
    } finally {
      await activation.dispose();
    }
  });

  it('builds OpenCode Session preferences through the public CLI command declaration', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const buildSessionOptions = activation.registration('agents', 'opencode')?.cliSessionCommand?.buildSessionOptions;
      expect(buildSessionOptions).toBeTypeOf('function');
      expect(await buildSessionOptions?.({
        isExplicitCliSubcommand: true,
        parsed: { agentArgs: [] },
        settings: {},
        pluginSettings: { account: {
          opencodeBackendMode: 'server',
          opencodeServerBaseUrl: 'https://opencode.example.test',
        } },
        environment: {},
        startOrigin: 'terminal',
      })).toEqual({
        ok: true,
        options: {
          opencodeBackendMode: 'server',
          opencodeServerBaseUrl: 'https://opencode.example.test/',
          opencodeServerBaseUrlExplicit: true,
        },
      });
    } finally {
      await activation.dispose();
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('registers the OpenCode config MCP discovery source through the plugin API', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-plugin-mcp-'));
    let activation: PluginTestkit | undefined;
    onTestFinished(async () => {
      try { await activation?.dispose(); }
      finally { await rm(root, { recursive: true, force: true }); }
    });
    const opencodeDir = join(root, '.config', 'opencode');
    const configPath = join(opencodeDir, 'opencode.json');
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        mcp: {
          review: {
            type: 'local',
            command: ['review-mcp', '--stdio'],
          },
        },
      }),
      'utf8',
    );
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    vi.stubEnv('XDG_CONFIG_HOME', '');
    vi.stubEnv('OPENCODE_CONFIG', '');
    vi.stubEnv('OPENCODE_CONFIG_DIR', '');

    activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const agent = activation.registration('agents', 'opencode');

    expect(agent).toEqual(expect.objectContaining({
      factory: expect.any(Function),
      externalSessions: expect.any(Object),
      externalSessionObservation: expect.any(Object),
      externalSessionTakeover: {
        resolveLaunch: expect.any(Function),
      },
    }));
    expect(agent?.providerBinding).toEqual({
      v: 1,
      adapterVersion: OPENCODE_PROVIDER_BINDING_ADAPTER_V1.adapterVersion,
      supportsModelSettings: true,
      prepare: expect.any(Function),
      materialize: expect.any(Function),
    });
    const prepareInput = {
      v: 1 as const,
      agentTargetKey: 'backend:opencode:built_in',
      connectionId: 'pc_opencode_activation_test',
    };
    expect(agent?.providerBinding?.prepare(prepareInput)).toEqual(
      OPENCODE_PROVIDER_BINDING_ADAPTER_V1.prepare(prepareInput),
    );
    const externalSessions = agent?.externalSessions;
    expect(Object.keys(externalSessions ?? {}).sort()).toEqual([
      'listCandidates',
      'pageTranscript',
      'readAccounting',
      'readAfterTranscript',
      'resolveLinkIdentity',
      'resolveLinkedIdentity',
      // Declares the OpenCode server Happier owns for browse reads, so a
      // listing does not require a live Session runner.
      'resolveManagedEndpointService',
      'resolveSource',
    ]);
    expect(externalSessions).not.toHaveProperty('status');
    expect(externalSessions).not.toHaveProperty('follow');
    expect(externalSessions).not.toHaveProperty('takeover');
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
    const discovery = activation.registration('mcp.discoverySources', 'config');
    expect(discovery).toEqual(expect.any(Function));
    if (!discovery) throw new Error('Missing OpenCode MCP discovery registration');
    await expect(Reflect.apply(discovery, undefined, [{}])).resolves.toEqual({
      items: [],
      detectedServers: [{
        provider: 'opencode',
        name: 'review',
        transport: 'stdio',
        stdio: { command: 'review-mcp', args: ['--stdio'] },
        envKeys: [],
        enabled: null,
        source: { kind: 'user', path: configPath },
      }],
      warnings: [],
    });
  });

  it.each([
    {
      kind: 'create',
      sessionId: 'happier-opencode-create',
      cwd: '/workspace',
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp' },
        unset: [],
      },
    },
    {
      kind: 'resume',
      sessionId: 'happier-opencode-resume',
      providerSessionId: 'provider-session',
      cwd: '/workspace',
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp' },
        unset: [],
      },
    },
    {
      kind: 'fork',
      sessionId: 'happier-opencode-fork',
      cwd: '/workspace-fork',
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp' },
        unset: [],
      },
      source: {
        sessionId: 'happier-opencode-source',
        providerSessionId: 'provider-session',
        cwd: '/workspace',
      },
    },
  ] satisfies AgentSessionOpenRequest[])('registers a native primary that opens $kind sessions', async (request) => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = activation.registration('agents', 'opencode')?.factory;
    if (!factory) throw new Error('Expected OpenCode Agent factory');
    const runtime = await factory({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
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
      _options: unknown,
    ) => session);

    const opened = await runtime.sessions.open(
      request,
      {
        protocols: { acp: { open } },
        services: { connectedAccounts: createUnboundConnectedAccounts() },
      } as unknown as AgentSessionRuntimeContext,
    );

    expect(opened).toMatchObject({ send: session.send });
    await activation.dispose();
  });

  it.each([undefined, 'deny'] as const)('opens detached ACP execution or refuses an unenforceable workspace ceiling (%s)', async workspaceWrites => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = activation.registration('agents', 'opencode')?.factory;
    if (!factory) throw new Error('Expected OpenCode Agent factory');
    const runtime = await factory({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });
    const execution = {
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      stop: vi.fn(async () => ({ status: 'requested' as const })),
      watch: () => ({ dispose: () => undefined }),
      dispose: vi.fn(),
    } satisfies AgentExecutionRunRuntime;
    const openExecutionRunV1 = vi.fn(async () => execution);
    const request = {
      kind: 'create',
      runId: 'opencode-run-1',
      cwd: '/workspace',
      input: { text: 'Implement the change' },
      profile: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
      configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: 'yolo', updatedAtMs: 0 }, options: {}, ...(workspaceWrites ? { workspaceWrites } : {}) },
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp' },
        unset: [],
      },
    } satisfies AgentExecutionRunOpenRequest;
    const context = {
      scope: { kind: 'execution_run', executionRunId: request.runId },
      executionRun: { id: request.runId, services: {} },
      protocols: { acp: { openExecutionRunV1 } },
      services: { connectedAccounts: createUnboundConnectedAccounts() },
    } as unknown as AgentExecutionRunRuntimeContextV1;

    expect(context).not.toHaveProperty('session');
    if (workspaceWrites === 'deny') {
      await expect(runtime.sessions.executionRunContextV1?.open(request, context))
        .rejects.toMatchObject({ code: 'role_policy_unenforceable' });
      expect(openExecutionRunV1).not.toHaveBeenCalled();
      await activation.dispose();
      return;
    }
    const opened = await runtime.sessions.executionRunContextV1?.open(request, context);

    expect(opened).toMatchObject({
      send: execution.send,
      stop: execution.stop,
      watch: execution.watch,
    });
    expect(openExecutionRunV1).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'create',
      runId: 'opencode-run-1',
      cwd: '/workspace',
      input: { text: 'Implement the change' },
    }), expect.objectContaining({
      transport: expect.objectContaining({
        kind: 'stdio',
        args: ['acp'],
      }),
    }));
    await opened?.dispose();
    await activation.dispose();
  });
});
