import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AccountSettingsV2UpdateRequestSchema, accountSettingsParse, buildRecoveryCreditConsumeIdempotencyKey } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { StoredCredentials } from '@/persistence';
import { createCliConnectedServiceAction } from './connectedServiceActionDeps';

describe('native connected-service Action adapter', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('settles a pool mutation with unknown outcome when the server never replies', async () => {
    vi.stubEnv('HAPPIER_CONNECTED_SERVICES_API_TIMEOUT_MS', '1000');
    let accepted = false;
    const server = createServer((request) => {
      request.resume();
      request.on('end', () => { accepted = true; });
      // The HTTP boundary accepts the mutation but deliberately withholds its acknowledgement.
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const action = createCliConnectedServiceAction({
      credentials: { token: 'boundary-token', encryption: null },
      serverHttpBaseUrl: `http://127.0.0.1:${address.port}`,
      resolveHeaders: () => ({ Authorization: 'Bearer boundary-token' }),
      callMachineAction: async () => { throw new Error('pool_creation_is_http'); },
    });
    try {
      await expect(action({ actionId: 'connectedServices.pools.create',
        input: { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, group: { groupId: 'pool-boundary' } },
        context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } },
      })).rejects.toMatchObject({ code: 'outcome_unknown' });
      expect(accepted).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 4000);

  it('admits a qualified quota refresh on the selected Home machine and preserves an HTTP refusal', async () => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const account = { service, accountId: 'work-account' };
    const machineRequests: unknown[] = [];
    const http = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { success: true } });
    const action = createCliConnectedServiceAction({ credentials: { token: 'boundary-token', encryption: null },
      serverId: 'work-home', serverHttpBaseUrl: 'https://work.invalid',
      resolveHeaders() { return { Authorization: 'Bearer boundary-token' }; },
      async callMachineAction(request) {
        machineRequests.push(request);
        return { status: 'described', service,
          descriptor: { id: 'openai-codex', title: 'Codex', authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', pkce: 'required', outcomeReconciliation: 'none' }] } },
          occurrenceId: 'occurrence-1', sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-1' } },
          accounts: [], operationTransport: { kind: 'v4' },
        };
      },
    });
    const args = { actionId: 'connectedServices.quota.refresh' as const, input: { account, machineId: 'work-machine' }, context: { surface: 'cli' as const, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const } } };
    expect(await action(args)).toEqual({ applied: true });
    expect(machineRequests).toEqual([{ machineId: 'work-machine', serverId: 'work-home', method: 'daemon.connectedAccounts.control.command',
      request: { v: 1, machineId: 'work-machine', command: { operation: 'describeService', service, requiredOperation: 'quota_refresh' } } }]);
    expect(http).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://work.invalid/v4/connect/qualified/quotas/refresh', method: 'POST', data: { ref: account } }));
    http.mockResolvedValue({ status: 404, data: { error: 'quota_refresh_unavailable' } });
    await expect(action(args)).rejects.toMatchObject({ code: 'quota_refresh_unavailable' });
  });

  it.each(['rename', 'default'] as const)('persists the %s action through the real settings owner and qualified Agent catalog', async (operation) => {
    let written: unknown;
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { version: 1, content: { t: 'plain', v: { futureSetting: { retained: true } } } } };
      throw new Error(`Unexpected HTTP request: ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url: string, body: unknown) => {
      if (!url.endsWith('/v2/account/settings')) throw new Error(`Unexpected HTTP request: ${url}`);
      const request = AccountSettingsV2UpdateRequestSchema.parse(body);
      expect(request.content?.t).toBe('plain');
      if (request.content?.t === 'plain') written = request.content.v;
      return { status: 200, data: { success: true, version: 2 } };
    });
    const action = createCliConnectedServiceAction({
      credentials: { token: 'boundary-token', encryption: null }, serverHttpBaseUrl: 'https://work.invalid',
      resolveHeaders() { throw new Error('configuration_uses_settings_owner'); },
      callMachineAction: async () => { throw new Error('configuration_is_not_machine_rpc'); },
    });
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    await expect(action({
      actionId: operation === 'rename' ? 'connectedServices.accounts.rename' : 'connectedServices.pools.default.set',
      input: operation === 'rename' ? { account: { service, accountId: 'work-account' }, label: 'Work' }
        : { group: { service, groupId: 'work-group' }, agentId: 'codex', makeDefault: true },
      context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } },
    })).resolves.toEqual({ applied: true });
    expect(written).toMatchObject({ futureSetting: { retained: true } });
    if (operation === 'rename') {
      expect(Object.values(accountSettingsParse(written).connectedServicesProfileLabelByKey)).toContain('Work');
    } else {
      expect(written).toMatchObject({ connectedAccountPurposeBindingsV1: {
        bindings: expect.arrayContaining([{ purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
          target: { kind: 'group', service, groupId: 'work-group' } }]),
      } });
    }
  });

  it('reaches the selected Home machine reset owner with the same recovery-credit identity as the app and preserves a refusal', async () => {
    const credentials = { token: 'boundary-test-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } } satisfies StoredCredentials;
    const observed: unknown[] = [];
    // Machine RPC is the external system boundary; request parsing and recovery-key ownership stay real.
    const action = createCliConnectedServiceAction({ credentials, serverId: 'home-work', serverHttpBaseUrl: 'https://work.invalid',
      resolveHeaders() { throw new Error('quota_reset_is_not_http'); },
      async callMachineAction(request) {
        observed.push(request);
        return { ok: false, errorCode: 'reset_unavailable', error: 'reset_unavailable' };
      },
    });
    const input = { machineId: 'machine-work', serviceId: 'openai-codex' as const, profileId: 'account-work', providerCreditId: 'credit-1', sourceSnapshotFetchedAtMs: 10 };
    expect(await action({ actionId: 'connectedServices.quota.reset', input, context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } } }))
      .toEqual({ ok: false, errorCode: 'reset_unavailable', error: 'reset_unavailable' });
    expect(observed).toEqual([{ machineId: 'machine-work', serverId: 'home-work', method: RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME, request: {
      serviceId: 'happier.agent.codex/openai-codex', profileId: input.profileId, providerCreditId: input.providerCreditId,
      idempotencyKey: buildRecoveryCreditConsumeIdempotencyKey(input),
    } }]);
  });
});
