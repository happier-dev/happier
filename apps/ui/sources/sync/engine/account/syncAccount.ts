import { Platform } from 'react-native';

import { deletePushToken as deletePushTokenApi, registerPushToken as registerPushTokenApi } from '@/sync/api/session/apiPush';
import type { Encryption } from '@/sync/encryption/encryption';
import type { Profile } from '@/sync/domains/profiles/profile';
import { profileParse } from '@/sync/domains/profiles/profile';
import { settingsParse, SUPPORTED_SCHEMA_VERSION } from '@/sync/domains/settings/settings';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { pickLocalOnlyAccountSettings } from '@/sync/domains/settings/localOnlyAccountSettings';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { serverFetch } from '@/sync/http/client';
import { isExpoPushNotificationChannelEnabled, openAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { deriveSettingsSecretsKey, sealSecretsDeep } from '@/sync/encryption/secretSettings';
import { loadLastRegisteredExpoPushToken, saveLastRegisteredExpoPushToken } from '@/sync/domains/state/pushTokenRegistration';
import { readExpoPushToken, readPushPermission } from '@/activity/notifications/permission/pushNotificationAccess';

export async function handleUpdateAccountSocketUpdate(params: {
    accountUpdate: any;
    updateCreatedAt: number;
    currentProfile: Profile;
    encryption: Encryption;
    applyProfile: (profile: Profile) => void;
    applySettings: (settings: any, version: number) => void;
    settingsScope?: AccountSettingsScope | null;
    applySettingsForScope?: (scope: AccountSettingsScope, settings: any, version: number) => void;
    getLocalSettings?: () => unknown;
    log: { log: (message: string) => void };
}): Promise<void> {
    const {
        accountUpdate,
        updateCreatedAt,
        currentProfile,
        encryption,
        applyProfile,
        applySettings,
        settingsScope,
        applySettingsForScope,
        getLocalSettings,
        log,
    } = params;

    const applyAccountSettings = (settings: any, version: number) => {
        if (settingsScope && applySettingsForScope) {
            applySettingsForScope(settingsScope, settings, version);
            return;
        }
        applySettings(settings, version);
    };

    // Build updated profile with new data
    const updatedProfile: Profile = {
        ...currentProfile,
        firstName: accountUpdate.firstName !== undefined ? accountUpdate.firstName : currentProfile.firstName,
        lastName: accountUpdate.lastName !== undefined ? accountUpdate.lastName : currentProfile.lastName,
        username: accountUpdate.username !== undefined ? accountUpdate.username : currentProfile.username,
        avatar: accountUpdate.avatar !== undefined ? accountUpdate.avatar : currentProfile.avatar,
        linkedProviders:
            accountUpdate.linkedProviders !== undefined ? accountUpdate.linkedProviders : currentProfile.linkedProviders,
        connectedServices:
            accountUpdate.connectedServices !== undefined
                ? accountUpdate.connectedServices
                : currentProfile.connectedServices,
        connectedServicesV2:
            accountUpdate.connectedServicesV2 !== undefined
                ? accountUpdate.connectedServicesV2
                : currentProfile.connectedServicesV2,
        timestamp: updateCreatedAt, // Update timestamp to latest
    };

    // Apply the updated profile to storage
    applyProfile(updatedProfile);

    // Handle settings updates (new for profile sync)
    if (accountUpdate.settingsV2?.content || accountUpdate.settingsV2?.content === null) {
        try {
            const version = Number(accountUpdate.settingsV2?.version ?? 0);
            const content = accountUpdate.settingsV2?.content;
            let decryptedSettings: unknown = null;

            if (!content) {
                decryptedSettings = null;
            } else if (content.t === 'plain') {
                decryptedSettings = content.v;
            } else if (content.t === 'encrypted') {
                const machineKey = encryption.getContentPrivateKey();
                const opened = openAccountScopedBlobCiphertext({
                    kind: 'account_settings',
                    material: { type: 'dataKey', machineKey },
                    ciphertext: content.c,
                });
                if (!opened) {
                    throw new Error('Account settings ciphertext has no authenticated settings domain');
                }
                decryptedSettings = opened.value;
            }

            const parsedSettings = decryptedSettings ? settingsParse(decryptedSettings) : settingsParse({});
            const secretsKey = await deriveSettingsSecretsKey(encryption.getContentPrivateKey());
            const sealedSettings = sealSecretsDeep(parsedSettings, secretsKey);

            const localSettings = settingsParse(getLocalSettings ? getLocalSettings() : {});
            const localOnlyAccountSettings = pickLocalOnlyAccountSettings(localSettings);
            const mergedSettings = {
                ...sealedSettings,
                ...localOnlyAccountSettings,
            };

            applyAccountSettings(mergedSettings, version);
            log.log(`📋 Settings synced from server (v2, version ${version})`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.log(`Failed to process settings v2 update: ${message}`);
        }
    } else if (accountUpdate.settings?.value) {
        try {
            const machineKey = encryption.getContentPrivateKey();
            const opened = openAccountScopedBlobCiphertext({
                kind: 'account_settings',
                material: { type: 'dataKey', machineKey },
                ciphertext: accountUpdate.settings.value,
            });
            if (!opened) {
                throw new Error('Account settings ciphertext has no authenticated settings domain');
            }
            const decryptedSettings = opened.value;
            const parsedSettings = settingsParse(decryptedSettings);

            // Version compatibility check
            const settingsSchemaVersion = parsedSettings.schemaVersion ?? 1;
            if (settingsSchemaVersion > SUPPORTED_SCHEMA_VERSION) {
                console.warn(
                    `⚠️ Received settings schema v${settingsSchemaVersion}, ` +
                        `we support v${SUPPORTED_SCHEMA_VERSION}. Update app for full functionality.`,
                );
            }

            const localSettings = settingsParse(getLocalSettings ? getLocalSettings() : {});
            const localOnlyAccountSettings = pickLocalOnlyAccountSettings(localSettings);
            const mergedSettings = {
                ...parsedSettings,
                ...localOnlyAccountSettings,
            };

            applyAccountSettings(mergedSettings, accountUpdate.settings.version);
            log.log(
                `📋 Settings synced from server (schema v${settingsSchemaVersion}, version ${accountUpdate.settings.version})`,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.log(`Failed to process settings update: ${message}`);
            // Don't crash on settings sync errors, just log
        }
    }
}

export async function fetchAndApplyProfile(params: {
    credentials: AuthCredentials;
    applyProfile: (profile: Profile) => void;
    shouldContinue?: () => boolean;
}): Promise<void> {
    const { credentials, applyProfile } = params;
    const shouldContinue = params.shouldContinue ?? (() => true);
    if (!shouldContinue()) return;

    const response = await serverFetch('/v1/account/profile', {
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
        },
    }, { includeAuth: false });
    if (!shouldContinue()) return;

    if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
            throw new HappyError(`Failed to fetch profile (${response.status})`, false);
        }
        throw new Error(`Failed to fetch profile: ${response.status}`);
    }

    const data = await response.json();
    const parsedProfile = profileParse(data);
    if (!shouldContinue()) return;

    // Apply profile to storage
    applyProfile(parsedProfile);
}

