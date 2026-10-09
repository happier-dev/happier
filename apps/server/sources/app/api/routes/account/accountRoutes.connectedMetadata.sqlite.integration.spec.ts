import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRoutes } from './accountRoutes';
import { kvRoutes } from '../kv/kvRoutes';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import type { Fastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createQualifiedConnectedAccountIdentityDigest, createQualifiedConnectedAccountServiceDigest } from '../connect/qualifiedConnectedAccounts/identity';
import { createQualifiedConnectedAccountGroup } from '../connect/qualifiedConnectedAccounts/groupRepository';
import { CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1,
    CONNECTED_PRESENTATION_SOURCE_ROOTS_V1, CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { storePlainAccountSettingsDbValue } from '@/app/encryption/accountSettingsStorage';
import { accountSettingsSnapshotToContent } from '@/app/accountSettings/accountSettingsHistoryContent';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

describe('connected metadata Account catalogs (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-connected-metadata-', initEncrypt: true }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('admits exact Account/Machine acknowledgements through row CAS without Settings history', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7 } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app); kvRoutes(app);
        const url = '/v1/account/entity-rows/connected-metadata/acknowledgements';
        const headers = { 'x-test-user-id': account.id };
        const content = { t: 'plain', v: { v: 1, entries: [
            { v: 1, subject: { kind: 'warning', warningId: 'installation', scope: { kind: 'account' } }, acknowledged: true },
            { v: 1, subject: { kind: 'warning', warningId: 'installation', scope: { kind: 'machine', machineId: 'machine:exact' } }, acknowledged: false },
        ] } };
        try {
            expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
            expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'absent' });
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                expectedRevision: 'absent', sourceSettingsVersion: 7, content: { t: 'encrypted', c: 'wrong-mode' },
            } })).json()).toEqual({ status: 'account-mode-mismatch' });
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                expectedRevision: 'absent', sourceSettingsVersion: 6, content,
            } })).json()).toEqual({ status: 'settings-conflict', revision: 7 });
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                expectedRevision: 'absent', sourceSettingsVersion: 7, content,
            } })).json()).toMatchObject({ status: 'updated', revision: 0 });
            expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'present', revision: 0, content });
            expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': other.id } })).json()).toEqual({ status: 'absent' });
            expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 9, content: null } })).json())
                .toEqual({ status: 'conflict', revision: 0 });
            expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 0, content: null } })).json())
                .toMatchObject({ status: 'updated', revision: 1 });
            expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'deleted', revision: 1 });
            expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 'absent', sourceSettingsVersion: 7, content } })).json())
                .toEqual({ status: 'conflict', revision: 1 });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(7);
            expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
            expect((await app.inject({ method: 'GET', url: '/v1/kv?prefix=%40happier%2Faccount%2Fconnected-', headers })).statusCode).toBe(400);
        } finally { await app.close(); }
    });

    it('validates exact owned presentation and adoption subjects without copying credential metadata', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 4 } });
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        const service = { pluginId: 'test.connected', localId: 'service' };
        const agentTargetKey = buildBackendTargetKeyV2({ kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } });
        const connectedRef = { service, accountId: 'profile:exact' };
        await db.serviceAccountToken.create({ data: {
            accountId: account.id, servicePluginId: service.pluginId, serviceLocalId: service.localId,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
            connectedAccountId: connectedRef.accountId, qualifiedIdentityDigest: createQualifiedConnectedAccountIdentityDigest(connectedRef),
            authenticationModeId: 'token', token: new Uint8Array(),
        } });
        expect((await createQualifiedConnectedAccountGroup({ accountId: account.id, service, group: { groupId: 'pool-exact' } })).status).toBe('written');
        expect((await createQualifiedConnectedAccountGroup({ accountId: foreign.id, service, group: { groupId: 'pool-foreign' } })).status).toBe('written');
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        const headers = { 'x-test-user-id': account.id };
        const base = '/v1/account/entity-rows/connected-metadata';
        const presentation = { t: 'plain', v: { v: 1, entries: [
            { v: 1, subject: { kind: 'account', account: connectedRef }, label: 'Personal account' },
            { v: 1, subject: { kind: 'group', service, groupId: 'pool-exact' }, label: 'Personal pool' },
        ] } };
        try {
            const missing = await app.inject({ method: 'POST', url: `${base}/presentation`, headers, payload: {
                expectedRevision: 'absent', sourceSettingsVersion: 4, content: { t: 'plain', v: { v: 1, entries: [
                    { v: 1, subject: { kind: 'account', account: { ...connectedRef, service: { ...service, localId: 'other' } } }, label: 'Wrong service' },
                ] } },
            } });
            expect(missing.json()).toEqual({ status: 'invalid-stored-content', reason: 'subject-not-owned' });
            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
            expect((await app.inject({ method: 'POST', url: `${base}/presentation`, headers, payload: {
                expectedRevision: 'absent', sourceSettingsVersion: 4, content: presentation,
            } })).json()).toMatchObject({ status: 'updated', revision: 0 });
            expect((await app.inject({ method: 'GET', url: `${base}/presentation`, headers })).json())
                .toEqual({ status: 'present', revision: 0, content: presentation });
            for (const groupId of ['pool-foreign', 'pool-missing']) {
                expect((await app.inject({ method: 'POST', url: `${base}/acknowledgements`, headers, payload: {
                    expectedRevision: 'absent', sourceSettingsVersion: 4, content: { t: 'plain', v: { v: 1, entries: [
                        { v: 1, subject: { kind: 'adoption', agentTargetKey, service, groupId }, acknowledged: true },
                    ] } },
                } })).json()).toEqual({ status: 'invalid-stored-content', reason: 'subject-not-owned' });
            }
            expect((await app.inject({ method: 'POST', url: `${base}/acknowledgements`, headers, payload: {
                expectedRevision: 'absent', sourceSettingsVersion: 4, content: { t: 'plain', v: { v: 1, entries: [
                    { v: 1, subject: { kind: 'adoption', agentTargetKey, service, groupId: 'pool-exact' }, acknowledged: true },
                ] } },
            } })).json()).toMatchObject({ status: 'updated', revision: 0 });
            expect((await db.serviceAccountToken.findFirstOrThrow({ where: { accountId: account.id } })).metadata).toBeNull();
            // A deleted credential must not strand unrelated edits or exact cleanup.
            await db.serviceAccountToken.deleteMany({ where: { accountId: account.id } });
            const renamedPool = { ...presentation, v: { ...presentation.v, entries: [
                presentation.v.entries[0], { ...presentation.v.entries[1], label: 'Renamed pool' },
            ] } };
            const unreadableValue = new TextEncoder().encode(JSON.stringify({ ...presentation, v: { ...presentation.v,
                entries: [...presentation.v.entries, { unreadableNeighbor: true }] } }));
            await db.userKVStore.update({ where: { accountId_key: { accountId: account.id, key: CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1 } }, data: { value: unreadableValue } });
            expect((await app.inject({ method: 'POST', url: `${base}/presentation`, headers, payload: {
                expectedRevision: 0, content: renamedPool,
            } })).json()).toEqual({ status: 'invalid-stored-content' });
            const unchanged = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1 } } });
            expect(unchanged.version).toBe(0);
            expect(unchanged.value).toEqual(unreadableValue);
            // Restore only the fixture's complete baseline before exercising the valid orphan flow.
            await db.userKVStore.update({ where: { accountId_key: { accountId: account.id, key: CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1 } }, data: {
                value: new TextEncoder().encode(JSON.stringify(presentation)),
            } });
            expect((await app.inject({ method: 'POST', url: `${base}/presentation`, headers, payload: {
                expectedRevision: 0, content: renamedPool,
            } })).json()).toMatchObject({ status: 'updated', revision: 1 });
            expect((await app.inject({ method: 'POST', url: `${base}/presentation`, headers, payload: {
                expectedRevision: 1, content: { ...renamedPool, v: { ...renamedPool.v, entries: [renamedPool.v.entries[1]] } },
            } })).json()).toMatchObject({ status: 'updated', revision: 2 });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(4);
            expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
        } finally { await app.close(); }
    });

    it.each([
        { key: CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, roots: CONNECTED_PRESENTATION_SOURCE_ROOTS_V1, domain: 'connectedPresentation' },
        { key: CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1, roots: CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1, domain: 'connectedAcknowledgements' },
    ] as const)('normalizes only history proved by the exact $domain row or tombstone', async ({ key, roots, domain }) => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 5 } });
        const sources = { connectedServicesProfileLabelByKey: { 'openai-codex/default': 'Retained' },
            connectedServicesDefaultAuthPoolAdoptionDismissedByKey: { 'codex:openai-codex:default': true },
            dismissedCLIWarnings: { global: { installation: true }, perMachine: {} },
            connectedServicesCollapsedItemKeysV1: { 'openai-codex:account:default': true },
            connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'default' }, preferredLanguage: 'de' };
        const previous = { t: 'plain' as const, v: sources };
        const next = { t: 'plain' as const, v: Object.fromEntries(Object.entries(sources).filter(([root]) => !(roots as readonly string[]).includes(root))) };
        await db.accountSettingsSnapshot.create({ data: { accountId: account.id, version: 2,
            encryptionMode: 'plain', contentKind: 'plain', settingsDbValue: storePlainAccountSettingsDbValue({ accountId: account.id, content: previous }) } });
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        const headers = { 'x-test-user-id': account.id };
        const mutation = { expectedSettingsVersion: 5, expectedProfileTransferRevision: 'absent',
            expectedEncryptionCurrentness: { mode: 'plain', signingKeyFingerprint: null, contentKeyFingerprint: null }, expectedContent: previous,
            operation: { kind: 'normalize', removedRoots: [...roots], transferredPrivateCatalogRevisions: { [domain]: 0 }, content: next } };
        try {
            expect((await app.inject({ method: 'POST', url: '/v2/account/settings/history/2/mutate', headers, payload: mutation })).json())
                .toEqual({ status: 'invalid_content' });
            await db.userKVStore.create({ data: { accountId: account.id, key, version: 0,
                value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: { v: 1, entries: [{}] } })) } });
            expect((await app.inject({ method: 'POST', url: '/v2/account/settings/history/2/mutate', headers, payload: mutation })).json())
                .toEqual({ status: 'invalid_content' });
            await db.userKVStore.update({ where: { accountId_key: { accountId: account.id, key } }, data: {
                value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: { v: 1, entries: [] } })),
            } });
            expect((await app.inject({ method: 'POST', url: '/v2/account/settings/history/2/mutate', headers, payload: {
                ...mutation, operation: { ...mutation.operation, transferredPrivateCatalogRevisions: { [domain]: 1 } },
            } })).json()).toEqual({ status: 'conflict' });
            expect((await app.inject({ method: 'POST', url: '/v2/account/settings/history/2/mutate', headers, payload: mutation })).json())
                .toEqual({ status: 'applied' });
            const snapshot = await db.accountSettingsSnapshot.findUniqueOrThrow({ where: { accountId_version: { accountId: account.id, version: 2 } } });
            expect(accountSettingsSnapshotToContent(snapshot)).toEqual(next);
            await db.accountSettingsSnapshot.update({ where: { id: snapshot.id }, data: {
                settingsDbValue: storePlainAccountSettingsDbValue({ accountId: account.id, content: previous }),
            } });
            await db.userKVStore.update({ where: { accountId_key: { accountId: account.id, key } }, data: { version: 1, value: null } });
            expect((await app.inject({ method: 'POST', url: '/v2/account/settings/history/2/mutate', headers, payload: {
                ...mutation, operation: { ...mutation.operation, transferredPrivateCatalogRevisions: { [domain]: 1 } },
            } })).json()).toEqual({ status: 'applied' });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(5);
        } finally { await app.close(); }
    });

    it('preserves malformed independent stored entries for admitted client diagnostics', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const content = { t: 'plain', v: { v: 1, entries: [
            { v: 1, subject: { kind: 'warning', warningId: 'installation', scope: { kind: 'account' } }, acknowledged: true },
            { v: 1, subject: { kind: 'warning', warningId: 'bad', scope: { kind: 'account' } }, acknowledged: 'unreadable' },
        ] } };
        await db.userKVStore.create({ data: { accountId: account.id, key: CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1,
            version: 3, value: new TextEncoder().encode(JSON.stringify(content)) } });
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        try {
            const response = await app.inject({ method: 'GET', url: '/v1/account/entity-rows/connected-metadata/acknowledgements',
                headers: { 'x-test-user-id': account.id } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ status: 'present', revision: 3, content });
        } finally { await app.close(); }
    });
});
