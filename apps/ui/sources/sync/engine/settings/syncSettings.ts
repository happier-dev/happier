import { tracking } from '@/track';
import { HappyError } from '@/utils/errors/errors';
import { applySettings, settingsDefaults, settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { summarizeSettings, summarizeSettingsDelta, dbgSettings, isSettingsSyncDebugEnabled } from '@/sync/domains/settings/debugSettings';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import { sealSecretsDeep } from '@/sync/encryption/secretSettings';
import { serverFetch } from '@/sync/http/client';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { openAccountSettingsCiphertext, sealAccountSettingsCiphertext } from '@/sync/domains/settings/accountSettingsCipher';

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

    // Apply pending settings
    if (Object.keys(pendingSettings).length > 0) {
        dbgSettings('syncSettings: pending detected; will POST', {
            endpoint: activeServerUrl,
            expectedVersion: storage.getState().settingsVersion ?? 0,
            pendingKeys: Object.keys(pendingSettings).sort(),
            pendingSummary: summarizeSettingsDelta(pendingSettings as Partial<Settings>),
            base: summarizeSettings(storage.getState().settings, { version: storage.getState().settingsVersion }),
        });

        while (retryCount < maxRetries) {
            const version = storage.getState().settingsVersion;
            const settings = applySettings(storage.getState().settings, pendingSettings);
            const machineKey = encryption.getContentPrivateKey();
            const settingsCiphertext = sealAccountSettingsCiphertext({
                machineKey,
                settings: settings as unknown as Record<string, unknown>,
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
                    pendingKeys: Object.keys(pendingSettings).sort(),
                };

                // Parse server settings
                const machineKey = encryption.getContentPrivateKey();
                const openedServerSettings = data.currentSettings
                    ? await openAccountSettingsCiphertext({
                          machineKey,
                          ciphertext: data.currentSettings,
                          fallbackDecryptRaw: (ciphertext) => encryption.decryptRaw(ciphertext),
                      })
                    : null;
                const serverSettings = openedServerSettings
                    ? settingsParse(openedServerSettings.value)
                    : { ...settingsDefaults };

                // Merge: server base + our pending changes (our changes win)
                const mergedSettings = applySettings(serverSettings, pendingSettings);
                dbgSettings('syncSettings: version-mismatch merge', {
                    endpoint: activeServerUrl,
                    expectedVersion: version ?? 0,
                    currentVersion: data.currentVersion,
                    pendingKeys: Object.keys(pendingSettings).sort(),
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
    const openedSettings = data.settings
        ? await openAccountSettingsCiphertext({
              machineKey,
              ciphertext: data.settings,
              fallbackDecryptRaw: (ciphertext) => encryption.decryptRaw(ciphertext),
          })
        : null;
    const parsedSettings = openedSettings
        ? settingsParse(openedSettings.value)
        : { ...settingsDefaults };

    dbgSettings('syncSettings: GET applied', {
        endpoint: activeServerUrl,
        serverVersion: data.settingsVersion,
        parsed: summarizeSettings(parsedSettings, { version: data.settingsVersion }),
    });

    // Apply settings to storage
    storage.getState().applySettings(parsedSettings, data.settingsVersion);

    // Sync PostHog opt-out state with settings
    if (tracking) {
        parsedSettings.analyticsOptOut ? tracking.optOut() : tracking.optIn();
    }

    // Best-effort migration: if settings were readable but not in the canonical v1 account-scoped format,
    // rewrite them so other clients (e.g. terminals/daemons) can decrypt them reliably.
    if (data.settings && openedSettings && openedSettings.format !== 'account_scoped_v1') {
        try {
            const migrateCiphertext = sealAccountSettingsCiphertext({
                machineKey,
                settings: parsedSettings as unknown as Record<string, unknown>,
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
                const migrateData = (await migrateRes.json()) as { success?: unknown } | undefined;
                if (migrateData && typeof migrateData === 'object' && (migrateData as any).success === true) {
                    storage.getState().applySettings(parsedSettings, data.settingsVersion + 1);
                }
            }
        } catch {
            // ignore migration failures (non-fatal)
        }
    }
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

    // Save pending settings
    const nextPending = { ...getPendingSettings(), ...delta };
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
