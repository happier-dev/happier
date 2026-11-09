import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import { createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { sealAccountScopedBlobCiphertext, openAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createLegacyAccountEncryptionCurrentnessFixture, createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { storage } = await import('@/sync/domains/state/storage');
const { Encryption } = await import('@/sync/encryption/encryption');
const normalization = await import('@/sync/domains/settings/accountSettingsNormalization');

beforeEach(() => installHomeGovernanceBoundaries(harness));
afterEach(async () => { vi.restoreAllMocks(); await harness.reset(); });

async function serveSettings(mode: 'plain' | 'e2ee', raw: Record<string, unknown> = { analyticsOptOut: false }) {
    const credentials = { token: createAccountTokenForTests('owner', { currentAccount: true }),
        ...(mode === 'e2ee' ? { secret: Buffer.alloc(32, 7).toString('base64url') } : {}) };
    const encryption = mode === 'e2ee' ? await Encryption.create(new Uint8Array(32).fill(7)) : null;
    const material = encryption ? resolveAccountScopedCryptoMaterialFromCredentials(credentials) : null;
    const serverId = await harness.addHome({ name: 'Write cost', serverUrl: 'https://write-cost.example',
        accountId: 'owner', currentAccount: true, accountEncryptionMode: mode, credentials });
    const scope = { serverId, accountId: 'owner' };
    let version = 1;
    const envelope = (): AccountSettingsStoredContentEnvelope => material
        ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
            material, payload: raw,
            randomBytes: size => new Uint8Array(size).fill(3) }) }
        : { t: 'plain', v: raw };
    harness.answer(serverId, '/v1/account/encryption', { body: { mode, updatedAt: 1 } });
    harness.answer(serverId, '/v1/account/encryption/currentness', { body: mode === 'e2ee'
        ? createLegacyAccountEncryptionCurrentnessFixture({ secret: new Uint8Array(32).fill(7) })
        : createPlainAccountEncryptionCurrentnessFixture() });
    harness.answer(serverId, '/v2/account/settings', { select: () => ({ body: { content: envelope(), version } }) });
    storage.setState({ settingsScope: scope, settingsVersion: version, settings: settingsParse(raw) });
    const account = await captureLazyActionAccountContext(serverId);
    // Identity admission precedes the effect. It cannot replace its fresh mode witness.
    await account.resolveAccountEncryption();
    const reads: Array<{ path: string }> = [];
    // The harness's body records omit HTTP methods; count at its real fetch boundary.
    setRuntimeFetch(async (input, init) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
            const url = new URL(String(input));
            reads.push({ path: url.pathname + url.search });
        }
        return harness.request(input, init);
    });
    const posts: ReturnType<typeof AccountSettingsV2UpdateRequestSchema.parse>[] = [];
    const readRaw = (content: AccountSettingsStoredContentEnvelope | null): Record<string, unknown> => {
        if (content?.t === 'plain') return content.v;
        if (!material || content?.t !== 'encrypted') throw new Error('Wrong Account envelope');
        const opened = openAccountScopedBlobCiphertext({ kind: 'account_settings', ciphertext: content.c,
            material });
        if (!opened?.value || typeof opened.value !== 'object' || Array.isArray(opened.value)) throw new Error('Unreadable Settings');
        return opened.value as Record<string, unknown>;
    };
    return { account, serverId, posts, scope, envelope, readRaw, credentials, encryption,
        reads: () => reads,
        get raw() { return raw; }, get version() { return version; },
        advance: (next: Record<string, unknown>) => { raw = next; version++; },
        commit: (input: unknown) => {
            const write = AccountSettingsV2UpdateRequestSchema.parse(input);
            posts.push(write);
            if (write.expectedVersion !== version) return { status: 409, body: {
                success: false, error: 'version-mismatch', currentVersion: version, currentContent: envelope() } };
            raw = readRaw(write.content); version++;
            return { body: { success: true, version } };
        },
    };
}

