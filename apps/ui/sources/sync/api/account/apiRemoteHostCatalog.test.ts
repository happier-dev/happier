import { describe, expect, it } from 'vitest';
import * as owner from './apiRemoteHostCatalog';
import type { ServerFetch } from '@/sync/http/client';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { deriveSavedSecretImportResourceIdV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { SavedSecretResourceMaterialV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { AccountSettingsV2HistoryMutationRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import type { AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';
import { applyRemoteHostCatalogSnapshot, getRemoteHostCatalogSnapshot } from '@/sync/store/settings/remoteHostCatalogSnapshot';
import { fetchAccountEncryptionMode } from './apiAccountEncryptionMode';

describe('Remote host captured catalog mutation', () => {
    it('captures the complete old SSH inventory when replacing a credential resource', async () => {
        const accountId = 'ssh-census-account';
        const ref = formatSharedSavedSecretRefV1;
        const old = { id: 'host', name: 'Host', ssh: { target: 'dev@example.test', authMode: 'password' as const,
            passwordSecretRef: ref('old-password'), identityPrivateKeySecretRef: ref('retained-key') },
            createdAt: 1, updatedAt: 1, lastUsedAt: null };
        const resources = ['old-password', 'retained-key'].map(resourceId => SavedSecretResourceMaterialV1Schema.parse({
            resourceId, encryptionMode: 'plain', recipientEnvelope: null,
            storedContent: { t: 'plain', v: { v: 1, name: 'SSH credential', kind: 'password', value: 'existing-private-fixture' } },
            entry: { ref: ref(resourceId), source: 'shared_resource', relationship: 'owner', name: 'SSH credential', kind: 'password',
                encryptionMode: 'plain', ownerAccountId: accountId, revision: 3, materialStatus: 'ready',
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }));
        const writes: unknown[] = [];
        const context: owner.RemoteHostAccountContext = { serverId: 'home', accountId, credentials: { token: createAccountTokenForTests(accountId) },
            resolveAccountMode: async () => 'plain', resolveAccountEncryption: async () => ({ accountMode: 'plain', encryption: null }),
            assertCurrent: () => {}, accountLifetime: { scope: { serverId: 'home', accountId }, isCurrent: () => true, onRetire: () => () => {} },
            mutateRawSettings: async () => { throw new Error('Destination-only credential replacement cannot write Settings'); },
            request: (async (path, init) => {
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }));
                if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources });
                if (path === '/v2/account/settings') return Response.json({ version: 4, content: { t: 'plain', v: {} } });
                if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
                if (path === '/v1/account/entity-rows/profiles/transfer') return Response.json({ status: 'absent' });
                if (path !== '/v1/account/entity-rows/remote-hosts') return Response.json({}, { status: 404 });
                if (init?.method === 'POST') { writes.push(JSON.parse(String(init.body))); return Response.json({ status: 'updated', revision: 5, cursor: 1 }); }
                return Response.json({ status: 'present', revision: 4, content: { t: 'plain', v: { v: 1, hosts: [old] } } });
            }) satisfies ServerFetch,
        };
        const resource = { resourceId: 'new-password', displayName: 'SSH credential', kind: 'password' as const, encryptionMode: 'plain' as const,
            storedContent: { t: 'plain' as const, v: { v: 1 as const, name: 'SSH credential', kind: 'password' as const, value: 'new-private-fixture' } } };
        const next = { ...old, ssh: { ...old.ssh, passwordSecretRef: ref(resource.resourceId) } };
        await expect(owner.saveRemoteHostInContext(context, { host: next, expectedRevision: 4, savedSecretResources: [resource],
            referencedSavedSecretRevisions: [{ resourceId: resource.resourceId, revision: 1 }] })).resolves.toEqual({ ok: true, revision: 5 });
        expect(writes).toEqual([{ mutation: { expectedRevision: 4,
            referencedSavedSecretRevisions: [{ resourceId: 'new-password', revision: 1 }, { resourceId: 'retained-key', revision: 3 }],
            content: { t: 'plain', v: { v: 1, hosts: [next] } } }, savedSecretResources: [resource],
            referenceCensus: { scope: 'catalogs', accountMode: 'plain', catalogs: {},
                remoteHosts: { revision: 4, resourceRefs: [ref('old-password'), ref('retained-key')] } } }]);
    });

    it.each(['unauthorized', 'forbidden', 'unreachable'] as const)(
        'preserves the canonical Account currentness failure reason (%s)', async reason => {
            const scope = { serverId: 'currentness-home', accountId: `currentness-${reason}` };
            const host = { id: 'known-host', name: 'Known host', ssh: { target: 'dev@example.test', authMode: 'agent' as const },
                createdAt: 1, updatedAt: 1, lastUsedAt: null };
            applyRemoteHostCatalogSnapshot(scope, { status: 'ready', revision: 4, hosts: [host], diagnostics: [] }, true);
            const admittedRows = getRemoteHostCatalogSnapshot(scope)!.data;
            const context: owner.RemoteHostAccountContext = {
                ...scope, credentials: { token: createAccountTokenForTests(scope.accountId) },
                resolveAccountMode: async () => 'plain',
                resolveAccountEncryption: async () => ({ accountMode: 'plain', encryption: null }),
                assertCurrent: () => {},
                accountLifetime: { scope, isCurrent: () => true, onRetire: () => () => {} },
                mutateRawSettings: async () => { throw new Error('A currentness failure must not mutate Settings'); },
                // Only Home HTTP is substituted; the canonical currentness admission and domain classification run together.
                request: (async path => {
                    if (path !== '/v1/account/encryption/currentness') throw new Error('Catalog data must not be disclosed before admission');
                    if (reason === 'unreachable') throw new TypeError('The Home transport is unavailable');
                    return Response.json({}, { status: reason === 'unauthorized' ? 401 : 403 });
                }) satisfies ServerFetch,
            };
            const result = await owner.readRemoteHostCatalogInContext(context);
            expect(result).toEqual({ status: 'unavailable', reason });
            applyRemoteHostCatalogSnapshot(scope, result, true);
            expect(getRemoteHostCatalogSnapshot(scope)).toMatchObject({ stale: true });
            expect(getRemoteHostCatalogSnapshot(scope)!.data).toBe(reason === 'unreachable' ? admittedRows : null);
        },
    );

    it('withdraws retained catalog data when the addressed Home does not support the row operation', async () => {
        const scope = { serverId: 'unsupported-home', accountId: 'unsupported-account' };
        const host = { id: 'known-host', name: 'Known host', ssh: { target: 'dev@example.test', authMode: 'agent' as const },
            createdAt: 1, updatedAt: 1, lastUsedAt: null };
        applyRemoteHostCatalogSnapshot(scope, { status: 'ready', revision: 4, hosts: [host], diagnostics: [] }, true);
        const context: owner.RemoteHostAccountContext = {
            ...scope, credentials: { token: createAccountTokenForTests(scope.accountId) },
            resolveAccountMode: async () => 'plain',
            resolveAccountEncryption: async () => ({ accountMode: 'plain', encryption: null }),
            assertCurrent: () => {},
            accountLifetime: { scope, isCurrent: () => true, onRetire: () => () => {} },
            mutateRawSettings: async () => { throw new Error('Unsupported catalog reads must not rewrite retained Settings'); },
            request: (async path => {
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }));
                if (path === '/v1/account/entity-rows/remote-hosts') return Response.json({}, { status: 404 });
                throw new Error('An unsupported row read must not fall back to another storage owner');
            }) satisfies ServerFetch,
        };
        const result = await owner.readRemoteHostCatalogInContext(context);
        expect(result).toEqual({ status: 'unavailable', reason: 'unsupported' });
        applyRemoteHostCatalogSnapshot(scope, result, true);
        expect(getRemoteHostCatalogSnapshot(scope)!.data).toBeNull();
    });

    it.each(['unauthorized', 'forbidden'] as const)(
        'withdraws catalog data when the prior persisted Account mode admission is refused (%s)', async reason => {
            const scope = { serverId: 'mode-admission-home', accountId: `mode-admission-${reason}` };
            const credentials = { token: createAccountTokenForTests(scope.accountId) };
            const host = { id: 'known-host', name: 'Known host', ssh: { target: 'dev@example.test', authMode: 'agent' as const },
                createdAt: 1, updatedAt: 1, lastUsedAt: null };
            applyRemoteHostCatalogSnapshot(scope, { status: 'ready', revision: 4, hosts: [host], diagnostics: [] }, true);
            // The persisted-mode HTTP owner runs before currentness, as it does in the captured Action context.
            const request: ServerFetch = async path => {
                if (path !== '/v1/account/encryption') throw new Error('Currentness and catalog reads must not follow refused mode admission');
                return Response.json({}, { status: reason === 'unauthorized' ? 401 : 403 });
            };
            const resolveAccountMode = async () => (await fetchAccountEncryptionMode(credentials, { request })).mode;
            const context: owner.RemoteHostAccountContext = {
                ...scope, credentials, request, resolveAccountMode,
                resolveAccountEncryption: async () => ({ accountMode: await resolveAccountMode(), encryption: null }),
                assertCurrent: () => {},
                accountLifetime: { scope, isCurrent: () => true, onRetire: () => () => {} },
                mutateRawSettings: async () => { throw new Error('Refused mode admission must not mutate Settings'); },
            };
            const result = await owner.readRemoteHostCatalogInContext(context);
            expect(result).toEqual({ status: 'unavailable', reason });
            applyRemoteHostCatalogSnapshot(scope, result, true);
            expect(getRemoteHostCatalogSnapshot(scope)!.data).toBeNull();
        },
    );

    it.each(['matching', 'rotated'] as const)('cleans signed SSH history through the captured UI catalog only for exact historical material (%s)', async state => {
        const accountId = 'ssh-history-account';
        const value = '  historical SSH private fixture\n';
        const source = { kind: 'remote-host-ssh-credential' as const, hostId: 'history-host', slot: 'password' as const };
        const resourceId = deriveSavedSecretImportResourceIdV1({ accountId, source });
        const ref = formatSharedSavedSecretRefV1(resourceId);
        const ssh = { target: 'dev@example.test', authMode: 'password' as const };
        const host = { id: source.hostId, name: 'Host', ssh: { ...ssh, passwordSecretRef: ref },
            createdAt: 1, updatedAt: 1, lastUsedAt: null };
        let recorded: AccountSettingsStoredContentEnvelope = { t: 'plain', v: { remoteHostsV1: [{ ...host,
            ssh: { ...ssh, passwordEnc: { _isSecretValue: true, value } } }], preferredLanguage: 'de' } };
        const resource = SavedSecretResourceMaterialV1Schema.parse({ resourceId, encryptionMode: 'plain', recipientEnvelope: null,
            storedContent: { t: 'plain', v: { v: 1, name: 'SSH password', kind: 'password', value: state === 'matching' ? value : 'rotated-private-fixture' } },
            entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'SSH password', kind: 'password',
                encryptionMode: 'plain', ownerAccountId: accountId, revision: 3, materialStatus: 'ready',
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } });
        const mutations: ReturnType<typeof AccountSettingsV2HistoryMutationRequestSchema.parse>[] = [];
        const context: owner.RemoteHostAccountContext = { serverId: 'home', accountId, credentials: { token: createAccountTokenForTests(accountId) },
            resolveAccountMode: async () => 'plain',
            resolveAccountEncryption: async () => ({ accountMode: 'plain', encryption: null }), assertCurrent: () => {},
            accountLifetime: { scope: { serverId: 'home', accountId }, isCurrent: () => true, onRetire: () => () => {} },
            mutateRawSettings: async () => { throw new Error('The current source is already clean'); },
            // Home HTTP is the sole substituted boundary; resource opening and History normalization stay real.
            request: (async (path, init) => {
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }));
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [resource] });
                if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {} } });
                if (path === '/v1/account/entity-rows/profiles/transfer') return Response.json({ status: 'absent' });
                if (path === '/v1/account/entity-rows/remote-hosts') return Response.json({ status: 'present', revision: 2,
                    content: { t: 'plain', v: { v: 1, hosts: [host] } } });
                if (path === '/v2/account/settings/history') return Response.json({ snapshots: [{ version: 4,
                    createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: JSON.stringify(recorded).length }] });
                if (path === '/v2/account/settings/history/4') return Response.json({ version: 4, createdAt: '2026-01-01T00:00:00.000Z', content: recorded });
                if (path === '/v2/account/settings/history/4/mutate') {
                    const mutation = AccountSettingsV2HistoryMutationRequestSchema.parse(JSON.parse(String(init?.body)));
                    if (mutation.operation.kind !== 'normalize') throw new Error('Expected History normalization');
                    mutations.push(mutation); recorded = mutation.operation.content!;
                    return Response.json({ status: 'applied' });
                }
                return Response.json({}, { status: 404 });
            }) satisfies ServerFetch,
        };
        const result = await owner.readRemoteHostCatalogProjectionInContext(context);
        expect(result).toMatchObject({ status: 'ready', revision: 2 });
        expect(result.status === 'ready' ? result.cleanup : null).toBe(state === 'matching' ? undefined : 'pending');
        expect(mutations).toHaveLength(state === 'matching' ? 1 : 0);
        if (state === 'matching') {
            expect(mutations[0]!.operation).toMatchObject({ savedSecretTransfers: [{ source, resourceId, expectedRevision: 3 }] });
            expect(recorded).toEqual({ t: 'plain', v: { preferredLanguage: 'de' } });
        } else expect(recorded.t === 'plain' && recorded.v.remoteHostsV1).toBeTruthy();
    });

    it('saves only against the addressed complete catalog and preserves siblings without publishing before acknowledgement', async () => {
        const host = { id: 'host', name: 'Host', ssh: { target: 'dev@example.test', authMode: 'agent' as const },
            createdAt: 1, updatedAt: 1, lastUsedAt: null };
        const sibling = { ...host, id: 'sibling' };
        const writes: unknown[] = [];
        let revision = 4;
        const context = { serverId: 'home', accountId: 'account', credentials: { token: createAccountTokenForTests('account') },
            resolveAccountMode: async () => 'plain' as const,
            resolveAccountEncryption: async () => ({ accountMode: 'plain' as const, encryption: null }), assertCurrent: () => {},
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => () => {} },
            mutateRawSettings: async () => { throw new Error('A destination-only edit must not write Settings'); },
            request: (async (path, init) => {
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }));
                if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [] });
                if (path === '/v2/account/settings') return Response.json({ version: 4, content: { t: 'plain', v: {} } });
                if (path.startsWith('/v2/account/settings/history')) return Response.json({ snapshots: [] });
                if (path === '/v1/account/entity-rows/profiles/transfer') return Response.json({ status: 'absent' });
                if (path !== '/v1/account/entity-rows/remote-hosts') return Response.json({}, { status: 404 });
                if (init?.method === 'POST') { writes.push(JSON.parse(String(init.body))); return Response.json({ status: 'updated', revision: 5, cursor: 1 }); }
                return Response.json({ status: 'present', revision, content: { t: 'plain', v: { v: 1, hosts: [host, sibling] } } });
            }) satisfies ServerFetch,
        };
        const save = 'saveRemoteHostInContext' in owner ? owner.saveRemoteHostInContext : undefined;
        expect(typeof save).toBe('function');
        if (typeof save !== 'function') throw new Error('missing_canonical_host_writer');
        await expect(save(context, { host: { ...host, name: 'Edited' }, expectedRevision: 4 })).resolves.toEqual({ ok: true, revision: 5 });
        expect(writes).toEqual([{ mutation: { expectedRevision: 4, referencedSavedSecretRevisions: [],
            content: { t: 'plain', v: { v: 1, hosts: [{ ...host, name: 'Edited' }, sibling] } } } }]);
        revision = 6;
        await expect(save(context, { host, expectedRevision: 4 })).resolves.toMatchObject({ ok: false, reason: 'changed' });
        expect(writes).toHaveLength(1);
    });
});