/**
 * Read the live account settings without giving this sync-engine module a load-time dependency on
 * the store graph. An unreadable store (early boot, isolated test) must not silently disable push,
 * so it degrades to the schema default rather than to "disabled".
 */
function readAccountSettingsFromStore(): unknown {
    try {
        const { storage } = require('@/sync/domains/state/storage') as typeof import('@/sync/domains/state/storage');
        return storage.getState().settings;
    } catch {
        return null;
    }
}

export async function registerPushTokenIfAvailable(params: {
    credentials: AuthCredentials;
    log: { log: (message: string) => void };
    /**
     * Account settings source. Defaults to the live store; injected by tests and by callers that
     * already hold a settings snapshot.
     */
    getAccountSettings?: () => unknown;
}): Promise<void> {
    const { credentials, log } = params;

    // Only register on mobile platforms
    if (Platform.OS === 'web') {
        return;
    }

    // The account-level push setting governs registration and prompting, not just delivery.
    // Registering a token for an account that disabled push would leave a live delivery target
    // contradicting the setting the user can see.
    const readAccountSettings = params.getAccountSettings ?? readAccountSettingsFromStore;
    if (!isExpoPushNotificationChannelEnabled(readAccountSettings())) {
        log.log('Push notifications disabled for this account; skipping push token registration');
        return;
    }

    const permission = await readPushPermission();
    if (!permission.ok) {
        log.log(`Push notification runtime unavailable (${permission.reason}); skipping push token registration`);
        return;
    }

    // Background registration never prompts. iOS grants exactly one system prompt per install, and
    // spending it from a sync task gives the user no context to decide. The primed permission flow
    // owns the ask; registration only consumes an already-granted permission.
    if (!permission.permission.granted) {
        log.log(`Push notification permission not granted (${permission.permission.status}); skipping push token registration`);
        return;
    }

    const tokenOutcome = await readExpoPushToken();
    if (!tokenOutcome.ok) {
        log.log(`Unable to read an Expo push token (${tokenOutcome.reason}); skipping push token registration`);
        return;
    }

    // Register with server
    try {
        const profiles = listServerProfiles();
        const token = tokenOutcome.token;
        const previousToken = loadLastRegisteredExpoPushToken();
        const normalizeServerUrl = (serverUrl: string) => serverUrl.replace(/\/+$/, '');
        let activeServerUrl: string | null = null;
        try {
            activeServerUrl = normalizeServerUrl(getActiveServerSnapshot().serverUrl);
        } catch {
            activeServerUrl = null;
        }

        let didRegisterActiveServer = false;
        let didRegisterAnyServer = false;
        for (const profile of profiles) {
            let serverCredentials: AuthCredentials | null = null;
            try {
                serverCredentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, {
                    serverId: profile.id,
                });
            } catch {
                serverCredentials = null;
            }
            if (!serverCredentials) continue;

            try {
                await registerPushTokenApi(serverCredentials, token, {
                    serverId: profile.id,
                    apiEndpoint: profile.serverUrl,
                    clientServerUrl: profile.serverUrl,
                    retry: 'none',
                });
                didRegisterAnyServer = true;
                if (activeServerUrl && normalizeServerUrl(profile.serverUrl) === activeServerUrl) {
                    didRegisterActiveServer = true;
                }
            } catch (error) {
                const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
                log.log(`Failed to register push token for ${profile.serverUrl}: ${message}`);
            }
        }

        // Back-compat: if the active server isn't included in profiles for some reason, still try the passed credentials.
        if (!didRegisterActiveServer) {
            await registerPushTokenApi(credentials, token, {
                clientServerUrl: activeServerUrl ?? undefined,
                retry: 'none',
            });
            didRegisterAnyServer = true;
        }

        if (didRegisterAnyServer) {
            saveLastRegisteredExpoPushToken(token);
        }

        // Best-effort cleanup when Expo rotates the token: remove the old token from servers we can still reach.
        if (didRegisterAnyServer && previousToken && previousToken !== token) {
            const unregisterPreviousToken = async (serverCredentials: AuthCredentials, apiEndpoint?: string) => {
                try {
                    await deletePushTokenApi(serverCredentials, previousToken, { apiEndpoint });
                } catch {
                    // best-effort; ignore
                }
            };

            for (const profile of profiles) {
                let serverCredentials: AuthCredentials | null = null;
                try {
                    serverCredentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, {
                        serverId: profile.id,
                    });
                } catch {
                    serverCredentials = null;
                }
                if (!serverCredentials) continue;
                await unregisterPreviousToken(serverCredentials, profile.serverUrl);
            }

            await unregisterPreviousToken(credentials, activeServerUrl ?? undefined);
        }
        log.log('Push token registered successfully');
    } catch (error) {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        log.log('Failed to register push token: ' + message);
    }
}
