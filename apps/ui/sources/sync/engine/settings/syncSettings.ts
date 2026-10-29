import { DEFAULT_THEME_PROFILES_LOCAL_STATE, ThemeProfileLibrarySchema, mergeThemeProfileLibraries, resolveThemeProfileSelection } from '@/theme/profiles/themeProfilePersistence';
import { canUseLegacyThemeProfiles, rememberThemeProfileMigration } from '@/sync/domains/settings/themeProfiles';
import { tracking } from '@/track';
import { HappyError } from '@/utils/errors/errors';
import { applySettings, settingsDefaults, settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { summarizeSettings, summarizeSettingsDelta, dbgSettings, isSettingsSyncDebugEnabled } from '@/sync/domains/settings/debugSettings';
import {
    pickLocalOnlyAccountSettings,
    stripLocalOnlyAccountSettings,
} from '@/sync/domains/settings/localOnlyAccountSettings';
import { stripMigratedSessionOrganizationSettings } from '@/sync/domains/settings/parse/accountSettingsLegacyCleanup';
import {
    areAccountSettingsScopesEqual,
    type AccountSettingsScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getServerProfileLegacyServerIds } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { loadLocalSettings, loadPendingSettings, savePendingSettings } from '@/sync/domains/state/persistence';
import {
    loadAccountSettings,
    loadPendingAccountSettings,
    loadPendingAccountSettingsState,
    savePendingAccountSettings,
} from '@/sync/domains/state/accountSettingsPersistence';
import { applyThemeProfileMigrationEdits, mergeThemeProfileMigrationEdits, rebaseThemeProfileMigrationEdits, removeCommittedThemeProfileMigrationEdits } from '@/theme/profiles/themeProfileMigrationEdits';
import type { ThemeProfileMigrationIntent, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import {
    resealSecretsDeep,
    sealSecretsDeep,
    unsealSecretsDeepWithKeys,
} from '@/sync/encryption/secretSettings';
import { serverFetch } from '@/sync/http/client';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { getRandomBytes } from '@/platform/cryptoRandom';
import {
    AccountSettingsV2GetResponseSchema,
    AccountSettingsV2UpdateResponseSchema,
    openAccountScopedBlobCiphertext,
    sealAccountScopedBlobCiphertext,
    type AccountSettingsStoredContentEnvelope,
    type AccountSettingsV2UpdateResponse,
} from '@happier-dev/protocol';
import { applyCrashReportsOptOut } from '@/utils/system/sentry';
import { emitAccountSettingChangedEvents } from '@/track/settingsAnalytics/emitSettingChangedEvent';
import type { SettingsAnalyticsSource } from '@/track/settingsAnalytics/types';
import {
    isServerIssuedIdentityId,
    migrateAccountSettingsServerIdentityKeys,
} from '@/sync/domains/settings/serverIdentityKeyMigration';
import {
    mergePendingSettingsIntoRawBaseline,
    removeCommittedPendingSettings,
} from './writeback/accountSettingsRawDeltaMerge';
import { areAccountSettingsRawObjectsEqual } from './writeback/accountSettingsRawEquality';
import { fetchSessionOrganizationSnapshot } from '@/sync/api/session/sessionOrganizationApi';
import { importLegacySessionOrganization as importLegacySessionOrganizationOp } from '@/sync/ops/sessionOrganization/importLegacySessionOrganization';
import {
    buildLegacySessionOrganizationImportPlan,
    hasCompletedLegacySessionOrganizationImport,
    markLegacySessionOrganizationImportComplete,
} from './legacySessionOrganizationImport';
import { assertUiAccountEncryptionModeAllowed } from '@/sync/domains/settings/clientEncryptionRequirement';

export type SyncSettingsParams = {
    credentials: AuthCredentials;
    encryption: Encryption;
    settingsScope?: AccountSettingsScope | null;
    pendingSettings: Partial<Settings>;
    /** Current intents from the captured Sync scope, including its quiet disk flush window. */
    getLatestPendingSettings?: () => Partial<Settings> | null;
    clearPendingSettings: (nextPendingSettings: Partial<Settings>) => void;
    settingsSecretsKey?: Uint8Array | null;
    settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
    onLegacySessionOrganizationImported?: (result: Readonly<{
        pinnedSessionIds: readonly string[];
    }>) => void | Promise<void>;
};

export async function syncSettings(params: SyncSettingsParams): Promise<void> {
    const { credentials, encryption, pendingSettings, clearPendingSettings } = params;
    const settingsScope = params.settingsScope ?? null;
    const settingsSecretsKey = params.settingsSecretsKey ?? null;
    const settingsSecretsReadKeys = params.settingsSecretsReadKeys ?? (settingsSecretsKey ? [settingsSecretsKey] : []);
    const legacyServerIdsForSettingsKeys = settingsScope
        ? getServerProfileLegacyServerIds(settingsScope.serverId)
        : [];

    const activeServerUrl = getActiveServerSnapshot().serverUrl;
    const maxRetries = 3;
    let retryCount = 0;
    let lastVersionMismatch: { expectedVersion: number; currentVersion: number; pendingKeys: string[] } | null = null;
    const pendingServerSettings = stripMigratedSessionOrganizationSettings(
        stripLocalOnlyAccountSettings(pendingSettings) as Record<string, unknown>,
    ) as Partial<Settings>;
    const submittedThemeIntent = settingsScope
        ? loadPendingAccountSettingsState(settingsScope).themeProfileMigration : null;
    const submittedThemeEdits = submittedThemeIntent?.edits ?? [];

    const migrationLocalSettings = loadLocalSettings();
    const legacyThemeProfiles = settingsScope
        && areAccountSettingsScopesEqual(storage.getState().settingsScope, settingsScope)
        && canUseLegacyThemeProfiles(migrationLocalSettings.themeProfileLegacyAccountScope, settingsScope)
        && migrationLocalSettings.themeProfiles.profiles.length > 0
        ? migrationLocalSettings.themeProfiles : null;
    if (legacyThemeProfiles && !migrationLocalSettings.themeProfileLegacyAccountScope) {
        // Bind before awaiting network work: an account switch must not import this library twice.
        storage.getState().applyLocalSettings({ themeProfileLegacyAccountScope: settingsScope });
    }

    function finishThemeProfileMigration(legacyProfileIds: ReadonlyMap<string, string>): void {
        if (!legacyThemeProfiles) return;
        const latest = loadLocalSettings();
        if (!areAccountSettingsJsonValuesEqual(latest.themeProfiles, legacyThemeProfiles)) return;
        if (settingsScope) rememberThemeProfileMigration(settingsScope, legacyProfileIds);
        storage.getState().applyLocalSettings({
            themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE,
            themeProfileLegacyAccountScope: null,
            ...(isSettingsScopeActive() || areAccountSettingsJsonValuesEqual(
                latest.themeProfileSelection, migrationLocalSettings.themeProfileSelection,
            ) ? { themeProfileSelection: resolveThemeProfileSelection(latest.themeProfileSelection,
                legacyThemeProfiles, legacyProfileIds) } : {}),
        });
    }

    // `/v1/account/encryption` and the account-settings GET are independent reads. The mode decides
    // how the fetched document is *opened* and written — `openSettingsContent` branches on the
    // envelope's own `t`, not on the mode — so nothing about the read depends on it. Awaiting the
    // mode before issuing the GET cost a measured 124 ms on every account-change foreground; both
    // requests are now in flight together, with the mode still awaited before anything opens.
    const encryptionModeResult = fetchAccountEncryptionMode(credentials);
    let pendingSettingsV2Fetch: Promise<{ content: AccountSettingsStoredContentEnvelope | null; version: number }> | null =
        fetchSettingsV2();
    // The first baseline read consumes it; keep the rejection observed until then.
    pendingSettingsV2Fetch.catch(() => undefined);
    function consumeSettingsV2Fetch(): Promise<{ content: AccountSettingsStoredContentEnvelope | null; version: number }> {
        const prefetched = pendingSettingsV2Fetch;
        pendingSettingsV2Fetch = null;
        return prefetched ?? fetchSettingsV2();
    }
    const encryptionMode = await encryptionModeResult;
    const accountMode = encryptionMode.mode === 'plain' ? 'plain' : 'e2ee';

    function isSettingsScopeActive(): boolean {
        if (!settingsScope) return true;
        return areAccountSettingsScopesEqual(storage.getState().settingsScope, settingsScope);
    }

    function loadSettingsForCapturedScope(): { settings: Settings; version: number | null } {
        if (!settingsScope || isSettingsScopeActive()) {
            const currentState = storage.getState();
            return {
                settings: currentState.settings,
                version: currentState.settingsVersion,
            };
        }
        const loaded = loadAccountSettings(settingsScope);
        return {
            settings: settingsParse(loaded.settings),
            version: loaded.version,
        };
    }

    function loadPendingSettingsForCapturedScope(): Partial<Settings> {
        // Pre-auth/bootstrap calls may not have a captured account scope yet. Authenticated
        // sync paths always pass a scope and therefore use scoped pending settings.
        const persisted = settingsScope ? loadPendingAccountSettings(settingsScope) : loadPendingSettings();
        return { ...persisted, ...params.getLatestPendingSettings?.() };
    }

    function applySettingsForCapturedScope(nextSettings: Settings, nextVersion: number): void {
        if (settingsScope) {
            storage.getState().applySettingsForScope(settingsScope, nextSettings, nextVersion);
            return;
        }
        storage.getState().applySettings(nextSettings, nextVersion);
    }

    function replaceSettingsForCapturedScope(nextSettings: Settings, nextVersion: number): void {
        if (settingsScope) {
            storage.getState().replaceSettingsForScope(settingsScope, nextSettings, nextVersion);
            return;
        }
        storage.getState().replaceSettings(nextSettings, nextVersion);
    }

    function applyActiveSettingsSideEffects(nextSettings: Settings): void {
        if (!isSettingsScopeActive()) return;
        if (tracking) {
            nextSettings.analyticsOptOut ? tracking.optOut() : tracking.optIn();
        }
        applyCrashReportsOptOut(nextSettings.crashReportsOptOut);
    }

    type AccountSettingsServerBaseline = {
        api: 'v2' | 'v1';
        content: AccountSettingsStoredContentEnvelope | null;
        version: number;
        raw: Record<string, unknown> | null;
        serverIdentityKeysChanged: boolean;
    };
    type AccountSettingsV1UpdateResponse =
        | { success: true; version: number }
        | { success: false; error: 'version-mismatch'; currentVersion: number; currentSettings: string | null };
    type AccountSettingsUpdateResponse = AccountSettingsV2UpdateResponse | AccountSettingsV1UpdateResponse;
    type AccountSettingsVersionMismatchResponse = Extract<AccountSettingsUpdateResponse, { success: false }>;

    async function fetchSettingsV2(): Promise<{ content: AccountSettingsStoredContentEnvelope | null; version: number }> {
        const response = await serverFetch('/v2/account/settings', {
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
        }, { includeAuth: false });

        if (!response.ok) {
            if (response.status === 404) {
                // Back-compat: old servers only support v1.
                throw Object.assign(new Error('settings_v2_not_supported'), { code: 'settings_v2_not_supported' });
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                throw new HappyError(`Failed to fetch settings (${response.status})`, false);
            }
            throw new Error(`Failed to fetch settings: ${response.status}`);
        }

        const data: unknown = await response.json();
        const parsed = AccountSettingsV2GetResponseSchema.safeParse(data);
        if (!parsed.success) {
            throw new Error('Failed to parse account settings v2 response');
        }
        return { content: parsed.data.content, version: parsed.data.version };
    }

    async function fetchSettingsV1(): Promise<{ content: AccountSettingsStoredContentEnvelope | null; version: number }> {
        const response = await serverFetch('/v1/account/settings', {
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
        }, { includeAuth: false });

        if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                throw new HappyError(`Failed to fetch settings (${response.status})`, false);
            }
            throw new Error(`Failed to fetch settings: ${response.status}`);
        }

        const data = (await response.json()) as { settings: string | null; settingsVersion: number };
        return { content: data.settings ? { t: 'encrypted', c: data.settings } : null, version: data.settingsVersion };
    }

    async function updateSettingsV2(params: { content: unknown; expectedVersion: number }): Promise<AccountSettingsV2UpdateResponse> {
        const response = await serverFetch('/v2/account/settings', {
            method: 'POST',
            body: JSON.stringify({
                content: params.content,
                expectedVersion: params.expectedVersion,
            }),
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
        }, { includeAuth: false });

        const data: unknown = await response.json().catch(() => null);
        const parsed = AccountSettingsV2UpdateResponseSchema.safeParse(data);
        if (response.ok && parsed.success) return parsed.data;
        if (response.status === 404) {
            throw Object.assign(new Error('settings_v2_not_supported'), { code: 'settings_v2_not_supported' });
        }
        if (parsed.success) return parsed.data;
        throw new Error(`Failed to update settings (v2): ${response.status}`);
    }

    async function updateSettingsV1(params: { settings: string | null; expectedVersion: number }): Promise<AccountSettingsV1UpdateResponse> {
        const response = await serverFetch('/v1/account/settings', {
            method: 'POST',
            body: JSON.stringify({
                settings: params.settings,
                expectedVersion: params.expectedVersion,
            }),
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
        }, { includeAuth: false });

        const data: unknown = await response.json().catch(() => null);
        if (!data || typeof data !== 'object') {
            throw new Error(`Failed to update settings (v1): ${response.status}`);
        }
        const record = data as Record<string, unknown>;

        if (response.ok && record.success === true && typeof record.version === 'number') {
            return { success: true, version: record.version };
        }
        if (
            response.ok
            && record.success === false
            && record.error === 'version-mismatch'
            && typeof record.currentVersion === 'number'
            && (typeof record.currentSettings === 'string' || record.currentSettings === null)
        ) {
            return {
                success: false,
                error: 'version-mismatch',
                currentVersion: record.currentVersion,
                currentSettings: record.currentSettings,
            };
        }
        throw new Error(`Failed to update settings (v1): ${response.status}`);
    }

    async function decryptSettingsCiphertext(ciphertext: string): Promise<Record<string, unknown> | null> {
        const machineKey = encryption.getContentPrivateKey();
        const opened = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey },
            ciphertext,
        });
        if (opened?.value && typeof opened.value === 'object' && !Array.isArray(opened.value)) {
            return opened.value as Record<string, unknown>;
        }
        return await decryptAccountSettingsCiphertextForUi(encryption, ciphertext);
    }

    async function openSettingsContent(
        content: AccountSettingsStoredContentEnvelope | null,
        options?: { requireReadable?: boolean },
    ): Promise<Record<string, unknown> | null> {
        if (!content) return null;
        if (content.t === 'plain') {
            const raw = content.v as Record<string, unknown>;
            assertUiAccountEncryptionModeAllowed({
                mode: 'plain',
                syncedSettings: raw,
                localSettings: loadSettingsForCapturedScope().settings,
            });
            return raw;
        }
        const decrypted = await decryptSettingsCiphertext(String(content.c ?? ''));
        if (!decrypted && options?.requireReadable) {
            throw new Error('Failed to open encrypted account settings');
        }
        return decrypted;
    }

    function migrateRawServerIdentityKeys(raw: Record<string, unknown> | null): {
        raw: Record<string, unknown> | null;
        changed: boolean;
    } {
        const rewriteUnknownServerIds = settingsScope ? isServerIssuedIdentityId(settingsScope.serverId) : false;
        if (!raw || !settingsScope || (legacyServerIdsForSettingsKeys.length === 0 && !rewriteUnknownServerIds)) {
            return { raw, changed: false };
        }
        const migrated = migrateAccountSettingsServerIdentityKeys({
            settings: raw,
            currentServerId: settingsScope.serverId,
            legacyServerIds: legacyServerIdsForSettingsKeys,
            rewriteUnknownServerIds,
        });
        return { raw: migrated.settings, changed: migrated.changed };
    }

    async function fetchAccountSettingsBaseline(options?: { requireReadable?: boolean }): Promise<AccountSettingsServerBaseline> {
        try {
            const fetched = await consumeSettingsV2Fetch();
            const raw = await openSettingsContent(fetched.content, options);
            const migrated = migrateRawServerIdentityKeys(raw);
            return {
                api: 'v2',
                content: fetched.content,
                version: fetched.version,
                raw: migrated.raw,
                serverIdentityKeysChanged: migrated.changed,
            };
        } catch (e: unknown) {
            const errorCode = e && typeof e === 'object' && 'code' in e
                ? (e as { code?: unknown }).code
                : undefined;
            if (errorCode !== 'settings_v2_not_supported') throw e;
            if (accountMode === 'plain') {
                throw new Error('Settings v2 is required but not supported by this server');
            }
            const fetched = await fetchSettingsV1();
            const raw = await openSettingsContent(fetched.content, options);
            const migrated = migrateRawServerIdentityKeys(raw);
            return {
                api: 'v1',
                content: fetched.content,
                version: fetched.version,
                raw: migrated.raw,
                serverIdentityKeysChanged: migrated.changed,
            };
        }
    }

    async function baselineFromVersionMismatch(data: AccountSettingsVersionMismatchResponse): Promise<AccountSettingsServerBaseline> {
        const currentContent: AccountSettingsStoredContentEnvelope | null = 'currentContent' in data
            ? data.currentContent
            : data.currentSettings
                ? { t: 'encrypted', c: data.currentSettings }
                : null;
        const raw = await openSettingsContent(currentContent, { requireReadable: true });
        const migrated = migrateRawServerIdentityKeys(raw);
        return {
            api: 'currentContent' in data ? 'v2' : 'v1',
            content: currentContent,
            version: data.currentVersion,
            raw: migrated.raw,
            serverIdentityKeysChanged: migrated.changed,
        };
    }

    function normalizeSettingsForLocalStorage(params: { raw: Record<string, unknown>; mode: 'plain' | 'e2ee' }): Settings {
        const parsed = settingsParse(params.raw);
        if (params.mode === 'plain') {
            return sealSecretsDeep(parsed, settingsSecretsKey);
        }
        if (settingsSecretsKey) {
            return resealSecretsDeep(parsed, {
                readKeys: settingsSecretsReadKeys,
                writeKey: settingsSecretsKey,
            }).value as Settings;
        }
        return parsed;
    }

    function normalizeSettingsForServerStorageResult(params: {
        raw: Settings | Record<string, unknown>;
        mode: 'plain' | 'e2ee';
    }): { value: Record<string, unknown>; changed: boolean } {
        const strippedLocalOnly = stripLocalOnlyAccountSettings(params.raw);
        const stripped = stripMigratedSessionOrganizationSettings(strippedLocalOnly as Record<string, unknown>);
        const migratedOrganizationStripped = !areAccountSettingsRawObjectsEqual(
            strippedLocalOnly as Record<string, unknown>,
            stripped,
        );
        if (params.mode === 'plain') {
            const unsealed = unsealSecretsDeepWithKeys(stripped, settingsSecretsReadKeys) as Record<string, unknown>;
            return { value: unsealed, changed: migratedOrganizationStripped || unsealed !== stripped };
        }
        if (!settingsSecretsKey) {
            return { value: stripped as Record<string, unknown>, changed: migratedOrganizationStripped };
        }
        const resealed = resealSecretsDeep(stripped, {
            readKeys: settingsSecretsReadKeys,
            writeKey: settingsSecretsKey,
        });
        return { value: resealed.value as Record<string, unknown>, changed: migratedOrganizationStripped || resealed.changed };
    }

    function createSettingsContentForWrite(raw: Record<string, unknown>): {
        content: AccountSettingsStoredContentEnvelope;
        v1Settings: string | null;
    } {
        if (accountMode === 'plain') {
            assertUiAccountEncryptionModeAllowed({
                mode: 'plain',
                syncedSettings: raw,
                localSettings: loadSettingsForCapturedScope().settings,
            });
            return { content: { t: 'plain', v: raw }, v1Settings: null };
        }
        const ciphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: encryption.getContentPrivateKey() },
            payload: raw,
            randomBytes: getRandomBytes,
        });
        return { content: { t: 'encrypted', c: ciphertext }, v1Settings: ciphertext };
    }

    function applyRawSettingsProjection(params: {
        raw: Record<string, unknown> | null;
        version: number;
        remainingPendingSettings?: Partial<Settings>;
        replace?: boolean;
    }): void {
        const parsedSettings = params.raw
            ? normalizeSettingsForLocalStorage({ raw: params.raw, mode: accountMode })
            : { ...settingsDefaults };
        const remainingServerPending = stripLocalOnlyAccountSettings(params.remainingPendingSettings ?? {});
        const cleanedRemainingServerPending = stripMigratedSessionOrganizationSettings(
            remainingServerPending as Record<string, unknown>,
        ) as Partial<Settings>;
        const mergedWithPending = Object.keys(cleanedRemainingServerPending).length > 0
            ? applySettings(parsedSettings, cleanedRemainingServerPending)
            : parsedSettings;
        const nextSettings = applySettings(
            mergedWithPending,
            pickLocalOnlyAccountSettings(loadSettingsForCapturedScope().settings),
        );
        if (params.replace) {
            replaceSettingsForCapturedScope(nextSettings, params.version);
        } else {
            applySettingsForCapturedScope(nextSettings, params.version);
        }
        applyActiveSettingsSideEffects(nextSettings);
    }

    function clearCommittedPendingSettings(submittedPendingSettings: Partial<Settings>, theme?: Readonly<{
        profiles: readonly ThemeProfileV1[]; legacyProfileIds: ReadonlyMap<string, string>;
    }>): Partial<Settings> {
        const currentPendingSettings = loadPendingSettingsForCapturedScope();
        let nextPendingSettings = stripMigratedSessionOrganizationSettings(
            removeCommittedPendingSettings(currentPendingSettings, submittedPendingSettings) as Record<string, unknown>,
        ) as Partial<Settings>;
        if (settingsScope && theme) {
            const currentIntent = loadPendingAccountSettingsState(settingsScope).themeProfileMigration;
            if (currentIntent || submittedThemeIntent) {
                const remaining = rebaseThemeProfileMigrationEdits(
                    removeCommittedThemeProfileMigrationEdits(currentIntent?.edits ?? [], submittedThemeEdits), theme.legacyProfileIds,
                );
                const { themeProfiles: _committedProfiles, ...otherPendingSettings } = nextPendingSettings;
                nextPendingSettings = remaining.length > 0 ? { ...otherPendingSettings,
                    themeProfiles: applyThemeProfileMigrationEdits(theme.profiles, remaining, new Map()),
                } : otherPendingSettings;
                // One atomic pending record bridges server acknowledgement, cache projection and
                // local backup cleanup. A restart must never re-import the pre-edit backup.
                savePendingAccountSettings(settingsScope, {
                    ...nextPendingSettings, themeProfiles: nextPendingSettings.themeProfiles ?? theme.profiles,
                }, { edits: remaining, legacyProfileIds: Object.fromEntries(theme.legacyProfileIds), acknowledged: true });
            }
            else if (legacyThemeProfiles) savePendingAccountSettings(settingsScope, {
                ...nextPendingSettings, themeProfiles: theme.profiles,
            }, { edits: [], legacyProfileIds: Object.fromEntries(theme.legacyProfileIds), acknowledged: true });
            return nextPendingSettings;
        }
        clearPendingSettings(nextPendingSettings);
        return nextPendingSettings;
    }

    function completeThemeProfileMigration(theme: Readonly<{ legacyProfileIds: ReadonlyMap<string, string> }> | undefined,
        remainingPendingSettings: Partial<Settings>): void {
        if (!theme) return;
        finishThemeProfileMigration(theme.legacyProfileIds);
        if (settingsScope) savePendingAccountSettings(settingsScope, remainingPendingSettings, null);
        clearPendingSettings(remainingPendingSettings);
    }

    async function maybeImportLegacySessionOrganization(rawSettings: Record<string, unknown> | null): Promise<void> {
        if (!settingsScope || !rawSettings) return;
        if (hasCompletedLegacySessionOrganizationImport(settingsScope)) return;

        try {
            const initialPlan = buildLegacySessionOrganizationImportPlan({
                serverId: settingsScope.serverId,
                rawSettings,
            });
            if (!initialPlan.hasLegacyOrganizationSettings) return;

            const existing = await fetchSessionOrganizationSnapshot({
                credentials,
                serverUrl: activeServerUrl,
                request: {
                    includeFolders: true,
                    includeTags: true,
                    includeLabels: true,
                    includeAllFolderAssignments: true,
                    includeAllTagAssignments: true,
                },
            });
            const plan = buildLegacySessionOrganizationImportPlan({
                serverId: settingsScope.serverId,
                rawSettings,
                existingSnapshot: existing.snapshot,
            });
            if (plan.hasImportableLegacyOrganization) {
                await importLegacySessionOrganizationOp({
                    credentials,
                    serverId: settingsScope.serverId,
                    serverUrl: activeServerUrl,
                    request: plan.request,
                });
            }
            markLegacySessionOrganizationImportComplete(settingsScope);
            if (plan.hasImportableLegacyOrganization && plan.request.pins.length > 0) {
                await params.onLegacySessionOrganizationImported?.({
                    pinnedSessionIds: plan.request.pins.map((pin) => pin.sessionId),
                });
            }
        } catch (error) {
            dbgSettings('syncSettings: legacy session organization import skipped', {
                endpoint: activeServerUrl,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    // Apply pending settings
    if (Object.keys(pendingServerSettings).length > 0 || legacyThemeProfiles) {
        dbgSettings('syncSettings: pending detected; will POST', {
            endpoint: activeServerUrl,
            pendingKeys: Object.keys(pendingServerSettings).sort(),
            pendingSummary: summarizeSettingsDelta(pendingServerSettings as Partial<Settings>),
            base: summarizeSettings(storage.getState().settings, { version: storage.getState().settingsVersion }),
        });

        let baseline = await fetchAccountSettingsBaseline({ requireReadable: true });
        while (retryCount < maxRetries) {
            const version = baseline.version;
            const themeUpdate = legacyThemeProfiles || submittedThemeIntent;
            // Merge the definition being imported, not its pre-edit backup. If a successful
            // POST response was lost, the canonical merger recognizes the already saved copy.
            const legacyUpserts = new Map(submittedThemeEdits.filter(edit => edit.target.kind === 'legacy' && edit.profile)
                .map(edit => [edit.target.id, edit.profile!]));
            const legacyForMerge = legacyThemeProfiles ? { ...legacyThemeProfiles,
                profiles: legacyThemeProfiles.profiles.filter(profile => !Object.prototype.hasOwnProperty.call(
                    submittedThemeIntent?.representedLegacyProfileIds ?? {}, profile.id,
                )).map(profile => {
                    const edited = legacyUpserts.get(profile.id);
                    return edited ? { ...edited, id: profile.id } : profile;
                }),
            } : DEFAULT_THEME_PROFILES_LOCAL_STATE;
            const latestThemeIntent = settingsScope ? loadPendingAccountSettingsState(settingsScope).themeProfileMigration : null;
            const migration = themeUpdate ? mergeThemeProfileLibraries(
                submittedThemeIntent ? ThemeProfileLibrarySchema.parse(baseline.raw?.themeProfiles)
                    : pendingServerSettings.themeProfiles ?? ThemeProfileLibrarySchema.parse(baseline.raw?.themeProfiles),
                submittedThemeIntent?.acknowledged ? DEFAULT_THEME_PROFILES_LOCAL_STATE
                    : legacyForMerge,
                new Map(Object.entries({ ...submittedThemeIntent?.legacyProfileIds, ...latestThemeIntent?.attemptedLegacyProfileIds })),
            ) : null;
            const legacyProfileIds = new Map(migration?.legacyProfileIds);
            for (const [id, mapped] of Object.entries(submittedThemeIntent?.representedLegacyProfileIds ?? {})) legacyProfileIds.set(id, mapped);
            if (submittedThemeIntent?.acknowledged) {
                for (const [id, mapped] of Object.entries(submittedThemeIntent.legacyProfileIds)) legacyProfileIds.set(id, mapped);
            }
            const theme = migration ? {
                profiles: applyThemeProfileMigrationEdits(migration.profiles, submittedThemeEdits, legacyProfileIds),
                legacyProfileIds,
            } : undefined;
            const pendingWithMigration: Partial<Settings> = theme
                ? { ...pendingServerSettings, themeProfiles: theme.profiles } : pendingServerSettings;
            const merged = mergePendingSettingsIntoRawBaseline({
                rawBaseline: baseline.raw,
                pendingSettings: pendingWithMigration,
                normalizeForPersistedStorage: (raw) => normalizeSettingsForServerStorageResult({ raw, mode: accountMode }),
            });

            if (!baseline.serverIdentityKeysChanged && !merged.comparisonChanged && areAccountSettingsRawObjectsEqual(merged.comparisonRaw, merged.outgoingRaw)) {
                const remainingPendingSettings = clearCommittedPendingSettings(pendingServerSettings, theme);
                dbgSettings('syncSettings: pending merge produced no server change; skipped POST', {
                    endpoint: activeServerUrl,
                    serverVersion: version,
                    pendingKeys: Object.keys(pendingServerSettings).sort(),
                });
                applyRawSettingsProjection({
                    raw: baseline.raw,
                    version,
                    remainingPendingSettings,
                });
                completeThemeProfileMigration(theme, remainingPendingSettings);
                return;
            }

            const { content, v1Settings } = createSettingsContentForWrite(merged.outgoingRaw);
            if (theme && settingsScope) {
                const current = loadPendingAccountSettingsState(settingsScope);
                const latestPending = loadPendingSettingsForCapturedScope();
                const queued = { ...latestPending, themeProfiles: latestPending.themeProfiles ?? theme.profiles };
                const accountIds = new Set(ThemeProfileLibrarySchema.parse(baseline.raw?.themeProfiles).map(profile => profile.id));
                const represented = new Map([...theme.legacyProfileIds].filter(([, id]) => accountIds.has(id)));
                savePendingAccountSettings(settingsScope, queued, {
                    ...(current.themeProfileMigration ?? { edits: submittedThemeEdits,
                        legacyProfileIds: Object.fromEntries([...theme.legacyProfileIds].filter(([id]) => !represented.has(id))),
                        representedLegacyProfileIds: Object.fromEntries(represented) }),
                    attemptedLegacyProfileIds: Object.fromEntries(theme.legacyProfileIds),
                });
                // Ordinary pending flushes must retain this same record while the POST is in flight.
                clearPendingSettings(queued);
            }
            dbgSettings('syncSettings: POST attempt', {
                endpoint: activeServerUrl,
                attempt: retryCount + 1,
                expectedVersion: version,
                merged: summarizeSettings(merged.outgoingRaw, { version }),
            });

            let data: AccountSettingsUpdateResponse;
            if (baseline.api === 'v2') {
                data = await updateSettingsV2({ content, expectedVersion: version ?? 0 });
            } else {
                data = await updateSettingsV1({ settings: v1Settings, expectedVersion: version });
            }

            if (data.success) {
                const remainingPendingSettings = clearCommittedPendingSettings(pendingServerSettings, theme);
                dbgSettings('syncSettings: POST success; pending cleared', {
                    endpoint: activeServerUrl,
                    expectedVersion: version,
                    responseVersion: data.version,
                });
                applyRawSettingsProjection({
                    raw: merged.outgoingRaw,
                    version: data.version,
                    remainingPendingSettings,
                });
                completeThemeProfileMigration(theme, remainingPendingSettings);
                return;
            }

            if (data.error === 'version-mismatch') {
                lastVersionMismatch = {
                    expectedVersion: version,
                    currentVersion: data.currentVersion,
                    pendingKeys: Object.keys(pendingServerSettings).sort(),
                };

                baseline = await baselineFromVersionMismatch(data);
                dbgSettings('syncSettings: version-mismatch merge', {
                    endpoint: activeServerUrl,
                    expectedVersion: version,
                    currentVersion: data.currentVersion,
                    pendingKeys: Object.keys(pendingServerSettings).sort(),
                    serverRawKeys: Object.keys(baseline.raw ?? {}).sort(),
                });
                retryCount++;
                continue;
            }

            throw new Error(`Failed to sync settings: ${data.error}`);
        }
    } else if (Object.keys(pendingSettings).length > 0) {
        // Pending keys can include UI-local server-selection fields, which are intentionally local-only.
        // Drop them from pending storage to avoid unnecessary sync attempts.
        clearCommittedPendingSettings(pendingSettings);
        dbgSettings('syncSettings: cleared local-only pending settings keys', {
            endpoint: activeServerUrl,
            pendingKeys: Object.keys(pendingSettings).sort(),
        });
    }

    // If exhausted retries, throw to trigger outer backoff delay
    if (retryCount >= maxRetries) {
        const mismatchHint = lastVersionMismatch
            ? ` (expected=${lastVersionMismatch.expectedVersion}, current=${lastVersionMismatch.currentVersion}, pendingKeys=${lastVersionMismatch.pendingKeys.join(',')})`
            : '';
        throw new Error(`Settings sync failed after ${maxRetries} retries due to version conflicts${mismatchHint}`);
    }

    const fetched = await fetchAccountSettingsBaseline();
    const decryptedSettings = fetched.raw;
    await maybeImportLegacySessionOrganization(decryptedSettings);

    const parsedSettings = decryptedSettings
        ? normalizeSettingsForLocalStorage({ raw: decryptedSettings, mode: accountMode })
        : { ...settingsDefaults };

    dbgSettings('syncSettings: GET applied', {
        endpoint: activeServerUrl,
        serverVersion: fetched.version,
        parsed: summarizeSettings(parsedSettings, { version: fetched.version }),
    });

    // Merge any locally-pending settings deltas before applying server settings.
    //
    // Why:
    // - Local writes apply immediately but do not bump `settingsVersion`.
    // - A concurrent sync tick can fetch/apply a newer server version (e.g. migrations/other clients)
    //   and accidentally clobber recent local edits before the pending POST flush runs.
    // - Pending settings are persisted for crash safety; reload from disk so in-flight sync calls
    //   don't miss deltas when the Sync instance replaces the pending object reference.
    const pendingLatest = loadPendingSettingsForCapturedScope();
    const pendingLatestForServer = stripMigratedSessionOrganizationSettings(
        stripLocalOnlyAccountSettings(pendingLatest) as Record<string, unknown>,
    ) as Partial<Settings>;

    const mergedWithPending =
        Object.keys(pendingLatestForServer).length > 0
            ? applySettings(parsedSettings, pendingLatestForServer)
            : parsedSettings;

    const nextSettings = applySettings(mergedWithPending, pickLocalOnlyAccountSettings(loadSettingsForCapturedScope().settings));

    applyRawSettingsProjection({
        raw: decryptedSettings,
        version: fetched.version,
        remainingPendingSettings: pendingLatest,
    });

    // Best-effort migration: if settings were readable but not in canonical `account_scoped_v1` format,
    // rewrite them so other clients can decrypt them reliably.
    if (decryptedSettings && fetched.api === 'v2') {
        const ciphertext = fetched.content?.t === 'encrypted' ? String(fetched.content.c ?? '') : '';
        const opened = accountMode === 'e2ee' && fetched.content?.t === 'encrypted' && ciphertext
            ? openAccountScopedBlobCiphertext({
                  kind: 'account_settings',
                  material: { type: 'dataKey', machineKey: encryption.getContentPrivateKey() },
                  ciphertext,
              })
            : null;
        try {
            const migratedServerSettings = normalizeSettingsForServerStorageResult({
                raw: decryptedSettings as Record<string, unknown>,
                mode: accountMode,
            });
            const missingCanonicalEnvelope = accountMode === 'e2ee' && fetched.content?.t === 'encrypted' && !opened;
            const nonCanonicalFormat = Boolean(opened && opened.format !== 'account_scoped_v1');
            const needsMigration = missingCanonicalEnvelope
                || nonCanonicalFormat
                || fetched.serverIdentityKeysChanged
                || migratedServerSettings.changed;
            dbgSettings('syncSettings: canonical migration check', {
                endpoint: activeServerUrl,
                serverVersion: fetched.version,
                openedFormat: opened?.format ?? null,
                missingCanonicalEnvelope,
                nonCanonicalFormat,
                serverIdentityKeysChanged: fetched.serverIdentityKeysChanged,
                secretsResealed: migratedServerSettings.changed,
                needsMigration,
                parsed: summarizeSettings(parsedSettings, { version: fetched.version }),
            });
            if (needsMigration) {
                const migrationStack = (() => {
                    try {
                        const stack = (new Error('settings canonical migration trace') as { stack?: string }).stack;
                        return typeof stack === 'string' ? stack.split('\n').slice(0, 10).join('\n') : null;
                    } catch {
                        return null;
                    }
                })();
                const { content: migrateContent } = createSettingsContentForWrite(migratedServerSettings.value);
                dbgSettings('syncSettings: canonical migration POST attempt', {
                    endpoint: activeServerUrl,
                    expectedVersion: fetched.version,
                    openedFormat: opened?.format ?? null,
                    missingCanonicalEnvelope,
                    nonCanonicalFormat,
                    serverIdentityKeysChanged: fetched.serverIdentityKeysChanged,
                    secretsResealed: migratedServerSettings.changed,
                    stack: migrationStack,
                });
                const migrateRes = await updateSettingsV2({
                    content: migrateContent,
                    expectedVersion: fetched.version,
                });
                if (migrateRes.success) {
                    dbgSettings('syncSettings: canonical migration POST success', {
                        endpoint: activeServerUrl,
                        expectedVersion: fetched.version,
                        responseVersion: migrateRes.version,
                    });
                    applySettingsForCapturedScope(nextSettings, migrateRes.version);
                } else {
                    dbgSettings('syncSettings: canonical migration POST returned non-success', {
                        endpoint: activeServerUrl,
                        expectedVersion: fetched.version,
                        response: migrateRes as Record<string, unknown>,
                    });
                }
            }
        } catch {
            // ignore migration failures (non-fatal)
        }
    }
}

async function decryptAccountSettingsCiphertextForUi(encryption: Encryption, ciphertext: string): Promise<Record<string, unknown> | null> {
    const machineKey = encryption.getContentPrivateKey();
    const opened = openAccountScopedBlobCiphertext({
        kind: 'account_settings',
        material: { type: 'dataKey', machineKey },
        ciphertext,
    });
    if (opened?.value && typeof opened.value === 'object' && !Array.isArray(opened.value)) {
        return opened.value as Record<string, unknown>;
    }

    // Backwards compatibility for historical ciphertext formats produced by older app builds.
    const decrypted = await encryption.decryptRaw(ciphertext);
    if (decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)) {
        return decrypted as Record<string, unknown>;
    }
    return null;
}

export function applySettingsLocalDelta(params: {
    delta: Partial<Settings>;
    settingsSecretsKey: Uint8Array | null;
    getPendingSettings: () => Partial<Settings>;
    setPendingSettings: (next: Partial<Settings>) => void;
    schedulePendingSettingsFlush: () => void;
    source?: SettingsAnalyticsSource;
    durability?: 'immediate';
    themeProfileMigration?: ThemeProfileMigrationIntent;
}): void {
    const { settingsSecretsKey, getPendingSettings, setPendingSettings, schedulePendingSettingsFlush } = params;
    let { delta } = params;

    // Seal secret settings fields before any persistence.
    delta = sealSecretsDeep(delta, settingsSecretsKey);

    // Avoid no-op writes. Settings writes cause:
    // - local persistence writes
    // - pending delta persistence
    // - a server POST (eventually)
    //
    // So we must not write when nothing actually changed.
    const currentSettings = storage.getState().settings;
    const deltaEntries = Object.entries(delta) as Array<[keyof Settings, unknown]>;
    const hasRealChange = deltaEntries.some(([key, next]) => {
        const prev = currentSettings[key];
        if (Object.is(prev, next)) return false;

        const prevIsObj = prev !== null && typeof prev === 'object';
        const nextIsObj = next !== null && typeof next === 'object';
        if (prevIsObj || nextIsObj) {
            return !areAccountSettingsJsonValuesEqual(prev, next);
        }
        return true;
    });
    if (!hasRealChange && params.durability !== 'immediate') {
        dbgSettings('applySettings skipped (no-op delta)', {
            delta: summarizeSettingsDelta(delta),
            base: summarizeSettings(currentSettings, { version: storage.getState().settingsVersion }),
        });
        return;
    }

    if (isSettingsSyncDebugEnabled()) {
        const stack = (() => {
            try {
                const s = (new Error('settings-sync trace') as { stack?: string }).stack;
                return typeof s === 'string' ? s.split('\n').slice(0, 10).join('\n') : null;
            } catch {
                return null;
            }
        })();
        const st = storage.getState();
        dbgSettings('applySettings called', {
            delta: summarizeSettingsDelta(delta),
            base: summarizeSettings(st.settings, { version: st.settingsVersion }),
            stack,
        });
    }

    const deltaForServer = stripMigratedSessionOrganizationSettings(
        stripLocalOnlyAccountSettings(delta) as Record<string, unknown>,
    ) as Partial<Settings>;
    const nextPending = { ...getPendingSettings(), ...deltaForServer };
    if (Object.keys(deltaForServer).length > 0 && (params.durability === 'immediate' || params.themeProfileMigration)) {
        const scope = storage.getState().settingsScope;
        if (scope) {
            const previous = loadPendingAccountSettingsState(scope).themeProfileMigration;
            const intent = params.themeProfileMigration ? {
                edits: mergeThemeProfileMigrationEdits(previous?.edits ?? [], params.themeProfileMigration.edits),
                legacyProfileIds: previous?.acknowledged ? previous.legacyProfileIds : params.themeProfileMigration.legacyProfileIds,
                representedLegacyProfileIds: params.themeProfileMigration.representedLegacyProfileIds ?? previous?.representedLegacyProfileIds,
                attemptedLegacyProfileIds: previous?.attemptedLegacyProfileIds,
                ...(previous?.acknowledged ? { acknowledged: true as const } : {}),
            } : 'themeProfiles' in deltaForServer ? null : previous;
            savePendingAccountSettings(scope, nextPending, intent);
        } else {
            if (params.themeProfileMigration) throw new Error('Theme migration requires an account settings scope');
            savePendingSettings(nextPending);
        }
    }

    const nextSettings = applySettings(currentSettings, delta);
    emitAccountSettingChangedEvents({
        previousSettings: currentSettings,
        nextSettings,
        source: params.source,
    });
    storage.getState().applySettingsLocal(delta);

    if (Object.keys(deltaForServer).length === 0) {
        dbgSettings('applySettings: local-only delta (no pending sync)', {
            delta: summarizeSettingsDelta(delta),
        });
        return;
    }

    // Save pending settings
    setPendingSettings(nextPending);
    dbgSettings('applySettings: pendingSettings updated', {
        pendingKeys: Object.keys(nextPending).sort(),
    });

    // Sync PostHog opt-out state if it was changed
    if (tracking && 'analyticsOptOut' in delta) {
        nextSettings.analyticsOptOut ? tracking.optOut() : tracking.optIn();
    }
    if ('crashReportsOptOut' in delta) {
        applyCrashReportsOptOut(nextSettings.crashReportsOptOut);
    }

    schedulePendingSettingsFlush();
}
