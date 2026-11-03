import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { type SavedSecretResourceMaterialV1, SavedSecretCatalogEntryV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { SharedSavedSecretCreateInputV1Schema, SharedSavedSecretPromoteInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { createSecretSourceHostFixture } from '@/plugins/testkit/secretSources';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createInvocationSavedSecretOperationContextV1 } from './savedSecretOperationContext';
import { createCliPersonalSavedSecretActionExecute } from './personalSavedSecretActionHost';

// The HTTP transport and native vault are boundaries; Action admission and resource sealing remain real.
vi.mock('axios', async importOriginal => {
    const actual = await importOriginal<typeof import('axios')>();
    return { ...actual, default: Object.assign(actual.default.create(), { get: vi.fn(), post: vi.fn(), request: vi.fn() }) };
});
afterEach(() => { vi.mocked(axios.get).mockReset(); vi.unstubAllGlobals(); });
const accountId = 'vault-owner';
const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
const credentials = { token, encryption: null };
function boundary(resources: readonly SavedSecretResourceMaterialV1[] = []) {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }))));
    vi.mocked(axios.get).mockImplementation(async rawUrl => {
        const path = new URL(String(rawUrl)).pathname;
        if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 0,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (path.endsWith('/resources/materials')) return { status: 200, data: { resources } };
        throw new Error(`Unexpected boundary request ${path}`);
    });
}
function snapshot() {
    return { source: 'network' as const, settings: AccountSettingsSchema.parse({}), rawSettings: {}, settingsVersion: 0,
        loadedAtMs: 1, scopeKey: resolveAccountSettingsScopeKeyForToken(token), settingsSecretsReadKeys: [] };
}

