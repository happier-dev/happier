import * as React from 'react';

import { getAuthProvider } from '@/auth/providers/registry';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import {
    getCachedServerFeaturesSnapshot,
    getServerFeaturesSnapshot,
    subscribeServerFeaturesSnapshot,
    type ServerFeaturesSnapshot,
} from '@/sync/api/capabilities/serverFeaturesClient';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { t } from '@/text';
import { getServerRetentionPolicy } from '@/sync/api/capabilities/serverRetentionPolicyClient';
import { formatServerRetentionDisclosure } from '@/sync/domains/server/retention/formatServerRetentionPolicy';

type AuthEntryServerAvailability = 'loading' | 'ready' | 'legacy' | 'unavailable' | 'incompatible';

type AuthMethodActionMode = 'keyed' | 'keyless' | 'either';

type AuthMethodAction = Readonly<{
    id: 'login' | 'provision';
    enabled: boolean;
    mode: AuthMethodActionMode;
}>;

type AuthMethod = Readonly<{
    id: string;
    actions?: readonly AuthMethodAction[];
}>;

export type AuthEntryPrimaryAction = Readonly<{
    kind: 'anonymous' | 'provider-keyed' | 'mtls' | 'keyless';
    title: string;
}>;

export type AuthEntryOptions = Readonly<{
    serverAvailability: AuthEntryServerAvailability;
    serverUrlForCopy: string;
    showAuthActions: boolean;
    showProviderSignup: boolean;
    showAnonymousSignup: boolean;
    showMtlsLogin: boolean;
    showKeylessProviderLogin: boolean;
    providerId: string | null;
    keylessProviderId: string | null;
    providerSignupTitle: string;
    providerKeylessTitle: string;
    anonymousSignupTitle: string;
    mtlsTitle: string;
    primaryAction: AuthEntryPrimaryAction | null;
    mtlsPrimary: boolean;
    keylessPrimary: boolean;
    retentionSummary?: string | null;
    autoRedirect: Readonly<{
        enabled: boolean;
        providerId: string | null;
        toKeyedProvision: boolean;
        toKeylessLogin: boolean;
        toMtls: boolean;
        toLegacySignupProvider: boolean;
    }>;
    retryServerCheck: () => void;
}>;

const DEFAULT_WELCOME_SERVER_CHECK_TIMEOUT_MS = 6_000;
const DEFAULT_WELCOME_SERVER_CHECK_RETRY_DELAY_MS = 1_000;

function readWelcomeServerCheckTimeoutMs(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_WELCOME_SERVER_CHECK_TIMEOUT_MS ?? '').trim();
    if (!raw) return DEFAULT_WELCOME_SERVER_CHECK_TIMEOUT_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_WELCOME_SERVER_CHECK_TIMEOUT_MS;
    return Math.max(1_000, Math.min(30_000, parsed));
}

function readWelcomeServerCheckRetryDelayMs(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_WELCOME_SERVER_CHECK_RETRY_DELAY_MS ?? '').trim();
    if (!raw) return DEFAULT_WELCOME_SERVER_CHECK_RETRY_DELAY_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_WELCOME_SERVER_CHECK_RETRY_DELAY_MS;
    return Math.max(1, Math.min(10_000, parsed));
}

function normalizeProviderId(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
}

function hasEnabledAction(
    method: AuthMethod | null,
    actionId: 'login' | 'provision',
    modes: readonly AuthMethodActionMode[],
): boolean {
    const actions = Array.isArray(method?.actions) ? method.actions : [];
    return actions.some((action) => action?.enabled === true && action.id === actionId && modes.includes(action.mode));
}

function resolveMethodById(methods: readonly AuthMethod[], providerId: string): AuthMethod | null {
    const normalized = normalizeProviderId(providerId);
    if (!normalized) return null;
    return methods.find((method) => normalizeProviderId(method.id) === normalized) ?? null;
}

