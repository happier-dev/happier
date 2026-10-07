import { describe, expect, it } from 'vitest';

import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
  AgentPreflightJsonRpcRequestClientV1,
  AgentPreflightSessionControlsProbeContextV1,
  AgentPreflightSessionControlsContributionV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { CODEX_PREFLIGHT_SESSION_CONTROLS } from './sessionControls.js';

function createPreflightContext(params: Readonly<{
  accountSettings?: Readonly<Record<string, JsonValue>> | null;
  environment?: Readonly<Record<string, boolean>>;
  nonblankEnvironment?: Readonly<Record<string, boolean>>;
  catalogs?: Awaited<ReturnType<AgentPreflightSessionControlsProbeContextV1['probeDeclaredAcpCatalogs']>>;
  runtimeDescriptorV1?: AgentPreflightSessionControlsProbeContextV1['runtimeDescriptorV1'];
  runtimeKindOverride?: string;
  request(method: string, requestParams?: JsonValue): Promise<JsonValue>;
}>) {
  const controller = new AbortController();
  const commands: Array<Parameters<AgentPreflightSessionControlsProbeContextV1['withDeclaredJsonRpcClient']>[0]> = [];
  const requests: Array<Readonly<{ method: string; params: JsonValue | undefined }>> = [];
  const notifications: Array<Readonly<{ method: string; params: JsonValue | undefined }>> = [];
  const catalogRequests: Array<Parameters<AgentPreflightSessionControlsProbeContextV1['probeDeclaredAcpCatalogs']>[0]> = [];
  const client: AgentPreflightJsonRpcRequestClientV1 = Object.freeze({
    onNotification: () => ({ dispose() {} }),
    onRequest: () => ({ dispose() {} }),
    request: async (method, requestParams) => {
      requests.push({ method, params: requestParams });
      return await params.request(method, requestParams);
    },
    notify: async (method, notificationParams) => {
      notifications.push({ method, params: notificationParams });
    },
  });
  const context: AgentPreflightSessionControlsProbeContextV1 = {
    cwd: process.cwd(),
    accountSettings: params.accountSettings ?? null,
    runtimeDescriptorV1: params.runtimeDescriptorV1,
    runtimeKindOverride: params.runtimeKindOverride,
    environment: params.environment ?? Object.freeze({}),
    nonblankEnvironment: params.nonblankEnvironment,
    signal: controller.signal,
    runDeclaredSystemToolCommand: async () => ({
      ok: false,
      stdout: '',
      stderr: '',
      exitCode: null,
    }),
    probeDeclaredAcpCatalogs: async (input) => {
      catalogRequests.push(input);
      return params.catalogs ?? { commands: null, skills: null };
    },
    resolveDeclaredSystemTool: async () => { throw new Error('Native Codex preflight owns no managed service'); },
    withDeclaredManagedService: async () => { throw new Error('Native Codex preflight owns no managed service'); },
    withDeclaredJsonRpcClient: async <TResult>(command, inspect) => {
      commands.push(command);
      return await inspect(client, controller.signal);
    },
  };
  return { context, commands, requests, notifications, catalogRequests };
}

