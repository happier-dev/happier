import { RoundButton } from "@/components/ui/buttons/RoundButton";
import { useAuth } from "@/auth/context/AuthContext";
import { ActivityIndicator, View, Image, Platform, Linking } from 'react-native';
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as React from 'react';
import { encodeBase64 } from "@/encryption/base64";
import { authGetToken } from "@/auth/flows/getToken";
import { router, useRouter } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { getRandomBytesAsync } from "@/platform/cryptoRandom";
import { useIsLandscape } from "@/utils/platform/responsive";
import { Typography } from "@/constants/Typography";
import { trackAccountCreated, trackAccountRestored } from '@/track';
import { HomeHeaderNotAuth } from "@/components/navigation/shell/HomeHeader";
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
import { Text } from '@/components/ui/text/Text';
import { buildDataKeyCredentialsForToken } from "@/auth/flows/buildDataKeyCredentialsForToken";
import { digest } from "@/platform/digest";
import { encodeHex } from "@/encryption/hex";


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
    return <MainView variant="phone" />;
}

function NotAuthenticated() {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const router = useRouter();
    const isLandscape = useIsLandscape();
    const insets = useSafeAreaInsets();

    const [serverAvailability, setServerAvailability] = React.useState<'loading' | 'ready' | 'legacy' | 'unavailable' | 'incompatible'>('loading');
    const [serverCheckNonce, setServerCheckNonce] = React.useState(0);
    const [signupOptions, setSignupOptions] = React.useState<{
        anonymousEnabled: boolean;
        providerIds: readonly string[];
        preferredProviderId: string | null;
    }>({ anonymousEnabled: true, providerIds: Object.freeze([]), preferredProviderId: null });
    const [loginOptions, setLoginOptions] = React.useState<{
        mtlsEnabled: boolean;
        keylessProviderIds: readonly string[];
        preferredKeylessProviderId: string | null;
    }>({ mtlsEnabled: false, keylessProviderIds: Object.freeze([]), preferredKeylessProviderId: null });
    const autoRedirectAttemptedRef = React.useRef(false);
    const hasPendingTerminalConnect = Boolean(getPendingTerminalConnect());

    React.useEffect(() => {
        let mounted = true;
        fireAndForget((async () => {
            try {
                if (mounted) setServerAvailability('loading');

                const featuresSnapshot = await getServerFeaturesSnapshot({ timeoutMs: 1500, force: serverCheckNonce > 0 });
                if (featuresSnapshot.status === 'error') {
                    if (mounted) setServerAvailability('unavailable');
                    return;
                }
                if (featuresSnapshot.status === 'unsupported' && featuresSnapshot.reason === 'invalid_payload') {
                    if (mounted) setServerAvailability('incompatible');
                    return;
                }

                const features = featuresSnapshot.status === 'ready' ? featuresSnapshot.features : null;
                const authMethodsRaw = features?.capabilities?.auth?.methods ?? [];
                const authMethods = Array.isArray(authMethodsRaw) ? authMethodsRaw : [];

                const hasAuthMethods = authMethods.length > 0;

                const legacySignupMethods = features?.capabilities?.auth?.signup?.methods ?? [];
                const legacyEnabledSignupIds = legacySignupMethods
                    .filter((m) => m.enabled === true)
                    .map((m) => String(m.id).trim().toLowerCase())
                    .filter(Boolean);

                const legacyLoginMethods = features?.capabilities?.auth?.login?.methods ?? [];
                const legacyEnabledLoginIds = legacyLoginMethods
                    .filter((m) => m.enabled === true)
                    .map((m) => String(m.id).trim().toLowerCase())
                    .filter(Boolean);

                const resolveMethodById = (id: string): any | null =>
                    authMethods.find((m: any) => String(m?.id ?? '').trim().toLowerCase() === id) ?? null;

                const hasEnabledAction = (
                    method: any | null,
                    actionId: 'login' | 'provision',
                    modes: readonly ('keyed' | 'keyless' | 'either')[],
                ): boolean => {
                    const actions = Array.isArray(method?.actions) ? method.actions : [];
                    return actions.some((a: any) => a?.enabled === true && a?.id === actionId && modes.includes(a?.mode));
                };

                const anonymousEnabled = hasAuthMethods
                    ? hasEnabledAction(resolveMethodById('key_challenge'), 'provision', ['keyed', 'either'])
                    : legacyEnabledSignupIds.includes('anonymous');

                const keyedProvisionProviderIds = hasAuthMethods
                    ? authMethods
                          .map((m: any) => String(m?.id ?? '').trim().toLowerCase())
                          .filter(Boolean)
                          .filter((id: string) => id !== 'key_challenge' && id !== 'mtls')
                          .filter((id: string) => hasEnabledAction(resolveMethodById(id), 'provision', ['keyed', 'either']))
                    : legacyEnabledSignupIds.filter((id) => id !== 'anonymous');

                const keylessLoginMethodIds = hasAuthMethods
                    ? authMethods
                          .map((m: any) => String(m?.id ?? '').trim().toLowerCase())
                          .filter(Boolean)
                          .filter((id: string) => id !== 'key_challenge')
                          .filter((id: string) => hasEnabledAction(resolveMethodById(id), 'login', ['keyless', 'either']))
                    : legacyEnabledLoginIds.filter((id) => id !== 'key_challenge');

                const mtlsEnabled = keylessLoginMethodIds.includes('mtls');
                const keylessProviderIds = keylessLoginMethodIds.filter((id) => id !== 'mtls');

                // Default to legacy behavior (anonymous) when features can't be fetched
                // and the server doesn't advertise any viable auth methods.
                if (!hasAuthMethods && legacyEnabledSignupIds.length === 0 && legacyEnabledLoginIds.length === 0) {
                    if (mounted) {
                        setSignupOptions({ anonymousEnabled: true, providerIds: Object.freeze([]), preferredProviderId: null });
                        setLoginOptions({ mtlsEnabled: false, keylessProviderIds: Object.freeze([]), preferredKeylessProviderId: null });
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
                if (mounted) {
                    setSignupOptions({
                        anonymousEnabled,
                        providerIds: Object.freeze(keyedProvisionProviderIds),
                        preferredProviderId,
                    });
                    setLoginOptions({
                        mtlsEnabled,
                        keylessProviderIds: Object.freeze(keylessProviderIds),
                        preferredKeylessProviderId,
                    });
                    setServerAvailability('ready');
                }

                const autoRedirect = features?.capabilities?.auth?.ui?.autoRedirect ?? null;
                const autoRedirectProviderId = (autoRedirect?.providerId ?? "").trim().toLowerCase();
                const methodForAutoRedirect = hasAuthMethods ? resolveMethodById(autoRedirectProviderId) : null;
                const autoRedirectToKeyedProvision =
                    hasAuthMethods && hasEnabledAction(methodForAutoRedirect, 'provision', ['keyed', 'either']);
                const autoRedirectToKeylessLogin =
                    hasAuthMethods && hasEnabledAction(methodForAutoRedirect, 'login', ['keyless', 'either']);
                const autoRedirectToMtls = autoRedirectProviderId === "mtls" && mtlsEnabled;
                const autoRedirectToLegacySignupProvider =
                    !hasAuthMethods && autoRedirectProviderId && legacyEnabledSignupIds.includes(autoRedirectProviderId);
                if (
                    !autoRedirectAttemptedRef.current &&
                    autoRedirect?.enabled === true &&
                    autoRedirectProviderId &&
                    !anonymousEnabled &&
                    (autoRedirectToMtls || autoRedirectToKeyedProvision || autoRedirectToKeylessLogin || autoRedirectToLegacySignupProvider)
                ) {
                    autoRedirectAttemptedRef.current = true;
                    const suppressedUntil = await TokenStorage.getAuthAutoRedirectSuppressedUntil();
                    if (Date.now() < suppressedUntil) return;
                    if (autoRedirectToMtls) {
                        await loginWithMtls();
                    } else if (autoRedirectToKeylessLogin) {
                        await loginWithKeylessProvider(autoRedirectProviderId);
                    } else {
                        await createAccountViaProvider(autoRedirectProviderId);
                    }
                }
            } catch {
                if (mounted) {
                    setServerAvailability('unavailable');
                }
            }
        })(), { tag: "HomeScreen.loadSignupModeAndAutoRedirect" });
        return () => {
            mounted = false;
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
            const message = process.env.EXPO_PUBLIC_DEBUG
                ? formatOperationFailedDebugMessage(t('errors.operationFailed'), error)
                : t('errors.operationFailed');
            await Modal.alert(t('common.error'), message);
        }
    }

    const createAccountViaProvider = async (providerId: string) => {
        try {
            const secretBytes = await getRandomBytesAsync(32);
            const secret = encodeBase64(secretBytes, "base64url");
            const snapshot = getActiveServerSnapshot();
            const serverUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim() : '';
            await TokenStorage.setPendingExternalAuth({ provider: providerId, secret, returnTo: '/', ...(serverUrl ? { serverUrl } : {}) });

            const kp = sodium.crypto_sign_seed_keypair(secretBytes);
            const publicKey = encodeBase64(kp.publicKey);

            const provider = getAuthProvider(providerId);
            if (!provider) {
                await TokenStorage.clearPendingExternalAuth();
                await Modal.alert(t('common.error'), t('errors.operationFailed'));
                return;
            }

            const url = await provider.getExternalSignupUrl({ publicKey });
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
                mode: 'keyless',
                returnTo: '/',
                ...(serverUrl ? { serverUrl } : {}),
            });

            const provider = getAuthProvider(providerId);
            if (!provider || !provider.getExternalLoginUrl) {
                await TokenStorage.clearPendingExternalAuth();
                await Modal.alert(t('common.error'), t('errors.operationFailed'));
                return;
            }

            const url = await provider.getExternalLoginUrl({ proofHash });
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
            const serverUrl = rawServerUrl.replace(/\/+$/, "");
            if (!serverUrl) {
                await Modal.alert(t('common.error'), t('errors.operationFailed'));
                return;
            }

            if (Platform.OS !== 'web') {
                const returnTo = 'happier:///mtls';
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

    const providerId = signupOptions.preferredProviderId;
    const keylessProviderId = loginOptions.preferredKeylessProviderId;
    const providerSignupTitle = providerId
        ? t("welcome.signUpWithProvider", {
              provider: getAuthProvider(providerId)?.displayName ?? providerId,
          })
        : "";
    const providerKeylessTitle = keylessProviderId
        ? t("welcome.signUpWithProvider", {
              provider: getAuthProvider(keylessProviderId)?.displayName ?? keylessProviderId,
          })
        : "";
    const anonymousSignupTitle = t("welcome.createAccount");

    const showProviderSignup = Boolean(providerId);
    const showAnonymousSignup = signupOptions.anonymousEnabled;
    const showMtlsLogin = loginOptions.mtlsEnabled;
    const showKeylessProviderLogin = Boolean(keylessProviderId) && keylessProviderId !== providerId;
    const mtlsTitle = t('welcome.signInWithCertificate');

    const mtlsPrimary = showMtlsLogin && !showProviderSignup && !showAnonymousSignup;
    const keylessPrimary = showKeylessProviderLogin && !showProviderSignup && !showAnonymousSignup && !showMtlsLogin;
    const primarySignupTitle = mtlsPrimary
        ? mtlsTitle
        : keylessPrimary
          ? providerKeylessTitle
          : showProviderSignup
            ? providerSignupTitle
            : anonymousSignupTitle;
    const primarySignupAction = mtlsPrimary
        ? loginWithMtls
        : keylessPrimary
          ? () => loginWithKeylessProvider(keylessProviderId!)
          : showProviderSignup
            ? () => createAccountViaProvider(providerId!)
            : createAccount;
    const terminalConnectIntentBlock = hasPendingTerminalConnect ? (
        <View testID="welcome-terminal-connect-intent" style={styles.intentBlock}>
            <Text style={styles.intentTitle}>{t('terminal.connectTerminal')}</Text>
            <Text style={styles.intentBody}>{t('modals.pleaseSignInFirst')}</Text>
        </View>
    ) : null;

    const showAuthActions = serverAvailability === 'ready' || serverAvailability === 'legacy';

    const serverUrlForCopy = (() => {
        const snapshot = getActiveServerSnapshot();
        const raw = snapshot?.serverUrl ? String(snapshot.serverUrl).trim() : '';
        return raw || t('status.unknown');
    })();

    const serverBlockedActions = (
        <>
            <View testID="welcome-server-unavailable" style={styles.serverUnavailableBlock}>
                <Text style={styles.serverUnavailableTitle}>
                    {serverAvailability === 'incompatible' ? t('welcome.serverIncompatibleTitle') : t('welcome.serverUnavailableTitle')}
                </Text>
                <Text style={styles.serverUnavailableBody}>
                    {serverAvailability === 'incompatible'
                        ? t('welcome.serverIncompatibleBody', { serverUrl: serverUrlForCopy })
                        : t('welcome.serverUnavailableBody', { serverUrl: serverUrlForCopy })}
                </Text>
            </View>
            <View style={styles.buttonContainer}>
                <RoundButton
                    testID="welcome-retry-server"
                    title={t('common.retry')}
                    onPress={() => setServerCheckNonce((v) => v + 1)}
                />
            </View>
            <View style={styles.buttonContainerSecondary}>
                <RoundButton
                    testID="welcome-configure-server"
                    size="normal"
                    title={t('server.changeServer')}
                    onPress={() => router.push('/server')}
                    display="inverted"
                />
            </View>
        </>
    );

    const serverLoadingActions = (
        <View style={styles.serverLoadingBlock}>
            <ActivityIndicator />
            <Text style={styles.serverLoadingText}>{t('common.loading')}</Text>
        </View>
    );

    const portraitLayout = (
        <View style={styles.portraitContainer}>
            <Image
                source={theme.dark ? require('@/assets/images/logotype-light.png') : require('@/assets/images/logotype-dark.png')}
                resizeMode="contain"
                style={styles.logo}
            />
            <Text style={styles.title}>
                {t('welcome.title')}
            </Text>
            <Text style={styles.subtitle}>
                {t('welcome.subtitle')}
            </Text>
            {terminalConnectIntentBlock}
            {serverAvailability === 'unavailable' || serverAvailability === 'incompatible'
                ? serverBlockedActions
                : serverAvailability === 'loading'
                    ? serverLoadingActions
                    : null}
            {Platform.OS !== 'android' && Platform.OS !== 'ios' ? (
                <>
                    {showAuthActions && (
                        <View style={styles.buttonContainer}>
                            <RoundButton
                                testID="welcome-restore"
                                size="normal"
                                title={t('welcome.loginWithMobileApp')}
                                onPress={() => {
                                    trackAccountRestored();
                                    router.push('/restore');
                                }}
                            />
                        </View>
                    )}
                    {showAuthActions && showProviderSignup && (
                        <View style={styles.buttonContainerSecondary}>
                            <RoundButton
                                testID="welcome-signup-provider"
                                size="normal"
                                title={providerSignupTitle}
                                action={() => createAccountViaProvider(providerId!)}
                            />
                        </View>
                    )}
                    {showAuthActions && showMtlsLogin && !mtlsPrimary && (
                        <View style={styles.buttonContainerSecondary}>
                            <RoundButton
                                testID="welcome-mtls-login"
                                size="normal"
                                title={mtlsTitle}
                                action={loginWithMtls}
                            />
                        </View>
                    )}
                    {showAuthActions && showAnonymousSignup && (
                        <View style={showProviderSignup ? styles.buttonContainerTertiary : styles.buttonContainerSecondary}>
                            <RoundButton
                                testID="welcome-create-account"
                                size="small"
                                title={anonymousSignupTitle}
                                action={createAccount}
                                display="inverted"
                            />
                        </View>
                    )}
                    {showAuthActions && !showProviderSignup && !showAnonymousSignup && (
                        <View style={styles.buttonContainerSecondary}>
                            <RoundButton
                                testID="welcome-create-account"
                                size="small"
                                title={primarySignupTitle}
                                action={primarySignupAction}
                                display="inverted"
                            />
                        </View>
                    )}
                </>
            ) : (
                <>
                    {showAuthActions && (
                        <View style={styles.buttonContainer}>
                            <RoundButton
                                testID={showProviderSignup ? "welcome-signup-provider" : "welcome-create-account"}
                                size="normal"
                                title={primarySignupTitle}
                                action={primarySignupAction}
                            />
                        </View>
                    )}
                    {showAuthActions && showMtlsLogin && !mtlsPrimary && (
                        <View style={styles.buttonContainerSecondary}>
                            <RoundButton
                                testID="welcome-mtls-login"
                                size="small"
                                title={mtlsTitle}
                                action={loginWithMtls}
                                display="inverted"
                            />
                        </View>
                    )}
                    {showAuthActions && showProviderSignup && showAnonymousSignup && (
                        <View style={styles.buttonContainerSecondary}>
                            <RoundButton
                                testID="welcome-create-account"
                                size="small"
                                title={anonymousSignupTitle}
                                action={createAccount}
                                display="inverted"
                            />
                        </View>
                    )}
                    {showAuthActions && (
                        <View style={showProviderSignup && showAnonymousSignup ? styles.buttonContainerTertiary : styles.buttonContainerSecondary}>
                            <RoundButton
                                testID="welcome-create-account"
                                size="small"
                                title={t('welcome.linkOrRestoreAccount')}
                                onPress={() => {
                                    trackAccountRestored();
                                    router.push('/restore');
                                }}
                                display="inverted"
                            />
                        </View>
                    )}
                </>
            )}
        </View>
    );

    const landscapeLayout = (
        <View style={[styles.landscapeContainer, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.landscapeInner}>
                <View style={styles.landscapeLogoSection}>
                    <Image
                        source={theme.dark ? require('@/assets/images/logotype-light.png') : require('@/assets/images/logotype-dark.png')}
                        resizeMode="contain"
                        style={styles.logo}
                    />
                </View>
                <View style={styles.landscapeContentSection}>
                    <Text style={styles.landscapeTitle}>
                        {t('welcome.title')}
                    </Text>
                    <Text style={styles.landscapeSubtitle}>
                        {t('welcome.subtitle')}
                    </Text>
                    {terminalConnectIntentBlock}
                    {serverAvailability === 'unavailable' || serverAvailability === 'incompatible'
                        ? serverBlockedActions
                        : serverAvailability === 'loading'
                            ? serverLoadingActions
                            : null}
                    {Platform.OS !== 'android' && Platform.OS !== 'ios'
                        ? (<>
                            {showAuthActions && (
                                <View style={styles.landscapeButtonContainer}>
                                    <RoundButton
                                        testID="welcome-restore"
                                        size="normal"
                                        title={t('welcome.loginWithMobileApp')}
                                        onPress={() => {
                                            trackAccountRestored();
                                            router.push('/restore');
                                        }}
                                    />
                                </View>
                            )}
                            {showAuthActions && showProviderSignup && (
                                <View style={styles.landscapeButtonContainerSecondary}>
                                    <RoundButton
                                        testID="welcome-signup-provider"
                                        size="normal"
                                        title={providerSignupTitle}
                                        action={() => createAccountViaProvider(providerId!)}
                                    />
                                </View>
                            )}
                            {showAuthActions && showAnonymousSignup && (
                                <View style={showProviderSignup ? styles.landscapeButtonContainerTertiary : styles.landscapeButtonContainerSecondary}>
                                    <RoundButton
                                        testID="welcome-create-account"
                                        size="small"
                                        title={anonymousSignupTitle}
                                        action={createAccount}
                                        display="inverted"
                                    />
                                </View>
                            )}
                            {showAuthActions && !showProviderSignup && !showAnonymousSignup && (
                                <View style={styles.landscapeButtonContainerSecondary}>
                                    <RoundButton
                                        testID="welcome-create-account"
                                        size="small"
                                        title={primarySignupTitle}
                                        action={primarySignupAction}
                                        display="inverted"
                                    />
                                </View>
                            )}
                        </>)
                        : (<>
                            {showAuthActions && (
                                <View style={styles.landscapeButtonContainer}>
                                    <RoundButton
                                        testID={showProviderSignup ? "welcome-signup-provider" : "welcome-create-account"}
                                        size="normal"
                                        title={primarySignupTitle}
                                        action={primarySignupAction}
                                    />
                                </View>
                            )}
                            {showAuthActions && showProviderSignup && showAnonymousSignup && (
                                <View style={styles.landscapeButtonContainerSecondary}>
                                    <RoundButton
                                        testID="welcome-create-account"
                                        size="small"
                                        title={anonymousSignupTitle}
                                        action={createAccount}
                                        display="inverted"
                                    />
                                </View>
                            )}
                            {showAuthActions && (
                                <View style={showProviderSignup && showAnonymousSignup ? styles.landscapeButtonContainerTertiary : styles.landscapeButtonContainerSecondary}>
                                    <RoundButton
                                        testID="welcome-restore"
                                        size="small"
                                        title={t('welcome.linkOrRestoreAccount')}
                                        onPress={() => {
                                            trackAccountRestored();
                                            router.push('/restore');
                                        }}
                                        display="inverted"
                                    />
                                </View>
                            )}
                        </>)
                    }
                </View>
            </View>
        </View>
    );

    return (
        <>
            <HomeHeaderNotAuth />
            {isLandscape ? landscapeLayout : portraitLayout}
        </>
    )
}

const styles = StyleSheet.create((theme) => ({
    // NotAuthenticated styles
    portraitContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
    },
    logo: {
        width: 300,
        height: 90,
    },
    title: {
        marginTop: 16,
        textAlign: 'center',
        fontSize: 24,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 18,
        color: theme.colors.textSecondary,
        marginTop: 16,
        textAlign: 'center',
        marginHorizontal: 24,
        marginBottom: 64,
    },
    intentBlock: {
        width: '100%',
        maxWidth: 560,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 20,
    },
    intentTitle: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        color: theme.colors.text,
        textAlign: 'center',
        marginBottom: 6,
    },
    intentBody: {
        ...Typography.default(),
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        lineHeight: 20,
    },
    serverUnavailableBlock: {
        width: '100%',
        maxWidth: 560,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 20,
    },
    serverUnavailableTitle: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        color: theme.colors.text,
        textAlign: 'center',
        marginBottom: 6,
    },
    serverUnavailableBody: {
        ...Typography.default(),
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        lineHeight: 20,
    },
    serverLoadingBlock: {
        width: '100%',
        maxWidth: 560,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 20,
    },
    serverLoadingText: {
        ...Typography.default(),
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginTop: 10,
    },
    buttonContainer: {
        maxWidth: 320,
        width: '100%',
        marginBottom: 16,
    },
    buttonContainerSecondary: {
        maxWidth: 320,
        width: '100%',
        marginBottom: 16,
    },
    buttonContainerTertiary: {
        maxWidth: 320,
        width: '100%',
        marginBottom: 0,
    },
    // Landscape styles
    landscapeContainer: {
        flexBasis: 0,
        flexGrow: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 48,
    },
    landscapeInner: {
        flexGrow: 1,
        flexBasis: 0,
        maxWidth: 800,
        flexDirection: 'row',
    },
    landscapeLogoSection: {
        flexBasis: 0,
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingRight: 24,
    },
    landscapeContentSection: {
        flexBasis: 0,
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingLeft: 24,
    },
    landscapeTitle: {
        textAlign: 'center',
        fontSize: 24,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    landscapeSubtitle: {
        ...Typography.default(),
        fontSize: 18,
        color: theme.colors.textSecondary,
        marginTop: 16,
        textAlign: 'center',
        marginBottom: 32,
        paddingHorizontal: 16,
    },
    landscapeButtonContainer: {
        width: 320,
        marginBottom: 16,
    },
    landscapeButtonContainerSecondary: {
        width: 320,
        marginBottom: 16,
    },
    landscapeButtonContainerTertiary: {
        width: 320,
    },
}));
