import { describe, expect, it, vi } from 'vitest';

import { accountSettingsParse, deriveSettingsSecretsKeyV1, encryptSecretStringV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';
import type { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';

type BootstrapAccountSettingsContextParams = Parameters<typeof bootstrapAccountSettingsContext>[0];

function deterministicRandomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    out[index] = (index + 1) & 0xff;
  }
  return out;
}

describe('rpcHandlers.mcpServers (saved secret refresh)', () => {
  it('forces a fresh settings fetch so draft tests can resolve newly saved secrets', async () => {
    const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => {
        handlers.set(method, handler);
      },
    } as any;

    const credentials = {
      token: 'tok_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
    };
    const settingsSecretsKey = deriveSettingsSecretsKeyV1(credentials.encryption.secret);
    const encryptedSecret = encryptSecretStringV1('Bearer test-secret', settingsSecretsKey, deterministicRandomBytes);
    const staleSettings = accountSettingsParse({});
    const freshSettings = accountSettingsParse({
      secrets: [{
        id: 'sec_remote_auth',
        name: 'remote auth',
        kind: 'apiKey',
        encryptedValue: { _isSecretValue: true as const, encryptedValue: encryptedSecret },
        createdAt: 1,
        updatedAt: 1,
      }],
    });

    registerMachineMcpServersRpcHandlers({
      rpcHandlerManager,
      deps: {
        readCredentials: async () => credentials as any,
        bootstrapAccountSettingsContext: async (args: BootstrapAccountSettingsContextParams) => ({
          source: args.refresh === 'force' ? 'remote' : 'cache',
          settings: args.refresh === 'force' ? freshSettings : staleSettings,
          settingsVersion: args.refresh === 'force' ? 2 : 1,
          loadedAtMs: 0,
          whenRefreshed: null,
        }),
        probeMcpStdioServerTools: async () => [{ name: 'remote_echo' }],
      },
    } as any);

    const handler = handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST);
    expect(handler).toBeTruthy();

    const out = (await handler!({
      t: 'draft',
      machineId: 'm1',
      directory: '/',
      server: {
        id: 'srv_remote',
        name: 'remote_fixture',
        transport: 'http',
        remote: {
          url: 'https://mcp.example.com',
          headers: {
            Authorization: { t: 'savedSecret', secretId: 'sec_remote_auth' },
          },
        },
        env: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      binding: null,
    })) as any;

    expect(out.ok).toBe(true);
    expect(out.toolNamesSample).toContain('remote_echo');
  });

  it('resolves a plaintext saved secret with token-only credentials', async () => {
    const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => {
        handlers.set(method, handler);
      },
    } as any;
    const tokenOnlyCredentials = {
      token: 'token-only',
      encryption: null,
    };
    const settings = accountSettingsParse({
      secrets: [{
        id: 'sec_remote_auth',
        name: 'remote auth',
        kind: 'apiKey',
        encryptedValue: {
          _isSecretValue: true as const,
          value: 'Bearer token-only-secret',
        },
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    const probeMcpStdioServerTools = vi.fn(async ({ config }: {
      config: { env?: Record<string, string> };
    }) => {
      expect(config.env).toMatchObject({
        HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: expect.any(String),
      });
      return [{ name: 'remote_echo' }];
    });

    registerMachineMcpServersRpcHandlers({
      rpcHandlerManager,
      deps: {
        readCredentials: async () => tokenOnlyCredentials as any,
        bootstrapAccountSettingsContext: async () => ({
          source: 'remote',
          settings,
          settingsVersion: 1,
          loadedAtMs: 0,
          whenRefreshed: null,
        }),
        probeMcpStdioServerTools,
      },
    } as any);

    const handler = handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST);
    expect(handler).toBeTruthy();
    const out = await handler!({
      t: 'draft',
      machineId: 'm1',
      directory: '/',
      server: {
        id: 'srv_remote',
        name: 'remote_fixture',
        transport: 'http',
        remote: {
          url: 'https://mcp.example.com',
          headers: {
            Authorization: { t: 'savedSecret', secretId: 'sec_remote_auth' },
          },
        },
        env: {},
        createdAt: 1,
        updatedAt: 1,
      },
      binding: null,
    });

    expect(out).toMatchObject({ ok: true });
    expect(probeMcpStdioServerTools).toHaveBeenCalledOnce();
  });
});
