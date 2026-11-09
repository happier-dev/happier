import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption as AccountEncryption } from '@/sync/encryption/encryption';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDataKeyAccountEncryptionCurrentnessFixture, createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createDeferred } from '@/dev/testkit';
import { AccountSettingsV2UpdateRequestSchema, type AccountSettingsV2UpdateRequest } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import type { AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { Settings } from '@/sync/domains/settings/settings';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

// Analytics is an external delivery boundary; parsing, persistence and the Settings store stay real.
const analytics = vi.hoisted(() => {
    const sequence: string[] = [];
    return { sequence, tracking: {
        capture: vi.fn((..._args: unknown[]) => { sequence.push('capture'); }),
        identify: vi.fn((..._args: unknown[]) => { sequence.push('identify'); }),
        flush: vi.fn(async () => { sequence.push('flush'); }),
        optOut: vi.fn(() => { sequence.push('optOut'); }), optIn: vi.fn(),
    } };
});
vi.mock('@/track', () => ({ tracking: analytics.tracking, getTrackingAnonymousUserId: () => 'anon-user' }));
vi.mock('@/platform/cryptoRandom', () => ({ getRandomBytes: (length: number) => new Uint8Array(length).fill(4) }));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { saveAccountSettings, loadAccountSettings, savePendingAccountSettings, loadPendingAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
const { saveHomeViewState, loadHomeViewState, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { Encryption } = await import('@/sync/encryption/encryption');
const { syncSettings, applySettingsLocalDelta } = await import('./syncSettings');

const endpointUrl = 'https://settings-local-a.example.test';
const machineKey = new Uint8Array(32).fill(11);
const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
let credentials: AuthCredentials;
let encryption: AccountEncryption | null;
let scope: { serverId: string; accountId: string };
let siblingScope: typeof scope;
let content: AccountSettingsStoredContentEnvelope | null;
let version: number;
let pending: Partial<Settings>;
let posts: AccountSettingsV2UpdateRequest[];
let cleared: Partial<Settings>[];
let beforeRead: (() => Promise<void>) | undefined;
let afterPost: ((input: AccountSettingsV2UpdateRequest) => unknown) | undefined;

beforeEach(async () => {
    await homes.reset(); installHomeGovernanceBoundaries(homes);
    credentials = { token: createAccountTokenForTests('account-local-a') };
    encryption = null;
    const serverId = await homes.addHome({ name: 'Settings A', serverUrl: endpointUrl, accountId: 'account-local-a', credentials });
    const siblingId = await homes.addHome({ name: 'Settings B', serverUrl: 'https://settings-local-b.example.test', accountId: 'account-local-b', active: false });
    scope = { serverId, accountId: 'account-local-a' };
    siblingScope = { serverId: siblingId, accountId: 'account-local-b' };
    content = null; version = 4; pending = {}; posts = []; cleared = []; beforeRead = undefined; afterPost = undefined;
    await saveHomeViewState({ version: 1, groups: [], activeTargetKind: null, activeTargetId: null });
    const settings = settingsParse({ analyticsOptOut: false });
    saveAccountSettings(scope, settings, 1);
    storage.setState({ settings, settingsScope: scope, settingsVersion: 1 });
    homes.answer(serverId, '/v1/account/encryption/currentness', { select: () => ({ body: encryption
        ? createDataKeyAccountEncryptionCurrentnessFixture({ machineKey, publicKey }) : createPlainAccountEncryptionCurrentnessFixture() }) });
    homes.answer(serverId, '/v2/account/settings', { select: async () => {
        await beforeRead?.();
        return { body: { content, version } };
    } });
    homes.answer(serverId, 'POST /v2/account/settings', { select: input => {
        const mutation = AccountSettingsV2UpdateRequestSchema.parse(input);
        posts.push(mutation);
        return { body: afterPost ? afterPost(mutation) : { success: true, version: version + 1 } };
    } });
    vi.clearAllMocks(); analytics.sequence.length = 0;
});
afterEach(async () => { vi.restoreAllMocks(); await homes.reset(); });

async function useE2ee() {
    credentials = { token: credentials.token, encryption: {
        publicKey: Buffer.from(publicKey).toString('base64'), machineKey: Buffer.from(machineKey).toString('base64'),
    } };
    await TokenStorage.setCredentialsForServerUrl(endpointUrl, { serverId: scope.serverId }, credentials);
    encryption = await Encryption.createFromContentKeyPair({ publicKey, machineKey });
    homes.answer(scope.serverId, '/v1/account/encryption', { body: { mode: 'e2ee', updatedAt: 1 } });
}
function envelope(raw: Record<string, unknown>): AccountSettingsStoredContentEnvelope {
    return encryption ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
        material: { type: 'dataKey', machineKey }, payload: raw, randomBytes: length => new Uint8Array(length).fill(3) }) }
        : { t: 'plain', v: raw };
}
function opened(input: AccountSettingsV2UpdateRequest): unknown {
    return input.content?.t === 'encrypted' ? openAccountScopedBlobCiphertext({ kind: 'account_settings',
        material: { type: 'dataKey', machineKey }, ciphertext: input.content.c })?.value : input.content?.v;
}
function run(requested: Partial<Settings> = {}, latest = true) {
    return syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: requested,
        ...(latest ? { getPendingSettings: () => pending } : {}),
        clearPendingSettings: next => { pending = next; cleared.push(next); },
        requestContext: { scope, endpointUrl, request: createServerFetchAtEndpoint({ endpointUrl, serverId: scope.serverId, credentials }) },
    });
}
function local(delta: Partial<Settings>, expectedSettingsScope: typeof scope | null = scope) {
    let scheduled = 0;
    applySettingsLocalDelta({ expectedSettingsScope, delta, settingsSecretsKey: null,
        getPendingSettings: () => pending, setPendingSettings: next => { pending = next; },
        schedulePendingSettingsFlush: () => { scheduled++; }, source: 'ui' });
    return scheduled;
}
function settingsRequests() { return homes.requests.filter(request => request.path.startsWith('/v2/account/settings')); }

