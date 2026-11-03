import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    accountSettingsParse,
    applyAccountSettingsSavedSecretMutation,
    formatSavedSecretCatalogReferenceV1,
    resolveAccountSettingsPluginSecret,
    resolveAccountSettingsPluginSecretBinding,
    sealSavedSecretResourceStoredContentV1,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { listUnreferencedPluginCreatedSecretResources } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
    resolveAccountSettingsScopeKey,
    resolveAccountSettingsScopeKeyForToken,
} from '@/settings/accountSettings/accountSettingsScopeKey';
import {
    clearActiveAccountSettingsSnapshot,
    getActiveAccountSettingsSnapshot,
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
    type ActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { createAccountPluginSecretCustodyRouter as createRouter } from './accountPluginSecretCustody';
import { createSecretSourceHostFixture } from '@/plugins/testkit/secretSources';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
    createDaemonPluginSecretCustodyRouter,
    createDeclaredPluginSecretsService,
    createPluginSecretCustodyRouter,
} from './secrets';

const {
    axiosGetMock,
    axiosPostMock,
    readStoredCredentialsMock,
} = vi.hoisted(() => ({
    axiosGetMock: vi.fn(),
    axiosPostMock: vi.fn(),
    readStoredCredentialsMock: vi.fn(),
}));

vi.mock('axios', () => ({
    default: {
        // The credential transport reads Axios defaults before the HTTP boundary.
        defaults: {},
        get: axiosGetMock,
        post: axiosPostMock,
    },
    get: axiosGetMock,
    post: axiosPostMock,
}));

vi.mock('@/persistence', async original => ({
    ...await original<typeof import('@/persistence')>(),
    readStoredCredentials: () => readStoredCredentialsMock(),
}));

// The Home features read is a network boundary of the catalog refresh owner.
vi.mock('@/features/serverFeaturesClient', () => ({
    fetchServerFeaturesSnapshot: vi.fn(async () => ({
        status: 'ready' as const,
        features: {
            features: { teams: { enabled: true, credentialResources: { enabled: true } } },
            capabilities: {},
        },
    })),
}));

// In-memory Settings and resource persistence boundaries for the custody tests.
// The companion resources test exercises the real HTTP/crypto/Action composition.
function createAccountPluginSecretCustodyRouter(params: NonNullable<Parameters<typeof createRouter>[0]>
    & Readonly<{ createId?: () => string; nowMs?: () => number; onResourceRead?: () => void }> = {}) {
    const readSnapshot = params.owner?.readSnapshot ?? getActiveAccountSettingsSnapshot;
    let sequence = 0;
    const publish = (resources: NonNullable<ActiveAccountSettingsSnapshot['savedSecretResources']>) => {
        const snapshot = readSnapshot();
        if (!snapshot) throw new Error('Fixture Account is unavailable');
        if (params.owner) Object.assign(snapshot, { savedSecretResources: resources, savedSecretCatalogState: 'ready' });
        else setActiveAccountSettingsSnapshot({ ...snapshot, savedSecretResources: resources, savedSecretCatalogState: 'ready' });
    };
    return createRouter({ ...params, resources: params.resources ?? {
        ...(params.onResourceRead ? { async readCensus(assertCurrent: () => void) {
            params.onResourceRead?.();
            assertCurrent();
            return { resources: [] };
        } } : {}),
        async create(input) {
            input.assertCurrent();
            const resourceId = params.createId?.() ?? `fixture-resource-${++sequence}`;
            publish([...(readSnapshot()?.savedSecretResources ?? []), { resourceId, ownerAccountId: 'fixture-owner', displayName: input.name,
                kind: 'other', encryptionMode: 'plain', revision: 1, materialStatus: 'ready', relationship: 'owner',
                storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
                    content: { v: 1, name: input.name, kind: 'other', value: input.value } }) }]);
            return formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
        },
        async delete(input) {
            input.assertCurrent();
            publish((readSnapshot()?.savedSecretResources ?? []).filter(row =>
                formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: row.resourceId }) !== input.ref));
        },
    } });
}

