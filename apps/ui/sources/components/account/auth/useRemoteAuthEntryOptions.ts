import * as React from 'react';

import { getAuthProvider } from '@/auth/providers/registry';
import { t } from '@/text';

import type { FeaturesResponse } from '@happier-dev/protocol';

export type RemoteServerAvailability = 'loading' | 'ready' | 'legacy' | 'unavailable' | 'incompatible';

export type RemoteSignupOptions = Readonly<{
    anonymousEnabled: boolean;
    providerIds: readonly string[];
    preferredProviderId: string | null;
}>;

export type RemoteLoginOptions = Readonly<{
    mtlsEnabled: boolean;
    keylessProviderIds: readonly string[];
    preferredKeylessProviderId: string | null;
}>;

export type RemoteAuthEntryPrimaryKind = 'anonymous' | 'provider-keyed' | 'mtls' | 'keyless';
export type RemoteAuthEntryPrimaryAction = Readonly<{
    kind: RemoteAuthEntryPrimaryKind;
    title: string;
}>;

export type RemoteAuthCapabilityOptions = Readonly<{
    signupOptions: RemoteSignupOptions;
    loginOptions: RemoteLoginOptions;
    serverAvailability: 'ready' | 'legacy';
    autoRedirect: Readonly<{
        enabled: boolean;
        providerId: string | null;
        target: 'provider-keyed' | 'mtls' | 'keyless' | null;
    }>;
}>;

export type RemoteAuthEntryOptionsInput = Readonly<{
    serverAvailability: RemoteServerAvailability;
    serverUrlForCopy: string;
    retryServerCheck: () => void;
    signupOptions: RemoteSignupOptions;
    loginOptions: RemoteLoginOptions;
    providerDisplayNameById?: (providerId: string) => string;
    hasPendingTerminalConnect: boolean;
    hasPendingSetupIntent: boolean;
}>;

export type RemoteAuthEntryOptions = Readonly<{
    serverAvailability: RemoteServerAvailability;
    serverUrlForCopy: string;
    retryServerCheck: () => void;
    showAnonymousSignup: boolean;
    showProviderSignup: boolean;
    providerId: string | null;
    providerSignupTitle: string;
    showMtlsLogin: boolean;
    mtlsPrimary: boolean;
    mtlsTitle: string;
    showKeylessProviderLogin: boolean;
    keylessProviderId: string | null;
    keylessPrimary: boolean;
    providerKeylessTitle: string;
    anonymousSignupTitle: string;
    primaryAction: RemoteAuthEntryPrimaryAction | null;
    showTerminalConnectIntent: boolean;
    showSetupIntent: boolean;
    showAuthActions: boolean;
}>;

type AuthActionId = 'login' | 'provision';
type AuthActionMode = 'keyed' | 'keyless' | 'either';

function readRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readMethodId(method: unknown): string {
    const record = readRecord(method);
    return String(record?.id ?? '').trim().toLowerCase();
}

function resolveMethodById(authMethods: readonly unknown[], id: string): unknown | null {
    return authMethods.find((method) => readMethodId(method) === id) ?? null;
}

function hasEnabledAction(method: unknown, actionId: AuthActionId, modes: readonly AuthActionMode[]): boolean {
    const record = readRecord(method);
    const actions = record ? record.actions : null;
    if (!Array.isArray(actions)) return false;
    return actions.some((action) => {
        const actionRecord = readRecord(action);
        return actionRecord?.enabled === true && actionRecord.id === actionId && modes.includes(actionRecord.mode as AuthActionMode);
    });
}

function readEnabledMethodIds(methods: unknown): string[] {
    if (!Array.isArray(methods)) return [];
    return methods
        .filter((method) => readRecord(method)?.enabled === true)
        .map((method) => String(readRecord(method)?.id ?? '').trim().toLowerCase())
        .filter(Boolean);
}

function isOauthProviderConfigured(features: FeaturesResponse | null, providerId: string): boolean {
    const providers = readRecord(features?.capabilities?.oauth?.providers);
    const provider = providers ? readRecord(providers[providerId]) : null;
    return provider?.configured === true;
}

