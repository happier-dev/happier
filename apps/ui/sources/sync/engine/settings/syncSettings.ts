import { tracking } from '@/track';
import { HappyError } from '@/utils/errors/errors';
import { applySettings, settingsDefaults, settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { summarizeSettings, summarizeSettingsDelta, dbgSettings, isSettingsSyncDebugEnabled } from '@/sync/domains/settings/debugSettings';
import {
    pickLocalOnlyAccountSettings,
    stripLocalOnlyAccountSettings,
} from '@/sync/domains/settings/localOnlyAccountSettings';
import {
    areAccountSettingsScopesEqual,
    type AccountSettingsScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getServerProfileLegacyServerIds } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { loadPendingSettings } from '@/sync/domains/state/persistence';
import {
    loadAccountSettings,
    loadPendingAccountSettings,
} from '@/sync/domains/state/accountSettingsPersistence';
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

export type SyncSettingsParams = {
    credentials: AuthCredentials;
    encryption: Encryption;
    settingsScope?: AccountSettingsScope | null;
    pendingSettings: Partial<Settings>;
    clearPendingSettings: (nextPendingSettings: Partial<Settings>) => void;
    settingsSecretsKey?: Uint8Array | null;
    settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
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
    const pendingServerSettings = stripLocalOnlyAccountSettings(pendingSettings);

    const encryptionMode = await fetchAccountEncryptionMode(credentials);
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
        return settingsScope ? loadPendingAccountSettings(settingsScope) : loadPendingSettings();
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

    async function updateSettingsV2(params: { content: unknown; expectedVersion: number }): Promise<unknown> {
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

    async function updateSettingsV1(params: { settings: string | null; expectedVersion: number }): Promise<any> {
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

        const data: any = await response.json().catch(() => null);
        if (!data || typeof data !== 'object') {
            throw new Error(`Failed to update settings (v1): ${response.status}`);
        }

        if (response.ok && data.success === true && typeof data.version === 'number') {
            return data;
        }
        if (response.ok && data.success === false && data.error === 'version-mismatch' && typeof data.currentVersion === 'number') {
            return data;
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
        if (content.t === 'plain') return content.v as Record<string, unknown>;
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
        if (!raw || !settingsScope) return { raw, changed: false };
        const migrated = migrateAccountSettingsServerIdentityKeys({
            settings: raw,
            currentServerId: settingsScope.serverId,
            legacyServerIds: legacyServerIdsForSettingsKeys,
            rewriteUnknownServerIds: isServerIssuedIdentityId(settingsScope.serverId),
        });
        return { raw: migrated.settings, changed: migrated.changed };
    }

    async function fetchAccountSettingsBaseline(options?: { requireReadable?: boolean }): Promise<AccountSettingsServerBaseline> {
        try {
            const fetched = await fetchSettingsV2();
            const raw = await openSettingsContent(fetched.content, options);
            const migrated = migrateRawServerIdentityKeys(raw);
            return {
                api: 'v2',
                content: fetched.content,
                version: fetched.version,
                raw: migrated.raw,
                serverIdentityKeysChanged: migrated.changed,
            };
        } catch (e: any) {
            if (e?.code !== 'settings_v2_not_supported') throw e;
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

    async function baselineFromVersionMismatch(data: any): Promise<AccountSettingsServerBaseline> {
        const currentContent = (data.currentContent ??
            (typeof data.currentSettings === 'string' || data.currentSettings === null
                ? (data.currentSettings ? { t: 'encrypted', c: data.currentSettings } : null)
                : null)) as AccountSettingsStoredContentEnvelope | null;
        const raw = await openSettingsContent(currentContent, { requireReadable: true });
        const migrated = migrateRawServerIdentityKeys(raw);
        return {
            api: data.currentContent !== undefined ? 'v2' : 'v1',
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
        const stripped = stripLocalOnlyAccountSettings(params.raw);
        if (params.mode === 'plain') {
            const unsealed = unsealSecretsDeepWithKeys(stripped, settingsSecretsReadKeys) as Record<string, unknown>;
            return { value: unsealed, changed: unsealed !== stripped };
        }
        if (!settingsSecretsKey) {
            return { value: stripped as Record<string, unknown>, changed: false };
        }
        const resealed = resealSecretsDeep(stripped, {
            readKeys: settingsSecretsReadKeys,
            writeKey: settingsSecretsKey,
        });
        return { value: resealed.value as Record<string, unknown>, changed: resealed.changed };
    }

    function createSettingsContentForWrite(raw: Record<string, unknown>): {
        content: AccountSettingsStoredContentEnvelope;
        v1Settings: string | null;
    } {
        if (accountMode === 'plain') {
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
        const mergedWithPending = Object.keys(remainingServerPending).length > 0
            ? applySettings(parsedSettings, remainingServerPending)
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

    function clearCommittedPendingSettings(submittedPendingSettings: Partial<Settings>): Partial<Settings> {
        const currentPendingSettings = loadPendingSettingsForCapturedScope();
        const nextPendingSettings = removeCommittedPendingSettings(currentPendingSettings, submittedPendingSettings);
        clearPendingSettings(nextPendingSettings);
        return nextPendingSettings;
    }

    // Apply pending settings
    if (Object.keys(pendingServerSettings).length > 0) {
        dbgSettings('syncSettings: pending detected; will POST', {
            endpoint: activeServerUrl,
            pendingKeys: Object.keys(pendingServerSettings).sort(),
            pendingSummary: summarizeSettingsDelta(pendingServerSettings as Partial<Settings>),
            base: summarizeSettings(storage.getState().settings, { version: storage.getState().settingsVersion }),
        });

        let baseline = await fetchAccountSettingsBaseline({ requireReadable: true });
        while (retryCount < maxRetries) {
            const version = baseline.version;
            const merged = mergePendingSettingsIntoRawBaseline({
                rawBaseline: baseline.raw,
                pendingSettings: pendingServerSettings,
                normalizeForPersistedStorage: (raw) => normalizeSettingsForServerStorageResult({ raw, mode: accountMode }),
            });

            if (!baseline.serverIdentityKeysChanged && !merged.comparisonChanged && areAccountSettingsRawObjectsEqual(merged.comparisonRaw, merged.outgoingRaw)) {
                const remainingPendingSettings = clearCommittedPendingSettings(pendingServerSettings);
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
                return;
            }

            const { content, v1Settings } = createSettingsContentForWrite(merged.outgoingRaw);
            dbgSettings('syncSettings: POST attempt', {
                endpoint: activeServerUrl,
                attempt: retryCount + 1,
                expectedVersion: version,
                merged: summarizeSettings(merged.outgoingRaw as any, { version }),
            });

            const data: any = baseline.api === 'v2'
                ? await updateSettingsV2({ content, expectedVersion: version })
                : await updateSettingsV1({ settings: v1Settings, expectedVersion: version });

            if (data.success) {
                const remainingPendingSettings = clearCommittedPendingSettings(pendingServerSettings);
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
    const pendingLatestForServer = stripLocalOnlyAccountSettings(pendingLatest);

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
        const machineKey = encryption.getContentPrivateKey();
        const opened = accountMode === 'e2ee' && fetched.content?.t === 'encrypted' && ciphertext
            ? openAccountScopedBlobCiphertext({
                  kind: 'account_settings',
                  material: { type: 'dataKey', machineKey },
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
            if (needsMigration) {
                const { content: migrateContent } = createSettingsContentForWrite(migratedServerSettings.value);
                const migrateRes = await updateSettingsV2({
                    content: migrateContent,
                    expectedVersion: fetched.version,
                });
                if ((migrateRes as any)?.success) {
                    applySettingsForCapturedScope(nextSettings, (migrateRes as any).version);
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const prev = (currentSettings as any)[key];
        if (Object.is(prev, next)) return false;

        const prevIsObj = prev !== null && typeof prev === 'object';
        const nextIsObj = next !== null && typeof next === 'object';
        if (prevIsObj || nextIsObj) {
            return !areAccountSettingsJsonValuesEqual(prev, next);
        }
        return true;
    });
    if (!hasRealChange) {
        dbgSettings('applySettings skipped (no-op delta)', {
            delta: summarizeSettingsDelta(delta),
            base: summarizeSettings(currentSettings, { version: storage.getState().settingsVersion }),
        });
        return;
    }

    if (isSettingsSyncDebugEnabled()) {
        const stack = (() => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const s = (new Error('settings-sync trace') as any)?.stack;
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

    const nextSettings = applySettings(currentSettings, delta);
    emitAccountSettingChangedEvents({
        previousSettings: currentSettings,
        nextSettings,
        source: params.source,
    });
    storage.getState().applySettingsLocal(delta);

    const deltaForServer = stripLocalOnlyAccountSettings(delta);
    if (Object.keys(deltaForServer).length === 0) {
        dbgSettings('applySettings: local-only delta (no pending sync)', {
            delta: summarizeSettingsDelta(delta),
        });
        return;
    }

    // Save pending settings
    const nextPending = { ...getPendingSettings(), ...deltaForServer };
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