describe('syncSettings local-only settings through the real captured Home and store', () => {
    it('keeps local state unchanged and reports typed unavailability when GET ciphertext cannot be decrypted', async () => {
        await useE2ee(); content = { t: 'encrypted', c: 'ciphertext' };
        const before = storage.getState().settings;
        await expect(run()).rejects.toMatchObject({ code: 'account_settings_content_unreadable' });
        expect(storage.getState().settings).toBe(before);
        expect(posts).toHaveLength(0);
    });
    it('keeps every request and its scoped persistence on the original Home across focus change and CAS retry', async () => {
        beforeRead = async () => {
            await setActiveServerId(siblingScope.serverId, { scope: 'device' });
            storage.setState({ settingsScope: siblingScope, settings: settingsParse({ analyticsOptOut: false }), settingsVersion: 9 });
        };
        afterPost = () => posts.length === 1 ? { success: false, error: 'version-mismatch', currentVersion: 5,
            currentContent: { t: 'plain', v: {} } } : { success: true, version: 6 };
        await run({ analyticsOptOut: true });
        expect(posts).toHaveLength(2);
        expect(homes.requests.filter(request => request.path.includes('/account/')).every(request => request.serverId === scope.serverId)).toBe(true);
        expect(loadAccountSettings(scope)).toMatchObject({ version: 6, settings: { analyticsOptOut: true } });
        expect(storage.getState()).toMatchObject({ settingsScope: siblingScope, settingsVersion: 9, settings: { analyticsOptOut: false } });
    });
    it('opens genuine matching E2EE Settings without rewriting them', async () => {
        await useE2ee(); content = envelope({ analyticsOptOut: true });
        await run();
        expect(storage.getState()).toMatchObject({ settingsVersion: 4, settings: { analyticsOptOut: true } });
        expect(posts).toHaveLength(0);
    });
    it('preserves device Home selection and local compatibility settings while applying fetched Settings', async () => {
        const view = { version: 1 as const, groups: [{ id: 'grp-dev', name: 'Dev', serverIds: [scope.serverId, siblingScope.serverId], presentation: 'grouped' as const }],
            activeTargetKind: 'group' as const, activeTargetId: 'grp-dev' };
        await saveHomeViewState(view);
        storage.getState().applySettingsLocal({ terminalConnectLegacySecretExportEnabled: true });
        content = envelope({ analyticsOptOut: true });
        await run();
        expect(loadHomeViewState()).toEqual(view);
        expect(storage.getState().settings).toMatchObject({ analyticsOptOut: true, terminalConnectLegacySecretExportEnabled: true });
    });
    it('preserves a newer in-memory pending delta while applying an earlier fetched baseline', async () => {
        pending = { sessionReplayEnabled: true };
        await run();
        expect(storage.getState().settings.sessionReplayEnabled).toBe(true);
        expect(pending).toEqual({ sessionReplayEnabled: true });
    });
    it('reloads pending settings from the captured scope rather than another Home', async () => {
        savePendingAccountSettings(scope, { sessionReplayEnabled: true });
        savePendingAccountSettings(siblingScope, { sessionReplayEnabled: false });
        await run({}, false);
        expect(storage.getState().settings.sessionReplayEnabled).toBe(true);
        expect(loadPendingAccountSettings(scope)).toEqual({ sessionReplayEnabled: true });
        expect(loadPendingAccountSettings(siblingScope)).toEqual({ sessionReplayEnabled: false });
    });
    it('applies an in-flight read to scoped persistence without replacing the newly active Account', async () => {
        const gate = createDeferred<void>(); const entered = createDeferred<void>();
        beforeRead = async () => { entered.resolve(); await gate.promise; };
        content = envelope({ analyticsOptOut: true });
        const operation = run(); await entered.promise;
        storage.setState({ settingsScope: siblingScope, settings: settingsParse({ analyticsOptOut: false }), settingsVersion: 9 });
        gate.resolve(); await operation;
        expect(loadAccountSettings(scope)).toMatchObject({ version: 4, settings: { analyticsOptOut: true } });
        expect(storage.getState()).toMatchObject({ settingsScope: siblingScope, settingsVersion: 9, settings: { analyticsOptOut: false } });
    });
    it.each(['plain', 'e2ee'] as const)('keeps local-only keys out of the actual %s Settings write while retaining valid content', async mode => {
        if (mode === 'e2ee') await useE2ee();
        content = envelope({ unrelated: { retained: true } });
        pending = { analyticsOptOut: true, terminalConnectLegacySecretExportEnabled: true, serverSelectionGroups: [],
            serverSelectionActiveTargetKind: null, serverSelectionActiveTargetId: null };
        await run(pending);
        expect(posts).toHaveLength(1);
        const raw = opened(posts[0]!);
        expect(raw).toMatchObject({ analyticsOptOut: true, unrelated: { retained: true } });
        for (const key of ['serverSelectionGroups', 'serverSelectionActiveTargetKind', 'serverSelectionActiveTargetId', 'terminalConnectLegacySecretExportEnabled'])
            expect(raw).not.toHaveProperty(key);
    });
    it('does not import a server-provided legacy Home selection over an initialized empty device selection', async () => {
        await useE2ee(); content = envelope({ analyticsOptOut: true, serverSelectionGroups: [{ id: 'legacy', name: 'Legacy', serverIds: [scope.serverId] }],
            serverSelectionActiveTargetKind: 'group', serverSelectionActiveTargetId: 'legacy' });
        await run();
        expect(loadHomeViewState()).toMatchObject({ groups: [], activeTargetKind: null, activeTargetId: null });
        expect(storage.getState().settings.analyticsOptOut).toBe(true);
    });
    it('clears matching local-only pending keys without issuing a Settings write', async () => {
        pending = { serverSelectionGroups: [], serverSelectionActiveTargetKind: null, serverSelectionActiveTargetId: null };
        await run(pending);
        expect(pending).toEqual({}); expect(cleared).toHaveLength(1);
        expect(settingsRequests().map(request => request.method)).toEqual(['GET']);
    });
    it('clears only committed pending keys after the actual Settings acknowledgement', async () => {
        pending = { analyticsOptOut: true, sessionListDensity: 'detailed' };
        await run({ analyticsOptOut: true });
        expect(pending).toEqual({ sessionListDensity: 'detailed' });
        expect(opened(posts[0]!)).toMatchObject({ analyticsOptOut: true });
    });
    it('keeps a same-key concurrent pending edit after acknowledging the captured value', async () => {
        pending = { analyticsOptOut: true };
        afterPost = () => { pending = { analyticsOptOut: false }; return { success: true, version: 5 }; };
        await run({ analyticsOptOut: true });
        expect(pending).toEqual({ analyticsOptOut: false });
        expect(opened(posts[0]!)).toMatchObject({ analyticsOptOut: true });
    });
    it('clears only matching local-only pending keys and retains a later selection', async () => {
        pending = { lastUsedAgent: 'codex', serverSelectionActiveTargetKind: 'server' };
        await run({ lastUsedAgent: 'codex' });
        expect(pending).toEqual({ serverSelectionActiveTargetKind: 'server' });
        expect(posts).toHaveLength(0);
    });
});

