import { Platform } from 'react-native';

import { deletePushToken as deletePushTokenApi, registerPushToken as registerPushTokenApi } from '@/sync/api/session/apiPush';
import type { Encryption } from '@/sync/encryption/encryption';
import type { Profile } from '@/sync/domains/profiles/profile';
import { profileParse, tryParseProfile } from '@/sync/domains/profiles/profile';
import { settingsParse, SUPPORTED_SCHEMA_VERSION } from '@/sync/domains/settings/settings';
import {
    areAccountSettingsScopesEqual,
    type AccountSettingsScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';
import {
    normalizeAccountSettingsForLocalStorage,
    openAccountSettingsStoredContent,
} from '@/sync/domains/settings/accountSettingsNormalization';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import {
    areServerProfileIdentifiersEquivalent,
    listServerProfiles,
    resolveServerProfileScopeId,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { serverFetch, type ServerFetch } from '@/sync/http/client';
import { isExpoPushNotificationChannelEnabled } from '@happier-dev/protocol/account/settings/accountSettings';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import {
    clearLastRegisteredExpoPushToken,
    loadExpoPushTokensToUnregister,
    loadRegisteredExpoPushTokenState,
    saveExpoPushTokenGeneration,
    saveLastRegisteredExpoPushToken,
} from '@/sync/domains/state/pushTokenRegistration';
import {
    readExpoPushToken,
    readPushPermission,
    subscribeExpoPushTokenChanges,
} from '@/activity/notifications/permission/pushNotificationAccess';
import {
    loadAccountSettings,
    subscribeAccountSettingsPersistenceMutations,
} from '@/sync/domains/state/accountSettingsPersistence';
import { createAccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { parseToken } from '@/utils/auth/parseToken';
import { createServerRequestForExplicitServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { resolveServerScopedTransport } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport';
import {
    reconcileHomeRemoteAlertEnrollment,
} from '@/sync/engine/account/homeRemoteAlertEnrollment';
import { config } from '@/config';
import { log as appLog } from '@/log';
import { clearActivityNotificationContext } from '../../../../modules/happier-activity-notifications';
import { persistHomeRemoteAlertPreparedContext } from './homeRemoteAlertPreparedContext';
import { refreshAuthenticatedServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { subscribeLocalAttentionSettingsMutations } from '@/sync/domains/state/settingsPersistence';

type HomeNotificationSettingsTarget = Readonly<{
    id: string;
    serverUrl: string;
    serverIdentityId?: string | null;
    legacyServerIds?: readonly string[];
    runtimeOrigin?: string;
}>;

function areCredentialsCurrent(
    expected: AuthCredentials,
    current: AuthCredentials | null,
): boolean {
    if (!current || current.token !== expected.token) return false;
    if ('secret' in expected || 'secret' in current) {
        return 'secret' in expected
            && 'secret' in current
            && expected.secret === current.secret;
    }
    if ('encryption' in expected || 'encryption' in current) {
        return 'encryption' in expected
            && 'encryption' in current
            && expected.encryption.publicKey === current.encryption.publicKey
            && expected.encryption.machineKey === current.encryption.machineKey;
    }
    return true;
}

async function isPushRegistrationStillCurrent(params: Readonly<{
    profile: ServerProfile;
    profileScopeId: string;
    credentials: AuthCredentials;
    settingsScope: AccountSettingsScope | null;
    readScopedActiveAccountSettings: (scope: AccountSettingsScope | null) => unknown | undefined;
    knownAccountSettings: unknown | null;
}>): Promise<boolean> {
    const currentProfile = listServerProfiles().find((candidate) => (
        areServerProfileIdentifiersEquivalent(resolveServerProfileScopeId(candidate), params.profileScopeId)
        && candidate.serverUrl === params.profile.serverUrl
    ));
    if (!currentProfile) return false;
    const currentCredentials = await TokenStorage.getCredentialsForServerUrl(
        currentProfile.serverUrl,
        { serverId: resolveServerProfileScopeId(currentProfile) },
    ).catch(() => null);
    if (!currentCredentials || !areCredentialsCurrent(params.credentials, currentCredentials)) return false;
    let isProfileCurrentlyActive = false;
    try {
        isProfileCurrentlyActive = areServerProfileIdentifiersEquivalent(
            params.profileScopeId,
            String(getActiveServerSnapshot().serverId ?? ''),
        );
    } catch {
        isProfileCurrentlyActive = false;
    }
    const activeSettings = isProfileCurrentlyActive
        ? params.readScopedActiveAccountSettings(params.settingsScope)
        : undefined;
    if (activeSettings !== undefined) return isExpoPushNotificationChannelEnabled(activeSettings);
    // An explicit exact-Home reread that is unavailable cannot be replaced by
    // an older persisted projection after the registration mutation.
    if (params.knownAccountSettings === null) return false;
    try {
        const scope = params.settingsScope;
        if (!scope) return isExpoPushNotificationChannelEnabled(params.knownAccountSettings);
        const cached = loadAccountSettings(scope);
        if (!isProfileCurrentlyActive && cached.version !== null) {
            return isExpoPushNotificationChannelEnabled(cached.settings);
        }
    } catch {
        // Fall through to the exact-Home value resolved by this reconciliation.
    }
    return isExpoPushNotificationChannelEnabled(params.knownAccountSettings);
}

/**
 * Resolve one Home's notification consent.
 *
 * The Home's live Account Settings are authoritative and are read through an
 * explicit Home-targeted request (never the active-server transport). Only
 * when that live read is unavailable — offline, unsupported, or a fail-closed
 * unreadable envelope — does the Home's canonical persisted scoped projection
 * apply as the last-known value. Null means neither source is available and
 * therefore cannot authorize a registration mutation for that Home.
 */
export async function fetchHomeNotificationSettings(
    home: HomeNotificationSettingsTarget,
    credentials: AuthCredentials,
): Promise<unknown | null> {
    // Live first: this Home answers for its own Account Settings through an
    // explicit Home-targeted request. The mode comes from that Home's endpoint;
    // it is never inferred from the credential or the envelope, and an E2EE
    // envelope without usable material fails closed instead of opening.
    try {
        const request = createServerRequestForExplicitServerScope({
            serverUrl: home.serverUrl,
            ...(home.runtimeOrigin ? { runtimeOrigin: home.runtimeOrigin } : {}),
            token: credentials.token,
        });
        const encryptionMode = await fetchAccountEncryptionMode(credentials, { request });
        const accountMode = encryptionMode.mode === 'plain' ? 'plain' : 'e2ee';
        const encryption = accountMode === 'e2ee'
            ? await createEncryptionFromAuthCredentials(credentials)
            : null;
        const baseline = await readAccountSettingsBaseline({
            request,
            credentials,
            encryption,
            accountMode,
        });
        return baseline.raw ?? {};
    } catch {
        // Live read unavailable: fall through to the last-known scoped value.
    }
    try {
        const serverId = resolveServerProfileScopeId(home);
        const scope = createAccountSettingsScope(serverId, parseToken(credentials.token));
        if (!scope) return null;
        const cached = loadAccountSettings(scope);
        return cached.version === null ? null : cached.settings;
    } catch {
        return null;
    }
}

export async function handleUpdateAccountSocketUpdate(params: {
    accountUpdate: any;
    updateCreatedAt: number;
    currentProfile: Profile;
    encryption: Encryption | null;
    settingsSecretsKey?: Uint8Array | null;
    settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
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
    const settingsSecretsKey = params.settingsSecretsKey ?? null;
    const settingsSecretsReadKeys = params.settingsSecretsReadKeys
        ?? (settingsSecretsKey ? [settingsSecretsKey] : []);

    const applyAccountSettings = (settings: any, version: number) => {
        if (settingsScope && applySettingsForScope) {
            applySettingsForScope(settingsScope, settings, version);
            return;
        }
        applySettings(settings, version);
    };

    const hasQualifiedConnectedAccountsUpdate =
        accountUpdate.connectedAccountsV4 !== undefined
        || accountUpdate.connectedAccountGroupsV4 !== undefined;
    const qualifiedConnectedAccountsProjection = hasQualifiedConnectedAccountsUpdate
        ? tryParseProfile({
            ...currentProfile,
            connectedAccountsV4: accountUpdate.connectedAccountsV4 !== undefined
                ? accountUpdate.connectedAccountsV4
                : currentProfile.connectedAccountsV4,
            connectedAccountGroupsV4: accountUpdate.connectedAccountGroupsV4 !== undefined
                ? accountUpdate.connectedAccountGroupsV4
                : currentProfile.connectedAccountGroupsV4,
        })
        : null;
    if (hasQualifiedConnectedAccountsUpdate && !qualifiedConnectedAccountsProjection) {
        log.log('Ignored invalid Connected Accounts V4 profile update');
    }

    // Build updated profile with new data.
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
        connectedServiceCredentialRevisionsV1:
            accountUpdate.connectedServiceCredentialRevisionsV1 !== undefined
                ? accountUpdate.connectedServiceCredentialRevisionsV1
                : currentProfile.connectedServiceCredentialRevisionsV1,
        connectedAccountsV4:
            qualifiedConnectedAccountsProjection?.connectedAccountsV4
                ?? currentProfile.connectedAccountsV4,
        connectedAccountGroupsV4:
            qualifiedConnectedAccountsProjection?.connectedAccountGroupsV4
                ?? currentProfile.connectedAccountGroupsV4,
        timestamp: updateCreatedAt, // Update timestamp to latest
    };

    // Apply the updated profile to storage
    applyProfile(updatedProfile);

    const applyStoredAccountSettings = (paramsForSettings: Readonly<{
        content: unknown;
        version: number;
        source: 'v1' | 'v2';
    }>): void => {
        const pushWasEnabled = isExpoPushNotificationChannelEnabled(getLocalSettings?.());
        const opened = openAccountSettingsStoredContent({
            content: paramsForSettings.content,
            encryption,
            ...(paramsForSettings.source === 'v1' ? { expectedMode: 'e2ee' as const } : {}),
        });
        const parsedSettings = settingsParse(opened.raw ?? {});
        const settingsSchemaVersion = parsedSettings.schemaVersion ?? 1;
        if (settingsSchemaVersion > SUPPORTED_SCHEMA_VERSION) {
            console.warn(
                `⚠️ Received settings schema v${settingsSchemaVersion}, `
                    + `we support v${SUPPORTED_SCHEMA_VERSION}. Update app for full functionality.`,
            );
        }
        const normalizedSettings = normalizeAccountSettingsForLocalStorage({
            raw: opened.raw,
            mode: opened.mode,
            settingsSecretsKey,
            settingsSecretsReadKeys,
            localSettings: getLocalSettings?.(),
        });
        applyAccountSettings(normalizedSettings, paramsForSettings.version);
        if (pushWasEnabled !== isExpoPushNotificationChannelEnabled(normalizedSettings)) {
            schedulePushTokenReconciliation();
        }
        log.log(
            paramsForSettings.source === 'v2'
                ? `📋 Settings synced from server (v2, version ${paramsForSettings.version})`
                : `📋 Settings synced from server (schema v${settingsSchemaVersion}, version ${paramsForSettings.version})`,
        );
    };

    // Handle settings updates (new for profile sync)
    if (accountUpdate.settingsV2?.content || accountUpdate.settingsV2?.content === null) {
        try {
            applyStoredAccountSettings({
                content: accountUpdate.settingsV2.content,
                version: Number(accountUpdate.settingsV2.version ?? 0),
                source: 'v2',
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.log(`Failed to process settings v2 update: ${message}`);
        }
    } else if (accountUpdate.settings?.value) {
        try {
            applyStoredAccountSettings({
                content: {
                    t: 'encrypted',
                    c: accountUpdate.settings.value,
                },
                version: accountUpdate.settings.version,
                source: 'v1',
            });
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
    request?: ServerFetch;
    shouldContinue?: () => boolean;
}): Promise<void> {
    const { credentials, applyProfile } = params;
    const shouldContinue = params.shouldContinue ?? (() => true);
    if (!shouldContinue()) return;

    const request = params.request ?? serverFetch;
    const response = await request('/v1/account/profile', {
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
function readAccountSettingsProjectionFromStore(): Readonly<{
    settings: unknown;
    scope: AccountSettingsScope | null;
}> {
    try {
        const { storage } = require('@/sync/domains/state/storageStore') as typeof import('@/sync/domains/state/storageStore');
        const state = storage.getState();
        return { settings: state.settings, scope: state.settingsScope };
    } catch {
        return { settings: null, scope: null };
    }
}

/** This device's own notification settings, read through the same non-load-bearing seam. */
function readLocalSettingsFromStore(): unknown {
    try {
        const { storage } = require('@/sync/domains/state/storageStore') as typeof import('@/sync/domains/state/storageStore');
        return storage.getState().localSettings;
    } catch {
        return null;
    }
}

type HomePushTransportProfile = Pick<ServerProfile,
    | 'serverUrl'
    | 'canonicalServerUrl'
    | 'publicServerUrl'
    | 'serverIdentityId'
    | 'homeConnectionDescriptor'
>;

async function deletePushTokenThroughHomeTransport(params: Readonly<{
    credentials: AuthCredentials;
    token: string;
    transport: Awaited<ReturnType<typeof resolveServerScopedTransport>>;
}>): Promise<boolean> {
    try {
        await deletePushTokenApi(params.credentials, params.token, {
            apiEndpoint: params.transport.canonicalServerUrl,
            runtimeOrigin: params.transport.runtimeOrigin,
        });
        return true;
    } catch {
        return false;
    }
}

export async function unregisterPushTokenForHomeBestEffort(params: Readonly<{
    credentials: AuthCredentials;
    token: string | null | undefined;
    serverUrl: string;
    profile?: HomePushTransportProfile;
}>): Promise<boolean> {
    const token = String(params.token ?? '').trim();
    const serverUrl = String(params.serverUrl ?? '').trim();
    if (!token || !serverUrl) return true;
    const transport = await resolveServerScopedTransport({
        profile: params.profile ?? { serverUrl },
        credentials: params.credentials,
    }).catch(() => null);
    if (!transport) return false;
    try {
        return await deletePushTokenThroughHomeTransport({
            credentials: params.credentials,
            token,
            transport,
        });
    } finally {
        await transport.release().catch(() => undefined);
    }
}

export async function registerPushTokenIfAvailable(params: {
    credentials?: AuthCredentials | null;
    log: { log: (message: string) => void };
    getAccountSettings?: () => unknown;
    getLocalSettings?: () => unknown;
    getHomeAccountSettings?: (
        home: HomeNotificationSettingsTarget,
        credentials: AuthCredentials,
    ) => Promise<unknown | null | undefined>;
}): Promise<void> {
    const { log } = params;
    if (Platform.OS === 'web') return;

    const readAccountSettingsProjection = params.getAccountSettings
        ? () => ({ settings: params.getAccountSettings?.(), scope: null })
        : readAccountSettingsProjectionFromStore;
    const readLocalSettings = params.getLocalSettings ?? readLocalSettingsFromStore;
    const getHomeAccountSettings = params.getHomeAccountSettings ?? fetchHomeNotificationSettings;
    const permission = await readPushPermission();
    if (!permission.ok) {
        log.log(`Push notification runtime unavailable (${permission.reason}); skipping push token registration`);
        return;
    }
    if (!permission.permission.granted) {
        clearActivityNotificationContext();
        const tokens = loadExpoPushTokensToUnregister();
        let cleanupFailed = false;
        const profiles = listServerProfiles();
        let allHomesReachable = profiles.length > 0;
        for (const profile of profiles) {
            const profileScopeId = resolveServerProfileScopeId(profile);
            const serverCredentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, {
                serverId: profileScopeId,
            }).catch(() => null);
            if (!serverCredentials) {
                allHomesReachable = false;
                continue;
            }
            for (const token of tokens) {
                const cleaned = await unregisterPushTokenForHomeBestEffort({
                    credentials: serverCredentials,
                    token,
                    serverUrl: profile.serverUrl,
                    profile,
                });
                cleanupFailed = cleanupFailed || !cleaned;
            }
        }
        if (tokens.length > 0 && allHomesReachable && !cleanupFailed) clearLastRegisteredExpoPushToken();
        log.log(`Push notification permission not granted (${permission.permission.status}); remote registrations withdrawn where reachable`);
        return;
    }
    const tokenOutcome = await readExpoPushToken();
    if (!tokenOutcome.ok) {
        log.log(`Unable to read an Expo push token (${tokenOutcome.reason}); skipping push token registration`);
        return;
    }

    try {
        const profiles = listServerProfiles();
        const token = tokenOutcome.token;
        const previousState = loadRegisteredExpoPushTokenState();
        if (previousState.current && previousState.current !== token) {
            clearActivityNotificationContext();
        }
        const cleanupPendingToken = previousState.current && previousState.current !== token
            ? previousState.current
            : previousState.cleanupPending;
        saveExpoPushTokenGeneration({ current: token, cleanupPending: cleanupPendingToken });

        let activeServerId: string | null = null;
        try {
            const activeServer = getActiveServerSnapshot();
            activeServerId = String(activeServer.serverId ?? '').trim() || null;
        } catch {
            activeServerId = null;
        }

        let didRegisterAnyServer = false;
        let didEnabledRegistrationFail = false;
        let didTokenCleanupFail = false;
        let didProcessAnyHome = false;

        const reconciliationResults = await Promise.allSettled(profiles.map(async (profile) => {
            const profileScopeId = resolveServerProfileScopeId(profile);
            const isActiveProfile = activeServerId !== null
                && areServerProfileIdentifiersEquivalent(profileScopeId, activeServerId);
            const serverCredentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, {
                serverId: profileScopeId,
            }).catch(() => null);
            if (!serverCredentials) return;
            didProcessAnyHome = true;

            let settingsScope: AccountSettingsScope | null = null;
            try {
                settingsScope = createAccountSettingsScope(profileScopeId, parseToken(serverCredentials.token));
            } catch {
                settingsScope = null;
            }
            const readScopedActiveAccountSettings = (expectedScope: AccountSettingsScope | null): unknown | undefined => {
                const projection = readAccountSettingsProjection();
                // Explicit test callers predate scoped storage and supply the
                // focused Home projection directly. Production projections are
                // admitted only with the exact Home+Account scope.
                if (params.getAccountSettings) return isActiveProfile ? projection.settings : undefined;
                return expectedScope && areAccountSettingsScopesEqual(projection.scope, expectedScope)
                    ? projection.settings
                    : undefined;
            };

            const transport = await resolveServerScopedTransport({ profile, credentials: serverCredentials }).catch(() => null);
            if (!transport) {
                didEnabledRegistrationFail = true;
                return;
            }
            try {
                // Focused settings include the user's synchronous local write even while its
                // server flush is pending. Other Homes have no active local writer, so they
                // continue through their explicit scoped read/cache owner.
                let homeSettings: unknown = readScopedActiveAccountSettings(settingsScope);
                if (!isActiveProfile || homeSettings == null) {
                    try {
                        homeSettings = await getHomeAccountSettings({
                            id: profile.id,
                            serverUrl: transport.canonicalServerUrl,
                            serverIdentityId: profile.serverIdentityId,
                            legacyServerIds: profile.legacyServerIds,
                            runtimeOrigin: transport.runtimeOrigin,
                        }, serverCredentials);
                    } catch {
                        homeSettings = undefined;
                    }
                }
                if (homeSettings == null) {
                    homeSettings = readScopedActiveAccountSettings(settingsScope);
                    if (homeSettings == null) {
                        // An unavailable live read with no exact scoped projection
                        // is not permission. Leave any existing registration alone,
                        // retain cleanup custody, and continue the other Homes.
                        didEnabledRegistrationFail = true;
                        log.log(`Push notification consent unavailable for Home ${profile.serverUrl}; skipping this reconciliation cycle`);
                        return;
                    }
                }

                if (!isExpoPushNotificationChannelEnabled(homeSettings)) {
                    log.log(`Push notifications disabled for Home ${profile.serverUrl}; skipping push token registration`);
                    const cleanedCurrentToken = await deletePushTokenThroughHomeTransport({
                        credentials: serverCredentials,
                        token,
                        transport,
                    });
                    didTokenCleanupFail = didTokenCleanupFail || !cleanedCurrentToken;
                    if (cleanupPendingToken && cleanupPendingToken !== token) {
                        const cleanedPendingToken = await deletePushTokenThroughHomeTransport({
                            credentials: serverCredentials,
                            token: cleanupPendingToken,
                            transport,
                        });
                        didTokenCleanupFail = didTokenCleanupFail || !cleanedPendingToken;
                    }
                    if (settingsScope) {
                        persistHomeRemoteAlertPreparedContext({
                            kind: 'remove',
                            serverId: profileScopeId,
                            accountId: settingsScope.accountId,
                        });
                    }
                    return;
                }

                try {
                    const registrationBasis = {
                        profile,
                        profileScopeId,
                        credentials: serverCredentials,
                        settingsScope,
                        readScopedActiveAccountSettings,
                    };
                    const readCurrentHomeSettings = async (): Promise<unknown | null> => {
                        const activeSettings = readScopedActiveAccountSettings(settingsScope);
                        if (activeSettings != null) return activeSettings;
                        try {
                            return (await getHomeAccountSettings({
                                id: profile.id,
                                serverUrl: transport.canonicalServerUrl,
                                serverIdentityId: profile.serverIdentityId,
                                legacyServerIds: profile.legacyServerIds,
                                runtimeOrigin: transport.runtimeOrigin,
                            }, serverCredentials)) ?? null;
                        } catch {
                            return null;
                        }
                    };
                    if (!await isPushRegistrationStillCurrent({
                        ...registrationBasis,
                        knownAccountSettings: homeSettings,
                    })) return;
                    await registerPushTokenApi(serverCredentials, token, {
                        serverId: profileScopeId,
                        apiEndpoint: transport.canonicalServerUrl,
                        runtimeOrigin: transport.runtimeOrigin,
                        clientServerUrl: transport.canonicalServerUrl,
                        retry: 'none',
                    });
                    const currentHomeSettings = await readCurrentHomeSettings();
                    if (!await isPushRegistrationStillCurrent({
                        ...registrationBasis,
                        knownAccountSettings: currentHomeSettings,
                    })) {
                        // The just-created row is compensatable, but a prior
                        // token may still be registered on this Home. Keep the
                        // device-level cleanup hint until a later cycle can
                        // re-establish exact-Home consent/currentness and
                        // complete every outstanding withdrawal.
                        didEnabledRegistrationFail = true;
                        const compensated = await deletePushTokenThroughHomeTransport({
                            credentials: serverCredentials,
                            token,
                            transport,
                        });
                        didTokenCleanupFail = didTokenCleanupFail || !compensated;
                        return;
                    }
                    didRegisterAnyServer = true;
                    if (cleanupPendingToken && cleanupPendingToken !== token) {
                        const cleanedPendingToken = await deletePushTokenThroughHomeTransport({
                            credentials: serverCredentials,
                            token: cleanupPendingToken,
                            transport,
                        });
                        didTokenCleanupFail = didTokenCleanupFail || !cleanedPendingToken;
                    }
                    // The exact row this cycle just registered is the only row this
                    // device may enroll, and only while its Home consent, credential
                    // and permission are still the ones this cycle decided on.
                    const featureSnapshot = await refreshAuthenticatedServerFeaturesSnapshot({
                        credentials: serverCredentials,
                        serverId: profileScopeId,
                        scopedTransport: transport,
                        // Enrollment advertises a shipped native consumer to this
                        // exact Home. A cached pre-enrollment feature snapshot may
                        // not decide that write after the token registration has
                        // just committed, so re-read the canonical feature owner.
                        force: true,
                    }).catch(() => null);
                    const remoteAlertsEnabled = featureSnapshot?.status === 'ready'
                        && readServerEnabledBit(featureSnapshot.features, 'sessions.following') === true;
                    if (!remoteAlertsEnabled) {
                        if (settingsScope) {
                            persistHomeRemoteAlertPreparedContext({
                                kind: 'remove',
                                serverId: profileScopeId,
                                accountId: settingsScope.accountId,
                            });
                        }
                        return;
                    }
                    await reconcileHomeRemoteAlertEnrollment({
                        credentials: serverCredentials,
                        token,
                        apiEndpoint: transport.canonicalServerUrl,
                        ...(transport.runtimeOrigin ? { runtimeOrigin: transport.runtimeOrigin } : {}),
                        serverId: profileScopeId,
                        accountId: settingsScope?.accountId ?? '',
                        accountSettings: homeSettings,
                        accountConsentKnown: true,
                        localSettings: readLocalSettings(),
                        readCurrentPolicyInputs: async () => {
                            const accountSettings = await readCurrentHomeSettings();
                            if (accountSettings == null) return null;
                            return { accountSettings, localSettings: readLocalSettings() };
                        },
                        scheduleReconciliation: schedulePushTokenReconciliation,
                        isStillCurrent: () => isPushRegistrationStillCurrent({
                            ...registrationBasis,
                            knownAccountSettings: currentHomeSettings,
                        }),
                        log,
                    });
                } catch (error) {
                    didEnabledRegistrationFail = true;
                    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
                    log.log(`Failed to register push token for ${profile.serverUrl}: ${message}`);
                }
            } finally {
                await transport.release().catch(() => undefined);
            }
        }));
        for (let index = 0; index < reconciliationResults.length; index += 1) {
            const result = reconciliationResults[index];
            if (result?.status !== 'rejected') continue;
            didEnabledRegistrationFail = true;
            const message = result.reason instanceof Error
                ? (result.reason.stack ?? result.reason.message)
                : String(result.reason);
            log.log(`Failed to reconcile push token for ${profiles[index]?.serverUrl ?? 'unknown Home'}: ${message}`);
        }

        if (didProcessAnyHome && !didEnabledRegistrationFail && !didTokenCleanupFail) {
            saveLastRegisteredExpoPushToken(token);
        }
        log.log(didRegisterAnyServer
            ? 'Push token registered successfully'
            : 'Failed to register push token: no Home registration succeeded');
    } catch (error) {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        log.log('Failed to register push token: ' + message);
    }
}

let devicePushReconcilerStarted = false;
let devicePushReconcileTimer: ReturnType<typeof setTimeout> | null = null;
let devicePushReconcileInFlight = false;
let devicePushReconcileAgain = false;
let expoPushTokenChangeUnsubscribe: (() => void) | null = null;
let expoPushTokenChangeSubscriptionStart: Promise<void> | null = null;

function ensureExpoPushTokenChangeSubscription(): void {
    if (expoPushTokenChangeUnsubscribe || expoPushTokenChangeSubscriptionStart) return;
    expoPushTokenChangeSubscriptionStart = subscribeExpoPushTokenChanges(() => {
        // The event payload is not registration authority. Re-read permission and
        // the current Expo token through the canonical reconciler.
        schedulePushTokenReconciliation();
    }).then((unsubscribe) => {
        if (!unsubscribe) return;
        if (!devicePushReconcilerStarted) {
            unsubscribe();
            return;
        }
        expoPushTokenChangeUnsubscribe = unsubscribe;
    }).catch(() => undefined).finally(() => {
        expoPushTokenChangeSubscriptionStart = null;
    });
}

async function runDevicePushTokenReconciliation(): Promise<void> {
    if (!devicePushReconcilerStarted || devicePushReconcileInFlight) return;
    devicePushReconcileInFlight = true;
    try {
        if (!__DEV__ || config.enableDevPushTokenRegistration === true) {
            await registerPushTokenIfAvailable({ credentials: null, log: appLog });
        }
    } catch (error) {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        appLog.log(`Failed to reconcile device push registration: ${message}`);
    } finally {
        devicePushReconcileInFlight = false;
        if (devicePushReconcilerStarted && devicePushReconcileAgain) {
            devicePushReconcileAgain = false;
            schedulePushTokenReconciliation();
        }
    }
}

export function startPushTokenReconciliation(): void {
    devicePushReconcilerStarted = true;
    ensureExpoPushTokenChangeSubscription();
}

export function stopPushTokenReconciliation(): void {
    devicePushReconcilerStarted = false;
    devicePushReconcileAgain = false;
    if (devicePushReconcileTimer) {
        clearTimeout(devicePushReconcileTimer);
        devicePushReconcileTimer = null;
    }
    expoPushTokenChangeUnsubscribe?.();
    expoPushTokenChangeUnsubscribe = null;
}

export function schedulePushTokenReconciliation(): void {
    if (!devicePushReconcilerStarted) return;
    if (devicePushReconcileInFlight) {
        devicePushReconcileAgain = true;
        return;
    }
    if (devicePushReconcileTimer) return;
    devicePushReconcileTimer = setTimeout(() => {
        devicePushReconcileTimer = null;
        void runDevicePushTokenReconciliation();
    }, 0);
}

// Device and persisted Account privacy/quiet-hours mutations invalidate prepared
// native context before they reach these subscribers, then re-enter the one
// existing push enrollment reconciler. Its in-flight/rerun state coalesces
// bursts; these signals own no timer or enrollment state.
subscribeLocalAttentionSettingsMutations(schedulePushTokenReconciliation);
subscribeAccountSettingsPersistenceMutations(schedulePushTokenReconciliation);