function normalizeProviderId(providerId: unknown): string | null {
    const normalized = String(providerId ?? '').trim().toLowerCase();
    return normalized || null;
}

function defaultProviderDisplayName(providerId: string): string {
    return getAuthProvider(providerId)?.displayName ?? providerId;
}

export function resolveRemoteAuthCapabilityOptions(features: FeaturesResponse | null): RemoteAuthCapabilityOptions {
    const authMethodsRaw = features?.capabilities?.auth?.methods ?? [];
    const authMethods = Array.isArray(authMethodsRaw) ? authMethodsRaw : [];
    const hasAuthMethods = authMethods.length > 0;

    const legacyEnabledSignupIds = readEnabledMethodIds(features?.capabilities?.auth?.signup?.methods);
    const legacyEnabledLoginIds = readEnabledMethodIds(features?.capabilities?.auth?.login?.methods);

    const anonymousEnabled = hasAuthMethods
        ? hasEnabledAction(resolveMethodById(authMethods, 'key_challenge'), 'provision', ['keyed', 'either'])
        : legacyEnabledSignupIds.includes('anonymous');

    const keyedProvisionProviderIds = hasAuthMethods
        ? authMethods
              .map(readMethodId)
              .filter(Boolean)
              .filter((id) => id !== 'key_challenge' && id !== 'mtls')
              .filter((id) => hasEnabledAction(resolveMethodById(authMethods, id), 'provision', ['keyed', 'either']))
        : legacyEnabledSignupIds.filter((id) => id !== 'anonymous');

    const keylessLoginMethodIds = hasAuthMethods
        ? authMethods
              .map(readMethodId)
              .filter(Boolean)
              .filter((id) => id !== 'key_challenge')
              .filter((id) => hasEnabledAction(resolveMethodById(authMethods, id), 'login', ['keyless', 'either']))
        : legacyEnabledLoginIds.filter((id) => id !== 'key_challenge');

    if (!hasAuthMethods && legacyEnabledSignupIds.length === 0 && legacyEnabledLoginIds.length === 0) {
        return {
            signupOptions: { anonymousEnabled: true, providerIds: Object.freeze([]), preferredProviderId: null },
            loginOptions: { mtlsEnabled: false, keylessProviderIds: Object.freeze([]), preferredKeylessProviderId: null },
            serverAvailability: 'legacy',
            autoRedirect: { enabled: false, providerId: null, target: null },
        };
    }

    const keylessProviderIds = keylessLoginMethodIds.filter((id) => id !== 'mtls');
    const preferredProviderId =
        keyedProvisionProviderIds.find((id) => isOauthProviderConfigured(features, id)) ?? keyedProvisionProviderIds[0] ?? null;
    const preferredKeylessProviderId =
        keylessProviderIds.find((id) => isOauthProviderConfigured(features, id)) ?? keylessProviderIds[0] ?? null;
    const mtlsEnabled = keylessLoginMethodIds.includes('mtls');

    const autoRedirectRaw = features?.capabilities?.auth?.ui?.autoRedirect ?? null;
    const autoRedirectRecord = readRecord(autoRedirectRaw);
    const autoRedirectProviderId = normalizeProviderId(autoRedirectRecord?.providerId);
    const methodForAutoRedirect = autoRedirectProviderId && hasAuthMethods ? resolveMethodById(authMethods, autoRedirectProviderId) : null;
    const autoRedirectToProviderKeyed =
        Boolean(autoRedirectProviderId) && hasAuthMethods && hasEnabledAction(methodForAutoRedirect, 'provision', ['keyed', 'either']);
    const autoRedirectToKeyless =
        Boolean(autoRedirectProviderId) && hasAuthMethods && hasEnabledAction(methodForAutoRedirect, 'login', ['keyless', 'either']);
    const autoRedirectToMtls = autoRedirectProviderId === 'mtls' && mtlsEnabled;
    const autoRedirectToLegacySignupProvider =
        !hasAuthMethods && Boolean(autoRedirectProviderId) && legacyEnabledSignupIds.includes(autoRedirectProviderId!);
    const autoRedirectTarget = autoRedirectToMtls
        ? 'mtls'
        : autoRedirectToKeyless
          ? 'keyless'
          : autoRedirectToProviderKeyed || autoRedirectToLegacySignupProvider
            ? 'provider-keyed'
            : null;

    return {
        signupOptions: {
            anonymousEnabled,
            providerIds: Object.freeze(keyedProvisionProviderIds),
            preferredProviderId,
        },
        loginOptions: {
            mtlsEnabled,
            keylessProviderIds: Object.freeze(keylessProviderIds),
            preferredKeylessProviderId,
        },
        serverAvailability: 'ready',
        autoRedirect: {
            enabled: autoRedirectRecord?.enabled === true,
            providerId: autoRedirectProviderId,
            target: autoRedirectTarget,
        },
    };
}

