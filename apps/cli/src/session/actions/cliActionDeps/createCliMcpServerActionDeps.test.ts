import { afterEach, describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { callSocketRpc } from '@happier-dev/sync-client';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { clearActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createDeferred } from '@/testkit/async/deferred';
import { createCliMcpServerActionExecuteV1 } from './createCliMcpServerActionDeps';

afterEach(() => resetActiveAccountSettingsSnapshotForTests());

describe('MCP Machine Action transport disposition', () => {
  it('reports an issued cancelled process test as unknown, not as an unexecuted cancellation', async () => {
    const base = 'https://mcp-machine.example.test';
    await runWithServerHttpBaseUrl(base, async () => {
      const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-machine-account' })).toString('base64url')}.signature`, encryption: null };
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      const issued = createDeferred<void>();
      const reply = createDeferred<unknown>();
      const controller = new AbortController();
      const execute = createCliMcpServerActionExecuteV1({ credentials, serverId: 'home', serverHttpBaseUrl: base,
          // Socket emit is the replaced boundary. The real request-correlated
          // cancellation/disposition owner remains beneath the Action adapter.
          callMachineAction: input => callSocketRpc({ target: { kind: 'machine', id: input.machineId },
            method: input.method, params: input.request, content: { mode: 'plain' }, signal: input.signal,
            randomBytes: length => new Uint8Array(length), socket: { connected: true, emit: () => {},
              emitWithAck: async () => { issued.resolve(); return reply.promise; } } }),
        });
      const pending = execute({ actionId: 'mcp.servers.test', input: { t: 'byId', machineId: 'exact-machine',
        directory: '/project', serverId: 'server' }, context: { surface: 'cli', authority: 'present_user',
        serverId: 'home', actionCaller: { kind: 'host' }, signal: controller.signal } });
      await issued.promise;
      controller.abort();
      expect(await pending).toEqual({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
      reply.resolve({ ok: true, result: { ok: true, toolCount: 1, durationMs: 1 } });
    });
  });
  it('retains an acknowledged process-test receipt but refuses probe content after Account retirement', async () => {
    const base = 'https://mcp-machine.example.test';
    await runWithServerHttpBaseUrl(base, async () => {
      const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-machine-account' })).toString('base64url')}.signature`, encryption: null };
      for (const actionId of ['mcp.servers.test', 'mcp.servers.probe'] as const) {
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
          settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
        const receipt = actionId === 'mcp.servers.test' ? { ok: true, toolCount: 1, durationMs: 1 }
          : { ok: true, servers: [] };
        const execute = createCliMcpServerActionExecuteV1({ credentials, serverId: 'home', serverHttpBaseUrl: base,
            callMachineAction: async input => {
              const result = await callSocketRpc({ target: { kind: 'machine', id: input.machineId },
                method: input.method, params: input.request, content: { mode: 'plain' },
                randomBytes: length => new Uint8Array(length), socket: { connected: true, emit: () => {},
                  emitWithAck: async () => ({ ok: true, result: receipt }) } });
              // The transport has consumed its genuine ACK before the Account
              // retires; private read content and effect receipts differ here.
              clearActiveAccountSettingsSnapshot();
              return result;
            },
          });
        const input = actionId === 'mcp.servers.test' ? { t: 'byId', machineId: 'exact-machine', directory: '/project', serverId: 'server' }
          : { machineId: 'exact-machine', directory: '/project' };
        expect(await execute({ actionId, input, context: { surface: 'cli', authority: 'present_user', serverId: 'home',
          actionCaller: { kind: 'host' } } })).toEqual(actionId === 'mcp.servers.test'
          ? { ok: true, result: receipt } : { ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
      }
    });
  });
});
