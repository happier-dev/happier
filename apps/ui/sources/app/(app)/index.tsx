import { useAuth } from "@/auth/context/AuthContext";
import { View, Platform, Linking } from 'react-native';
import * as React from 'react';
import { encodeBase64 } from "@/encryption/base64";
import { authGetToken, AuthTokenRequestError } from "@/auth/flows/getToken";
import { router, useRouter, useLocalSearchParams } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { getRandomBytesAsync } from "@/platform/cryptoRandom";
import { trackAccountCreated, trackAccountRestored } from '@/track';
import { MainView } from "@/components/navigation/shell/MainView";
import { t } from '@/text';
import { TokenStorage } from "@/auth/storage/tokenStorage";
import sodium from '@/encryption/libsodium.lib';
import { getAuthProvider } from "@/auth/providers/registry";
import { Modal } from "@/modal";
import { getPendingTerminalConnect } from "@/sync/domains/pending/pendingTerminalConnect";
import { isSafeExternalAuthUrl } from "@/auth/providers/externalAuthUrl";
import { fireAndForget } from "@/utils/system/fireAndForget";
import { formatOperationFailedDebugMessage } from "@/utils/errors/formatOperationFailedDebugMessage";
import { getActiveServerSnapshot } from "@/sync/domains/server/serverRuntime";
import { getServerFeaturesSnapshot } from "@/sync/api/capabilities/serverFeaturesClient";
import { getServerRetentionPolicy } from '@/sync/api/capabilities/serverRetentionPolicyClient';
import { formatServerRetentionDisclosure } from '@/sync/domains/server/retention/formatServerRetentionPolicy';
import { buildDataKeyCredentialsForToken } from "@/auth/flows/buildDataKeyCredentialsForToken";
import { digest } from "@/platform/digest";
import { encodeHex } from "@/encryption/hex";
import { resolveAppUrlScheme } from "@/utils/url/appScheme";
import { readConfiguredServerUrlEnv } from "@/sync/domains/server/readConfiguredServerUrlEnv";
import { getPendingSetupIntent, setPendingSetupIntent } from "@/sync/domains/pending/pendingSetupIntent";
import { isTauriDesktop } from "@/utils/platform/tauri";
import { isAuthenticatedRootDeepLinkRedirectAllowed } from "@/auth/routing/isAuthenticatedRootDeepLinkRedirectAllowed";
import { buildScopedSessionRouteHref } from "@/hooks/session/sessionRouteServerScope";
import { RemoteWelcomeDecisionPanel } from "@/components/account/auth/RemoteWelcomeDecisionPanel";
import { UnauthenticatedSplitShell, useApplyBrandHeroSeen } from "@/components/onboarding/unauthShell";
import {
    resolveRemoteAuthCapabilityOptions,
    useRemoteAuthEntryOptions,
    type RemoteLoginOptions,
    type RemoteServerAvailability,
    type RemoteSignupOptions,
} from "@/components/account/auth/useRemoteAuthEntryOptions";

import { shouldAutoRedirectToSetupOnFirstLaunch } from "@/utils/navigation/firstLaunchSetupRedirectPolicy";

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

export default function Home() {
    const auth = useAuth();
    if (!auth.isAuthenticated) {
        return <NotAuthenticated />;
    }
    return (
        <Authenticated />
    )
}

function Authenticated() {
    const params = useLocalSearchParams<{
        id?: string | string[];
        serverId?: string | string[];
        messageId?: string | string[];
        jumpChildId?: string | string[];
    }>();
    const router = useRouter();

    const sessionId = typeof params.id === 'string' ? params.id : Array.isArray(params.id) ? (params.id[0] ?? null) : null;
    const serverId = typeof params.serverId === 'string' ? params.serverId : Array.isArray(params.serverId) ? (params.serverId[0] ?? null) : null;
    const messageId = typeof params.messageId === 'string' ? params.messageId : Array.isArray(params.messageId) ? (params.messageId[0] ?? null) : null;
    const jumpChildId = typeof params.jumpChildId === 'string' ? params.jumpChildId : Array.isArray(params.jumpChildId) ? (params.jumpChildId[0] ?? null) : null;

    React.useEffect(() => {
        const sid = String(sessionId ?? '').trim();
        if (!sid) return;
        if (!isAuthenticatedRootDeepLinkRedirectAllowed()) return;
        const normalizedServerId = String(serverId ?? '').trim() || null;
        const mid = String(messageId ?? '').trim();
        const child = String(jumpChildId ?? '').trim();

        const href = buildScopedSessionRouteHref({
            sessionId: sid,
            serverId: normalizedServerId,
            suffix: mid ? `/message/${encodeURIComponent(mid)}` : '',
            query: child ? { jumpChildId: child } : undefined,
        });
        router.replace(href);
    }, [jumpChildId, messageId, router, serverId, sessionId]);

    React.useEffect(() => {
        const sid = String(sessionId ?? '').trim();
        if (sid) return;
        if (!isAuthenticatedRootDeepLinkRedirectAllowed()) return;
        if (getPendingTerminalConnect()) return;

        const pendingSetupIntent = getPendingSetupIntent();
        if (pendingSetupIntent?.phase !== 'awaiting_auth') {
            return;
        }
        if (!isTauriDesktop()) {
            return;
        }
        router.replace('/setup');
    }, [router, sessionId]);

    return <MainView variant="phone" />;
}