export function useAuthEntryOptions(): AuthEntryOptions {
    const activeServerSnapshot = useActiveServerSnapshot();
    const cachedServerFeaturesSnapshot = React.useSyncExternalStore(
        subscribeServerFeaturesSnapshot,
        getCachedServerFeaturesSnapshot,
        getCachedServerFeaturesSnapshot,
    );
    const [serverAvailability, setServerAvailability] = React.useState<AuthEntryServerAvailability>('loading');
    const [serverCheckNonce, setServerCheckNonce] = React.useState(0);
    const [serverFeaturesRecoveryNonce, setServerFeaturesRecoveryNonce] = React.useState(0);
    const consumedForcedServerCheckNonceRef = React.useRef(0);
    const consumedRecoveredServerFeaturesSnapshotRef = React.useRef<ServerFeaturesSnapshot | null>(null);
    const [options, setOptions] = React.useState<Pick<
        AuthEntryOptions,
        | 'showAuthActions'
        | 'showProviderSignup'
        | 'showAnonymousSignup'
        | 'showMtlsLogin'
        | 'showKeylessProviderLogin'
        | 'providerId'
        | 'keylessProviderId'
        | 'providerSignupTitle'
        | 'providerKeylessTitle'
        | 'anonymousSignupTitle'
        | 'mtlsTitle'
        | 'primaryAction'
        | 'mtlsPrimary'
        | 'keylessPrimary'
        | 'retentionSummary'
        | 'autoRedirect'
    >>({
        showAuthActions: false,
        showProviderSignup: false,
        showAnonymousSignup: false,
        showMtlsLogin: false,
        showKeylessProviderLogin: false,
        providerId: null,
        keylessProviderId: null,
        providerSignupTitle: '',
        providerKeylessTitle: '',
        anonymousSignupTitle: t('welcome.createAccount'),
        mtlsTitle: t('welcome.signInWithCertificate'),
        primaryAction: null,
        mtlsPrimary: false,
        keylessPrimary: false,
        retentionSummary: null,
        autoRedirect: {
            enabled: false,
            providerId: null,
            toKeyedProvision: false,
            toKeylessLogin: false,
            toMtls: false,
            toLegacySignupProvider: false,
        },
    });

    const serverUrlForCopy = React.useMemo(() => {
        const raw = activeServerSnapshot?.serverUrl ? String(activeServerSnapshot.serverUrl).trim() : '';
        return raw || t('status.unknown');
    }, [activeServerSnapshot?.serverUrl]);

    const activeServerComparableKey = React.useMemo(
        () => createServerUrlComparableKey(activeServerSnapshot?.serverUrl ?? '') ?? '',
        [activeServerSnapshot?.serverUrl],
    );
    const activeServerGeneration = activeServerSnapshot?.generation ?? 0;

    React.useEffect(() => {
        if (serverAvailability !== 'unavailable') return;
        if (!cachedServerFeaturesSnapshot || cachedServerFeaturesSnapshot.status === 'error') return;
        if (consumedRecoveredServerFeaturesSnapshotRef.current === cachedServerFeaturesSnapshot) return;

        consumedRecoveredServerFeaturesSnapshotRef.current = cachedServerFeaturesSnapshot;
        setServerFeaturesRecoveryNonce((value) => value + 1);
    }, [cachedServerFeaturesSnapshot, serverAvailability]);

    React.useEffect(() => {
        let mounted = true;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        const forceServerCheck = serverCheckNonce > consumedForcedServerCheckNonceRef.current;
        if (forceServerCheck) {
            consumedForcedServerCheckNonceRef.current = serverCheckNonce;
        }

        const scheduleInitialServerCheckRetry = (): boolean => {
            if (serverCheckNonce > 0) return false;
            if (mounted) {
                setServerAvailability('loading');
            }
            retryTimer = setTimeout(() => {
                if (mounted) {
                    setServerCheckNonce((value) => value + 1);
                }
            }, readWelcomeServerCheckRetryDelayMs());
            return true;
        };

        void (async () => {
            try {
                if (mounted) {
                    setServerAvailability('loading');
                    setOptions((prev) => (prev.showAuthActions ? { ...prev, showAuthActions: false } : prev));
                }

                const featuresSnapshot = await getServerFeaturesSnapshot({
                    timeoutMs: readWelcomeServerCheckTimeoutMs(),
                    // A retry nonce grants one forced revalidation. Keeping force
                    // sticky after the retry succeeds turns an identity update into
                    // a request loop: the response advances the active generation,
                    // this effect re-runs, and another forced response advances it
                    // again. Generation-only rechecks consume the canonical cache.
                    force: forceServerCheck,
                });

                if (featuresSnapshot.status === 'error') {
                    if (scheduleInitialServerCheckRetry()) return;
                    if (mounted) {
                        setOptions((prev) => (prev.showAuthActions ? { ...prev, showAuthActions: false } : prev));
                        setServerAvailability('unavailable');
                    }
                    return;
                }

                if (featuresSnapshot.status === 'unsupported' && featuresSnapshot.reason === 'invalid_payload') {
                    if (mounted) {
                        setOptions((prev) => (prev.showAuthActions ? { ...prev, showAuthActions: false } : prev));
                        setServerAvailability('incompatible');
                    }
                    return;
                }

                const features = featuresSnapshot.status === 'ready' ? featuresSnapshot.features : null;
                const authMethodsRaw = features?.capabilities?.auth?.methods ?? [];
                const authMethods = Array.isArray(authMethodsRaw) ? (authMethodsRaw as readonly AuthMethod[]) : [];

                const legacySignupMethods = features?.capabilities?.auth?.signup?.methods ?? [];
                const legacyEnabledSignupIds = legacySignupMethods
                    .filter((method) => method.enabled === true)
                    .map((method) => normalizeProviderId(method.id))
                    .filter(Boolean);

                const legacyLoginMethods = features?.capabilities?.auth?.login?.methods ?? [];
                const legacyEnabledLoginIds = legacyLoginMethods
                    .filter((method) => method.enabled === true)
                    .map((method) => normalizeProviderId(method.id))
                    .filter(Boolean);

                const anonymousEnabled = authMethods.length > 0
                    ? hasEnabledAction(resolveMethodById(authMethods, 'key_challenge'), 'provision', ['keyed', 'either'])
                    : legacyEnabledSignupIds.includes('anonymous');

                const keyedProvisionProviderIds = authMethods.length > 0
                    ? authMethods
                        .map((method) => normalizeProviderId(method.id))
                        .filter(Boolean)
                        .filter((id) => id !== 'key_challenge' && id !== 'mtls')
                        .filter((id) => hasEnabledAction(resolveMethodById(authMethods, id), 'provision', ['keyed', 'either']))
                    : legacyEnabledSignupIds.filter((id) => id !== 'anonymous');

                const keylessLoginMethodIds = authMethods.length > 0
                    ? authMethods
                        .map((method) => normalizeProviderId(method.id))
                        .filter(Boolean)
                        .filter((id) => id !== 'key_challenge')
                        .filter((id) => hasEnabledAction(resolveMethodById(authMethods, id), 'login', ['keyless', 'either']))
                    : legacyEnabledLoginIds.filter((id) => id !== 'key_challenge');

                const mtlsEnabled = keylessLoginMethodIds.includes('mtls');
                const keylessProviderIds = keylessLoginMethodIds.filter((id) => id !== 'mtls');

                if (!authMethods.length && legacyEnabledSignupIds.length === 0 && legacyEnabledLoginIds.length === 0) {
                    if (mounted) {
                        setOptions({
                            showAuthActions: true,
                            showProviderSignup: false,
                            showAnonymousSignup: true,
                            showMtlsLogin: false,
                            showKeylessProviderLogin: false,
                            providerId: null,
                            keylessProviderId: null,
                            providerSignupTitle: '',
                            providerKeylessTitle: '',
                            anonymousSignupTitle: t('welcome.createAccount'),
                            mtlsTitle: t('welcome.signInWithCertificate'),
                            primaryAction: {
                                kind: 'anonymous',
                                title: t('welcome.createAccount'),
                            },
                            mtlsPrimary: false,
                            keylessPrimary: false,
                            autoRedirect: {
                                enabled: false,
                                providerId: null,
                                toKeyedProvision: false,
                                toKeylessLogin: false,
                                toMtls: false,
                                toLegacySignupProvider: false,
                            },
                        });
                        setServerAvailability('legacy');
                    }
                    return;
                }

                const configuredProviderId =
                    keyedProvisionProviderIds.find((id) => features?.capabilities?.oauth?.providers?.[id]?.configured === true) ?? null;
                const preferredProviderId = configuredProviderId ?? keyedProvisionProviderIds[0] ?? null;

                const configuredKeylessProviderId =
                    keylessProviderIds.find((id) => features?.capabilities?.oauth?.providers?.[id]?.configured === true) ?? null;
                const preferredKeylessProviderId = configuredKeylessProviderId ?? keylessProviderIds[0] ?? null;

                const providerSignupTitle = preferredProviderId
                    ? t('welcome.signUpWithProvider', {
                        provider: getAuthProvider(preferredProviderId)?.displayName ?? preferredProviderId,
                    })
                    : '';
                const providerKeylessTitle = preferredKeylessProviderId
                    ? t('welcome.signUpWithProvider', {
                        provider: getAuthProvider(preferredKeylessProviderId)?.displayName ?? preferredKeylessProviderId,
                    })
                    : '';
                const anonymousSignupTitle = t('welcome.createAccount');
                const mtlsTitle = t('welcome.signInWithCertificate');

                const mtlsPrimary = mtlsEnabled && !preferredProviderId && !anonymousEnabled;
                const keylessPrimary = Boolean(preferredKeylessProviderId) && preferredKeylessProviderId !== preferredProviderId && !anonymousEnabled && !mtlsEnabled;
                const primaryAction: AuthEntryPrimaryAction | null = mtlsPrimary
                    ? { kind: 'mtls', title: mtlsTitle }
                    : keylessPrimary
                        ? { kind: 'keyless', title: providerKeylessTitle }
                        : preferredProviderId
                            ? { kind: 'provider-keyed', title: providerSignupTitle }
                            : anonymousEnabled
                                ? { kind: 'anonymous', title: anonymousSignupTitle }
                                : null;

                const autoRedirect = features?.capabilities?.auth?.ui?.autoRedirect ?? null;
                const autoRedirectProviderId = normalizeProviderId(autoRedirect?.providerId);
                const methodForAutoRedirect = autoRedirectProviderId && authMethods.length > 0
                    ? resolveMethodById(authMethods, autoRedirectProviderId)
                    : null;
                const autoRedirectToKeyedProvision = authMethods.length > 0 && hasEnabledAction(methodForAutoRedirect, 'provision', ['keyed', 'either']);
                const autoRedirectToKeylessLogin = authMethods.length > 0 && hasEnabledAction(methodForAutoRedirect, 'login', ['keyless', 'either']);
                const autoRedirectToMtls = autoRedirectProviderId === 'mtls' && mtlsEnabled;
                const autoRedirectToLegacySignupProvider =
                    authMethods.length === 0 && autoRedirectProviderId.length > 0 && legacyEnabledSignupIds.includes(autoRedirectProviderId);

                if (mounted) {
                    setOptions({
                        showAuthActions: true,
                        showProviderSignup: Boolean(preferredProviderId),
                        showAnonymousSignup: anonymousEnabled,
                        showMtlsLogin: mtlsEnabled,
                        showKeylessProviderLogin: Boolean(preferredKeylessProviderId) && preferredKeylessProviderId !== preferredProviderId,
                        providerId: preferredProviderId,
                        keylessProviderId: preferredKeylessProviderId,
                        providerSignupTitle,
                        providerKeylessTitle,
                        anonymousSignupTitle,
                        mtlsTitle,
                        primaryAction,
                        mtlsPrimary,
                        keylessPrimary,
                        retentionSummary: null,
                        autoRedirect: {
                            enabled: autoRedirect?.enabled === true && Boolean(autoRedirectProviderId),
                            providerId: autoRedirectProviderId || null,
                            toKeyedProvision: autoRedirectToKeyedProvision,
                            toKeylessLogin: autoRedirectToKeylessLogin,
                            toMtls: autoRedirectToMtls,
                            toLegacySignupProvider: autoRedirectToLegacySignupProvider,
                        },
                    });
                    setServerAvailability('ready');
                    void getServerRetentionPolicy({ serverId: activeServerSnapshot.serverId }).then((retentionPolicy) => {
                        if (!mounted) return;
                        const retentionSummary = formatServerRetentionDisclosure(retentionPolicy);
                        setOptions((current) => current.retentionSummary === retentionSummary
                            ? current
                            : { ...current, retentionSummary });
                    });
                }
            } catch {
                if (scheduleInitialServerCheckRetry()) return;
                if (mounted) {
                    setOptions((prev) => (prev.showAuthActions ? { ...prev, showAuthActions: false } : prev));
                    setServerAvailability('unavailable');
                }
            }
        })();

        return () => {
            mounted = false;
            if (retryTimer) {
                clearTimeout(retryTimer);
            }
        };
    // A server lifecycle can leave and restore the same canonical URL (the
    // onboarding demo relay is one example) while invalidating the feature
    // snapshot for that server. URL equality alone would retain the previous
    // unavailable result forever. The active-server owner increments generation
    // for that lifecycle transition, so re-run the canonical feature probe.
    }, [activeServerComparableKey, activeServerGeneration, serverCheckNonce, serverFeaturesRecoveryNonce]);

    return {
        serverAvailability,
        serverUrlForCopy,
        ...options,
        retryServerCheck: React.useCallback(() => {
            setServerCheckNonce((value) => value + 1);
        }, []),
    };
}
