import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExecService } from '@happier-dev/plugin-sdk/exec';
import type {
  PluginJsonRpcClient,
  PluginProtocolClientHandle,
  PluginProtocolClientSpec,
} from '@happier-dev/plugin-sdk/exec/protocol-clients';

import * as sessionControls from './sessionControls';

describe('resolveCodexPreflightSessionControlsPolicy', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeAuthEnv(extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-preflight-policy-'));
    tempDirs.push(dir);
    return {
      HOME: dir,
      USERPROFILE: dir,
      CODEX_HOME: join(dir, '.codex'),
      ...extra,
    };
  }

  function createPreflightExecFixture(options?: Readonly<{
    request?: (method: string, params: unknown, requestOptions: unknown) => Promise<unknown>;
    realtimeAdvertised?: boolean;
  }>) {
    const specs: PluginProtocolClientSpec[] = [];
    const requests: Array<Readonly<{
      method: string;
      params: unknown;
      options: unknown;
    }>> = [];
    let disposeCount = 0;
    const client: PluginJsonRpcClient = {
      request: async (method, params, requestOptions) => {
        requests.push({ method, params, options: requestOptions });
        if (options?.request) return await options.request(method, params, requestOptions);
        if (method === 'initialize') {
          return {};
        }
        if (method === 'collaborationMode/list') {
          return { data: [{ id: 'default', name: 'Default', mode: 'default' }] };
        }
        if (method === 'model/list') {
          return {
            data: [
              {
                id: 'gpt-5.5',
                displayName: 'GPT-5.5',
                isDefault: true,
                supported_reasoning_efforts: [
                  { reasoning_effort: 'medium', description: 'Balanced' },
                ],
                default_reasoning_effort: 'medium',
              },
            ],
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
      notify: async () => {},
      onRequest: () => ({ dispose: () => {} }),
      onNotification: () => ({ dispose: () => {} }),
      dispose: async () => {},
    };
    const never = new Promise<never>(() => undefined);
    const handle: PluginProtocolClientHandle<'jsonRpc'> = {
      client,
      process: {
      pid: 1,
      write: async () => {},
      closeStdin: async () => {},
      wait: () => never,
      onOutput: () => ({ dispose: () => {} }),
      dispose: async () => {},
      },
      wait: () => never,
      dispose: async () => {
        disposeCount += 1;
      },
    };
    const exec = {
      run: async (_request: Readonly<{ args: readonly string[] }>) => {
        const stdout = options?.realtimeAdvertised
          ? 'realtime_conversation                under development  false\n'
          : '';
        return {
          termination: {
            requestedBy: { kind: 'none' },
            observed: { kind: 'exit', exitCode: 0 },
          },
          stdout: new TextEncoder().encode(stdout),
          stderr: new Uint8Array(),
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
      systemTools: {
        resolve: async () => ({
          executable: { kind: 'systemTool' as const, id: 'codex-cli' },
          executablePath: '/fixture/codex',
        }),
      },
      clients: {
        spawn: async (spec: PluginProtocolClientSpec) => {
          specs.push(spec);
          return handle;
        },
      },
    } as unknown as ExecService;

    return {
      exec,
      specs,
      readRequests: () => requests,
      readDisposeCount: () => disposeCount,
    };
  }

  it('skips session-controls probes when account settings select ACP', () => {
    expect(
      sessionControls.resolveCodexPreflightSessionControlsPolicy({
        accountSettings: { codexBackendMode: 'acp' },
        timeoutMs: 2_000,
        env: {},
      }),
    ).toBeNull();
  });

  it('clamps app-server RPC timeout and surfaces the Codex auth method', async () => {
    expect(
      sessionControls.resolveCodexPreflightSessionControlsPolicy({
        accountSettings: null,
        timeoutMs: 120_000,
        env: await makeAuthEnv({
          OPENAI_API_KEY: 'sk-test',
        }),
      }),
    ).toEqual({
      processEnv: {
        HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '60000',
      },
      authMethod: 'api_key_env',
    });

    expect(
      sessionControls.resolveCodexPreflightSessionControlsPolicy({
        accountSettings: null,
        timeoutMs: 10,
        env: await makeAuthEnv(),
      }),
    ).toEqual({
      processEnv: {
        HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '250',
      },
      authMethod: null,
    });
  });

  it('declares retry caching for Codex app-server preflight probes', () => {
    expect(sessionControls.codexPreflightSessionControlsProbeConfig).toEqual(expect.objectContaining({
      failureCacheStrategy: 'retry',
      needsAccountSettings: true,
      resolveProbeVariant: expect.any(Function),
      probeModelsRaw: expect.any(Function),
      probeModesRaw: expect.any(Function),
      probeConfigOptionsRaw: expect.any(Function),
      probePassiveRealtimeSetupRaw: expect.any(Function),
    }));
  });

  it('checks passive realtime setup through a cold no-thread app-server probe', async () => {
    const fixture = createPreflightExecFixture({
      realtimeAdvertised: true,
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
        throw new Error(`Unexpected method: ${method}`);
      },
    });
    const probe = (
      sessionControls.codexPreflightSessionControlsProbeConfig as Readonly<Record<string, unknown>>
    ).probePassiveRealtimeSetupRaw;

    expect(probe).toBeTypeOf('function');
    if (typeof probe !== 'function') return;

    await expect(probe({
      exec: fixture.exec,
      cwd: '/workspace',
      timeoutMs: 2_000,
      accountSettings: null,
      env: await makeAuthEnv({ OPENAI_API_KEY: 'sk-test' }),
    })).resolves.toEqual({ v: 1, status: 'ready' });
    expect(fixture.specs[0]).toMatchObject({
      launch: {
        args: ['app-server', '--listen', 'stdio://', '--enable', 'realtime_conversation'],
      },
    });
    const passiveRequests = fixture.readRequests().filter((request) => request.method !== 'initialize');
    expect(passiveRequests).toEqual([
      {
        method: 'account/read',
        params: { refreshToken: false },
        options: { timeoutMs: 2_000 },
      },
      {
        method: 'experimentalFeature/list',
        params: { cursor: null, limit: 100 },
        options: { timeoutMs: 2_000 },
      },
    ]);
    expect(passiveRequests.every((request) => (
      !request.method.startsWith('thread/') && !request.method.startsWith('realtime/')
    ))).toBe(true);
    expect(fixture.readDisposeCount()).toBe(1);
  });

  it.each([
    [
      'accepts a supported Codex account',
      {
        requiresOpenaiAuth: true,
        account: { type: 'chatgpt', email: 'voice@example.test', planType: 'plus' },
      },
      { v: 1, status: 'ready' },
      ['account/read', 'experimentalFeature/list'],
    ],
    [
      'reports a missing required OpenAI account',
      { requiresOpenaiAuth: true, account: null },
      { v: 1, status: 'authentication_required' },
      ['account/read'],
    ],
    [
      'does not treat a no-auth local account state as selected Codex authentication',
      { requiresOpenaiAuth: false, account: null },
      { v: 1, status: 'authentication_required' },
      ['account/read'],
    ],
    [
      'fails closed for an invalid account shape',
      { requiresOpenaiAuth: true, account: { type: 42 } },
      { v: 1, status: 'unavailable' },
      ['account/read'],
    ],
  ] as const)('%s', async (_label, accountResponse, expected, expectedMethods) => {
    const fixture = createPreflightExecFixture({
      realtimeAdvertised: true,
      request: async (method) => {
        if (method === 'initialize') return {};
        if (method === 'account/read') return accountResponse;
        if (method === 'experimentalFeature/list') {
          return {
            data: [{ name: 'realtime_conversation', enabled: true }],
            nextCursor: null,
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    });

    await expect(sessionControls.probeCodexPassiveRealtimeSetupRaw({
      exec: fixture.exec,
      cwd: '/workspace',
      timeoutMs: 2_000,
      accountSettings: null,
      env: await makeAuthEnv({ OPENAI_API_KEY: 'sk-test' }),
    })).resolves.toEqual(expected);
    expect(fixture.readRequests().map((request) => request.method).filter((method) => method !== 'initialize'))
      .toEqual(expectedMethods);
    expect(fixture.readDisposeCount()).toBe(1);
  });

  it('cancels an in-flight cold setup probe without issuing a feature or realtime request', async () => {
    let settleAccountRead: ((value: unknown) => void) | null = null;
    const accountRead = new Promise<unknown>((resolve) => {
      settleAccountRead = resolve;
    });
    const fixture = createPreflightExecFixture({
      realtimeAdvertised: true,
      request: async (method) => {
        if (method === 'initialize') return {};
        if (method === 'account/read') return await accountRead;
        throw new Error(`Unexpected method: ${method}`);
      },
    });
    const controller = new AbortController();

    const probe = sessionControls.probeCodexPassiveRealtimeSetupRaw({
      exec: fixture.exec,
      cwd: '/workspace',
      timeoutMs: 2_000,
      accountSettings: null,
      env: await makeAuthEnv({ OPENAI_API_KEY: 'sk-test' }),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(
      fixture.readRequests().find((request) => request.method === 'account/read'),
    ).toEqual({
      method: 'account/read',
      params: { refreshToken: false },
      options: { signal: controller.signal, timeoutMs: 2_000 },
    }));
    controller.abort();

    await expect(probe).resolves.toEqual({ v: 1, status: 'unavailable' });
    expect(fixture.readRequests().map((request) => request.method)).not.toContain('experimentalFeature/list');
    expect(fixture.readRequests().some((request) => (
      request.method.startsWith('thread/') || request.method.startsWith('realtime/')
    ))).toBe(false);
    expect(fixture.readDisposeCount()).toBe(1);
    settleAccountRead?.({
      requiresOpenaiAuth: true,
      account: { type: 'chatgpt', email: 'late@example.test', planType: 'plus' },
    });
  });

  it('probes Codex app-server session controls through the exec-client runtime', async () => {
    const fixture = createPreflightExecFixture();
    const models = await sessionControls.codexPreflightSessionControlsProbeConfig.probeModelsRaw?.({
      exec: fixture.exec,
      cwd: '/workspace',
      timeoutMs: 2_000,
      accountSettings: null,
      env: await makeAuthEnv({ OPENAI_API_KEY: 'sk-test' }),
    });

    expect(models).toEqual([
      {
        id: 'gpt-5.5',
        name: 'GPT 5.5',
        modelOptions: [
          {
            id: 'reasoning_effort',
            name: 'Thinking',
            type: 'select',
            currentValue: 'medium',
            options: [
              { value: 'medium', name: 'Medium', description: 'Balanced' },
            ],
          },
        ],
      },
    ]);
    expect(fixture.specs[0]).toMatchObject({
      kind: 'jsonRpc',
      launch: {
        executable: { kind: 'systemTool', id: 'codex-cli' },
        cwd: { root: 'workspace', relativePath: '' },
        args: ['app-server', '--listen', 'stdio://'],
      },
      framing: 'jsonLines',
      requestTimeoutMs: 2_000,
    });
    expect(fixture.readDisposeCount()).toBe(1);
  });

  it('does not inherit runtime RPC-log diagnostics for preflight probes', async () => {
    const fixture = createPreflightExecFixture();
    const env = await makeAuthEnv({
      OPENAI_API_KEY: 'sk-test',
      HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH: '/tmp/ambient-codex-rpc.jsonl',
      HAPPIER_CODEX_APP_SERVER_RPC_LOG_MAX_BYTES: '1234',
      HAPPIER_CODEX_APP_SERVER_RPC_LOG_ROTATE_COUNT: '3',
    });

    const models = await sessionControls.codexPreflightSessionControlsProbeConfig.probeModelsRaw?.({
      exec: fixture.exec,
      cwd: '/workspace',
      timeoutMs: 2_000,
      accountSettings: null,
      env,
    });

    expect(models).toHaveLength(1);
    expect(fixture.specs[0]).not.toHaveProperty('lifecycle');
    expect(fixture.readDisposeCount()).toBe(1);
  });
});