function resolveAuthReturnToRoute(): string {
    const pendingSetupIntent = getPendingSetupIntent();
    return pendingSetupIntent?.phase === 'awaiting_auth' && isTauriDesktop() ? '/setup' : '/';
}

function NotAuthenticated() {
    const auth = useAuth();
    const router = useRouter();
    const isDesktopShell = React.useMemo(() => isTauriDesktop(), []);
    const applyBrandHeroSeen = useApplyBrandHeroSeen();

    const [serverAvailability, setServerAvailability] = React.useState<RemoteServerAvailability>('loading');
    const [serverCheckNonce, setServerCheckNonce] = React.useState(0);
    const [signupOptions, setSignupOptions] = React.useState<RemoteSignupOptions>({
        anonymousEnabled: true,
        providerIds: Object.freeze([]),
        preferredProviderId: null,
    });
    const [loginOptions, setLoginOptions] = React.useState<RemoteLoginOptions>({
        mtlsEnabled: false,
        keylessProviderIds: Object.freeze([]),
        preferredKeylessProviderId: null,
    });
    const [retentionSummary, setRetentionSummary] = React.useState<string | null>(null);
    const autoRedirectAttemptedRef = React.useRef(false);
    const hasPendingTerminalConnect = Boolean(getPendingTerminalConnect());
    const firstLaunchSetupRedirectedRef = React.useRef(false);

    React.useEffect(() => {
        if (firstLaunchSetupRedirectedRef.current) {
            return;
        }
        if (!shouldAutoRedirectToSetupOnFirstLaunch({ platformOs: Platform.OS, isDesktopTauri: isTauriDesktop() })) {
            return;
        }
        const pendingSetupIntent = getPendingSetupIntent();
        if (pendingSetupIntent) {
            return;
        }

        firstLaunchSetupRedirectedRef.current = true;
        const snapshot = getActiveServerSnapshot();
        const relayUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim().replace(/\/+$/, '') : null;
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'pre_auth',
            relayUrl: relayUrl || null,
        });
        router.replace('/setup');
    }, [router]);

    React.useEffect(() => {
        let mounted = true;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        const scheduleInitialServerCheckRetry = (): boolean => {
            if (serverCheckNonce > 0) return false;
            if (mounted) {
                setServerAvailability('loading');
            }
            retryTimer = setTimeout(() => {
                if (mounted) {
                    setServerCheckNonce((v) => v + 1);
                }
            }, readWelcomeServerCheckRetryDelayMs());
            return true;
        };
        fireAndForget((async () => {
            try {
                if (mounted) setServerAvailability('loading');

                const featuresSnapshot = await getServerFeaturesSnapshot({
                    timeoutMs: readWelcomeServerCheckTimeoutMs(),
                    force: serverCheckNonce > 0,
                });
                if (featuresSnapshot.status === 'error') {
                    if (scheduleInitialServerCheckRetry()) return;
                    if (mounted) setServerAvailability('unavailable');
                    return;
                }
                if (featuresSnapshot.status === 'unsupported' && featuresSnapshot.reason === 'invalid_payload') {
                    if (mounted) setServerAvailability('incompatible');
                    return;
                }

                const features = featuresSnapshot.status === 'ready' ? featuresSnapshot.features : null;
                const capabilityOptions = resolveRemoteAuthCapabilityOptions(features);
                if (mounted) {
                    setSignupOptions(capabilityOptions.signupOptions);
                    setLoginOptions(capabilityOptions.loginOptions);
                    setServerAvailability(capabilityOptions.serverAvailability);
                }
                fireAndForget((async () => {
                    const retentionPolicy = await getServerRetentionPolicy();
                    if (mounted) setRetentionSummary(formatServerRetentionDisclosure(retentionPolicy));
                })(), { tag: 'welcome.retentionPolicy' });

                if (
                    !autoRedirectAttemptedRef.current &&
                    capabilityOptions.autoRedirect.enabled &&
                    capabilityOptions.autoRedirect.providerId &&
                    !capabilityOptions.signupOptions.anonymousEnabled &&
                    capabilityOptions.autoRedirect.target
                ) {
                    autoRedirectAttemptedRef.current = true;
                    const suppressedUntil = await TokenStorage.getAuthAutoRedirectSuppressedUntil();
                    if (Date.now() < suppressedUntil) return;
                    if (capabilityOptions.autoRedirect.target === 'mtls') {
                        await loginWithMtls();
                    } else if (capabilityOptions.autoRedirect.target === 'keyless') {
                        await loginWithKeylessProvider(capabilityOptions.autoRedirect.providerId);
                    } else {
                        await createAccountViaProvider(capabilityOptions.autoRedirect.providerId);
                    }
                }
            } catch {
                if (scheduleInitialServerCheckRetry()) return;
                if (mounted) {
                    setServerAvailability('unavailable');
                }
            }
        })(), { tag: "HomeScreen.loadSignupModeAndAutoRedirect" });
        return () => {
            mounted = false;
            if (retryTimer) {
                clearTimeout(retryTimer);
            }
        };
    }, [serverCheckNonce]);

    const createAccount = async () => {
        try {
            const secret = await getRandomBytesAsync(32);
            const token = await authGetToken(secret);
            if (token && secret) {
                await auth.login(token, encodeBase64(secret, 'base64url'));
                trackAccountCreated();
            }
        } catch (error) {
            if (error instanceof AuthTokenRequestError && error.code === 'signup-disabled') {
                await Modal.alert(t('common.error'), t('errors.signupDisabled'));
                return;
            }
            const message = process.env.EXPO_PUBLIC_DEBUG
                ? formatOperationFailedDebugMessage(t('errors.operationFailed'), error)
                : t('errors.operationFailed');
            await Modal.alert(t('common.error'), message);
        }
    }

    const createAccountViaProvider = async (providerId: string) => {
        try {
            const proofBytes = await getRandomBytesAsync(32);
            const proof = encodeBase64(proofBytes, 'base64url');
            const proofHashBytes = await digest('SHA-256', new TextEncoder().encode(proof));
            const proofHash = encodeHex(proofHashBytes).toLowerCase();

            const secretBytes = await getRandomBytesAsync(32);
            const secret = encodeBase64(secretBytes, 'base64url');
            const signingKeyPair = sodium.crypto_sign_seed_keypair(secretBytes);
            const publicKey = encodeBase64(signingKeyPair.publicKey);

            const snapshot = getActiveServerSnapshot();
            const serverUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim() : '';
            await TokenStorage.setPendingExternalAuth({
                provider: providerId,
                proof,
                secret,
                returnTo: resolveAuthReturnToRoute(),
                ...(serverUrl ? { serverUrl } : {}),
            });

            const provider = getAuthProvider(providerId);
            if (!provider) {
                await TokenStorage.clearPendingExternalAuth();
                await Modal.alert(t('common.error'), t('errors.operationFailed'));
                return;
            }

            const url = await provider.getExternalAuthUrl({ mode: 'keyed', proofHash, publicKey });
            if (!isSafeExternalAuthUrl(url)) {
                await TokenStorage.clearPendingExternalAuth();
                await Modal.alert(t('common.error'), t('errors.operationFailed'));
                return;
            }
            if (Platform.OS === 'web') {
                const location = (globalThis as any)?.window?.location;
                if (location && typeof location.assign === 'function') {
                    location.assign(url);
                    return;
                }
                if (location && typeof location.href === 'string') {
                    location.href = url;
                    return;
                }
            }
            await Linking.openURL(url);
        } catch (error) {
            await TokenStorage.clearPendingExternalAuth();
            await Modal.alert(t('common.error'), t('errors.operationFailed'));
        }
    };

    const loginWithKeylessProvider = async (providerId: string) => {
        try {
            const proofBytes = await getRandomBytesAsync(32);
            const proof = encodeBase64(proofBytes, "base64url");
            const proofHashBytes = await digest('SHA-256', new TextEncoder().encode(proof));
            const proofHash = encodeHex(proofHashBytes).toLowerCase();

            const snapshot = getActiveServerSnapshot();
            const serverUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim() : '';
            await TokenStorage.setPendingExternalAuth({
                provider: providerId,
                proof,
                returnTo: resolveAuthReturnToRoute(),
                ...(serverUrl ? { serverUrl } : {}),
            });

            const provider = getAuthProvider(providerId);
            if (!provider) {
                await TokenStorage.clearPendingExternalAuth();
                await Modal.alert(t('common.error'), t('errors.operationFailed'));
                return;
            }

            const url = await provider.getExternalAuthUrl({ mode: 'keyless', proofHash });
            if (!isSafeExternalAuthUrl(url)) {
                await TokenStorage.clearPendingExternalAuth();
                await Modal.alert(t('common.error'), t('errors.operationFailed'));
                return;
            }
            if (Platform.OS === 'web') {
                const location = (globalThis as any)?.window?.location;
                if (location && typeof location.assign === 'function') {
                    location.assign(url);
                    return;
                }
                if (location && typeof location.href === 'string') {
                    location.href = url;
                    return;
                }
            }
            await Linking.openURL(url);
        } catch {
            await TokenStorage.clearPendingExternalAuth();
            await Modal.alert(t('common.error'), t('errors.operationFailed'));
        }
    };

    const loginWithMtls = async () => {
        try {
            const snapshot = getActiveServerSnapshot();
            const rawServerUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim() : "";
            const serverUrl = (rawServerUrl.replace(/\/+$/, "") || readConfiguredServerUrlEnv().replace(/\/+$/, ""));
            if (!serverUrl) {
                await Modal.alert(t('common.error'), t('errors.operationFailed'));
                return;
            }

            if (Platform.OS !== 'web') {
                const returnTo = `${resolveAppUrlScheme()}:///mtls`;
                const startUrl = `${serverUrl}/v1/auth/mtls/start?returnTo=${encodeURIComponent(returnTo)}`;
                await Linking.openURL(startUrl);
                return;
            }

            const controller = new AbortController();
            const timeoutMs = 15000;
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const res = await fetch(`${serverUrl}/v1/auth/mtls`, { method: 'POST', signal: controller.signal });
                const json = await res.json().catch(() => null);
                if (!res.ok || !json || typeof json.token !== 'string') {
                    await Modal.alert(t('common.error'), t('errors.operationFailed'));
                    return;
                }
                const token = String(json.token);
                const credentials = await buildDataKeyCredentialsForToken(token);
                await auth.loginWithCredentials(credentials);
            } finally {
                clearTimeout(timer);
            }
        } catch (error) {
            const message = process.env.EXPO_PUBLIC_DEBUG
                ? formatOperationFailedDebugMessage(t('errors.operationFailed'), error)
                : t('errors.operationFailed');
            await Modal.alert(t('common.error'), message);
        }
    };

    const serverUrlForCopy = (() => {
        const snapshot = getActiveServerSnapshot();
        const raw = snapshot?.serverUrl ? String(snapshot.serverUrl).trim() : '';
        return raw || t('status.unknown');
    })();
    const authEntryOptions = useRemoteAuthEntryOptions({
        serverAvailability,
        serverUrlForCopy,
        retryServerCheck: () => setServerCheckNonce((v) => v + 1),
        signupOptions,
        loginOptions,
        hasPendingTerminalConnect,
        hasPendingSetupIntent: isDesktopShell && getPendingSetupIntent()?.phase === 'awaiting_auth',
    });
    const handleRestore = () => {
        trackAccountRestored();
        router.push('/restore');
    };
    const renderDecisionPanel = () => (
        <RemoteWelcomeDecisionPanel
            options={authEntryOptions}
            layout="portrait"
            isDesktopShell={isDesktopShell}
            onOpenSetup={() => router.push('/setup')}
            onRestore={handleRestore}
            onProviderSignup={createAccountViaProvider}
            onAnonymousSignup={createAccount}
            onMtlsLogin={loginWithMtls}
            onKeylessProviderLogin={loginWithKeylessProvider}
            onChangeRelay={() => router.push('/setup?openCustom=1')}
        />
    );

    return (
        <UnauthenticatedSplitShell
            stepId="welcome"
            isWelcomeStep
            allowMobileBrandHero
            onOpenRelayCustomFlow={() => router.push('/setup?openCustom=1')}
            onBrandHeroGetStarted={applyBrandHeroSeen}
            retentionSummary={retentionSummary}
            testID="unauth-shell-route-welcome"
        >
            <View style={styles.welcomeBody}>
                {renderDecisionPanel()}
            </View>
        </UnauthenticatedSplitShell>
    )
}

const styles = StyleSheet.create((theme) => ({
    // NotAuthenticated styles
    welcomeBody: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
    },
}));
