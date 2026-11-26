import axios from 'axios';
import { expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { configuration } from '@/configuration';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

const network = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: network.io }));

it.each(['execute', 'prepare'] as const)('keeps paired-terminal Role %s edits on the authenticated owner Session RPC', async method => {
  await withConfiguredDaemonTestHome({ prefix: 'happier-cli-role-ingress-' }, async () => {
    const serverApiUrl = 'https://role-home.test';
    const sub = 'role-owner';
    const token = `e30.${Buffer.from(JSON.stringify({ sub, tokenEpoch: 1,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' },
    })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    const sessionId = 'c123456789012345678901234';
    const machineId = 'role-machine';
    const session = createSessionRecordFixture({ id: sessionId, active: true, machineId,
      encryptionMode: 'plain', metadata: JSON.stringify({ machineId, path: '/fixture' }),
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
    });
    const scopeKey = runWithServerHttpBaseUrl(serverApiUrl, () => resolveAccountSettingsScopeKey(credentials));
    setActiveAccountSettingsSnapshot({ scopeKey, source: 'network', settings: accountSettingsParse({}),
      rawSettings: {}, settingsVersion: 1, settingsSecretsReadKeys: [], loadedAtMs: 1,
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      throw new Error(`Unexpected fixture Home read: ${new URL(url).pathname}`);
    });
    const actionRelay = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Direct Role RPC fixture has no Machine Action relay'));
    const rpc = vi.fn(async (_event: string, _packet: unknown) => ({ ok: true, result: { updated: true } }));
    network.io.mockImplementation(() => createApiSessionSocketStub({ emitWithAck: (event, packet) => rpc(event, packet),
      emit: (event, [packet, callback]) => {
        if (typeof callback === 'function') void rpc(event, packet).then(value => callback(value));
      } }));
    try {
      const executor = createCliActionExecutorFromCredentials({ credentials, serverApiUrl, machineId,
        serverId: configuration.activeServerId, serverIdentityId: 'srv_role_home',
        actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1,
          approvalWaivedSurfaces: { 'session.role.set': ['cli'] } }) },
      });
      for (const edit of [{ answersWorkerQuestions: false }, { roleId: 'orchestrator' }]) {
        const input = { sessionId, ...edit };
        const context = { surface: 'cli' as const, authority: 'present_user' as const };
        const result = method === 'execute' ? await executor.execute('session.role.set', input, context)
          : await (async () => {
            const prepared = await executor.prepare('session.role.set', input, context);
            return prepared.kind === 'ready' ? prepared.invocation.run() : prepared.result;
          })();
        expect(result)
          .toMatchObject({ ok: true, result: { updated: true } });
        expect(rpc).toHaveBeenLastCalledWith('rpc-call', expect.objectContaining({
          method: `${sessionId}:session.role.set`, params: input,
        }));
      }
      expect(actionRelay).not.toHaveBeenCalled();
    } finally {
      resetActiveAccountSettingsSnapshotForTests();
      vi.restoreAllMocks();
      network.io.mockReset();
    }
  });
});
