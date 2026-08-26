import { describe, expect, it } from 'vitest';

import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
  AgentPreflightJsonRpcRequestClientV1,
  AgentPreflightSessionControlsProbeContextV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { CODEX_PREFLIGHT_SESSION_CONTROLS } from './sessionControls.js';

function createPreflightContext(params: Readonly<{
  accountSettings?: Readonly<Record<string, JsonValue>> | null;
  environment?: Readonly<Record<string, boolean>>;
  request(method: string, requestParams?: JsonValue): Promise<JsonValue>;
}>) {
  const controller = new AbortController();
  const commands: Array<Readonly<{ toolId: string; args: readonly string[] }>> = [];
  const requests: Array<Readonly<{ method: string; params: JsonValue | undefined }>> = [];
  const client: AgentPreflightJsonRpcRequestClientV1 = Object.freeze({
    request: async (method, requestParams) => {
      requests.push({ method, params: requestParams });
      return await params.request(method, requestParams);
    },
  });
  const context: AgentPreflightSessionControlsProbeContextV1 = {
    accountSettings: params.accountSettings ?? null,
    environment: params.environment ?? Object.freeze({}),
    signal: controller.signal,
    runDeclaredSystemToolCommand: async () => ({
      ok: false,
      stdout: '',
      stderr: '',
      exitCode: null,
    }),
    withDeclaredJsonRpcClient: async <TResult>(command, inspect) => {
      commands.push(command);
      return await inspect(client, controller.signal);
    },
  };
  return { context, commands, requests };
}

describe('CODEX_PREFLIGHT_SESSION_CONTROLS', () => {
  it('declares a request-only app-server probe with host-owned diagnostics and cache policy', () => {
    expect(CODEX_PREFLIGHT_SESSION_CONTROLS.jsonRpcCommand).toEqual({
      toolId: 'codex-cli',
      args: ['app-server', '--listen', 'stdio://'],
      environmentExcludeKeys: [
        'HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH',
        'HAPPIER_CODEX_APP_SERVER_RPC_LOG_MAX_BYTES',
        'HAPPIER_CODEX_APP_SERVER_RPC_LOG_ROTATE_COUNT',
      ],
    });
    expect(CODEX_PREFLIGHT_SESSION_CONTROLS).not.toHaveProperty('failureCacheStrategy');
    expect(CODEX_PREFLIGHT_SESSION_CONTROLS).not.toHaveProperty('connectedServiceAuth');
    expect(CODEX_PREFLIGHT_SESSION_CONTROLS).not.toHaveProperty('needsAccountSettings');
  });

  it('reads models through the host JSON-RPC scope without process or timeout controls', async () => {
    const fixture = createPreflightContext({
      environment: Object.freeze({ OPENAI_API_KEY: true }),
      request: async (method) => {
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
    }]);
    expect(fixture.requests.map(({ method }) => method).sort())
      .toEqual(['collaborationMode/list', 'model/list']);
  });

  it('checks passive realtime eligibility in the same bounded app-server scope', async () => {
    const fixture = createPreflightContext({
      request: async (method) => {
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
      .toEqual(['account/read', 'experimentalFeature/list']);
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
