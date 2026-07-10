import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type {
  ExecClientHandleV1,
  ExecClientSpecV1,
  ExecProcessHandleV1,
  ExecRuntimeServiceV1,
  JsonRpcClientV1,
} from '@happier-dev/plugin-sdk';

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

  function createPreflightExecFixture() {
    const specs: ExecClientSpecV1[] = [];
    let disposeCount = 0;
    const client: JsonRpcClientV1 = {
      request: async (method) => {
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
      registerRequestHandler: () => () => {},
      registerNotificationHandler: () => () => {},
    };
    const processHandle: ExecProcessHandleV1 = {
      pid: 1,
      exit: Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      writeStdin: async () => {},
      kill: () => {},
      dispose: async () => {},
    };
    const handle: ExecClientHandleV1<JsonRpcClientV1> = {
      client,
      process: processHandle,
      status: 'running',
      onExit: () => () => {},
      dispose: async () => {
        disposeCount += 1;
      },
    };
    const exec: ExecRuntimeServiceV1 = {
      systemTools: {
        resolve: async () => {
          throw new Error('system tools should not be used for Codex preflight');
        },
      },
      run: async () => {
        throw new Error('run should not be used for Codex preflight');
      },
      spawn: async () => {
        throw new Error('spawn should not be used for Codex preflight');
      },
      spawnClient: (async (spec: ExecClientSpecV1) => {
        specs.push(spec);
        return handle;
      }) as ExecRuntimeServiceV1['spawnClient'],
    };

    return {
      exec,
      specs,
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
    }));
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
      launch: {
        kind: 'agent-cli',
        agentId: 'codex',
        cwd: '/workspace',
        args: ['app-server', '--listen', 'stdio://'],
      },
      protocol: { kind: 'json-rpc-2.0' },
      lifecycle: {
        requestTimeoutMs: 2_000,
      },
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
    expect(fixture.specs[0]?.lifecycle?.diagnostics).toBeUndefined();
    expect(fixture.readDisposeCount()).toBe(1);
  });
});
