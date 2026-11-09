import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { x25519 } from '@noble/curves/ed25519';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { PushNotificationClient } from '@/api/pushNotifications';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { artifactListResponse, artifactReadResponse } from '@/testkit/http/artifactHome';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { registerDaemonCommittedServiceHealthDeliveryRpcHandler } from './committedServiceHealthDelivery';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

describe('committed service health receiver admission', () => {
  it('binds the Home identity once at receiver admission', async () => {
    const source = await readFile(new URL('./committedServiceHealthDelivery.ts', import.meta.url), 'utf8');
    expect([...source.matchAll(/\bisServerProfileHomeIdentity\(/g)]).toHaveLength(1);
    expect([...source.matchAll(/\breadAccountIdFromToken\(/g)]).toHaveLength(0);
  });
  it.each(['plain', 'e2ee'] as const)('delivers the exact private %s revision with one admission and one Artifact read', async mode => {
    const accountId = 'health-owner';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const machineKey = new Uint8Array(randomBytes(32));
    const credentials = { token, encryption: mode === 'plain' ? null
      : { type: 'dataKey' as const, machineKey, publicKey: x25519.getPublicKey(machineKey) } };
    const baseUrl = `http://committed-health-${mode}.test`;
    const rows = new Map<string, { id: string } & Record<string, unknown>>();
    const reads: string[] = [];
    // Only Home HTTP, installed-runtime lifetime and native push are boundary
    // substitutes; RPC admission, C1 codecs/privacy and dispatch remain real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      reads.push(path);
      if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200,
        data: createAccountEncryptionCurrentnessFixture({ mode }) };
      if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(String(url), [...rows.values()]) };
      const row = rows.get(path.split('/')[3]!);
      return row ? { status: 200, data: row } : { status: 404, data: {} };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, input: unknown) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/artifacts/read') {
        reads.push(path);
        return artifactReadResponse(input, id => rows.get(id) ?? null);
      }
      const mutation = readCarrierMutation(input);
      const id = typeof mutation.id === 'string' ? mutation.id : path.split('/').at(-1)!;
      const version = Number(rows.get(id)?.bodyVersion ?? 0) + 1;
      rows.set(id, { ...rows.get(id), ...mutation, id, ownerAccountId: accountId, access: 'owner',
        publicAudience: 'none', encryptionMode: mode, headerVersion: version, bodyVersion: version,
        seq: version, createdAt: 1, updatedAt: version });
      return { status: 200, data: { id, success: true, headerVersion: version, bodyVersion: version } };
    });
    const push = vi.spyOn(PushNotificationClient.prototype, 'sendToAllDevicesAsync').mockResolvedValue(true);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
      notificationChannelCatalog: { status: 'ready', revision: 1, diagnostics: [], channels: [
        NotificationChannelRecordV1Schema.parse({ v: 1, id: 'health-push', kind: 'expo_push', topics: { machines: true } }),
      ] } });
    const subject = { kind: 'deployment', machineId: 'source-machine', environmentId: 'environment',
      environmentInstanceId: 'instance', composeService: 'db', serviceId: 'instance/db' } as const;
    const store = createCredentialedAccountArtifactStore(credentials);
    const receipt = await runWithServerHttpBaseUrl(baseUrl, () => store.writeNotice({ accountId,
      source: { kind: 'host', topic: 'service_health', subject }, page: { kind: 'host', page: 'machine_service',
        machine: { serverId: 'home', machineId: subject.machineId }, service: subject },
      title: 'db needs attention', type: 'blocked', healthPhase: 'open', resolved: false, body: 'Service health: failed.' }));
    let admissionReads = 0;
    let admitted = true;
    const runtimeCurrent = vi.fn(async () => true);
    const receiver = new RpcHandlerManager({ scopePrefix: 'controller', localMachineId: 'controller',
      encryptionMode: 'plain', logger: () => {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
        machineId: 'controller', resolveCustodianAccountId: async () => accountId,
        resolveInstallationId: () => 'installation',
        verifyMachineAdmission: async () => { admissionReads++; return admitted; },
      }) });
    registerDaemonCommittedServiceHealthDeliveryRpcHandler(receiver, {
      target: () => ({ serverId: 'home', machineId: 'controller', installationId: 'installation', custodianAccountId: accountId }),
      resolveRuntime: async () => ({ credentials, accountId, serverId: 'home', serverHttpBaseUrl: baseUrl,
        machineId: 'controller', isCurrent: runtimeCurrent }),
    });
    const invoke = (actorAccountId = accountId, revision = receipt.revision, serverId = 'home') => receiver.handleRequest({
      method: `controller:${RPC_METHODS.DAEMON_SERVICE_HEALTH_DELIVER}`,
      callerAuthority: 'account_automation', params: { machineId: 'controller', serverId, artifactId: receipt.artifactId, revision },
      machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({ machineId: 'controller', installationId: 'installation',
        actorAccountId, custodianAccountId: accountId, role: 'manage', encryptionMode: mode }),
    });
    reads.length = 0;
    expect(await invoke()).toEqual({ kind: 'attempted' });
    expect(admissionReads).toBe(1);
    const artifactPath = `/v1/artifacts/${encodeURIComponent(receipt.artifactId)}`;
    expect(reads.filter(path => path === artifactPath)).toHaveLength(1);
    expect(reads.filter(path => path !== artifactPath && !path.startsWith('/v1/account/encryption'))).toEqual([]);
    expect(runtimeCurrent).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1);
    // Each new request is a natural admission boundary, including denial.
    const pushes = push.mock.calls.length;
    expect(await invoke('another-person')).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(await invoke(accountId, receipt.revision, 'another-home')).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(push).toHaveBeenCalledTimes(pushes);
    expect(await invoke(accountId, { ...receipt.revision, bodyVersion: receipt.revision.bodyVersion + 1 })).toEqual({ kind: 'suppressed' });
    expect(push).toHaveBeenCalledTimes(pushes);
    const row = rows.get(receipt.artifactId)!;
    rows.set(receipt.artifactId, { ...row, ownerAccountId: 'another-person' });
    expect(await invoke()).toEqual({ kind: 'suppressed' });
    expect(push).toHaveBeenCalledTimes(pushes);
    rows.set(receipt.artifactId, row);
    admitted = false;
    expect(await invoke()).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(push).toHaveBeenCalledTimes(pushes);
  });
});
