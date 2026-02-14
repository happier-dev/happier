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
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import { sealSecretsDeep } from '@/sync/encryption/secretSettings';
import { serverFetch } from '@/sync/http/client';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

export async function syncSettings(params: {
    credentials: AuthCredentials;
    encryption: Encryption;
    pendingSettings: Partial<Settings>;
    clearPendingSettings: () => void;
}): Promise<void> {
    const { credentials, encryption, pendingSettings, clearPendingSettings } = params;

    const activeServerUrl = getActiveServerSnapshot().serverUrl;
    const maxRetries = 3;
    let retryCount = 0;
    let lastVersionMismatch: { expectedVersion: number; currentVersion: number; pendingKeys: string[] } | null = null;
    const pendingServerSettings = stripLocalOnlyAccountSettings(pendingSettings);

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
            const settings = stripLocalOnlyAccountSettings(mergedSettings);
            const settingsCiphertext = sealAccountScopedBlobCiphertext({
                kind: 'account_settings',
                material: { type: 'dataKey', machineKey: encryption.getContentPrivateKey() },
                payload: settings,
                randomBytes: getRandomBytes,
            });
            dbgSettings('syncSettings: POST attempt', {
                endpoint: activeServerUrl,
                attempt: retryCount + 1,
                expectedVersion: version ?? 0,
                merged: summarizeSettings(settings, { version }),
            });

            const response = await serverFetch('/v1/account/settings', {
                method: 'POST',
                body: JSON.stringify({
                    settings: settingsCiphertext,
                    expectedVersion: version ?? 0,
                }),
                headers: {
                    'Authorization': `Bearer ${credentials.token}`,
                    'Content-Type': 'application/json',
                },
            }, { includeAuth: false });

            const data = (await response.json()) as
                | {
                      success: false;
                      error: string;
                      currentVersion: number;
                      currentSettings: string | null;
                  }
                | {
                      success: true;
                  };

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

                // Parse server settings
                const serverSettings = data.currentSettings
                    ? settingsParse((await decryptAccountSettingsCiphertextForUi(encryption, data.currentSettings)) ?? {})
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

    // Run request
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

    const data = (await response.json()) as {
        settings: string | null;
        settingsVersion: number;
    };

    // Parse response
    const machineKey = encryption.getContentPrivateKey();
    const opened = data.settings
        ? openAccountScopedBlobCiphertext({
              kind: 'account_settings',
              material: { type: 'dataKey', machineKey },
              ciphertext: data.settings,
          })
        : null;
    const fallbackDecrypted = !opened && data.settings
        ? await decryptAccountSettingsCiphertextForUi(encryption, data.settings)
        : null;
    const decryptedSettings = (() => {
        const value = opened?.value ?? fallbackDecrypted;
        return value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    })();
    const parsedSettings = decryptedSettings
        ? settingsParse(decryptedSettings)
        : { ...settingsDefaults };

    dbgSettings('syncSettings: GET applied', {
        endpoint: activeServerUrl,
        serverVersion: data.settingsVersion,
        parsed: summarizeSettings(parsedSettings, { version: data.settingsVersion }),
    });

    const nextSettings = applySettings(
        parsedSettings,
        pickLocalOnlyAccountSettings(storage.getState().settings),
    );

    // Apply settings to storage
    storage.getState().applySettings(nextSettings, data.settingsVersion);

    // Sync PostHog opt-out state with settings
    if (tracking) {
        nextSettings.analyticsOptOut ? tracking.optOut() : tracking.optIn();
    }

    // Best-effort migration: if settings were readable but not in the canonical v1 account-scoped format,
    // rewrite them so other clients (e.g. terminals/daemons) can decrypt them reliably.
    if (data.settings && decryptedSettings && (!opened || opened.format !== 'account_scoped_v1')) {
        try {
            const migrateCiphertext = sealAccountScopedBlobCiphertext({
                kind: 'account_settings',
                material: { type: 'dataKey', machineKey },
                payload: stripLocalOnlyAccountSettings(parsedSettings),
                randomBytes: getRandomBytes,
            });
            const migrateRes = await serverFetch('/v1/account/settings', {
                method: 'POST',
                body: JSON.stringify({
                    settings: migrateCiphertext,
                    expectedVersion: data.settingsVersion,
                }),
                headers: {
                    'Authorization': `Bearer ${credentials.token}`,
                    'Content-Type': 'application/json',
                },
            }, { includeAuth: false });

            if (migrateRes.ok) {
                const migrateData = await migrateRes.json() as { success?: unknown; version?: unknown } | undefined;
                const ok = Boolean(migrateData && typeof migrateData === 'object' && (migrateData as any).success === true);
                const nextVersion =
                    typeof (migrateData as any)?.version === 'number'
                        ? (migrateData as any).version
                        : data.settingsVersion + 1;
                if (ok) {
                    storage.getState().applySettings(nextSettings, nextVersion);
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

    schedulePendingSettingsFlush();
}
