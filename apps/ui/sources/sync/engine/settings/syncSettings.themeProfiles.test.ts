import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { artifactIdScopeMatchesAccountV1 } from '@happier-dev/protocol/artifacts/idScope';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { createThemeProfileLibrary, type ThemeProfileArtifactRecord } from '@/theme/profiles/themeProfileLibrary';
import { createThemeProfileArtifactAdapter } from '@/theme/profiles/themeProfileArtifactAdapter';
import { parseThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import { THEME_ARTIFACT_KIND } from '@happier-dev/protocol/account/settings/themeProfileArtifact';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createArtifactsDomain, type ArtifactsDomain } from '@/sync/store/domains/artifacts';
import type { ArtifactDataKeyCacheEntry } from '@/sync/engine/artifacts/syncArtifacts';
import { isArtifactInventoryLoaded } from '@/sync/domains/artifacts/artifactInventory';
import { readThemeProfileReferenceSelection } from '@/theme/profiles/themeProfilePersistence';
import type { WithThemeProfileLibrary } from './themeProfileMigration';
import { writeThemeProfileLegacyAccountScope } from '@/sync/domains/state/themeProfileMigrationUiState';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Prove the migration producer loads before collecting its existing Sync consumer.
await import('./themeProfileMigration');
const { syncSettings } = await import('./syncSettings');
const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { storage } = await import('@/sync/domains/state/storageStore');
const { loadLocalSettings } = await import('@/sync/domains/state/settingsPersistence');
const { pendingAccountSettingsKey } = await import('@/sync/domains/state/pendingAccountSettingsPersistence');
const { saveActiveAccountSettingsScope, savePendingAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');

// Golden producer vector: ui-web-v0.2.20 cc98c23cea1d,
// themeProfilePersistence.test.ts profile('ocean'); assetAppearance was optional.
const profile = (id = 'ocean', name = `Profile ${id}`) => ({ schemaVersion: 1 as const, id, name,
    createdAt: '2026-05-12T00:00:00.000Z', updatedAt: '2026-05-12T00:00:00.000Z',
    base: { light: 'light' as const, dark: 'dark' as const }, overrides: { light: {}, dark: {} } });

async function artifactBoundary(serverId: string) {
    const boundary = harness.artifacts(serverId);
    const account = await captureLazyActionAccountContext(serverId);
    onTestFinished(() => account.dispose());
    const { encryption } = await account.resolveAccountEncryption();
    const store = createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
    const captured = { credentials: account.credentials, request: account.request, readTransport: account.readTransport,
        serverId: account.serverId, ownerAccountId: account.accountId, encryption,
        artifactDataKeys: new Map<string, ArtifactDataKeyCacheEntry>() };
    const withLibrary: WithThemeProfileLibrary = async (operation, options) => {
        const before = store.getState().artifacts;
        const artifacts = createThemeProfileArtifactAdapter({ ...captured, signal: options?.signal,
            artifactIdScopes: options?.artifactIdScopes, readArtifacts: () => store.getState().artifacts,
            applyArtifacts: rows => store.getState().applyArtifacts(rows),
            applyInventory: (rows, source) => store.getState().applyArtifacts(rows, source ? before : undefined, [THEME_ARTIFACT_KIND], source),
            deleteArtifact: id => store.getState().deleteArtifact(id),
            isLoaded: () => isArtifactInventoryLoaded(store.getState(), [THEME_ARTIFACT_KIND]) });
        return operation(createThemeProfileLibrary({ artifacts,
            readSelection: () => readThemeProfileReferenceSelection(loadLocalSettings().themeProfileSelection),
            writeSelection: (mode, reference) => storage.getState().applyLocalSettings({ themeProfileSelection:
                { ...readThemeProfileReferenceSelection(loadLocalSettings().themeProfileSelection), [mode]: reference } }),
            createId: () => '123e4567-e89b-42d3-a456-426614174000', now: () => 0,
        }));
    };
    return { get records() {
        return new Map(boundary.list().map(row => {
            const parsed = parseThemeProfileDocument(JSON.parse(boundary.readPlainBody(row.id)!));
            if (!parsed.ok) throw new Error('Stored theme document is invalid');
            if (row.bodyVersion === undefined) throw new Error('Stored theme fixture has no body revision');
            return [row.id, { document: parsed.document, revision: row.bodyVersion, headerVersion: row.headerVersion } satisfies ThemeProfileArtifactRecord] as const;
        }));
    }, withLibrary, writes: () => boundary.list().reduce((total, row) => {
        if (row.bodyVersion === undefined) throw new Error('Stored theme fixture has no body revision');
        return total + row.bodyVersion;
    }, 0),
    loseReply: (beforeLoss: () => void) => boundary.afterNextCreate(async () => { beforeLoss(); throw new Error('Artifact reply lost'); }),
    assertScopedIds: () => {
        for (const request of harness.requests.filter(request => request.serverId === serverId && request.path === '/v1/artifacts' && request.method === 'POST')) {
            const input = request.input;
            if (!input || typeof input !== 'object' || !('id' in input) || typeof input.id !== 'string') throw new Error('Missing Artifact create identity');
            expect(artifactIdScopeMatchesAccountV1({ accountId: account.accountId, artifactId: input.id,
                idScope: 'idScope' in input ? input.idScope : undefined })).toBe(true);
        }
    } };
}

beforeEach(() => installHomeGovernanceBoundaries(harness));
afterEach(async () => { await harness.reset(); });

describe('released theme input transfer', () => {
    async function setup(accountProfiles: readonly unknown[] = [profile('cloud')], localProfiles: readonly unknown[] = [profile('local')]) {
        const serverId = await harness.addHome({ name: 'Themes', serverUrl: 'https://themes.example', accountId: 'owner', currentAccount: true });
        const artifacts = await artifactBoundary(serverId);
        const scope = { serverId, accountId: 'owner' };
        writeThemeProfileLegacyAccountScope(null);
        const setDevice = (profiles: readonly unknown[]) => {
            getPersistenceStorage().set('local-settings', JSON.stringify({ themeProfiles: { profiles, activeProfileIds: { light: null, dark: profiles.length ? 'local' : null } } }));
            storage.setState({ localSettings: loadLocalSettings() });
        };
        setDevice(localProfiles);
        storage.setState({ settingsScope: scope, settingsVersion: 1, settings: settingsParse({}) });
        expect(loadLocalSettings().themeProfiles.profiles).toHaveLength(localProfiles.length);
        expect(storage.getState().settingsScope).toEqual(scope);
        savePendingAccountSettings(scope, {});
        saveActiveAccountSettingsScope(scope);
        let raw: Record<string, unknown> = accountProfiles.length ? { themeProfiles: accountProfiles } : {};
        let version = 4;
        const posts: Record<string, unknown>[] = [];
        let conflict = false;
        let refuse = false;
        harness.answer(serverId, '/v2/account/settings', { select: () => ({ body: { content: { t: 'plain', v: raw }, version } }) });
        harness.answer(serverId, 'POST /v2/account/settings', { select: input => {
            if (refuse) return { status: 503, body: { error: 'offline' } };
            if (conflict) { conflict = false; raw = { themeProfiles: [...(Array.isArray(raw.themeProfiles) ? raw.themeProfiles : []), profile('winner')] }; version++; }
            const request = AccountSettingsV2UpdateRequestSchema.parse(input);
            if (request.expectedVersion !== version) return { body: { success: false, error: 'version-mismatch', currentVersion: version, currentContent: { t: 'plain', v: raw } } };
            if (request.content?.t !== 'plain') throw new Error('Expected plain fixture');
            raw = request.content.v; posts.push(raw); version++;
            return { body: { success: true, version } };
        } });
        const sync = () => syncSettings({ credentials: { token: createAccountTokenForTests(scope.accountId, { currentAccount: true }) },
            encryption: null, settingsScope: scope, pendingSettings: {}, clearPendingSettings: next => savePendingAccountSettings(scope, next),
            withThemeProfileLibrary: artifacts.withLibrary });
        return { scope, sync, raw: () => raw, posts, artifacts, setDevice, conflict: () => { conflict = true; }, refuse: (value: boolean) => { refuse = value; } };
    }
    it('transfers released definitions with stable scoped ids and preserves colliding device selection', async () => {
        const state = await setup([profile('local', 'Account local')]);
        await state.sync();
        expect(state.raw()).not.toHaveProperty('themeProfiles');
        expect([...state.artifacts.records.values()].map(row => row.document.profile.name).sort()).toEqual(['Account local', 'Profile local']);
        const selected = readThemeProfileReferenceSelection(loadLocalSettings().themeProfileSelection).dark;
        expect(selected?.kind).toBe('artifact');
        if (selected?.kind !== 'artifact') throw new Error('Expected migrated Artifact selection');
        expect(state.artifacts.records.get(selected.id)?.document.profile.name).toBe('Profile local');
        const writes = state.artifacts.writes();
        await state.sync();
        expect(state.artifacts.writes()).toBe(writes);
        expect(state.posts).toHaveLength(1);
        state.artifacts.assertScopedIds();
    });
    it('recovers a lost Artifact acknowledgement without duplicating a released definition', async () => {
        const state = await setup([profile('cloud')], []);
        let sawLostAcknowledgement = false;
        state.artifacts.loseReply(() => {
            sawLostAcknowledgement = true;
            expect(state.raw()).toHaveProperty('themeProfiles');
            expect(state.artifacts.records.size).toBe(1);
        });
        await state.sync();
        expect(sawLostAcknowledgement).toBe(true);
        await state.sync();
        expect(state.artifacts.records.size).toBe(1);
        expect(state.artifacts.writes()).toBe(1);
        expect(state.raw()).not.toHaveProperty('themeProfiles');
        state.artifacts.assertScopedIds();
    });
    it('retries a released attempted-remap checkpoint after post-acknowledgement cleanup refusal', async () => {
        const state = await setup([profile('local', 'Account local')]);
        // ui-web-v0.2.20 syncSettings.ts 663-674 persisted the attempted library
        // and mapping before POST, retaining this envelope through acknowledgement.
        const pending = { themeProfiles: [profile('local', 'Account local'), profile('local_2', 'Edited local')],
            __themeProfileMigrationEditsV1: { edits: [{ target: { kind: 'legacy', id: 'local' }, profile: profile('local', 'Edited local') }],
                legacyProfileIds: { local: 'local_2' }, attemptedLegacyProfileIds: { local: 'local_2' } } };
        const key = pendingAccountSettingsKey(state.scope);
        getPersistenceStorage().set(key, JSON.stringify(pending));
        const device = getPersistenceStorage();
        const remove = device.delete.bind(device);
        const refusal = vi.spyOn(device, 'delete').mockImplementation(candidate => {
            if (candidate === key) throw new Error('Pending cleanup refused');
            remove(candidate);
        });
        try { await expect(state.sync()).rejects.toThrow('Pending cleanup refused'); }
        finally { refusal.mockRestore(); }
        expect(state.raw()).not.toHaveProperty('themeProfiles');
        expect(loadLocalSettings().themeProfiles.profiles).toEqual([]);
        expect([...state.artifacts.records.values()].map(row => row.document.profile.name).sort()).toEqual(['Account local', 'Edited local']);
        await state.sync();
        expect(state.artifacts.writes()).toBe(2);
        expect(getPersistenceStorage().getString(key)).toBeUndefined();
        state.artifacts.assertScopedIds();
    });
});
