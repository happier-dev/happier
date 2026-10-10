import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { persistRemoteHostAfterRemoteSshCompletion } from './persistRemoteHostAfterRemoteSshCompletion';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let disposeNativeStorage: (() => void) | undefined;
let failLocalOverrideWrite = false;
let localOverrideWriteFailed = false;

beforeAll(async () => {
    // Metro's call-time require must reach the same canonical native storage boundary as Vitest imports.
    const native = await loadVitestModuleForNodeRequire(pathToFileURL(createRequire(import.meta.url).resolve('react-native-mmkv')),
        () => import('react-native-mmkv'));
    disposeNativeStorage = native.dispose;
    const write = native.module.MMKV.prototype.set;
    vi.spyOn(native.module.MMKV.prototype, 'set').mockImplementation(function (this: InstanceType<typeof native.module.MMKV>, key, value) {
        if (failLocalOverrideWrite && key.startsWith('remote-host-local-overrides-v1')) {
            localOverrideWriteFailed = true;
            throw new Error('Native storage write failed');
        }
        write.call(this, key, value);
    });
});
beforeEach(() => { failLocalOverrideWrite = false; localOverrideWriteFailed = false; });
afterEach(async () => {
    failLocalOverrideWrite = false;
    await homes.reset();
    const profiles = await import('@/sync/domains/server/serverProfiles');
    for (const profile of profiles.listServerProfiles()) {
        if (profile.serverUrl === 'https://discovered-relay.example') await profiles.removeServerProfile(profile.id);
    }
});

type Params = Parameters<typeof persistRemoteHostAfterRemoteSshCompletion>[0];
function completion(scope: ServerAccountScope, overrides: Partial<Params> = {}): Params {
    return { scope, expectedRevision: 4, managementEnabled: true, secretMaterialEnabled: false,
        selectedSavedRemoteHostId: '__new__', runContext: { selectedSavedRemoteHostId: '__new__', saveHost: true, saveSecretMaterial: false },
        newHostSentinelId: '__new__', draft: { username: 'dev', host: 'remote.example', port: '22', authMode: 'agent',
            identityFilePath: '/device/key', password: '' }, privateKeyMaterialDraft: '',
        completion: { machineId: 'machine-remote', relayRuntimeUrl: 'https://discovered-relay.example' }, ...overrides };
}
async function seedSource(): Promise<ServerAccountScope> {
    const source = await homes.addHome({ name: 'Source', serverUrl: 'https://source.example', accountId: 'source-account', active: false });
    await homes.addHome({ name: 'Focused', serverUrl: 'https://focused.example', active: true });
    homes.answer(source, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
    homes.answer(source, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: {} } } });
    homes.answer(source, '/v2/account/settings/history', { body: { snapshots: [] } });
    homes.answer(source, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
    homes.answer(source, '/v1/account/saved-secrets/resources/materials', { body: { resources: [] } });
    homes.answer(source, '/v1/account/entity-rows/remote-hosts', { body: { status: 'present', revision: 4,
        content: { t: 'plain', v: { v: 1, hosts: [] } } } });
    homes.answer(source, 'POST /v1/account/entity-rows/remote-hosts', { body: { status: 'updated', revision: 5, cursor: 1 } });
    return { serverId: source, accountId: 'source-account' };
}

describe('Remote SSH completion through Home and Account owners', () => {
    it('still adopts the discovered Home without moving focus when host management is disabled', async () => {
        const scope = await seedSource();
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const before = profiles.getActiveServerSnapshot();
        await profiles.saveHomeViewState({ version: 1, groups: [{ id: 'visible-homes', name: 'Visible Homes', serverIds: [before.serverId] }],
            activeTargetKind: 'server', activeTargetId: before.serverId });
        const viewBefore = profiles.loadHomeViewState();
        const owner = await import('./persistRemoteHostAfterRemoteSshCompletion');
        const withoutCatalog = { ...completion(scope, { managementEnabled: false, runContext: null }), scope: null, expectedRevision: null };
        await expect(owner.persistRemoteHostAfterRemoteSshCompletion(withoutCatalog)).resolves.toEqual({ ok: false, reason: 'not_requested' });
        expect(profiles.listServerProfiles()).toContainEqual(expect.objectContaining({ serverUrl: 'https://discovered-relay.example', source: 'manual' }));
        expect(profiles.getActiveServerSnapshot()).toMatchObject({ serverId: before.serverId, serverUrl: before.serverUrl });
        expect(profiles.loadHomeViewState()).toEqual(viewBefore);
        expect(homes.requestsFor('/v1/account/entity-rows/remote-hosts')).toEqual([]);
    });

    it('keeps a durable host acknowledgement successful when the device-local override write fails', async () => {
        const scope = await seedSource();
        const owner = await import('./persistRemoteHostAfterRemoteSshCompletion');
        failLocalOverrideWrite = true;
        const result = await owner.persistRemoteHostAfterRemoteSshCompletion(completion(scope));
        const writes = homes.requestsFor('/v1/account/entity-rows/remote-hosts')
            .filter(request => request.input !== null);
        expect(writes).toHaveLength(1);
        expect(localOverrideWriteFailed).toBe(true);
        expect(result).toMatchObject({ ok: true, revision: 5, hostId: expect.any(String), localOverrides: 'pending' });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const relay = profiles.listServerProfiles().find(profile => profile.serverUrl === 'https://discovered-relay.example');
        expect(writes[0]?.input).toMatchObject({ mutation: { content: { t: 'plain', v: { hosts: [
            { id: result.ok ? result.hostId : '', linkedMachineId: 'machine-remote', linkedRelayProfileId: relay?.id },
        ] } } } });
    });

    it('refuses malformed discovered Homes before a catalog mutation', async () => {
        const scope = await seedSource();
        const owner = await import('./persistRemoteHostAfterRemoteSshCompletion');
        const result = await owner.persistRemoteHostAfterRemoteSshCompletion(completion(scope,
            { completion: { machineId: null, relayRuntimeUrl: 'ssh://not-a-home' } }));
        expect(result.ok).toBe(false);
        expect(homes.requestsFor('/v1/account/entity-rows/remote-hosts').filter(request => request.input !== null)).toEqual([]);
    });

    it('refuses completion writes to a partial catalog rather than overwriting unknown sibling rows', async () => {
        const scope = await seedSource();
        const host = { id: 'host-1', name: 'Developer', ssh: { target: 'dev@remote.example', authMode: 'agent' as const },
            createdAt: 1, updatedAt: 1, lastUsedAt: null };
        homes.answer(scope.serverId, '/v1/account/entity-rows/remote-hosts', { body: { status: 'present', revision: 4,
            content: { t: 'plain', v: { v: 1, hosts: [host, { id: 'future-host', v: 2, transport: 'future' }] } } } });
        const owner = await import('./persistRemoteHostAfterRemoteSshCompletion');
        const result = await owner.persistSavedRemoteHostAfterRemoteSshCompletion({ scope, host, expectedRevision: 4,
            completion: { machineId: 'machine-remote', relayRuntimeUrl: null } });
        expect(result.ok).toBe(false);
        expect(homes.requestsFor('/v1/account/entity-rows/remote-hosts').filter(request => request.input !== null)).toEqual([]);
    });
});

// Restore only this file's native boundary cache bridge; no production owner is replaced.
afterAll(() => { disposeNativeStorage?.(); });