describe('Account settings write acquisition cost', () => {
    it('refuses legacy organization import when Account mode changes during admitted intent preparation', async () => {
        const home = await serveSettings('plain', { analyticsOptOut: false, pinnedSessionKeysV1: ['legacy-session'] });
        harness.answer(home.serverId, '/v2/session-organization', { body: SessionOrganizationSnapshotResponseSchema.parse({ snapshot: {
            schemaVersion: 1, version: 0, pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
        } }) });
        const imports: string[] = [];
        setRuntimeFetch(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path.includes('session-organization') && init?.method === 'POST') imports.push(path);
            return harness.request(input, init);
        });
        const entered = createDeferred<void>();
        const resume = createDeferred<void>();
        const write = home.account.mutateRawSettings(async raw => {
            entered.resolve(); await resume.promise;
            return { ...raw, analyticsOptOut: true };
        });
        const refusal = expect(write).rejects.toMatchObject({ code: 'account_settings_encryption_material_unavailable' });
        try {
            await entered.promise;
            harness.answer(home.serverId, '/v1/account/encryption/currentness', {
                body: createLegacyAccountEncryptionCurrentnessFixture({ secret: new Uint8Array(32).fill(7) }),
            });
            resume.resolve();
            await refusal;
            expect(imports).toEqual([]);
            expect(home.posts).toHaveLength(0);
        } finally { resume.resolve(); await refusal; home.account.dispose(); }
    });

    it('refuses an admitted empty E2EE document with a changed key before sealing or posting', async () => {
        const home = await serveSettings('e2ee');
        harness.answer(home.serverId, '/v2/account/settings', { body: { content: null, version: 1 } });
        const randomBytes = vi.spyOn(await import('@/platform/cryptoRandom'), 'getRandomBytes');
        try {
            await expect(home.account.mutateRawSettings(async raw => {
                harness.answer(home.serverId, '/v1/account/encryption/currentness', {
                    body: createLegacyAccountEncryptionCurrentnessFixture({ secret: new Uint8Array(32).fill(8) }),
                });
                return { ...raw, analyticsOptOut: true };
            })).rejects.toMatchObject({ code: 'account_settings_encryption_material_unavailable' });
            expect(home.posts).toHaveLength(0);
            expect(randomBytes).not.toHaveBeenCalled();
            expect(storage.getState().settingsVersion).toBe(1);
        } finally { randomBytes.mockRestore(); home.account.dispose(); }
    });
    it.each(['plain', 'e2ee'] as const)('does not turn idle refreshes or another client revision into a %s Settings intent', async mode => {
        const home = await serveSettings(mode, { sessionRemoteAlertsEnabled: true, analyticsOptOut: false,
            vendorOpaquePreference: { selected: 'kept' } });
        harness.answer(home.serverId, '/v1/push-tokens?projectionVersion=2', {
            select: () => ({ body: { v: 2, accountRemoteAlerts: { settingsVersion: home.version, status: 'stale' }, tokens: [] } }),
        });
        harness.answer(home.serverId, 'POST /v2/account/settings', { select: home.commit });
        const { syncSettings } = await import('./syncSettings');
        // Capture the incumbent bootstrap input. Its derived-policy request is
        // not a person's preference intent, even when the stored policy is stale.
        const bootstrap = { credentials: home.credentials, encryption: home.encryption, settingsScope: home.scope,
            pendingSettings: {}, getPendingSettings: () => ({}), clearPendingSettings: () => {},
            republishRemoteAlertPolicy: true,
            requestContext: { scope: home.scope, endpointUrl: 'https://write-cost.example', request: home.account.request },
        };
        try {
            for (let refresh = 0; refresh < 3; refresh++) await syncSettings(bootstrap);
            expect(home.posts).toHaveLength(0);
            home.advance({ ...home.raw, crashReportsOptOut: true });
            await syncSettings(bootstrap);
            expect(home.posts).toHaveLength(0);
            expect(storage.getState().settings.crashReportsOptOut).toBe(true);
            expect(storage.getState().settingsVersion).toBe(home.version);
            expect(home.reads().filter(read => read.path.startsWith('/v1/push-tokens'))).toHaveLength(0);

            await home.account.mutateRawSettings(raw => ({ ...raw, analyticsOptOut: true }));
            expect(home.posts).toHaveLength(1);
            expect(home.posts[0]?.remoteAlertPolicy).toMatchObject({ channels: { expo_push: { enabled: true } } });
            expect(storage.getState().settings.analyticsOptOut).toBe(true);
            expect(home.raw.vendorOpaquePreference).toEqual({ selected: 'kept' });
            await syncSettings(bootstrap);
            expect(home.posts).toHaveLength(1);
        } finally { home.account.dispose(); }
    });

    it.each(['plain', 'e2ee'] as const)('takes one fresh identity witness per %s commit attempt; publishes only its acknowledgement', async mode => {
        const home = await serveSettings(mode);
        const issued = createDeferred<void>();
        const acknowledgement = createDeferred<void>();
        harness.answer(home.serverId, 'POST /v2/account/settings', { select: input => {
            const response = home.commit(input); issued.resolve();
            return { ...response, respondAfter: acknowledgement.promise };
        } });
        const write = home.account.mutateRawSettings(raw => ({ ...raw, analyticsOptOut: true }));
        try {
            await issued.promise;
            expect(storage.getState().settings.analyticsOptOut).toBe(false);
            // The opened baseline is admitted already. Final material admission
            // takes one fresh identity witness after asynchronous preparation.
            expect(home.reads().map(read => read.path).sort()).toEqual([
                '/v1/account/encryption/currentness', '/v2/account/settings',
            ]);
        } finally {
            acknowledgement.resolve();
            await write;
            home.account.dispose();
        }
        expect(home.posts).toHaveLength(1);
        expect(home.raw.analyticsOptOut).toBe(true);
        expect(storage.getState().settings.analyticsOptOut).toBe(true);
        expect(storage.getState().settingsVersion).toBe(2);
        console.info('LIVING_BOTS_SETTINGS_HTTP', JSON.stringify({ mode, conflicts: 0,
            gets: home.reads().map(read => read.path), posts: home.posts.length }));
    });

    it('normalizes only the acknowledged document for the local consumer', async () => {
        const home = await serveSettings('plain');
        const issued = createDeferred<void>();
        const acknowledgement = createDeferred<void>();
        harness.answer(home.serverId, 'POST /v2/account/settings', { select: input => {
            const response = home.commit(input); issued.resolve();
            return { ...response, respondAfter: acknowledgement.promise };
        } });
        // Observe the real parser; internal normalization is never substituted.
        const normalize = vi.spyOn(normalization, 'normalizeAccountSettingsForLocalStorage');
        const write = home.account.mutateRawSettings(raw => ({ ...raw, analyticsOptOut: true }));
        try {
            await issued.promise;
            expect(normalize).toHaveBeenCalledTimes(0);
            expect(storage.getState().settings.analyticsOptOut).toBe(false);
        } finally {
            acknowledgement.resolve();
            try { await write; } finally { home.account.dispose(); }
        }
        try {
            expect(normalize).toHaveBeenCalledTimes(1);
            expect(storage.getState().settings.analyticsOptOut).toBe(true);
        } finally { normalize.mockRestore(); }
    });

    it('rebases on the returned CAS winner without another baseline and rechecks material for each commit attempt', async () => {
        const home = await serveSettings('plain');
        harness.answer(home.serverId, 'POST /v2/account/settings', { select: input => {
            if (home.posts.length === 0) home.advance({ ...home.raw, crashReportsOptOut: true });
            return home.commit(input);
        } });
        try {
            await home.account.mutateRawSettings(raw => ({ ...raw, analyticsOptOut: true }));
            expect(home.posts.map(post => post.expectedVersion)).toEqual([1, 2]);
            expect(home.raw).toMatchObject({ analyticsOptOut: true, crashReportsOptOut: true });
            expect(storage.getState().settings).toMatchObject({ analyticsOptOut: true, crashReportsOptOut: true });
            expect(home.reads().map(read => read.path).sort()).toEqual([
                '/v1/account/encryption/currentness', '/v1/account/encryption/currentness',
                '/v2/account/settings',
            ]);
            console.info('LIVING_BOTS_SETTINGS_HTTP', JSON.stringify({ mode: 'plain', conflicts: 1,
                gets: home.reads().map(read => read.path), posts: home.posts.length }));
        } finally { home.account.dispose(); }
    });

    it.each([true, false])('rebinds a previously enabled remote policy when the next consent is %s', async enabled => {
        const home = await serveSettings('plain', { sessionRemoteAlertsEnabled: true, analyticsOptOut: false });
        harness.answer(home.serverId, '/v1/push-tokens?projectionVersion=2', {
            body: { v: 2, accountRemoteAlerts: { settingsVersion: 1, status: 'current' }, tokens: [] },
        });
        harness.answer(home.serverId, 'POST /v2/account/settings', { select: home.commit });
        try {
            await home.account.mutateRawSettings(raw => ({ ...raw, sessionRemoteAlertsEnabled: enabled, analyticsOptOut: true }));
            expect(home.posts).toHaveLength(1);
            expect(home.posts[0]?.remoteAlertPolicy?.channels.expo_push.enabled ?? false).toBe(enabled);
            expect(Object.hasOwn(home.posts[0]!, 'remoteAlertPolicy')).toBe(true);
            expect(home.reads().filter(read => read.path.startsWith('/v1/push-tokens'))).toHaveLength(1);
            expect(storage.getState().settings.sessionRemoteAlertsEnabled).toBe(enabled);
        } finally { home.account.dispose(); }
    });

    it('withdraws a disclosed policy when a CAS winner revoked consent', async () => {
        const home = await serveSettings('plain', { sessionRemoteAlertsEnabled: true, analyticsOptOut: false });
        harness.answer(home.serverId, '/v1/push-tokens?projectionVersion=2', {
            body: { v: 2, accountRemoteAlerts: { settingsVersion: 1, status: 'current' }, tokens: [] },
        });
        harness.answer(home.serverId, 'POST /v2/account/settings', { select: input => {
            if (home.posts.length === 0) home.advance({ ...home.raw, sessionRemoteAlertsEnabled: false });
            return home.commit(input);
        } });
        try {
            await home.account.mutateRawSettings(raw => ({ ...raw, analyticsOptOut: true }));
            expect(home.posts.map(post => post.expectedVersion)).toEqual([1, 2]);
            expect(home.posts[0]?.remoteAlertPolicy?.channels.expo_push.enabled).toBe(true);
            expect(home.posts[1]?.remoteAlertPolicy).toBeNull();
            expect(storage.getState().settings.sessionRemoteAlertsEnabled).toBe(false);
        } finally { home.account.dispose(); }
    });

    it('returns conflict for an explicit stale version without invoking the mutation or writing', async () => {
        const home = await serveSettings('plain');
        home.advance({ ...home.raw, crashReportsOptOut: true });
        let mutations = 0;
        try {
            const result = await home.account.mutateRawSettings(raw => { mutations++; return { ...raw, analyticsOptOut: true }; },
                { expectedSettingsVersion: 1, rebaseOnConflict: false, observeOutcome: true });
            expect(result).toMatchObject({ status: 'conflict', currentSettingsVersion: 2 });
            expect(mutations).toBe(0);
            expect(home.posts).toHaveLength(0);
        } finally { home.account.dispose(); }
    });

    it('refuses a mode change after identity admission before issuing a Settings POST', async () => {
        const home = await serveSettings('plain');
        harness.answer(home.serverId, '/v1/account/encryption/currentness', {
            body: createLegacyAccountEncryptionCurrentnessFixture({ secret: new Uint8Array(32).fill(7) }),
        });
        try {
            await expect(home.account.mutateRawSettings(raw => ({ ...raw, analyticsOptOut: true })))
                .rejects.toMatchObject({ code: 'account_settings_encryption_material_unavailable' });
            expect(home.posts).toHaveLength(0);
            expect(storage.getState().settingsVersion).toBe(1);
        } finally { home.account.dispose(); }
    });

    it('refuses a mode change while intent preparation awaits, before sealing or posting the candidate', async () => {
        const home = await serveSettings('plain');
        const entered = createDeferred<void>();
        const resume = createDeferred<void>();
        const write = home.account.mutateRawSettings(async raw => {
            entered.resolve();
            await resume.promise;
            return { ...raw, analyticsOptOut: true };
        });
        const refusal = expect(write).rejects.toMatchObject({ code: 'account_settings_encryption_material_unavailable' });
        try {
            await entered.promise;
            harness.answer(home.serverId, '/v1/account/encryption/currentness', {
                body: createLegacyAccountEncryptionCurrentnessFixture({ secret: new Uint8Array(32).fill(7) }),
            });
            resume.resolve();
            await refusal;
            expect(home.posts).toHaveLength(0);
            expect(storage.getState().settingsVersion).toBe(1);
        } finally {
            resume.resolve();
            try { await refusal; } finally { home.account.dispose(); }
        }
    });
});
