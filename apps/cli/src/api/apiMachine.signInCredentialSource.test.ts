import { osStore } from '@/testkit/machines/nativeSoftwareInstall';
import axios, { AxiosHeaders } from 'axios';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { sealConnectedAccountCatalogContentV1, type ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { Machine } from './types';
import type { RpcHandlerContext } from './rpc/types';
import { ApiMachineClient } from './apiMachine';
import { configuration } from '@/configuration';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';

describe('Machine sign-in credential source Account custody', () => {
  it.each([true, false])('uses requester purpose defaults, with requester connected=%s, instead of daemon defaults', async requesterConnected => {
    const channel = await createRequesterCurrentnessSocketHarness();
    const pair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    const installationId = '11111111-1111-4111-8111-111111111111';
    osStore.identity = { version: 1, installationId, createdAt: 1,
      publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
    const token = (id: string) => `header.${Buffer.from(JSON.stringify({ sub: id })).toString('base64url')}.signature`;
    const alice = { token: token('alice'), encryption: null };
    const bob = { token: token('bob'), encryption: null };
    osStore.credentials = alice;
    const consumer = { pluginId: 'happier.scm.forge.github', localId: 'gh' };
    const service = { pluginId: consumer.pluginId, localId: 'github-account' };
    const catalog = (connected: boolean): ConnectedAccountCatalogRecordV1 => ({ key: 'purposes', value: { v: 1, bindings: connected
      ? [{ purpose: { consumer, purpose: 'github.cli' }, target: { kind: 'account', account: { service, accountId: 'unavailable-selected' } } }]
      : [] } });
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKeyForToken(alice.token),
      settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      connectedPurposeCatalog: { status: 'ready', revision: 1, record: catalog(!requesterConnected) } });
    const requests: string[] = [];
    // Only the Account HTTP transport and device-local OS store are substituted.
    // Private requester custody, catalog opening and selection remain real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      const path = new URL(String(url)).pathname;
      const isBob = AxiosHeaders.from(options?.headers).get('Authorization') === `Bearer ${bob.token}`;
      requests.push(`${isBob ? 'bob' : 'alice'}:${path}`);
      if (path === '/v1/account/profile') return { status: 200, data: { id: isBob ? 'bob' : 'alice' } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      if (path === '/v1/account/entity-rows/connected-accounts/purposes') return { status: 200, data: {
        status: 'present', revision: 1, content: sealConnectedAccountCatalogContentV1({ mode: 'plain', material: null,
          record: catalog(isBob ? requesterConnected : !requesterConnected) }),
      } };
      throw new Error(`Unexpected sign-in metadata request: ${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: [consumer.pluginId] } });
    const machine: Machine = { id: 'alice-machine', encryptionMode: 'plain', metadata: null, metadataVersion: 0,
      daemonState: null, daemonStateVersion: 0 };
    const client = new ApiMachineClient(alice.token, machine);
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'bob-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      serverIdentityId: 'stable-home', machineId: machine.id, installationId, actionId: 'machines.agents.signIn.status',
      requestId: 'bob-sign-in', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: machine.id },
    } });
    let requester: ReturnType<typeof readRequesterAccountActionContext> = null;
    try {
      const http = await projectExternalActionRequesterHttpAuthorization({ authorization: root, serverId: configuration.activeServerId,
        serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://bob-home.test', target: root.binding.target,
        installationId, privateKey: pair.secretKey, isCurrent: async () => true });
      if (!http) throw new Error('Original HTTP custody missing');
      requester = await admitRequesterAccountActionContext({ authorization: http, credentials: bob,
        serverId: configuration.activeServerId, serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://bob-home.test',
        purpose: { kind: 'external_action' }, isCurrent: async () => true });
      if (!requester) throw new Error('Private requester custody missing');
      const authorization = requester.authorization;
      const ingress: RpcHandlerContext = { signal: new AbortController().signal, callerInputAuthorization: authorization,
        machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: machine.id, installationId,
          role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
      osStore.reads.length = 0;
      expect(await client.readSignInConnectedDefaultSelection(`${consumer.pluginId}/${consumer.localId}`, ingress))
        .toBe(requesterConnected ? 'connectedAccount' : 'native');
      expect(osStore.reads).toEqual([]);
      expect(requests).toContain('bob:/v1/account/entity-rows/connected-accounts/purposes');
      expect(requests).not.toContain('alice:/v1/account/entity-rows/connected-accounts/purposes');
      expect(await client.readSignInConnectedDefaultSelection(`${consumer.pluginId}/${consumer.localId}`,
        { ...ingress, callerInputAuthorization: root })).toBeNull();
      expect(await client.readSignInConnectedDefaultSelection(`${consumer.pluginId}/${consumer.localId}`,
        { ...ingress, callerInputAuthorization: undefined })).toBeNull();
    } finally {
      await requester?.dispose(); await client.shutdown(); await runtime.dispose(); await channel.close(); get.mockRestore(); post.mockRestore();
      resetActiveAccountSettingsSnapshotForTests(); osStore.identity = null; osStore.credentials = null;
    }
  });
});