describe('createAccountPluginSecretCustodyRouter', () => {
    it('keeps undeclared Account binding ids distinct through one invocation custody', async () => {
        let snapshot: ActiveAccountSettingsSnapshot = { source: 'network', scopeKey: 'account:ids',
            settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1,
            settingsSecretsReadKeys: [], savedSecretCatalogState: 'ready' };
        const router = createAccountPluginSecretCustodyRouter({ owner: {
            readSnapshot: () => snapshot,
            // The in-memory resource boundary already publishes the exact rows.
            async admitSharedSecretForOperation() {},
            async updateOnce(input) {
                input.assertCurrent();
                snapshot = { ...snapshot, settings: accountSettingsParse(input.mutate(snapshot.settings)),
                    settingsVersion: snapshot.settingsVersion + 1 };
                return { status: 'applied', settings: snapshot.settings, version: snapshot.settingsVersion };
            },
        } });
        const service = createDeclaredPluginSecretsService({ pluginId: 'acme.example', declarations: [],
            resolveCustody: router.resolve, signal: new AbortController().signal,
            isOccurrenceCurrent: () => true, registerRawForRedaction: () => {} });
        await service.set('first', 'first-value');
        await service.set('second', 'second-value');
        await expect(service.get('first')).resolves.toBe('first-value');
        await expect(service.get('second')).resolves.toBe('second-value');
        await service.delete('first');
        await expect(service.get('first')).rejects.toMatchObject({ code: 'plugin_secret_missing' });
        await expect(service.get('second')).resolves.toBe('second-value');
    });
    it('saves without declaration opt-in with separately reviewed audiences and no cross-id write', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-shared-save-custody-'));
        onTestFinished(async () => { await rm(happyHomeDir, { recursive: true, force: true }); });
        const scopeKey = 'shared-save-account';
        const snapshot: ActiveAccountSettingsSnapshot = { source: 'network', scopeKey,
            settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] };
        let activeSnapshot: ActiveAccountSettingsSnapshot | null = snapshot;
        const created: string[] = [];
        const resourceCandidates: Array<NonNullable<Parameters<typeof listUnreferencedPluginCreatedSecretResources>[2]>['resources'][number]> = [];
        let beforeSharedCommit = () => {};
        const router = createRouter({ owner: { readSnapshot: () => activeSnapshot,
            updateOnce: async () => { throw new Error('Shared save must not mutate Settings'); } },
            resources: { create: async () => { throw new Error('Personal creation must not run'); }, delete: async () => {},
                createShared: async input => { input.assertCurrent(); beforeSharedCommit(); input.assertCurrent(); created.push(input.name);
                    resourceCandidates.push({ ref: `happier:shared-secret:v1:${input.name}`,
                        createdByPlugin: input.createdByPlugin, deploymentReferenceState: 'unreferenced' });
                    return { ref: `happier:shared-secret:v1:${input.name}`, resourceRevision: 1 }; } } });
        const resolveCustody = createPluginSecretCustodyRouter({ account: router.resolve,
            daemon: createDaemonPluginSecretCustodyRouter({ paths: resolvePluginStorePaths({ happyHomeDir }),
                resolveDeviceLocalSecretStorage: async () => ({ deriveSecretKey: () => new Uint8Array(32).fill(7) }),
            }).resolve,
        }).resolve;
        const declarations = [{ id: 'database', custody: 'account' as const },
            { id: 'backup', custody: 'account' as const },
            { id: 'settingsOnly', custody: 'account' as const }, { id: 'local', custody: 'daemon' as const }];
        const redacted: string[] = [];
        const signal = new AbortController();
        let current = true;
        const serviceFor = (id: string, audience: { teamGrants: string[] }) => createDeclaredPluginSecretsService({
            pluginId: 'acme.example', declarations: id === 'backup' ? [...declarations].reverse() : declarations,
            resolveCustody, signal: signal.signal,
            isOccurrenceCurrent: () => current, registerRawForRedaction: value => redacted.push(value),
            sharedSaveAdmission: { id, purpose: id, audience, assertCurrent: () => {} },
        });
        const admittedAudience = { teamGrants: ['team-db'] };
        const first = serviceFor('database', admittedAudience);
        const bytes = new TextEncoder().encode('\uFEFFshared-save-sentinel');
        await expect(first.saveShared('database', { label: 'database', bytes, audience: { teamGrants: ['team-db', 'team-db'] } }))
            .resolves.toEqual({ ref: 'happier:shared-secret:v1:database', resourceRevision: 1 });
        expect([...bytes]).toEqual([...new TextEncoder().encode('\uFEFFshared-save-sentinel')]);
        expect(listUnreferencedPluginCreatedSecretResources(snapshot.settings, snapshot.settings,
            { resources: resourceCandidates })).toEqual(['happier:shared-secret:v1:database']);
        // Home boundary projection after real bindings.set/unbind is proved by
        // the companion server DB contract; the canonical census remains real here.
        resourceCandidates[0] = { ...resourceCandidates[0]!, deploymentReferenceState: 'referenced' };
        expect(listUnreferencedPluginCreatedSecretResources(snapshot.settings, snapshot.settings,
            { resources: resourceCandidates })).toEqual([]);
        resourceCandidates[0] = { ...resourceCandidates[0]!, deploymentReferenceState: 'unreferenced' };
        expect(listUnreferencedPluginCreatedSecretResources(snapshot.settings, snapshot.settings,
            { resources: resourceCandidates })).toEqual(['happier:shared-secret:v1:database']);
        expect(snapshot.settings).not.toHaveProperty('pluginSecretBindingsV1');
        for (const id of ['backup', 'missing', 'settingsOnly', 'local']) {
            await expect(first.saveShared(id, { label: 'refused', bytes, audience: { teamGrants: ['team-db'] } })).rejects.toBeDefined();
        }
        await expect(first.saveShared('database', { label: 'refused', bytes, audience: { teamGrants: ['team-db', 'team-other'] } }))
            .rejects.toMatchObject({ code: 'plugin_secret_save_not_admitted' });
        await expect(serviceFor('settingsOnly', { teamGrants: ['team-db'] }).saveShared('settingsOnly', {
            label: 'settingsOnly', bytes, audience: { teamGrants: ['team-db'] },
        })).resolves.toEqual({ ref: 'happier:shared-secret:v1:settingsOnly', resourceRevision: 1 });
        await expect(serviceFor('undeclared', { teamGrants: ['team-db'] }).saveShared('undeclared', {
            label: 'undeclared', bytes, audience: { teamGrants: ['team-db'] },
        })).resolves.toEqual({ ref: 'happier:shared-secret:v1:undeclared', resourceRevision: 1 });
        const daemonRouted = serviceFor('local', { teamGrants: ['team-db'] });
        await daemonRouted.set('local', 'daemon-original');
        await expect(daemonRouted.saveShared('local', { label: 'local', bytes, audience: { teamGrants: ['team-db'] } }))
            .resolves.toEqual({ ref: 'happier:shared-secret:v1:local', resourceRevision: 1 });
        await expect(daemonRouted.get('local')).resolves.toBe('daemon-original');
        expect(snapshot.settings).not.toHaveProperty('pluginSecretBindingsV1');
        await expect(Reflect.apply(first.saveShared, first, [undefined, {
            label: 'refused', bytes, audience: { teamGrants: ['team-db'] },
        }])).rejects.toBeDefined();
        await expect(serviceFor('backup', { teamGrants: ['team-backup'] }).saveShared('backup', {
            label: 'backup', bytes, audience: { teamGrants: ['team-backup'] },
        })).resolves.toEqual({ ref: 'happier:shared-secret:v1:backup', resourceRevision: 1 });
        const aborted = new AbortController(); aborted.abort();
        await expect(first.saveShared('database', { label: 'refused', bytes, audience: { teamGrants: ['team-db'] } }, { signal: aborted.signal }))
            .rejects.toBeDefined();
        current = false;
        await expect(first.saveShared('database', { label: 'refused', bytes, audience: { teamGrants: ['team-db'] } })).rejects.toBeDefined();
        current = true;
        beforeSharedCommit = () => { current = false; };
        await expect(first.saveShared('database', { label: 'refused', bytes, audience: { teamGrants: ['team-db'] } })).rejects.toBeDefined();
        beforeSharedCommit = () => {};
        current = true;
        activeSnapshot = { ...snapshot, scopeKey: 'another-account' };
        await expect(first.saveShared('database', { label: 'refused', bytes, audience: { teamGrants: ['team-db'] } }))
            .rejects.toMatchObject({ code: 'plugin_secret_custody_unavailable' });
        activeSnapshot = snapshot;
        beforeSharedCommit = () => { admittedAudience.teamGrants.push('team-other'); };
        await expect.soft(first.saveShared('database', { label: 'refused', bytes, audience: { teamGrants: ['team-db'] } }))
            .rejects.toMatchObject({ code: 'plugin_secret_save_not_admitted' });
        beforeSharedCommit = () => {};
        admittedAudience.teamGrants = ['team-db'];
        signal.abort();
        await expect(first.saveShared('database', { label: 'refused', bytes, audience: { teamGrants: ['team-db'] } })).rejects.toBeDefined();
        expect.soft(created).toEqual(['database', 'settingsOnly', 'undeclared', 'local', 'backup']);
        expect.soft(redacted).toContain('\uFEFFshared-save-sentinel');
    });
    it('keeps the rejected binding outcome when cleanup loses the Account lifetime', async () => {
        let lifetime = 1;
        const snapshot: ActiveAccountSettingsSnapshot = { source: 'network', scopeKey: 'account:a',
            settings: accountSettingsParse({}), settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [] };
        const router = createAccountPluginSecretCustodyRouter({ owner: {
            readSnapshot: () => snapshot,
            readLifetimeToken: () => lifetime,
            async updateOnce(input) {
                input.assertCurrent();
                lifetime++;
                return { status: 'conflict', currentVersion: 5 };
            },
        } });
        const custody = router.resolve({ pluginId: 'acme.example', declaration: { id: 'token', custody: 'account' } });
        if (!custody) throw new Error('Fixture custody unavailable');
        await expect(custody.set({ secretId: 'token', value: 'fixture-material' })).rejects.toMatchObject({
            code: 'plugin_secret_revision_conflict',
        });
        expect(snapshot.savedSecretResources?.length).toBe(1);
    });
    it('keeps an acknowledged replacement when cleanup loses the Account lifetime', async () => {
        let lifetime = 1;
        const resourceReads = vi.fn();
        const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: 'previous-created' });
        let snapshot: ActiveAccountSettingsSnapshot = { source: 'network', scopeKey: 'account:a',
            settings: accountSettingsParse(applyAccountSettingsSavedSecretMutation({}, {
                kind: 'replacePluginSecret', target: { pluginId: 'acme.example', localId: 'token' },
                expectedSecretId: null, expectedSecretUpdatedAt: null, secretId: ref,
            }).settings), settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [],
            savedSecretResources: [{ resourceId: 'previous-created', ownerAccountId: 'fixture-owner', displayName: 'Previous',
                kind: 'other', encryptionMode: 'plain', revision: 1, materialStatus: 'ready', relationship: 'owner',
                storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'previous-created', mode: 'plain',
                    content: { v: 1, name: 'Previous', kind: 'other', value: 'previous-fixture' } }) }] };
        const router = createAccountPluginSecretCustodyRouter({ onResourceRead: resourceReads, owner: {
            readSnapshot: () => snapshot,
            readLifetimeToken: () => lifetime,
            async updateOnce(input) {
                input.assertCurrent();
                snapshot = { ...snapshot, settings: accountSettingsParse(input.mutate(snapshot.settings)), settingsVersion: 5 };
                lifetime++;
                return { status: 'applied', version: 5, settings: snapshot.settings };
            },
        } });
        const custody = router.resolve({ pluginId: 'acme.example', declaration: { id: 'token', custody: 'account' } });
        if (!custody) throw new Error('Fixture custody unavailable');
        await expect(custody.set({ secretId: 'token', value: 'replacement-fixture' })).resolves.toMatchObject({
            revision: expect.stringMatching(/^account-secret-r1:/u),
        });
        expect(snapshot.savedSecretResources?.length).toBe(2);
        expect(resourceReads, 'retirement withdraws resource-read authority before cleanup starts').not.toHaveBeenCalled();
    });
    it('binds and materializes a current shared ref, rotates by revision, and fails terminally after revocation', async () => {
        const resourceId = 'resource-plugin';
        const sharedRef = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
        const resource = (revision: number, value: string) => ({
            resourceId,
            ownerAccountId: 'owner-a',
            displayName: 'Shared plugin token',
            kind: 'token' as const,
            encryptionMode: 'plain' as const,
            revision,
            storedContent: sealSavedSecretResourceStoredContentV1({
                resourceId,
                mode: 'plain',
                content: { v: 1, name: 'Shared plugin token', kind: 'token', value },
            }),
            materialStatus: 'ready' as const,
        });
        let snapshot: ActiveAccountSettingsSnapshot = {
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            savedSecretResources: [resource(1, 'shared-v1')],
            savedSecretCatalogState: 'ready',
            scopeKey: 'account:a',
        };
        const router = createAccountPluginSecretCustodyRouter({
            owner: {
                readSnapshot: () => snapshot,
                // This case drives the catalog by replacing `snapshot`, which
                // stands for each fresh Home answer; the production admission
                // (proven below) is what writes that answer into the snapshot.
                async admitSharedSecretForOperation() {},
                async updateOnce(input: Readonly<{
                    expectedVersion: number;
                    mutate(settings: Readonly<Record<string, unknown>>): Record<string, unknown>;
                    assertCurrent(): void;
                }>) {
                    snapshot = {
                        ...snapshot,
                        settings: accountSettingsParse(input.mutate(snapshot.settings)),
                        settingsVersion: snapshot.settingsVersion + 1,
                    };
                    return {
                        status: 'applied' as const,
                        version: snapshot.settingsVersion,
                        settings: snapshot.settings,
                    };
                },
            } as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
        });

        await expect(router.bindExisting({
            pluginId: 'acme.example',
            secretId: 'token',
            savedSecretId: sharedRef,
        })).resolves.toMatchObject({ revision: expect.stringMatching(/^account-secret-r1:/u) });
        expect(resolveAccountSettingsPluginSecretBinding(snapshot.settings, {
            pluginId: 'acme.example',
            localId: 'token',
        })?.savedSecretId).toBe(sharedRef);
        expect(snapshot.settings.secrets).toEqual([]);

        const custody = router.resolve({
            pluginId: 'acme.example',
            declaration: { id: 'token', custody: 'account' },
        });
        if (!custody) throw new Error('expected Account custody');
        const first = await custody.status('token');
        await expect(custody.get('token')).resolves.toEqual({
            value: 'shared-v1',
            revision: first.revision,
        });

        snapshot = { ...snapshot, savedSecretResources: [resource(2, 'shared-v2')] };
        const rotated = await custody.status('token');
        expect(rotated.revision).not.toBe(first.revision);
        await expect(custody.get('token')).resolves.toEqual({
            value: 'shared-v2',
            revision: rotated.revision,
        });

        snapshot = { ...snapshot, savedSecretResources: [], savedSecretCatalogState: 'ready' };
        await expect(custody.get('token')).rejects.toMatchObject({
            code: 'plugin_secret_custody_unavailable',
            details: { materialStatus: 'forbidden' },
            retryable: false,
        });
        expect(JSON.stringify(await custody.status('token'))).not.toContain('shared-v2');

        const replacement = await custody.set({ secretId: 'token', value: 'plugin-personal' });
        expect(resolveAccountSettingsPluginSecretBinding(snapshot.settings, {
            pluginId: 'acme.example',
            localId: 'token',
        })).toMatchObject({
            createdForBinding: true,
        });
        expect(snapshot.savedSecretResources?.length).toBe(1);
        await custody.delete({ secretId: 'token', expectedRevision: replacement.revision });
        expect(resolveAccountSettingsPluginSecretBinding(snapshot.settings, {
            pluginId: 'acme.example',
            localId: 'token',
        })).toBeNull();
        expect(snapshot.settings.secrets).toEqual([]);
    });

    it('re-reads the Home before a new plugin read spends a shared secret whose revocation hint was missed', async () => {
        resetActiveAccountSettingsSnapshotForTests();
        const token = 'plugin-account-token';
        const resourceId = 'resource-plugin-revoked';
        const sharedRef = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
        try {
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse(applyAccountSettingsSavedSecretMutation(accountSettingsParse({}), {
                    kind: 'bindPluginSecret',
                    target: { pluginId: 'acme.example', localId: 'token' },
                    expectedSecretId: null,
                    expectedSecretUpdatedAt: null,
                    secretId: sharedRef,
                }).settings),
                settingsVersion: 4,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: resolveAccountSettingsScopeKeyForToken(token),
                savedSecretCatalogState: 'ready',
                // Hydrated before the owner removed the grant; the
                // AccountChange that would have said so never arrived.
                savedSecretResources: [{
                    resourceId,
                    ownerAccountId: 'owner-a',
                    displayName: 'Shared plugin token',
                    kind: 'token',
                    encryptionMode: 'plain',
                    revision: 3,
                    storedContent: sealSavedSecretResourceStoredContentV1({
                        resourceId,
                        mode: 'plain',
                        content: { v: 1, name: 'Shared plugin token', kind: 'token', value: 'revoked-value' },
                    }),
                    materialStatus: 'ready',
                }],
            });
            readStoredCredentialsMock.mockResolvedValue({ token, encryption: null });
            // The Home's current authorized answer no longer contains the row.
            axiosGetMock.mockResolvedValueOnce({ status: 200, data: { resources: [] } });
            const custody = createAccountPluginSecretCustodyRouter().resolve({
                pluginId: 'acme.example',
                declaration: { id: 'token', custody: 'account' },
            });
            if (!custody) throw new Error('expected Account custody');

            await expect(custody.get('token')).rejects.toMatchObject({ code: 'plugin_secret_custody_unavailable' });
            expect(axiosGetMock).toHaveBeenCalledWith(
                expect.stringContaining('/v1/account/saved-secrets/resources/materials'),
                expect.anything(),
            );
            expect(JSON.stringify(getActiveAccountSettingsSnapshot()?.savedSecretResources ?? [])).not.toContain('revoked-value');
        } finally {
            axiosGetMock.mockReset();
            readStoredCredentialsMock.mockReset();
            resetActiveAccountSettingsSnapshotForTests();
        }
    });

    it('creates resource material without adding a Settings secret through one explicit binding version', async () => {
        let snapshot: ActiveAccountSettingsSnapshot = {
            source: 'network',
            settings: accountSettingsParse({ secrets: [] }),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        const updateOnce = vi.fn(async (input: Readonly<{
            expectedVersion: number;
            mutate(settings: Readonly<Record<string, unknown>>): Record<string, unknown>;
            assertCurrent(): void;
        }>) => {
            input.assertCurrent();
            snapshot = {
                ...snapshot,
                settings: accountSettingsParse(input.mutate(snapshot.settings)),
                settingsVersion: 5,
            };
            return Object.freeze({
                status: 'applied' as const,
                version: snapshot.settingsVersion,
                settings: snapshot.settings,
            });
        });
        const owner = {
            readSnapshot: () => snapshot,
            updateOnce,
        };
        // The test owns an in-memory Account Settings boundary, not router internals.
        const router = createAccountPluginSecretCustodyRouter({
            owner: owner as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
            createId: () => 'saved-secret-1',
            nowMs: () => 10,
        });
        const custody = router.resolve({
            pluginId: 'acme.example',
            declaration: { id: 'token', custody: 'account' },
        });
        if (!custody) throw new Error('expected Account custody');
        expect(resolveAccountSettingsPluginSecret(snapshot.settings, {
            pluginId: 'acme.example',
            localId: 'token',
        })).toBeNull();

        const result = await custody.set({ secretId: 'token', value: 'raw-secret' });

        expect(snapshot.settings.secrets.length).toBe(0);
        expect(snapshot.savedSecretResources?.length).toBe(1);
        expect(result.revision).toMatch(/^account-secret-r1:/u);
        expect(updateOnce).toHaveBeenCalledTimes(1);
        expect(updateOnce).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 4 }));
        await expect(custody.status('token')).resolves.toMatchObject({
            state: 'configured',
            revision: result.revision,
        });
        expect(resolveAccountSettingsPluginSecretBinding(snapshot.settings, {
            pluginId: 'acme.example',
            localId: 'token',
        })).toMatchObject({
            savedSecretId: formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: 'saved-secret-1' }), createdForBinding: true,
        });
    });

    it('binds an existing SavedSecret without accepting or returning its material', async () => {
        let snapshot: ActiveAccountSettingsSnapshot = {
            source: 'network',
            settings: accountSettingsParse({
                secrets: [{
                    id: 'saved-secret-existing',
                    name: 'Existing',
                    kind: 'apiKey',
                    encryptedValue: {
                        _isSecretValue: true,
                        encryptedValue: { t: 'enc-v1', c: 'ciphertext' },
                    },
                    createdAt: 1,
                    updatedAt: 1,
                }],
            }),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        const owner = {
            readSnapshot: () => snapshot,
            async updateOnce(input: Readonly<{
                expectedVersion: number;
                mutate(settings: Readonly<Record<string, unknown>>): Record<string, unknown>;
                assertCurrent(): void;
            }>) {
                input.assertCurrent();
                snapshot = {
                    ...snapshot,
                    settings: accountSettingsParse(input.mutate(snapshot.settings)),
                    settingsVersion: 5,
                };
                return Object.freeze({
                    status: 'applied' as const,
                    version: snapshot.settingsVersion,
                    settings: snapshot.settings,
                });
            },
        };
        const router = createAccountPluginSecretCustodyRouter({
            owner: owner as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
        });

        const result = await router.bindExisting({
            pluginId: 'acme.example',
            secretId: 'token',
            savedSecretId: 'saved-secret-existing',
        });

        expect(result).toEqual({ revision: expect.stringMatching(/^account-secret-r1:/u) });
        expect(JSON.stringify(result)).not.toContain('ciphertext');
        expect(resolveAccountSettingsPluginSecret(snapshot.settings, {
            pluginId: 'acme.example',
            localId: 'token',
        })).toMatchObject({
            binding: { savedSecretId: 'saved-secret-existing', createdForBinding: false },
        });
    });

    it('unbinds an Account plugin secret without deleting the SavedSecret it referenced', async () => {
        let snapshot: ActiveAccountSettingsSnapshot = {
            source: 'network',
            settings: accountSettingsParse({
                secrets: [{
                    id: 'saved-secret-existing',
                    name: 'Existing',
                    kind: 'apiKey',
                    encryptedValue: {
                        _isSecretValue: true,
                        encryptedValue: { t: 'enc-v1', c: 'ciphertext' },
                    },
                    createdAt: 1,
                    updatedAt: 1,
                }],
                pluginSecretBindingsV1: {
                    '["acme.example","account","token"]': {
                        pluginId: 'acme.example',
                        custody: 'account',
                        localId: 'token',
                        savedSecretId: 'saved-secret-existing',
                        createdForBinding: true,
                    },
                },
            }),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        const router = createAccountPluginSecretCustodyRouter({
            owner: {
                readSnapshot: () => snapshot,
                async updateOnce(input: Readonly<{
                    expectedVersion: number;
                    mutate(settings: Readonly<Record<string, unknown>>): Record<string, unknown>;
                    assertCurrent(): void;
                }>) {
                    input.assertCurrent();
                    snapshot = {
                        ...snapshot,
                        settings: accountSettingsParse(input.mutate(snapshot.settings)),
                        settingsVersion: 5,
                    };
                    return Object.freeze({
                        status: 'applied' as const,
                        version: snapshot.settingsVersion,
                        settings: snapshot.settings,
                    });
                },
            } as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
        });

        await expect(router.unbind({
            pluginId: 'acme.example',
            secretId: 'token',
        })).resolves.toEqual({ revision: expect.stringMatching(/^account-secret-r1:/u) });
        expect(resolveAccountSettingsPluginSecret(snapshot.settings, {
            pluginId: 'acme.example',
            localId: 'token',
        })).toBeNull();
        expect((snapshot.settings.secrets as readonly { id: string }[]).map(({ id }) => id))
            .toEqual(['saved-secret-existing']);
    });

    it.each([
        {
            label: 'an Account switch',
            next: {
                source: 'network' as const,
                settings: accountSettingsParse({}),
                settingsVersion: 1,
                loadedAtMs: 2,
                settingsSecretsReadKeys: [],
                scopeKey: 'account:b',
            },
        },
        { label: 'logout', next: null },
    ])('fails closed after $label instead of rebinding an existing custody object', async ({ next }) => {
        let snapshot: ActiveAccountSettingsSnapshot | null = {
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        const updateOnce = vi.fn(async () => {
            throw new Error('A retired Account custody must not reach Account Settings CAS');
        });
        const router = createAccountPluginSecretCustodyRouter({
            owner: {
                readSnapshot: () => snapshot,
                updateOnce,
            } as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
        });
        const custody = router.resolve({
            pluginId: 'acme.example',
            declaration: { id: 'token', custody: 'account' },
        });
        if (!custody) throw new Error('expected Account custody');

        snapshot = next;

        await expect(custody.status('token')).rejects.toMatchObject({
            code: 'plugin_secret_custody_unavailable',
        });
        await expect(custody.get('token')).rejects.toMatchObject({
            code: 'plugin_secret_custody_unavailable',
        });
        await expect(custody.set({ secretId: 'token', value: 'must-not-rebind' })).rejects.toMatchObject({
            code: 'plugin_secret_custody_unavailable',
        });
        expect(updateOnce).not.toHaveBeenCalled();
    });

    it.each([true, false])('binds Account custody at invocation creation with declared=%s, not on its first secret read', async declared => {
        let snapshot: ActiveAccountSettingsSnapshot | null = {
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        const accountCustody = createAccountPluginSecretCustodyRouter({
            owner: {
                readSnapshot: () => snapshot,
                async updateOnce() {
                    throw new Error('not reached by a status read');
                },
            } as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
        });
        const service = createDeclaredPluginSecretsService({
            pluginId: 'acme.example',
            declarations: declared ? [{ id: 'token', custody: 'account' }] : [],
            resolveCustody: createPluginSecretCustodyRouter({
                account: accountCustody.resolve,
            }).resolve,
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
            registerRawForRedaction: () => {},
        });

        snapshot = {
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 1,
            loadedAtMs: 2,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:b',
        };

        await expect(service.status('token')).rejects.toMatchObject({
            code: 'plugin_secret_custody_unavailable',
        });
    });

    it('does not revive an Account service after Account A transitions through B and returns to A', async () => {
        const controller = new AbortController();
        resetActiveAccountSettingsSnapshotForTests();
        try {
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 4,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: 'account:a',
            });
            const accountCustody = createAccountPluginSecretCustodyRouter();
            const service = createDeclaredPluginSecretsService({
                pluginId: 'acme.example',
                declarations: [{ id: 'token', custody: 'account' }],
                resolveCustody: createPluginSecretCustodyRouter({
                    account: accountCustody.resolve,
                }).resolve,
                signal: controller.signal,
                isOccurrenceCurrent: () => true,
                registerRawForRedaction: () => {},
            });

            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 1,
                loadedAtMs: 2,
                settingsSecretsReadKeys: [],
                scopeKey: 'account:b',
            });
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 5,
                loadedAtMs: 3,
                settingsSecretsReadKeys: [],
                scopeKey: 'account:a',
            });

            await expect(service.status('token')).rejects.toMatchObject({
                code: 'plugin_secret_custody_unavailable',
            });
        } finally {
            controller.abort();
            resetActiveAccountSettingsSnapshotForTests();
        }
    });

    it('keeps a production Account service usable when its active Account snapshot advances from v4 to v5', async () => {
        const controller = new AbortController();
        resetActiveAccountSettingsSnapshotForTests();
        try {
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 4,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: 'account:a',
            });
            const accountCustody = createAccountPluginSecretCustodyRouter();
            const service = createDeclaredPluginSecretsService({
                pluginId: 'acme.example',
                declarations: [{ id: 'token', custody: 'account' }],
                resolveCustody: createPluginSecretCustodyRouter({
                    account: accountCustody.resolve,
                }).resolve,
                signal: controller.signal,
                isOccurrenceCurrent: () => true,
                registerRawForRedaction: () => {},
            });

            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 5,
                loadedAtMs: 2,
                settingsSecretsReadKeys: [],
                scopeKey: 'account:a',
            });

            await expect(service.status('token')).resolves.toMatchObject({ state: 'missing' });
        } finally {
            controller.abort();
            resetActiveAccountSettingsSnapshotForTests();
        }
    });

    it('keeps a production Account service usable after its own settled v4-to-v5 secret mutation', async () => {
        const controller = new AbortController();
        const credentials = {
            token: 'account-a',
            encryption: null,
        };
        resetActiveAccountSettingsSnapshotForTests();
        readStoredCredentialsMock.mockResolvedValue(credentials);
        axiosGetMock.mockImplementation(async (url: string) => {
            if (url.endsWith('/v2/account/settings')) {
                return { status: 200, data: { content: { t: 'plain', v: {} }, version: 4 } };
            }
            if (url.endsWith('/v1/account/encryption')) {
                return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            }
            throw new Error(`unexpected account settings request: ${url}`);
        });
        axiosPostMock.mockResolvedValue({ status: 200, data: { success: true, version: 5 } });
        try {
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 4,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: resolveAccountSettingsScopeKey(credentials),
            });
            const accountCustody = createAccountPluginSecretCustodyRouter();
            const service = createDeclaredPluginSecretsService({
                pluginId: 'acme.example',
                declarations: [{ id: 'token', custody: 'account' }],
                resolveCustody: createPluginSecretCustodyRouter({
                    account: accountCustody.resolve,
                }).resolve,
                signal: controller.signal,
                isOccurrenceCurrent: () => true,
                registerRawForRedaction: () => {},
            });

            const result = await service.set('token', 'raw-secret');

            expect(axiosPostMock).toHaveBeenCalledTimes(1);
            expect(result.revision).toMatch(/^account-secret-r1:/u);
            await expect(service.status('token')).resolves.toMatchObject({
                state: 'configured',
                revision: result.revision,
            });
        } finally {
            controller.abort();
            axiosGetMock.mockReset();
            axiosPostMock.mockReset();
            readStoredCredentialsMock.mockReset();
            resetActiveAccountSettingsSnapshotForTests();
        }
    });

    it('does not republish an outcome-unknown SavedSecret write after its Account lifetime is cleared', async () => {
        const controller = new AbortController();
        const credentials = {
            token: 'account-a',
            encryption: null,
        };
        let accountSettingsReads = 0;
        let submittedContent: unknown = null;
        let releaseAuthoritativeReread!: () => void;
        resetActiveAccountSettingsSnapshotForTests();
        readStoredCredentialsMock.mockResolvedValue(credentials);
        axiosGetMock.mockImplementation((url: string) => {
            if (url.endsWith('/v2/account/settings')) {
                accountSettingsReads += 1;
                if (accountSettingsReads === 1) {
                    return Promise.resolve({
                        status: 200,
                        data: { content: { t: 'plain', v: {} }, version: 4 },
                    });
                }
                return new Promise((resolve) => {
                    releaseAuthoritativeReread = () => resolve({
                        status: 200,
                        data: { content: submittedContent, version: 5 },
                    });
                });
            }
            if (url.endsWith('/v1/account/encryption')) {
                return Promise.resolve({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
            }
            throw new Error(`unexpected account settings request: ${url}`);
        });
        axiosPostMock.mockImplementation(async (_url: string, body: { content: unknown }) => {
            submittedContent = body.content;
            throw new Error('connection reset after submitted Account Settings write');
        });
        try {
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 4,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: resolveAccountSettingsScopeKey(credentials),
            });
            const accountCustody = createAccountPluginSecretCustodyRouter();
            const service = createDeclaredPluginSecretsService({
                pluginId: 'acme.example',
                declarations: [{ id: 'token', custody: 'account' }],
                resolveCustody: createPluginSecretCustodyRouter({
                    account: accountCustody.resolve,
                }).resolve,
                signal: controller.signal,
                isOccurrenceCurrent: () => true,
                registerRawForRedaction: () => {},
            });

            const pending = service.set('token', 'raw-secret');
            await vi.waitFor(() => expect(accountSettingsReads).toBe(2));
            clearActiveAccountSettingsSnapshot();
            releaseAuthoritativeReread();

            await expect(pending).rejects.toMatchObject({
                code: 'plugin_secret_outcome_unknown',
            });
            expect(getActiveAccountSettingsSnapshot()).toBeNull();
        } finally {
            controller.abort();
            axiosGetMock.mockReset();
            axiosPostMock.mockReset();
            readStoredCredentialsMock.mockReset();
            resetActiveAccountSettingsSnapshotForTests();
        }
    });

    it('uses the captured Account lifetime rather than scope equality after A transitions through B and back to A', async () => {
        let snapshot: ActiveAccountSettingsSnapshot | null = {
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        let lifetimeToken = 1;
        const router = createAccountPluginSecretCustodyRouter({
            owner: {
                readSnapshot: () => snapshot,
                readLifetimeToken: () => lifetimeToken,
                async updateOnce() {
                    throw new Error('a retired Account custody must not reach Account Settings CAS');
                },
            } as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
        });
        const custody = router.resolve({
            pluginId: 'acme.example',
            declaration: { id: 'token', custody: 'account' },
        });
        if (!custody) throw new Error('expected Account custody');

        snapshot = {
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 1,
            loadedAtMs: 2,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:b',
        };
        lifetimeToken += 1;
        snapshot = {
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 5,
            loadedAtMs: 3,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        lifetimeToken += 1;

        await expect(custody.status('token')).rejects.toMatchObject({
            code: 'plugin_secret_custody_unavailable',
        });
    });

    it('accepts a lost write response only after an authoritative reread proves the exact SavedSecret postcondition', async () => {
        let snapshot: ActiveAccountSettingsSnapshot = {
            source: 'network',
            settings: accountSettingsParse({ secrets: [] }),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        let submitted: Readonly<Record<string, unknown>> | null = null;
        let submittedWithoutResponse = false;
        const owner = {
            readSnapshot: () => snapshot,
            async updateOnce(input: Readonly<{
                expectedVersion: number;
                mutate(settings: Readonly<Record<string, unknown>>): Record<string, unknown>;
                assertCurrent(): void;
            }>) {
                input.assertCurrent();
                submitted = input.mutate(snapshot.settings);
                submittedWithoutResponse = true;
                return Object.freeze({ status: 'outcomeUnknown' as const, lastKnownVersion: 4 });
            },
            async rereadAfterAmbiguousWrite() {
                if (!submitted) throw new Error('expected submitted mutation');
                snapshot = {
                    ...snapshot,
                    settings: accountSettingsParse(submitted),
                    settingsVersion: 5,
                };
                return snapshot;
            },
        };
        const router = createAccountPluginSecretCustodyRouter({
            // The test owns an in-memory Account Settings boundary, not router internals.
            owner: owner as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
            createId: () => 'saved-secret-1',
            nowMs: () => 10,
        });
        const custody = router.resolve({
            pluginId: 'acme.example',
            declaration: { id: 'token', custody: 'account' },
        });
        if (!custody) throw new Error('expected Account custody');

        await expect(custody.set({
            secretId: 'token',
            value: 'raw-secret',
            assertCurrent: () => {
                if (!submittedWithoutResponse) return;
                throw new PluginError({
                    code: 'plugin_invocation_retired',
                    message: 'plugin invocation retired after submission',
                });
            },
        })).resolves.toMatchObject({
            revision: expect.stringMatching(/^account-secret-r1:/u),
        });
    });

    it('does not let post-ack currentness hide an acknowledged SavedSecret mutation', async () => {
        let acknowledged = false;
        let snapshot: ActiveAccountSettingsSnapshot = {
            source: 'network',
            settings: accountSettingsParse({ secrets: [] }),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        const rereadAfterAmbiguousWrite = vi.fn(async () => snapshot);
        const owner = {
            readSnapshot: () => snapshot,
            async updateOnce(input: Readonly<{
                expectedVersion: number;
                mutate(settings: Readonly<Record<string, unknown>>): Record<string, unknown>;
                assertCurrent(): void;
            }>) {
                input.assertCurrent();
                snapshot = {
                    ...snapshot,
                    settings: accountSettingsParse(input.mutate(snapshot.settings)),
                    settingsVersion: 5,
                };
                acknowledged = true;
                return Object.freeze({
                    status: 'applied' as const,
                    version: snapshot.settingsVersion,
                    settings: snapshot.settings,
                });
            },
            rereadAfterAmbiguousWrite,
        };
        const router = createAccountPluginSecretCustodyRouter({
            owner: owner as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
            createId: () => 'saved-secret-1',
            nowMs: () => 10,
        });
        const custody = router.resolve({
            pluginId: 'acme.example',
            declaration: { id: 'token', custody: 'account' },
        });
        if (!custody) throw new Error('expected Account custody');

        await expect(custody.set({
            secretId: 'token',
            value: 'raw-secret',
            assertCurrent: () => {
                if (!acknowledged) return;
                throw new PluginError({
                    code: 'plugin_invocation_retired',
                    message: 'plugin invocation retired after submission',
                });
            },
        })).resolves.toMatchObject({
            revision: expect.stringMatching(/^account-secret-r1:/u),
        });
        expect(rereadAfterAmbiguousWrite).not.toHaveBeenCalled();
    });

    it('does not accept a satisfied Account Settings result until the exact SavedSecret postcondition is reread', async () => {
        const snapshot: ActiveAccountSettingsSnapshot = {
            source: 'network',
            settings: accountSettingsParse({ secrets: [] }),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        const rereadAfterAmbiguousWrite = vi.fn(async () => snapshot);
        const owner = {
            readSnapshot: () => snapshot,
            async updateOnce(input: Readonly<{
                expectedVersion: number;
                mutate(settings: Readonly<Record<string, unknown>>): Record<string, unknown>;
                assertCurrent(): void;
            }>) {
                input.assertCurrent();
                return Object.freeze({
                    status: 'satisfied' as const,
                    version: 5,
                    settings: accountSettingsParse(input.mutate(snapshot.settings)),
                });
            },
            rereadAfterAmbiguousWrite,
        };
        const router = createAccountPluginSecretCustodyRouter({
            owner: owner as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
            createId: () => 'saved-secret-1',
            nowMs: () => 10,
        });
        const custody = router.resolve({
            pluginId: 'acme.example',
            declaration: { id: 'token', custody: 'account' },
        });
        if (!custody) throw new Error('expected Account custody');

        await expect(custody.set({ secretId: 'token', value: 'raw-secret' })).rejects.toMatchObject({
            code: 'plugin_secret_outcome_unknown',
        });
        expect(rereadAfterAmbiguousWrite).toHaveBeenCalledTimes(1);
    });

    it('preserves pre-submission cancellation and request-size refusal as distinct plugin errors', async () => {
        const snapshot: ActiveAccountSettingsSnapshot = {
            source: 'network',
            settings: accountSettingsParse({ secrets: [] }),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        const router = createAccountPluginSecretCustodyRouter({
            owner: {
                readSnapshot: () => snapshot,
                async updateOnce(input) {
                    input.assertCurrent();
                    return Object.freeze({ status: 'cancelled' as const, submitted: false as const });
                },
            },
            createId: () => 'saved-secret-1',
            nowMs: () => 10,
        });
        const custody = router.resolve({
            pluginId: 'acme.example',
            declaration: { id: 'token', custody: 'account' },
        });
        if (!custody) throw new Error('expected Account custody');

        await expect(custody.set({ secretId: 'token', value: 'raw-secret' })).rejects.toMatchObject({
            code: 'plugin_secret_custody_cancelled',
        });

        const tooLargeRouter = createAccountPluginSecretCustodyRouter({
            owner: {
                readSnapshot: () => snapshot,
                async updateOnce(input) {
                    input.assertCurrent();
                    return Object.freeze({ status: 'invalid' as const, reason: 'tooLarge' as const });
                },
            },
            createId: () => 'saved-secret-1',
            nowMs: () => 10,
        });
        const tooLargeCustody = tooLargeRouter.resolve({
            pluginId: 'acme.example',
            declaration: { id: 'token', custody: 'account' },
        });
        if (!tooLargeCustody) throw new Error('expected Account custody');

        await expect(tooLargeCustody.set({ secretId: 'token', value: 'raw-secret' })).rejects.toMatchObject({
            code: 'plugin_secret_custody_too_large',
        });
    });

    it('reports an unknown outcome when the authoritative reread cannot prove the submitted SavedSecret postcondition', async () => {
        const snapshot: ActiveAccountSettingsSnapshot = {
            source: 'network',
            settings: accountSettingsParse({ secrets: [] }),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        const owner = {
            readSnapshot: () => snapshot,
            async updateOnce(input: Readonly<{
                expectedVersion: number;
                mutate(settings: Readonly<Record<string, unknown>>): Record<string, unknown>;
                assertCurrent(): void;
            }>) {
                input.assertCurrent();
                input.mutate(snapshot.settings);
                return Object.freeze({ status: 'outcomeUnknown' as const, lastKnownVersion: 4 });
            },
            async rereadAfterAmbiguousWrite() {
                // The server may have accepted or rejected the request; this
                // still-current document proves neither outcome.
                return snapshot;
            },
        };
        const router = createAccountPluginSecretCustodyRouter({
            owner: owner as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
            createId: () => 'saved-secret-1',
            nowMs: () => 10,
        });
        const custody = router.resolve({
            pluginId: 'acme.example',
            declaration: { id: 'token', custody: 'account' },
        });
        if (!custody) throw new Error('expected Account custody');

        await expect(custody.set({ secretId: 'token', value: 'raw-secret' })).rejects.toMatchObject({
            code: 'plugin_secret_outcome_unknown',
        });
        expect(snapshot.savedSecretResources?.length).toBe(1);
    });


});
