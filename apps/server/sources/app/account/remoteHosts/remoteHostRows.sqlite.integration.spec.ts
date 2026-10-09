import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { accountRoutes } from '@/app/api/routes/account/accountRoutes';
import { inTx } from '@/storage/inTx';
import { createSavedSecretResourceInTx, deleteSavedSecretResourceInTx, updateSavedSecretResourceInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { deriveSavedSecretImportResourceIdV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { mutateAccountSettingsHistorySnapshotInTx } from '@/app/accountSettings/accountSettingsHistoryRepository';
import { openPlainAccountSettingsDbValue } from '@/app/encryption/accountSettingsStorage';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { sealRemoteHostCatalogContentV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { SavedSecretCatalogReferenceCensusV1Schema, SharedSavedSecretCreateInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { verifyAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { mutateRemoteHostCatalogRowInTx } from './remoteHostRows';

const route = '/v1/account/entity-rows/remote-hosts';
const host = { id: 'host-preserved', name: 'Build host', ssh: { target: 'builder@example.test', authMode: 'agent' },
    createdAt: 1, updatedAt: 1, lastUsedAt: null };
const content = { t: 'plain', v: { v: 1, hosts: [host] } };

describe('Remote host Account catalog (SQLite integration)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-remote-host-rows-', initEncrypt: true });
    }, 300_000);
    afterAll(async () => { await harness.close(); });
    beforeEach(() => { harness.resetEnv(); });
    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(), () => db.savedSecretResourceKeyEnvelope.deleteMany(),
            () => db.savedSecretAccountGrant.deleteMany(), () => db.savedSecretTeamGrant.deleteMany(),
            () => db.savedSecretGroupGrant.deleteMany(), () => db.savedSecretResource.deleteMany(),
            () => db.accountSettingsSnapshot.deleteMany(), () => db.userKVStore.deleteMany(), () => db.account.deleteMany(),
        ]);
    });

    it('mounts admitted CRUD with host CAS independently of Settings history and preserves exact host identity', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 4,
            settings: JSON.stringify({ t: 'plain', v: { remoteHostsV1: [host] } }) } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        await withAuthenticatedTestApp(accountRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id };
            expect((await app.inject({ method: 'GET', url: route, headers })).json()).toEqual({ status: 'absent' });
            const mutation = { expectedRevision: 'absent', sourceSettingsVersion: 4, content, referencedSavedSecretRevisions: [] };
            expect((await app.inject({ method: 'POST', url: route, headers, payload: { mutation: { ...mutation, sourceSettingsVersion: 3 } } })).json())
                .toEqual({ status: 'settings-conflict', revision: 4 });
            expect(await db.userKVStore.count()).toBe(0);
            expect((await app.inject({ method: 'POST', url: route, headers, payload: { mutation: {
                ...mutation, content: { t: 'plain', v: { v: 1, hosts: [{ ...host, id: 'invented-replacement' }] } },
            } } })).json()).toEqual({ status: 'invalid-stored-content' });
            expect(await db.userKVStore.count()).toBe(0);
            expect((await app.inject({ method: 'POST', url: route, headers, payload: { mutation } })).json())
                .toMatchObject({ status: 'updated', revision: 0 });
            expect((await app.inject({ method: 'GET', url: route, headers: { 'x-test-user-id': other.id } })).json())
                .toEqual({ status: 'absent' });
            expect((await app.inject({ method: 'GET', url: route, headers })).json())
                .toEqual({ status: 'present', revision: 0, content });
            const next = { t: 'plain', v: { v: 1, hosts: [{ ...host, name: 'Renamed', updatedAt: 2 }] } };
            expect((await app.inject({ method: 'POST', url: route, headers,
                payload: { mutation: { expectedRevision: 0, content: next, referencedSavedSecretRevisions: [] } } })).json())
                .toMatchObject({ status: 'updated', revision: 1 });
            expect((await app.inject({ method: 'POST', url: route, headers,
                payload: { mutation: { expectedRevision: 0, content, referencedSavedSecretRevisions: [] } } })).json())
                .toEqual({ status: 'conflict', revision: 1 });
            expect((await app.inject({ method: 'POST', url: route, headers,
                payload: { mutation: { expectedRevision: 1, content: { t: 'plain', v: { v: 1, hosts: [] } }, referencedSavedSecretRevisions: [] } } })).json())
                .toMatchObject({ status: 'updated', revision: 2 });
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).settingsVersion).toBe(4);
            expect(await db.accountSettingsSnapshot.count()).toBe(0);
        });
    });

    it('rejects raw SSH material before mutation and preserves malformed stored entries for client diagnostics', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        await withAuthenticatedTestApp(accountRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id };
            const invalid = await app.inject({ method: 'POST', url: route, headers, payload: { mutation: {
                expectedRevision: 'absent', sourceSettingsVersion: 0, referencedSavedSecretRevisions: [],
                content: { t: 'plain', v: { v: 1, hosts: [{ ...host,
                    ssh: { ...host.ssh, passwordEnc: { _isSecretValue: true, value: 'private' } } }] } },
            } } });
            expect(invalid.statusCode).toBe(400);
            expect(await db.userKVStore.count()).toBe(0);
            const stored = { t: 'plain', v: { v: 1, hosts: [host, { id: 'bad-host', ssh: { target: 4 } }] } };
            await db.userKVStore.create({ data: { accountId: owner.id, key: '@happier/account/remote-hosts/v1/catalog',
                version: 2, value: Buffer.from(JSON.stringify(stored)) } });
            expect((await app.inject({ method: 'GET', url: route, headers })).json())
                .toEqual({ status: 'present', revision: 2, content: stored });
        });
    });

    it('commits sealed SSH resource packets and the host catalog atomically through the authenticated route', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 4,
            settings: JSON.stringify({ t: 'plain', v: { preferredLanguage: 'en' } }) } });
        const resource = (resourceId: string) => ({ resourceId, displayName: 'SSH credential', kind: 'password', encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'SSH credential', kind: 'password', value: 'route-private-fixture' } } });
        const savedSecretResources = [resource('ssh-route-password'), resource('ssh-route-key')];
        const mutation = { expectedRevision: 'absent', sourceSettingsVersion: 4,
            referencedSavedSecretRevisions: savedSecretResources.map(resource => ({ resourceId: resource.resourceId, revision: 1 })),
            content: { t: 'plain', v: { v: 1, hosts: [{ ...host, ssh: { ...host.ssh,
                passwordSecretRef: formatSharedSavedSecretRefV1(savedSecretResources[0]!.resourceId),
                identityPrivateKeySecretRef: formatSharedSavedSecretRefV1(savedSecretResources[1]!.resourceId) } }] } } };
        await withAuthenticatedTestApp(accountRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id };
            expect((await app.inject({ method: 'POST', url: route, headers, payload: {
                mutation: { ...mutation, sourceSettingsVersion: 3 }, savedSecretResources,
            } })).json()).toEqual({ status: 'settings-conflict', revision: 4 });
            expect(await db.savedSecretResource.count()).toBe(0);
            expect(await db.userKVStore.count()).toBe(0);
            expect((await app.inject({ method: 'POST', url: route, headers, payload: { mutation, savedSecretResources } })).json())
                .toMatchObject({ status: 'updated', revision: 0 });
            expect(await db.savedSecretResource.count()).toBe(2);
            expect((await app.inject({ method: 'GET', url: route, headers })).json())
                .toEqual({ status: 'present', revision: 0, content: mutation.content });
            await db.account.update({ where: { id: owner.id }, data: { settingsVersion: 5 } });
            expect((await app.inject({ method: 'POST', url: route, headers, payload: { mutation, savedSecretResources } })).json())
                .toMatchObject({ status: 'updated', revision: 0 });
            expect(await db.savedSecretResource.count()).toBe(2);
            expect(await db.accountSettingsSnapshot.count()).toBe(0);
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).settingsVersion).toBe(5);
        });
    });

    it('requires a captured complete old-reference witness for an encrypted host resource packet', async () => {
        const binding = createSignedAccountContentBinding();
        const verified = verifyAccountContentKeyBindingV1({ accountSigningPublicKey: Buffer.from(binding.publicKey, 'hex'),
            contentPublicKey: binding.contentPublicKey, signature: binding.contentPublicKeySig });
        if (!verified) throw new Error('Expected a verified Account content-key binding');
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', settingsVersion: 4, publicKey: binding.publicKey,
            contentPublicKey: Buffer.from(binding.contentPublicKey), contentPublicKeySig: Buffer.from(binding.contentPublicKeySig) } });
        const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(3) };
        const createPacket = (resourceId: string, value: string) => {
            const dataKey = new Uint8Array(32).fill(7);
            return SharedSavedSecretCreateInputV1Schema.parse({ resourceId, displayName: 'SSH credential', kind: 'password', encryptionMode: 'e2ee',
                storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', resourceDataKey: dataKey,
                    content: { v: 1, name: 'SSH credential', kind: 'password', value }, randomBytes: length => new Uint8Array(length).fill(8) }),
                keyEnvelopes: [{ recipientAccountId: owner.id,
                    encryptedDataKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: binding.contentPublicKey,
                        randomBytes: length => new Uint8Array(length).fill(9) })).toString('base64'),
                    recipientContentPublicKeyFingerprint: verified.contentPublicKeyFingerprint }] });
        };
        const oldPassword = createPacket('ssh-e2ee-old-password', 'old-password-fixture');
        const retainedKey = createPacket('ssh-e2ee-retained-key', 'retained-key-fixture');
        for (const resource of [oldPassword, retainedKey]) {
            expect(await inTx(tx => createSavedSecretResourceInTx(tx, { ...resource, accountId: owner.id,
                keyEnvelopes: resource.keyEnvelopes?.map(envelope => ({ ...envelope,
                    encryptedDataKey: Buffer.from(envelope.encryptedDataKey, 'base64') })) }))).toMatchObject({ ok: true });
        }
        const oldHosts = [{ ...host, ssh: { ...host.ssh, authMode: 'password' as const,
            passwordSecretRef: formatSharedSavedSecretRefV1(oldPassword.resourceId),
            identityPrivateKeySecretRef: formatSharedSavedSecretRefV1(retainedKey.resourceId) } }];
        const oldContent = sealRemoteHostCatalogContentV1({ mode: 'e2ee', material, record: { v: 1, hosts: oldHosts },
            randomBytes: length => new Uint8Array(length).fill(2) });
        expect(await inTx(tx => mutateRemoteHostCatalogRowInTx(tx, { accountId: owner.id, expectedRevision: 'absent',
            sourceSettingsVersion: 4, content: oldContent,
            referencedSavedSecretRevisions: [oldPassword, retainedKey].map(resource => ({ resourceId: resource.resourceId, revision: 1 })) })))
            .toMatchObject({ status: 'updated', revision: 0 });
        await db.account.update({ where: { id: owner.id }, data: { settingsVersion: 5 } });
        const password = createPacket('ssh-e2ee-new-password', 'new-password-fixture');
        const nextContent = sealRemoteHostCatalogContentV1({ mode: 'e2ee', material,
            record: { v: 1, hosts: [{ ...oldHosts[0]!, ssh: { ...oldHosts[0]!.ssh,
                passwordSecretRef: formatSharedSavedSecretRefV1(password.resourceId) } }] },
            randomBytes: length => new Uint8Array(length).fill(4) });
        const mutation = { expectedRevision: 0, content: nextContent,
            referencedSavedSecretRevisions: [password, retainedKey].map(resource => ({ resourceId: resource.resourceId, revision: 1 })) };
        const referenceCensus = SavedSecretCatalogReferenceCensusV1Schema.parse({ scope: 'catalogs', accountMode: 'e2ee', catalogs: {},
            remoteHosts: { revision: 0, resourceRefs: oldHosts.flatMap(host => [host.ssh.passwordSecretRef, host.ssh.identityPrivateKeySecretRef]) } });
        await withAuthenticatedTestApp(accountRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id };
            expect((await app.inject({ method: 'POST', url: route, headers,
                payload: { mutation, savedSecretResources: [password] } })).json()).toEqual({ status: 'references-invalid' });
            expect(await db.savedSecretResource.count()).toBe(2);
            expect((await app.inject({ method: 'GET', url: route, headers })).json())
                .toEqual({ status: 'present', revision: 0, content: oldContent });
            expect((await app.inject({ method: 'POST', url: route, headers,
                payload: { mutation, savedSecretResources: [password], referenceCensus } })).json())
                .toMatchObject({ status: 'updated', revision: 1 });
            expect(await db.savedSecretResource.count()).toBe(3);
            expect(await db.savedSecretResourceKeyEnvelope.count()).toBe(3);
            expect((await app.inject({ method: 'GET', url: route, headers })).json())
                .toEqual({ status: 'present', revision: 1, content: nextContent });
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).settingsVersion).toBe(5);
            expect(await db.accountSettingsSnapshot.count()).toBe(0);
        });
    });

    it.each(['reference', 'material'] as const)('refuses stored host envelope credential carriers before mutation (%s)', async carrier => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const stored = { ...content, ...(carrier === 'reference'
            ? { futureSecretRef: formatSharedSavedSecretRefV1('uncharacterized-resource') }
            : { futureCredential: { _isSecretValue: true, value: 'retained-private-fixture' } }) };
        const bytes = Buffer.from(JSON.stringify(stored));
        await db.userKVStore.create({ data: { accountId: owner.id, key: '@happier/account/remote-hosts/v1/catalog',
            version: 2, value: bytes } });
        await withAuthenticatedTestApp(accountRoutes, async app => {
            const result = await app.inject({ method: 'POST', url: route, headers: { 'x-test-user-id': owner.id },
                payload: { mutation: { expectedRevision: 2, content, referencedSavedSecretRevisions: [] } } });
            expect(result.json()).toEqual({ status: 'invalid-stored-content' });
            expect((await app.inject({ method: 'GET', url: route, headers: { 'x-test-user-id': owner.id } })).json())
                .toEqual({ status: 'invalid-stored-content' });
            const retained = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: {
                accountId: owner.id, key: '@happier/account/remote-hosts/v1/catalog' } } });
            expect(retained.version).toBe(2);
            expect(Buffer.from(retained.value!)).toEqual(bytes);
        });
    });

    it('refuses initialization that drops retained SSH credential slots', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 4,
            settings: JSON.stringify({ t: 'plain', v: { remoteHostsV1: [{ ...host, ssh: { ...host.ssh,
                passwordEnc: { _isSecretValue: true, value: 'retained-private-password' } } }] } }) } });
        await withAuthenticatedTestApp(accountRoutes, async app => {
            const result = await app.inject({ method: 'POST', url: route, headers: { 'x-test-user-id': owner.id },
                payload: { mutation: { expectedRevision: 'absent', sourceSettingsVersion: 4, content,
                    referencedSavedSecretRevisions: [] } } });
            expect(result.json()).toEqual({ status: 'references-invalid' });
            expect(await db.userKVStore.count()).toBe(0);
            expect(await db.savedSecretResource.count()).toBe(0);
            const createCredential = (resourceId: string) => inTx(tx => createSavedSecretResourceInTx(tx, {
                accountId: owner.id, resourceId, displayName: 'SSH password', kind: 'password', encryptionMode: 'plain',
                storedContent: { t: 'plain', v: { v: 1, name: 'SSH password', kind: 'password', value: 'retained-private-password' } },
            }));
            await createCredential('unrelated-resource');
            const initialize = (resourceId: string) => app.inject({ method: 'POST', url: route,
                headers: { 'x-test-user-id': owner.id }, payload: { mutation: {
                    expectedRevision: 'absent', sourceSettingsVersion: 4,
                    content: { t: 'plain', v: { v: 1, hosts: [{ ...host,
                        ssh: { ...host.ssh, passwordSecretRef: formatSharedSavedSecretRefV1(resourceId) } }] } },
                    referencedSavedSecretRevisions: [{ resourceId, revision: 1 }],
                } } });
            expect((await initialize('unrelated-resource')).json()).toEqual({ status: 'references-invalid' });
            expect(await db.userKVStore.count()).toBe(0);
            const preservedResourceId = deriveSavedSecretImportResourceIdV1({ accountId: owner.id,
                source: { kind: 'remote-host-ssh-credential', hostId: host.id, slot: 'password' } });
            await createCredential(preservedResourceId);
            expect((await initialize(preservedResourceId)).json()).toMatchObject({ status: 'updated', revision: 0 });
        });
    });

    it('checks exact usable resource revisions and refuses uncaptured or stale host deletion census', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        for (const accountId of [owner.id, foreign.id]) {
            await inTx(tx => createSavedSecretResourceInTx(tx, { accountId, resourceId: `ssh-${accountId}`,
                displayName: 'SSH password', kind: 'password', encryptionMode: 'plain',
                storedContent: { t: 'plain', v: { v: 1, name: 'SSH password', kind: 'password', value: 'private' } } }));
        }
        await withAuthenticatedTestApp(accountRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id };
            const mutation = { expectedRevision: 'absent', sourceSettingsVersion: 0,
                content: { t: 'plain', v: { v: 1, hosts: [{ ...host, ssh: { ...host.ssh, authMode: 'password',
                    passwordSecretRef: formatSharedSavedSecretRefV1(`ssh-${owner.id}`) } }] } },
                referencedSavedSecretRevisions: [{ resourceId: `ssh-${owner.id}`, revision: 1 }] };
            expect((await app.inject({ method: 'POST', url: route, headers, payload: { mutation: {
                ...mutation, referencedSavedSecretRevisions: [{ resourceId: `ssh-${owner.id}`, revision: 2 }] } } })).json())
                .toEqual({ status: 'references-invalid' });
            expect((await app.inject({ method: 'POST', url: route, headers, payload: { mutation: {
                ...mutation, referencedSavedSecretRevisions: [{ resourceId: `ssh-${foreign.id}`, revision: 1 }] } } })).json())
                .toEqual({ status: 'references-invalid' });
            expect(await db.userKVStore.count()).toBe(0);
            expect((await app.inject({ method: 'POST', url: route, headers, payload: { mutation } })).json())
                .toMatchObject({ status: 'updated', revision: 0 });
        });
        const base = { accountId: owner.id, resourceId: `ssh-${owner.id}`, expectedRevision: 1, expectedSettingsVersion: 0,
            referenceCensus: { accountMode: 'plain' as const, profiles: { referenceGuardRevision: 'absent' as const, rows: [] } } };
        expect(await inTx(tx => deleteSavedSecretResourceInTx(tx, base))).toEqual({ ok: false, error: 'references_invalid' });
        expect(await inTx(tx => deleteSavedSecretResourceInTx(tx, { ...base,
            referenceCensus: { ...base.referenceCensus, ...{ remoteHosts: { revision: 'absent' as const, resourceRefs: [] } } } })))
            .toEqual({ ok: false, error: 'references_conflict' });
        expect(await inTx(tx => deleteSavedSecretResourceInTx(tx, { ...base,
            referenceCensus: { ...base.referenceCensus, ...{ remoteHosts: { revision: 0,
                resourceRefs: [formatSharedSavedSecretRefV1(`ssh-${owner.id}`)] } } } })))
            .toEqual({ ok: false, error: 'resource_in_use' });
        expect(await db.savedSecretResource.count()).toBe(2);
    });

    it('refuses a mode-mismatched stored host envelope before returning any contents', async () => {
        const binding = createSignedAccountContentBinding();
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', publicKey: binding.publicKey,
            contentPublicKey: Buffer.from(binding.contentPublicKey), contentPublicKeySig: Buffer.from(binding.contentPublicKeySig) } });
        await db.userKVStore.create({ data: { accountId: owner.id, key: '@happier/account/remote-hosts/v1/catalog',
            version: 1, value: Buffer.from(JSON.stringify(content)) } });
        await withAuthenticatedTestApp(accountRoutes, async app => {
            const result = await app.inject({ method: 'GET', url: route, headers: { 'x-test-user-id': owner.id } });
            expect(result.statusCode).toBe(200);
            expect(result.json()).toEqual({ status: 'account-mode-mismatch' });
        });
    });

    it('normalizes SSH credential history only with captured catalog and exact owned historical material proofs', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 4 } });
        const previous = { t: 'plain' as const, v: { remoteHostsV1: [{ ...host,
            ssh: { ...host.ssh, passwordEnc: { _isSecretValue: true, value: 'retained-private' } } }],
            preferredLanguage: 'de', futurePreference: { untouched: true } } };
        const cleaned = { t: 'plain' as const, v: { preferredLanguage: 'de', futurePreference: { untouched: true } } };
        await db.accountSettingsSnapshot.create({ data: { accountId: owner.id, version: 2, encryptionMode: 'plain',
            contentKind: 'plain', settingsDbValue: JSON.stringify(previous) } });
        await db.userKVStore.create({ data: { accountId: owner.id, key: '@happier/account/remote-hosts/v1/catalog',
            version: 2, value: Buffer.from(JSON.stringify(content)) } });
        const mutation = { expectedSettingsVersion: 4, expectedProfileTransferRevision: 'absent' as const,
            expectedEncryptionCurrentness: { mode: 'plain' as const, signingKeyFingerprint: null, contentKeyFingerprint: null },
            expectedContent: previous, operation: { kind: 'normalize' as const, removedRoots: ['remoteHostsV1'],
                transferredPrivateCatalogRevisions: { remoteHosts: 2 }, content: cleaned } };
        expect(await inTx(tx => mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: owner.id, version: 2,
            mutation: { ...mutation, operation: { ...mutation.operation, transferredPrivateCatalogRevisions: { remoteHosts: 1 } } } })))
            .toEqual({ status: 'conflict' });
        expect(await inTx(tx => mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: owner.id, version: 2, mutation })))
            .toEqual({ status: 'invalid_content' });
        const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: owner.id,
            source: { kind: 'remote-host-ssh-credential', hostId: host.id, slot: 'password' } });
        await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
            displayName: 'SSH password', kind: 'password', encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'SSH password', kind: 'password', value: 'different-private' } } }));
        const proved = { ...mutation, operation: { ...mutation.operation, ...{ savedSecretTransfers: [{
            source: { kind: 'remote-host-ssh-credential' as const, hostId: host.id, slot: 'password' as const },
            resourceId, expectedRevision: 1,
        }] } } };
        expect(await inTx(tx => mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: owner.id, version: 2, mutation: proved })))
            .toEqual({ status: 'invalid_content' });
        const valueFirst = { ...previous, v: { ...previous.v, remoteHostsV1: [{ ...host, ssh: { ...host.ssh,
            passwordEnc: { _isSecretValue: true, value: 'retained-private', encryptedValue: { t: 'enc-v1', c: 'retained-locked-fixture' } } } }] } };
        await db.accountSettingsSnapshot.update({ where: { accountId_version: { accountId: owner.id, version: 2 } },
            data: { settingsDbValue: JSON.stringify(valueFirst) } });
        expect(await inTx(tx => mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: owner.id, version: 2,
            mutation: { ...proved, expectedContent: valueFirst } }))).toEqual({ status: 'invalid_content' });
        await db.accountSettingsSnapshot.update({ where: { accountId_version: { accountId: owner.id, version: 2 } },
            data: { settingsDbValue: JSON.stringify(previous) } });
        expect(await inTx(tx => updateSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
            expectedRevision: 1, displayName: 'SSH password', kind: 'password',
            storedContent: { t: 'plain', v: { v: 1, name: 'SSH password', kind: 'password', value: 'retained-private' } } })))
            .toMatchObject({ ok: true, value: { revision: 2 } });
        const exact = { ...proved, operation: { ...proved.operation, savedSecretTransfers: [{
            ...proved.operation.savedSecretTransfers[0]!, expectedRevision: 2,
        }] } };
        for (const wrapper of [
            { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'retained-locked-fixture' } },
            { _isSecretValue: true, value: 'retained-private', encryptedValue: { t: 'enc-v1', c: 'retained-locked-fixture' } },
        ]) {
            const unsupported = { ...previous, v: { ...previous.v, remoteHostsV1: [{ ...host,
                ssh: { ...host.ssh, passwordEnc: wrapper } }] } };
            await db.accountSettingsSnapshot.update({ where: { accountId_version: { accountId: owner.id, version: 2 } },
                data: { settingsDbValue: JSON.stringify(unsupported) } });
            expect(await inTx(tx => mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: owner.id, version: 2,
                mutation: { ...mutation, expectedContent: unsupported } }))).toEqual({ status: 'invalid_content' });
            // Opaque-only material needs the client's exact snapshot/resource proof; the server never invents keys.
            expect(await inTx(tx => mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: owner.id, version: 2,
                mutation: { ...exact, expectedContent: unsupported } }))).toEqual({ status: 'applied' });
        }
        await db.accountSettingsSnapshot.update({ where: { accountId_version: { accountId: owner.id, version: 2 } },
            data: { settingsDbValue: JSON.stringify(previous) } });
        expect(await inTx(tx => mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: owner.id, version: 2, mutation: exact })))
            .toEqual({ status: 'applied' });
        const current = await db.accountSettingsSnapshot.findUniqueOrThrow({ where: {
            accountId_version: { accountId: owner.id, version: 2 } } });
        expect(openPlainAccountSettingsDbValue({ accountId: owner.id, dbValue: current.settingsDbValue })).toEqual(cleaned);
    });
});