describe('Saved Secret vault Actions', () => {
    it('returns empty vault destinations through native list and the personal list Action without acquiring values', async () => {
        boundary();
        const vaults = [{ id: 'empty-vault', name: 'Empty' }];
        const source = await createSecretSourceHostFixture({ runtime: {
            async acquire() { throw new Error('Metadata must not acquire values'); },
            async list() { return { ok: true, vaults, fields: [] }; },
        } });
        try {
            const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot: snapshot(),
                serverHttpBaseUrl: 'https://vault.example.test', isCurrent: async () => true, secretSources: source.host });
            const execute = createCliPersonalSavedSecretActionExecute({ credentials, operationContext,
                home: async () => { throw new Error('Metadata must not mutate'); } });
            await expect(execute({ actionId: 'secrets.list', input: { source: { contribution: source.contribution,
                account: 'selected-account' } }, context: { surface: 'cli' } }))
                .resolves.toMatchObject({ secrets: [], vaults, fields: [] });
        } finally { await source.dispose(); }
    });

    it('browses and links selected item fields in one resource transaction without reading native values', async () => {
        boundary();
        let acquisitions = 0;
        const fields = ['token', 'password'].map(id => ({ account: 'selected-account', reference: `op://vault/item/${id}`,
            vault: { id: 'vault', name: 'Work' }, item: { id: 'item', title: 'Cloud' }, field: { id, title: id, kind: 'CONCEALED' } }));
        const source = await createSecretSourceHostFixture({ runtime: {
            async acquire() { acquisitions += 1; return { ok: true, value: 'private' }; },
            async list() { return { ok: true, fields: [...fields, { ...fields[0]!, item: { id: 'other', title: 'Other' } }] }; },
        } });
        try {
            const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot: snapshot(),
                serverHttpBaseUrl: 'https://vault.example.test', isCurrent: async () => true, secretSources: source.host });
            const submitted: unknown[] = [];
            const execute = createCliPersonalSavedSecretActionExecute({ credentials, operationContext, home: async ({ actionId, input }) => {
                expect(actionId).toBe('secrets.shared.promote');
                const request = SharedSavedSecretPromoteInputV1Schema.parse(input); submitted.push(request);
                return { resourceId: request.resourceId, settingsVersion: 0 };
            } });
            const query = { contribution: source.contribution, account: 'selected-account', vaultId: 'vault' };
            await expect(execute({ actionId: 'secrets.list', input: { source: query }, context: { surface: 'cli' } }))
                .resolves.toMatchObject({ fields: [...fields, expect.objectContaining({ item: { id: 'other', title: 'Other' } })] });
            const result = await execute({ actionId: 'secrets.link', input: { source: query, itemIds: ['item'] }, context: { surface: 'cli' } });
            expect(result).toMatchObject({ secrets: [{ secretId: expect.any(String), secretRef: expect.any(String) },
                { secretId: expect.any(String), secretRef: expect.any(String) }] });
            expect(submitted).toHaveLength(1);
            const request = SharedSavedSecretPromoteInputV1Schema.parse(submitted[0]);
            expect(request).toMatchObject({ nextSettings: null, profileMutations: [], referenceCensus: { scope: 'catalogs', accountMode: 'plain', catalogs: {} } });
            const resources = [request, ...request.additionalSavedSecretResources ?? []];
            expect(resources.map(resource => resource.storedContent)).toEqual(fields.map(field => expect.objectContaining({ t: 'plain', v: {
                v: 2, name: `Cloud / ${field.field.title}`, kind: 'other', source: { kind: 'external', contribution: source.contribution,
                    account: field.account, reference: field.reference, metadata: { vault: field.vault, item: field.item, field: field.field } },
            } })));
            boundary(resources.map((resource, index) => ({ resourceId: resource.resourceId, encryptionMode: 'plain',
                recipientEnvelope: null, storedContent: resource.storedContent,
                entry: SavedSecretCatalogEntryV1Schema.parse({ ref: `happier:shared-secret:v1:${resource.resourceId}`,
                    source: 'shared_resource', relationship: 'owner', ownerAccountId: accountId,
                    name: `Cloud / ${fields[index]!.field.title}`, kind: 'other', revision: 1, materialStatus: 'ready',
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } }) })));
            await expect(execute({ actionId: 'secrets.list', input: {}, context: { surface: 'cli' } })).resolves.toMatchObject({
                secrets: fields.map(field => ({ name: `Cloud / ${field.field.title}`, source: { kind: 'external',
                    metadata: { vault: field.vault, item: field.item, field: field.field } } })),
            });
            expect(acquisitions).toBe(0);
        } finally { await source.dispose(); }
    });

    it('stores new material in the native vault and persists only its external locator', async () => {
        boundary();
        const stored: unknown[] = [];
        const source = await createSecretSourceHostFixture({ runtime: {
            async acquire() { return { ok: true, value: 'private' }; },
            async store(input) { stored.push(input); return { ok: true, account: input.account, reference: 'op://vault/created/token' }; },
        } });
        try {
            const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot: snapshot(),
                serverHttpBaseUrl: 'https://vault.example.test', isCurrent: async () => true, secretSources: source.host });
            const submitted: unknown[] = [];
            const execute = createCliPersonalSavedSecretActionExecute({ credentials, operationContext, home: async ({ actionId, input }) => {
                expect(actionId).toBe('secrets.shared.create');
                const request = SharedSavedSecretCreateInputV1Schema.parse(input); submitted.push(request);
                return { resourceId: request.resourceId, revision: 1 };
            } });
            await expect(execute({ actionId: 'secrets.create', input: { name: 'Cloud token', kind: 'token', value: 'new-private-token',
                storeIn: { contribution: source.contribution, account: 'chosen-account', vaultId: 'vault' } }, context: { surface: 'cli' } }))
                .resolves.toMatchObject({ secretRef: expect.any(String) });
            expect(stored).toEqual([{ account: 'chosen-account', vaultId: 'vault', title: 'Cloud token', value: 'new-private-token' }]);
            expect(SharedSavedSecretCreateInputV1Schema.parse(submitted[0]).storedContent).toMatchObject({ t: 'plain', v: {
                v: 2, name: 'Cloud token', kind: 'token', source: { kind: 'external', contribution: source.contribution,
                    account: 'chosen-account', reference: 'op://vault/created/token' },
            } });
        } finally { await source.dispose(); }
    });

    it('refuses shared and stale exports before any native vault write', async () => {
        let writes = 0;
        const source = await createSecretSourceHostFixture({ runtime: {
            async acquire() { return { ok: true, value: 'private' }; },
            async store(input) { writes += 1; return { ok: true, account: input.account, reference: 'op://vault/created/token' }; },
        } });
        try {
            const resourceId = 'shared';
            boundary([{ resourceId, encryptionMode: 'plain', recipientEnvelope: null,
                storedContent: { t: 'plain', v: { v: 1, name: 'Shared token', kind: 'token', value: 'private' } },
                entry: SavedSecretCatalogEntryV1Schema.parse({ ref: `happier:shared-secret:v1:${resourceId}`,
                    source: 'shared_resource', relationship: 'owner', ownerAccountId: accountId,
                    name: 'Shared token', kind: 'token', revision: 2, materialStatus: 'ready',
                    audience: { accounts: [accountId, 'other'].map(id => ({ kind: 'account', accountId: id,
                        name: null, firstName: null, lastName: null, username: null, avatarUrl: null })), teams: [], groups: [] },
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } }) }]);
            const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot: snapshot(),
                serverHttpBaseUrl: 'https://vault.example.test', isCurrent: async () => true, secretSources: source.host });
            const execute = createCliPersonalSavedSecretActionExecute({ credentials, operationContext,
                home: async () => { throw new Error('Rejected exports must not mutate'); } });
            const target = { contribution: source.contribution, account: 'chosen-account', vaultId: 'vault' };
            await expect(execute({ actionId: 'secrets.export', input: { target, secrets: [
                { secretId: resourceId, expectedUpdatedAt: 1 }, { secretId: resourceId, expectedUpdatedAt: 2 },
            ] }, context: { surface: 'cli' } })).resolves.toMatchObject({ results: [
                { status: 'failed', code: 'revision_conflict' }, { status: 'failed', code: 'recipient_mode_unsupported' },
            ] });
            expect(writes).toBe(0);
        } finally { await source.dispose(); }
    });

    it('keeps native unlock repair typed and denies a shared Machine use grant before browsing', async () => {
        boundary();
        let calls = 0;
        const source = await createSecretSourceHostFixture({ runtime: {
            async acquire() { return { ok: false, code: 'authentication_required', repair: 'unlock' }; },
            async list() { calls += 1; return { ok: false, code: 'authentication_required', repair: 'unlock' }; },
        } });
        try {
            const context = (shared: boolean) => createInvocationSavedSecretOperationContextV1({ credentials, snapshot: snapshot(),
                serverHttpBaseUrl: 'https://vault.example.test', isCurrent: async () => true, secretSources: source.host,
                ...(shared ? { machineAdmission: { actorAccountId: accountId, custodianAccountId: 'machine-owner', role: 'use' as const } } : {}) });
            const home = async () => { throw new Error('Browse must not mutate'); };
            const input = { source: { contribution: source.contribution, account: 'selected-account' } };
            await expect(createCliPersonalSavedSecretActionExecute({ credentials, operationContext: context(false), home })(
                { actionId: 'secrets.list', input, context: { surface: 'cli' } })).resolves.toMatchObject({
                    ok: false, errorCode: 'authentication_required', details: { sourceFailure: { code: 'authentication_required', repair: 'unlock' } },
                });
            await expect(createCliPersonalSavedSecretActionExecute({ credentials, operationContext: context(true), home })(
                { actionId: 'secrets.list', input, context: { surface: 'cli' } })).resolves.toMatchObject({ ok: false, errorCode: 'reference_forbidden' });
            expect(calls).toBe(1);
        } finally { await source.dispose(); }
    });
});