describe('applySettingsLocalDelta against the real Settings store', () => {
    it('keeps the device Home view authoritative over legacy Settings deltas without adding pending sync keys', async () => {
        const before = loadHomeViewState();
        expect(local({ serverSelectionGroups: [{ id: 'local', name: 'Local', serverIds: [scope.serverId], presentation: 'grouped' }],
            serverSelectionActiveTargetKind: 'group', serverSelectionActiveTargetId: 'local' })).toBe(0);
        expect(loadHomeViewState()).toEqual(before);
        expect(storage.getState().settings.serverSelectionGroups).toHaveLength(0);
        expect(pending).toEqual({});
        await saveHomeViewState({ version: 1, groups: [{ id: 'local', name: 'Local', serverIds: [scope.serverId], presentation: 'grouped' }],
            activeTargetKind: 'group', activeTargetId: 'local' });
        expect(loadHomeViewState()?.groups).toHaveLength(1);
    });
    it('rejects a retained writer after the active Account Settings scope changes', () => {
        storage.setState({ settingsScope: siblingScope });
        const before = storage.getState().settings;
        expect(local({ analyticsOptOut: true })).toBe(0);
        expect(storage.getState().settings).toBe(before); expect(pending).toEqual({});
        expect(analytics.tracking.capture).not.toHaveBeenCalled(); expect(analytics.tracking.optOut).not.toHaveBeenCalled();
    });
    it('applies local terminal-connect compatibility changes without adding pending sync keys', () => {
        expect(local({ terminalConnectLegacySecretExportEnabled: true })).toBe(0);
        expect(storage.getState().settings.terminalConnectLegacySecretExportEnabled).toBe(true); expect(pending).toEqual({});
    });
    it('drops a derived secret-binding projection before local persistence and pending writes', () => {
        const delta: Partial<Settings> & { currentSecretBindingsByProfileId: unknown } = {
            currentSecretBindingsByProfileId: { 'current-profile': { OPENAI_API_KEY: 'synthetic-value' } },
        };
        const before = storage.getState().settings;
        const persisted = getPersistenceStorage().getAllKeys().map(key => [key, getPersistenceStorage().getString(key)]);
        expect(local(delta)).toBe(0);
        expect(storage.getState().settings).toBe(before); expect(pending).toEqual({});
        expect(getPersistenceStorage().getAllKeys().map(key => [key, getPersistenceStorage().getString(key)])).toEqual(persisted);
    });
    it('does not admit a server-backed Voice write before scoped Account Settings hydrate', () => {
        storage.setState({ settingsVersion: null }); const before = storage.getState().settings;
        expect(local({ voice: voiceSettingsParse({ providerId: 'happier.voice.xai/realtime-grok' }) })).toBe(0);
        expect(storage.getState().settings).toBe(before); expect(pending).toEqual({});
    });
    it('still admits a local-only write before scoped Account Settings hydrate', () => {
        storage.setState({ settingsVersion: null });
        expect(local({ terminalConnectLegacySecretExportEnabled: true })).toBe(0);
        expect(storage.getState().settings.terminalConnectLegacySecretExportEnabled).toBe(true); expect(pending).toEqual({});
    });
    it('does not admit a server-backed write without an active Account Settings scope', () => {
        storage.setState({ settingsScope: null }); const before = storage.getState().settings;
        expect(local({ analyticsOptOut: true }, null)).toBe(0);
        expect(storage.getState().settings).toBe(before); expect(pending).toEqual({});
    });
    it('emits tracked Account and derived changes before applying analytics opt-out', () => {
        storage.setState({ settings: settingsParse({ sessionListDensity: 'detailed', analyticsOptOut: false }) });
        expect(local({ analyticsOptOut: true, sessionListDensity: 'narrow' })).toBe(1);
        expect(analytics.tracking.capture).toHaveBeenCalledWith('setting_changed', expect.objectContaining({ setting_key: 'analyticsOptOut', source: 'ui', prev_value: false, next_value: true }));
        expect(analytics.tracking.capture).toHaveBeenCalledWith('setting_changed', expect.objectContaining({ setting_key: 'compact_session_view_minimal', scope: 'derived', prev_value: false, next_value: true }));
        expect(analytics.tracking.identify).toHaveBeenCalledWith('anon-user', { acct_setting__analyticsOptOut: true });
        for (const fact of ['capture', 'identify', 'flush']) {
            expect(analytics.sequence.indexOf(fact)).toBeGreaterThanOrEqual(0);
            expect(analytics.sequence.indexOf(fact)).toBeLessThan(analytics.sequence.indexOf('optOut'));
        }
    });
    it('skips equal rebuilt object deltas without local persistence or pending sync', () => {
        const before = storage.getState().settings;
        const voice = structuredClone(before.voice);
        expect(local({ voice })).toBe(0);
        expect(storage.getState().settings).toBe(before); expect(pending).toEqual({});
        expect(analytics.tracking.capture).not.toHaveBeenCalled();
    });
});
