import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { registerPushToken as registerPushTokenApi } from '@/sync/api/session/apiPush';
import type { Encryption } from '@/sync/encryption/encryption';
import type { Profile } from '@/sync/domains/profiles/profile';
import { profileParse } from '@/sync/domains/profiles/profile';
import { settingsParse, SUPPORTED_SCHEMA_VERSION } from '@/sync/domains/settings/settings';
import { pickLocalOnlyAccountSettings } from '@/sync/domains/settings/localOnlyAccountSettings';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { serverFetch } from '@/sync/http/client';
import { openAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { deriveSettingsSecretsKey, sealSecretsDeep } from '@/sync/encryption/secretSettings';

export async function handleUpdateAccountSocketUpdate(params: {
    accountUpdate: any;
    updateCreatedAt: number;
    currentProfile: Profile;
    encryption: Encryption;
    applyProfile: (profile: Profile) => void;
    applySettings: (settings: any, version: number) => void;
    getLocalSettings?: () => unknown;
    log: { log: (message: string) => void };
}): Promise<void> {
    const { accountUpdate, updateCreatedAt, currentProfile, encryption, applyProfile, applySettings, getLocalSettings, log } = params;

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
                decryptedSettings = opened?.value ?? (await encryption.decryptRaw(content.c));
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

            applySettings(mergedSettings, version);
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
            const decryptedSettings = opened?.value ?? (await encryption.decryptRaw(accountUpdate.settings.value));
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

            applySettings(mergedSettings, accountUpdate.settings.version);
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
}): Promise<void> {
    const { credentials, applyProfile } = params;

    const response = await serverFetch('/v1/account/profile', {
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
        },
    }, { includeAuth: false });

    if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
            throw new HappyError(`Failed to fetch profile (${response.status})`, false);
        }
        throw new Error(`Failed to fetch profile: ${response.status}`);
    }

    const data = await response.json();
    const parsedProfile = profileParse(data);

    // Apply profile to storage
    applyProfile(parsedProfile);
}

export async function registerPushTokenIfAvailable(params: {
    credentials: AuthCredentials;
    log: { log: (message: string) => void };
}): Promise<void> {
    const { credentials, log } = params;

    // Only register on mobile platforms
    if (Platform.OS === 'web') {
        return;
    }

    // Request permission
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
    }

    if (finalStatus !== 'granted') {
        return;
    }

    // Get push token (avoid logging token contents)
    const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
    let tokenData: { data: string };
    try {
        tokenData = projectId
            ? await Notifications.getExpoPushTokenAsync({ projectId })
            : await Notifications.getExpoPushTokenAsync();
    } catch (error) {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        log.log('Failed to get Expo push token: ' + message);
        return;
    }

    // Register with server
    try {
        const profiles = listServerProfiles();
        const token = tokenData.data;
        const normalizeServerUrl = (serverUrl: string) => serverUrl.replace(/\/+$/, '');
        let activeServerUrl: string | null = null;
        try {
            activeServerUrl = normalizeServerUrl(getActiveServerSnapshot().serverUrl);
        } catch {
            activeServerUrl = null;
        }

        let didRegisterActiveServer = false;
        for (const profile of profiles) {
            let serverCredentials: AuthCredentials | null = null;
            try {
                serverCredentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl);
            } catch {
                serverCredentials = null;
            }
            if (!serverCredentials) continue;

            try {
                await registerPushTokenApi(serverCredentials, token, {
                    apiEndpoint: profile.serverUrl,
                    clientServerUrl: profile.serverUrl,
                });
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
            });
        }
        log.log('Push token registered successfully');
    } catch (error) {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        log.log('Failed to register push token: ' + message);
    }
}