export function deriveRemoteAuthEntryOptions(input: RemoteAuthEntryOptionsInput): RemoteAuthEntryOptions {
    const providerId = input.signupOptions.preferredProviderId;
    const keylessProviderId = input.loginOptions.preferredKeylessProviderId;
    const displayNameById = input.providerDisplayNameById ?? defaultProviderDisplayName;
    const providerSignupTitle = providerId
        ? t('welcome.signUpWithProvider', { provider: displayNameById(providerId) })
        : '';
    const providerKeylessTitle = keylessProviderId
        ? t('welcome.signUpWithProvider', { provider: displayNameById(keylessProviderId) })
        : '';
    const anonymousSignupTitle = t('welcome.createAccount');
    const mtlsTitle = t('welcome.signInWithCertificate');

    const showProviderSignup = Boolean(providerId);
    const showAnonymousSignup = input.signupOptions.anonymousEnabled;
    const showMtlsLogin = input.loginOptions.mtlsEnabled;
    const showKeylessProviderLogin = Boolean(keylessProviderId) && keylessProviderId !== providerId;
    const mtlsPrimary = showMtlsLogin && !showProviderSignup && !showAnonymousSignup;
    const keylessPrimary = showKeylessProviderLogin && !showProviderSignup && !showAnonymousSignup && !showMtlsLogin;
    const primaryAction: RemoteAuthEntryPrimaryAction | null = mtlsPrimary
        ? { kind: 'mtls', title: mtlsTitle }
        : keylessPrimary
          ? { kind: 'keyless', title: providerKeylessTitle }
          : showProviderSignup
            ? { kind: 'provider-keyed', title: providerSignupTitle }
            : showAnonymousSignup
              ? { kind: 'anonymous', title: anonymousSignupTitle }
              : null;

    return {
        serverAvailability: input.serverAvailability,
        serverUrlForCopy: input.serverUrlForCopy,
        retryServerCheck: input.retryServerCheck,
        showAnonymousSignup,
        showProviderSignup,
        providerId,
        providerSignupTitle,
        showMtlsLogin,
        mtlsPrimary,
        mtlsTitle,
        showKeylessProviderLogin,
        keylessProviderId,
        keylessPrimary,
        providerKeylessTitle,
        anonymousSignupTitle,
        primaryAction,
        showTerminalConnectIntent: input.hasPendingTerminalConnect,
        showSetupIntent: input.hasPendingSetupIntent,
        showAuthActions: input.serverAvailability === 'ready' || input.serverAvailability === 'legacy',
    };
}

export function useRemoteAuthEntryOptions(input: RemoteAuthEntryOptionsInput): RemoteAuthEntryOptions {
    return React.useMemo(
        () => deriveRemoteAuthEntryOptions(input),
        [
            input.hasPendingSetupIntent,
            input.hasPendingTerminalConnect,
            input.loginOptions.keylessProviderIds,
            input.loginOptions.mtlsEnabled,
            input.loginOptions.preferredKeylessProviderId,
            input.providerDisplayNameById,
            input.retryServerCheck,
            input.serverAvailability,
            input.serverUrlForCopy,
            input.signupOptions.anonymousEnabled,
            input.signupOptions.preferredProviderId,
            input.signupOptions.providerIds,
        ],
    );
}
