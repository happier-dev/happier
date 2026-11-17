import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { accountSettingsParse, deriveSettingsSecretsKeyV1, encryptSecretStringV1, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonMcpServersTestResponseSchema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';

import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveAccountSettingsCachePath } from '@/settings/accountSettings/accountSettingsCache';
import type { StoredCredentials } from '@/persistence';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';
import { createMcpOwnerRpcContext, MCP_TEST_HOME_ID } from './mcpServers.testkit';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const randomBytes = (length: number) => new Uint8Array(length).fill(11);
// A real MCP process advertises a tool only if fresh secret material reached it.
const fixture = String.raw`
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize' ? {
    protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
    serverInfo: { name: 'saved-secret-fixture', version: '1.0.0' }
  } : { tools: process.env.API_KEY === 'newly-saved-private-value'
    ? [{ name: 'fresh_secret_received', inputSchema: { type: 'object' } }] : [] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
`;

describe('rpcHandlers.mcpServers (saved secret refresh)', () => {
  const sourceEnvironment = createEnvKeyScope(['HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT']);
  beforeEach(() => { resetInMemoryAccountSettingsContextForTests();
    sourceEnvironment.patch({ HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1' }); });
  afterEach(() => { resetInMemoryAccountSettingsContextForTests(); sourceEnvironment.restore(); });

  it.each(['plain', 'e2ee'] as const)('refreshes a draft from stale Account settings and consumes its %s saved secret', async mode => {
    const secret = new Uint8Array(32).fill(7);
    const credentials: StoredCredentials = { token: `saved-secret-${mode}`, encryption:
      mode === 'plain' ? null : { type: 'legacy', secret } };
    const sealSettings = (settings: ReturnType<typeof accountSettingsParse>) => mode === 'plain'
      ? { t: 'plain' as const, v: settings }
      : { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
        material: { type: 'legacy', secret }, payload: settings, randomBytes }) };
    let settings = accountSettingsParse({});
    let version = 1;
    // Only Account HTTP/cache I/O is substituted; bootstrap publication,
    // invocation admission, decryption, materialization and probing stay real.
    const bootstrap: typeof bootstrapAccountSettingsContext = input => bootstrapAccountSettingsContext({ ...input,
      honorAccountSettingsModeEnv: false, deps: { resolveCachePath: resolveAccountSettingsCachePath,
        readCache: async () => null, writeCache: async () => undefined,
        fetchFromServer: async () => ({ settingsVersion: version, settingsContent: sealSettings(settings) }),
      } });
    await bootstrap({ credentials, mode: 'blocking', refresh: 'force' });
    settings = accountSettingsParse({ secrets: [{ id: 'new-secret', name: 'New token', kind: 'apiKey',
      encryptedValue: mode === 'plain'
        ? { _isSecretValue: true, value: 'newly-saved-private-value' }
        : { _isSecretValue: true, encryptedValue: encryptSecretStringV1('newly-saved-private-value',
          deriveSettingsSecretsKeyV1(secret), randomBytes) }, createdAt: 1, updatedAt: 1 }] });
    version = 2;
    const rpcHandlerManager = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain' });
    registerMachineMcpServersRpcHandlers({ rpcHandlerManager: { registerHandler(method, handler) {
      rpcHandlerManager.registerHandler(method, (raw, context) => handler(raw, createMcpOwnerRpcContext(context)));
    } } as Pick<RpcHandlerManager, 'registerHandler'> as RpcHandlerManager,
      deps: { hostHomeServerIdentityId: MCP_TEST_HOME_ID, readCredentials: async () => credentials, bootstrapAccountSettingsContext: bootstrap } });
    const result = DaemonMcpServersTestResponseSchema.parse(await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_MCP_SERVERS_TEST, {
      t: 'draft', machineId: 'machine', directory: tmpdir(), server: {
        id: 'draft', name: 'saved_secret_fixture', transport: 'stdio',
        stdio: { command: process.execPath, args: ['-e', fixture] },
        env: { API_KEY: { t: 'savedSecret', secretId: 'new-secret' } }, createdAt: 1, updatedAt: 1,
      }, binding: null,
    }));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, toolCount: 1,
      toolNamesSample: ['fresh_secret_received'] });
    expect(JSON.stringify(result)).not.toContain('newly-saved-private-value');
  });
});
