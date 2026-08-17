import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
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

  function createPreflightExecFixture() {
    const specs: PluginProtocolClientSpec[] = [];
    let disposeCount = 0;
    const client: PluginJsonRpcClient = {
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
