import { tracking } from '@/track';
import { HappyError } from '@/utils/errors/errors';
import { applySettings, settingsDefaults, settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { summarizeSettings, summarizeSettingsDelta, dbgSettings, isSettingsSyncDebugEnabled } from '@/sync/domains/settings/debugSettings';
import {
    pickLocalOnlyAccountSettings,
    stripLocalOnlyAccountSettings,
} from '@/sync/domains/settings/localOnlyAccountSettings';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { loadPendingSettings } from '@/sync/domains/state/persistence';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import { sealSecretsDeep, unsealSecretsDeep } from '@/sync/encryption/secretSettings';
import { serverFetch } from '@/sync/http/client';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { getRandomBytes } from '@/platform/cryptoRandom';
import {
    AccountSettingsV2GetResponseSchema,
    AccountSettingsV2UpdateResponseSchema,
    openAccountScopedBlobCiphertext,
    sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';
import { applyCrashReportsOptOut } from '@/utils/system/sentry';

export async function syncSettings(params: {
    credentials: AuthCredentials;
    encryption: Encryption;
    pendingSettings: Partial<Settings>;
    clearPendingSettings: () => void;
    settingsSecretsKey?: Uint8Array | null;
}): Promise<void> {
    const { credentials, encryption, pendingSettings, clearPendingSettings } = params;
    const settingsSecretsKey = params.settingsSecretsKey ?? null;

    const activeServerUrl = getActiveServerSnapshot().serverUrl;
    const maxRetries = 3;
    let retryCount = 0;
    let lastVersionMismatch: { expectedVersion: number; currentVersion: number; pendingKeys: string[] } | null = null;
    const pendingServerSettings = stripLocalOnlyAccountSettings(pendingSettings);

    const encryptionMode = await fetchAccountEncryptionMode(credentials);
    const accountMode = encryptionMode.mode === 'plain' ? 'plain' : 'e2ee';

    async function fetchSettingsV2(): Promise<{ content: unknown; version: number }> {
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

    function normalizeSettingsForLocalStorage(params: { raw: Record<string, unknown>; mode: 'plain' | 'e2ee' }): Settings {
        const parsed = settingsParse(params.raw);
        if (params.mode === 'plain') {
            return sealSecretsDeep(parsed, settingsSecretsKey);
        }
        return parsed;
    }

    function normalizeSettingsForServerStorage(params: { raw: Settings; mode: 'plain' | 'e2ee' }): Record<string, unknown> {
        const stripped = stripLocalOnlyAccountSettings(params.raw);
        if (params.mode === 'plain') {
            return unsealSecretsDeep(stripped, settingsSecretsKey) as any;
        }
        return stripped as any;
    }

    // Apply pending settings
    if (Object.keys(pendingServerSettings).length > 0) {
        dbgSettings('syncSettings: pending detected; will POST', {
            endpoint: activeServerUrl,
            expectedVersion: storage.getState().settingsVersion ?? 0,
            pendingKeys: Object.keys(pendingServerSettings).sort(),
            pendingSummary: summarizeSettingsDelta(pendingServerSettings as Partial<Settings>),
            base: summarizeSettings(storage.getState().settings, { version: storage.getState().settingsVersion }),
        });

        while (retryCount < maxRetries) {
            const version = storage.getState().settingsVersion;
            const mergedSettings = applySettings(storage.getState().settings, pendingServerSettings);
            const settingsForServer = normalizeSettingsForServerStorage({ raw: mergedSettings, mode: accountMode });

            let e2eeCiphertext: string | null = null;
            const content =
                accountMode === 'plain'
                    ? ({ t: 'plain', v: settingsForServer } as const)
                    : (() => {
                        e2eeCiphertext = sealAccountScopedBlobCiphertext({
                            kind: 'account_settings',
                            material: { type: 'dataKey', machineKey: encryption.getContentPrivateKey() },
                            payload: settingsForServer,
                            randomBytes: getRandomBytes,
                        });
                        return ({ t: 'encrypted', c: e2eeCiphertext } as const);
                    })();
            dbgSettings('syncSettings: POST attempt', {
                endpoint: activeServerUrl,
                attempt: retryCount + 1,
                expectedVersion: version ?? 0,
                merged: summarizeSettings(settingsForServer as any, { version }),
            });

            let data: any;
            try {
                data = await updateSettingsV2({ content, expectedVersion: version ?? 0 });
            } catch (e: any) {
                if (e?.code === 'settings_v2_not_supported') {
                    if (accountMode === 'plain') {
                        throw new Error('Settings v2 is required but not supported by this server');
                    }
                    data = await updateSettingsV1({ settings: e2eeCiphertext, expectedVersion: version ?? 0 });
                } else {
                    throw e;
                }
            }

            if (data.success) {
                clearPendingSettings();
                dbgSettings('syncSettings: POST success; pending cleared', {
                    endpoint: activeServerUrl,
                    newServerVersion: (version ?? 0) + 1,
                });
                break;
            }

            if (data.error === 'version-mismatch') {
                lastVersionMismatch = {
                    expectedVersion: version ?? 0,
                    currentVersion: data.currentVersion,
                    pendingKeys: Object.keys(pendingServerSettings).sort(),
                };

                const currentContent = (data.currentContent ??
                    (typeof data.currentSettings === 'string' || data.currentSettings === null
                        ? (data.currentSettings ? { t: 'encrypted', c: data.currentSettings } : null)
                        : null)) as any;
                const serverRaw = await (async () => {
                    if (!currentContent) return null;
                    if (currentContent.t === 'plain') return currentContent.v as Record<string, unknown>;
                    if (currentContent.t === 'encrypted') return await decryptSettingsCiphertext(String(currentContent.c ?? ''));
                    return null;
                })();

                const serverSettings = serverRaw
                    ? normalizeSettingsForLocalStorage({ raw: serverRaw, mode: accountMode })
                    : { ...settingsDefaults };

                // Merge: server base + our pending changes (our changes win)
                const mergedServerSettings = applySettings(serverSettings, pendingServerSettings);
                const mergedSettings = applySettings(
                    mergedServerSettings,
                    pickLocalOnlyAccountSettings(storage.getState().settings),
                );
                dbgSettings('syncSettings: version-mismatch merge', {
                    endpoint: activeServerUrl,
                    expectedVersion: version ?? 0,
                    currentVersion: data.currentVersion,
                    pendingKeys: Object.keys(pendingServerSettings).sort(),
                    serverParsed: summarizeSettings(serverSettings, { version: data.currentVersion }),
                    merged: summarizeSettings(mergedSettings, { version: data.currentVersion }),
                });

                // Update local storage with merged result at server's version.
                //
                // Important: `data.currentVersion` can be LOWER than our local `settingsVersion`
                // (e.g. when switching accounts/servers, or after server-side reset). If we only
                // "apply when newer", we'd never converge and would retry forever.
                storage.getState().replaceSettings(mergedSettings, data.currentVersion);

                // Sync tracking state with merged settings
                if (tracking) {
                    mergedSettings.analyticsOptOut ? tracking.optOut() : tracking.optIn();
                }
                applyCrashReportsOptOut(mergedSettings.crashReportsOptOut);

                // Log and retry
                retryCount++;
                continue;
            }

            throw new Error(`Failed to sync settings: ${data.error}`);
        }
    } else if (Object.keys(pendingSettings).length > 0) {
        // Pending keys can include UI-local server-selection fields, which are intentionally local-only.
        // Drop them from pending storage to avoid unnecessary sync attempts.
        clearPendingSettings();
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

    let fetched: { content: any; version: number };
    try {
        fetched = await fetchSettingsV2();
    } catch (e: any) {
        if (e?.code === 'settings_v2_not_supported') {
            // Back-compat: fall back to v1 (E2EE-only).
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
            fetched = { content: data.settings ? { t: 'encrypted', c: data.settings } : null, version: data.settingsVersion };
        } else {
            throw e;
        }
    }

    const decryptedSettings = await (async () => {
        if (!fetched.content) return null;
        if (fetched.content.t === 'plain') return fetched.content.v as Record<string, unknown>;
        if (fetched.content.t === 'encrypted') return await decryptSettingsCiphertext(String(fetched.content.c ?? ''));
        return null;
    })();

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
    const pendingLatest = loadPendingSettings();
    const pendingLatestForServer = stripLocalOnlyAccountSettings(pendingLatest);

    const mergedWithPending =
        Object.keys(pendingLatestForServer).length > 0
            ? applySettings(parsedSettings, pendingLatestForServer)
            : parsedSettings;

    const nextSettings = applySettings(mergedWithPending, pickLocalOnlyAccountSettings(storage.getState().settings));

    // Apply settings to storage
    storage.getState().applySettings(nextSettings, fetched.version);

    // Sync PostHog opt-out state with settings
    if (tracking) {
        nextSettings.analyticsOptOut ? tracking.optOut() : tracking.optIn();
    }
    applyCrashReportsOptOut(nextSettings.crashReportsOptOut);

    // Best-effort migration: if settings were readable but not in canonical `account_scoped_v1` format,
    // rewrite them so other clients can decrypt them reliably.
    if (accountMode === 'e2ee' && fetched.content?.t === 'encrypted' && decryptedSettings) {
        const ciphertext = String(fetched.content.c ?? '');
        const machineKey = encryption.getContentPrivateKey();
        const opened = ciphertext
            ? openAccountScopedBlobCiphertext({
                  kind: 'account_settings',
                  material: { type: 'dataKey', machineKey },
                  ciphertext,
              })
            : null;
        if (!opened || opened.format !== 'account_scoped_v1') {
            try {
                const migrateCiphertext = sealAccountScopedBlobCiphertext({
                    kind: 'account_settings',
                    material: { type: 'dataKey', machineKey },
                    payload: normalizeSettingsForServerStorage({ raw: parsedSettings, mode: 'e2ee' }),
                    randomBytes: getRandomBytes,
                });
                const migrateRes = await updateSettingsV2({
                    content: { t: 'encrypted', c: migrateCiphertext },
                    expectedVersion: fetched.version,
                });
                if ((migrateRes as any)?.success) {
                    storage.getState().applySettings(nextSettings, (migrateRes as any).version);
                }
            } catch {
                // ignore migration failures (non-fatal)
            }
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

        // Keep this O(1) and UI-friendly:
        // - For objects/arrays/records, rely on reference changes.
        // - Settings updates should always replace values immutably.
        const prevIsObj = prev !== null && typeof prev === 'object';
        const nextIsObj = next !== null && typeof next === 'object';
        if (prevIsObj || nextIsObj) {
            return prev !== next;
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
        const currentSettings = storage.getState().settings;
        currentSettings.analyticsOptOut ? tracking.optOut() : tracking.optIn();
    }
    if ('crashReportsOptOut' in delta) {
        const currentSettings = storage.getState().settings;
        applyCrashReportsOptOut(currentSettings.crashReportsOptOut);
    }

    schedulePendingSettingsFlush();
}