describe('CODEX_PREFLIGHT_SESSION_CONTROLS', () => {
  it('reads native skills before a first turn through the declared app-server scope', async () => {
    const fixture = createPreflightContext({
      request: async (method) => {
        if (method === 'initialize') return {};
        if (method === 'skills/list') return { data: [{ cwd: process.cwd(), skills: [{
          name: 'review', path: '/skills/review/SKILL.md', enabled: true,
          description: 'Review code',
        }] }] };
        throw new Error(`Unexpected native preflight request: ${method}`);
      },
    });
    const contribution: AgentPreflightSessionControlsContributionV1 = CODEX_PREFLIGHT_SESSION_CONTROLS;
    expect(await contribution.probeCatalogs?.(fixture.context)).toMatchObject({
      commands: null,
      skills: [{ id: 'vendor:codex:review', name: 'review', path: '/skills/review/SKILL.md', origin: 'vendor' }],
    });
    expect(fixture.requests).toEqual([
      expect.objectContaining({ method: 'initialize' }),
      { method: 'skills/list', params: { cwds: [process.cwd()] } },
    ]);
    expect(fixture.commands).toEqual([expect.objectContaining({
      toolId: 'codex-cli', args: ['app-server', '--listen', 'stdio://'],
    })]);
  });

  it('preserves an observable diagnostic when native skill listing is unsupported', async () => {
    const fixture = createPreflightContext({
      request: async (method) => {
        if (method === 'initialize') return {};
        throw Object.assign(new Error('Native method not found'), { code: -32601 });
      },
    });
    const contribution: AgentPreflightSessionControlsContributionV1 = CODEX_PREFLIGHT_SESSION_CONTROLS;
    expect(await contribution.probeCatalogs?.(fixture.context)).toMatchObject({
      commands: null, skills: null, diagnostic: expect.any(String),
    });
  });

  it.each([
    { nonblank: { OPENAI_API_KEY: true, CODEX_API_KEY: true }, methodId: 'openai-api-key' },
    { nonblank: { OPENAI_API_KEY: false, CODEX_API_KEY: true }, methodId: 'codex-api-key' },
    { nonblank: { OPENAI_API_KEY: false, CODEX_API_KEY: false }, methodId: undefined },
  ])('reads Codex ACP commands through the declared managed dependency with native auth $methodId', async ({ nonblank, methodId }) => {
    const nativeCommands = [{ name: 'review', description: 'Review code', input: { hint: 'target' } }];
    const fixture = createPreflightContext({
      accountSettings: { codexBackendMode: 'acp' },
      environment: { OPENAI_API_KEY: true, CODEX_API_KEY: true },
      nonblankEnvironment: nonblank,
      catalogs: { commands: nativeCommands, skills: null },
      request: async (method) => { throw new Error(`Unexpected app-server request: ${method}`); },
    });
    const contribution: AgentPreflightSessionControlsContributionV1 = CODEX_PREFLIGHT_SESSION_CONTROLS;
    expect(await contribution.probeCatalogs?.(fixture.context)).toEqual({ commands: nativeCommands, skills: null });
    expect(fixture.catalogRequests).toEqual([{
      executable: { kind: 'managedDependency', id: 'codex-acp' }, args: [],
      ...(methodId === undefined ? {} : { authenticationMethodId: methodId }),
    }]);
    expect(fixture.requests).toEqual([]);
  });

  it.each([
    { runtimeMode: 'acp', accountMode: 'appServer', expectedModels: null },
    { runtimeMode: 'appServer', accountMode: 'acp', expectedModels: [] },
  ] as const)('uses session $runtimeMode over account $accountMode and predecessor override for the probe and cache variant', async ({ runtimeMode, accountMode, expectedModels }) => {
    const fixture = createPreflightContext({
      accountSettings: { codexBackendMode: accountMode },
      runtimeKindOverride: accountMode,
      runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: runtimeMode } },
      request: async (method) => method === 'initialize' ? {} : [],
    });
    expect(CODEX_PREFLIGHT_SESSION_CONTROLS.resolveProbeVariant(fixture.context)).toBe(`codex:${runtimeMode}`);
    await expect(CODEX_PREFLIGHT_SESSION_CONTROLS.probeModels(fixture.context)).resolves.toEqual(expectedModels);
    if (runtimeMode === 'acp') expect(fixture.commands).toEqual([]);
  });

  it.each([
    { override: 'acp', accountMode: 'appServer', expectedMode: 'acp', expectedModels: null },
    { override: 'appServer', accountMode: 'acp', expectedMode: 'appServer', expectedModels: [] },
    { override: 'invalid-runtime', accountMode: 'acp', expectedMode: 'acp', expectedModels: null },
  ] as const)('interprets predecessor runtime override $override at the Codex boundary', async ({ override, accountMode, expectedMode, expectedModels }) => {
    const fixture = createPreflightContext({
      accountSettings: { codexBackendMode: accountMode },
      runtimeKindOverride: override,
      request: async (method) => method === 'initialize' ? {} : [],
    });
    expect(CODEX_PREFLIGHT_SESSION_CONTROLS.resolveProbeVariant(fixture.context)).toBe(`codex:${expectedMode}`);
    await expect(CODEX_PREFLIGHT_SESSION_CONTROLS.probeModels(fixture.context)).resolves.toEqual(expectedModels);
    if (expectedMode === 'acp') expect(fixture.commands).toEqual([]);
  });

  it('rejects the removed MCP runtime instead of probing a different backend', async () => {
    const fixture = createPreflightContext({
      runtimeKindOverride: 'mcp',
      request: async () => ({}),
    });
    expect(() => CODEX_PREFLIGHT_SESSION_CONTROLS.resolveProbeVariant(fixture.context))
      .toThrow(expect.objectContaining({ code: 'codex_legacy_mcp_backend_mode_unsupported' }));
    await expect(CODEX_PREFLIGHT_SESSION_CONTROLS.probeModels(fixture.context))
      .rejects.toMatchObject({ code: 'codex_legacy_mcp_backend_mode_unsupported' });
    expect(fixture.commands).toEqual([]);
  });

  it.each(['rejected', 'malformed', 'empty'] as const)('preserves %s model discovery at the host probe boundary', async (outcome) => {
    const fixture = createPreflightContext({
      request: async (method) => {
        if (method === 'initialize') return {};
        if (method !== 'model/list') return [];
        if (outcome === 'rejected') throw new Error('provider unavailable');
        return outcome === 'malformed' ? { unexpected: [] } : [];
      },
    });
    await expect(CODEX_PREFLIGHT_SESSION_CONTROLS.probeModels(fixture.context))
      .resolves.toEqual(outcome === 'empty' ? [] : null);
  });

  it('declares exact app-server probes with host-owned diagnostics and cache policy', () => {
    expect(CODEX_PREFLIGHT_SESSION_CONTROLS.jsonRpcCommands).toEqual([
      {
        toolId: 'codex-cli',
        args: ['app-server', '--listen', 'stdio://'],
        environmentExcludeKeys: [
          'HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH',
          'HAPPIER_CODEX_APP_SERVER_RPC_LOG_MAX_BYTES',
          'HAPPIER_CODEX_APP_SERVER_RPC_LOG_ROTATE_COUNT',
        ],
      },
      {
        toolId: 'codex-cli',
        args: ['app-server', '--listen', 'stdio://', '--enable', 'realtime_conversation'],
        environmentExcludeKeys: [
          'HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH',
          'HAPPIER_CODEX_APP_SERVER_RPC_LOG_MAX_BYTES',
          'HAPPIER_CODEX_APP_SERVER_RPC_LOG_ROTATE_COUNT',
        ],
      },
      { executable: { kind: 'managedDependency', id: 'codex-acp' }, args: [] },
    ]);
    expect(CODEX_PREFLIGHT_SESSION_CONTROLS).not.toHaveProperty('failureCacheStrategy');
    expect(CODEX_PREFLIGHT_SESSION_CONTROLS).not.toHaveProperty('connectedServiceAuth');
    expect(CODEX_PREFLIGHT_SESSION_CONTROLS).not.toHaveProperty('needsAccountSettings');
  });

  it('reads models through the host JSON-RPC scope without process or timeout controls', async () => {
    const fixture = createPreflightContext({
      environment: Object.freeze({ OPENAI_API_KEY: true }),
      request: async (method) => {
        if (method === 'initialize') return {};
        if (method === 'collaborationMode/list') {
          return { data: [{ id: 'default', name: 'Default', mode: 'default' }] };
        }
        if (method === 'model/list') {
          return {
            data: [{
              id: 'gpt-5.5',
              displayName: 'GPT-5.5',
              isDefault: true,
              supported_reasoning_efforts: [{ reasoning_effort: 'medium', description: 'Balanced' }],
              default_reasoning_effort: 'medium',
            }],
          };
        }
        throw new Error(`Unexpected request: ${method}`);
      },
    });

    await expect(CODEX_PREFLIGHT_SESSION_CONTROLS.probeModels(fixture.context))
      .resolves.toEqual([expect.objectContaining({ id: 'gpt-5.5', name: 'GPT 5.5' })]);
    expect(fixture.commands).toEqual([{
      toolId: 'codex-cli',
      args: ['app-server', '--listen', 'stdio://'],
      environmentExcludeKeys: [
        'HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH',
        'HAPPIER_CODEX_APP_SERVER_RPC_LOG_MAX_BYTES',
        'HAPPIER_CODEX_APP_SERVER_RPC_LOG_ROTATE_COUNT',
      ],
    }]);
    expect(fixture.requests.map(({ method }) => method).sort())
      .toEqual(['collaborationMode/list', 'initialize', 'model/list']);
    expect(fixture.notifications).toEqual([{ method: 'initialized', params: undefined }]);
  });

  it('checks passive realtime eligibility in the same bounded app-server scope', async () => {
    const fixture = createPreflightContext({
      request: async (method) => {
        if (method === 'initialize') return {};
        if (method === 'account/read') {
          return {
            requiresOpenaiAuth: true,
            account: { type: 'chatgpt', email: 'voice@example.test', planType: 'plus' },
          };
        }
        if (method === 'experimentalFeature/list') {
          return {
            data: [{ name: 'realtime_conversation', enabled: true }],
            nextCursor: null,
          };
        }
        throw new Error(`Unexpected request: ${method}`);
      },
    });

    await expect(CODEX_PREFLIGHT_SESSION_CONTROLS.probePassiveRealtimeSetup(fixture.context))
      .resolves.toEqual({ v: 1, status: 'ready' });
    expect(fixture.requests.map(({ method }) => method))
      .toEqual(['initialize', 'account/read', 'experimentalFeature/list']);
    expect(fixture.commands).toEqual([expect.objectContaining({
      args: ['app-server', '--listen', 'stdio://', '--enable', 'realtime_conversation'],
    })]);
    expect(fixture.notifications).toEqual([{ method: 'initialized', params: undefined }]);
  });

  it('fails closed without opening an app-server scope when settings select ACP', async () => {
    const fixture = createPreflightContext({
      accountSettings: Object.freeze({ codexBackendMode: 'acp' }),
      request: async () => ({}),
    });

    expect(CODEX_PREFLIGHT_SESSION_CONTROLS.resolveProbeVariant({
      accountSettings: fixture.context.accountSettings,
      environment: fixture.context.environment,
    })).toBe('codex:acp');
    await expect(CODEX_PREFLIGHT_SESSION_CONTROLS.probeModels(fixture.context)).resolves.toBeNull();
    expect(fixture.commands).toEqual([]);
  });
});
