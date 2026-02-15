import { RoundButton } from "@/components/ui/buttons/RoundButton";
import { useAuth } from "@/auth/context/AuthContext";
import { Text, View, Image, Platform, Linking } from "react-native";
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
import { getReadyServerFeatures } from "@/sync/api/capabilities/getReadyServerFeatures";
import { TokenStorage } from "@/auth/storage/tokenStorage";
import sodium from '@/encryption/libsodium.lib';
import { getAuthProvider } from "@/auth/providers/registry";
import { Modal } from "@/modal";
import { getPendingTerminalConnect } from "@/sync/domains/pending/pendingTerminalConnect";
import { isSafeExternalAuthUrl } from "@/auth/providers/externalAuthUrl";

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

    const [signupMode, setSignupMode] = React.useState<
        | { kind: "anonymous" }
        | { kind: "provider"; providerId: string }
    >({ kind: "anonymous" });
    const autoRedirectAttemptedRef = React.useRef(false);
    const hasPendingTerminalConnect = Boolean(getPendingTerminalConnect());

    React.useEffect(() => {
        let mounted = true;
        void (async () => {
            try {
                const features = await getReadyServerFeatures();
                const methods = features?.features?.auth?.signup?.methods ?? [];
                const enabled = methods
                    .filter((m) => m.enabled === true)
                    .map((m) => String(m.id).trim().toLowerCase())
                    .filter(Boolean);

                // Default to legacy behavior (anonymous) when features can't be fetched.
                if (enabled.length === 0) {
                    if (mounted) setSignupMode({ kind: "anonymous" });
                    return;
                }

                if (enabled.includes("anonymous")) {
                    if (mounted) setSignupMode({ kind: "anonymous" });
                    return;
                }

                // Pick the first enabled external provider, preferring one that is configured.
                const providers = enabled.filter((id) => id !== "anonymous");
                const configuredProvider =
                    providers.find((id) => features?.features?.oauth?.providers?.[id]?.configured === true) ?? null;
                const providerId = configuredProvider ?? providers[0] ?? null;
                if (mounted) {
                    setSignupMode(providerId ? { kind: "provider", providerId } : { kind: "anonymous" });
                }

                const autoRedirect = features?.features?.auth?.ui?.autoRedirect ?? null;
                const autoRedirectProviderId = (autoRedirect?.providerId ?? "").trim().toLowerCase();
                if (
                    !autoRedirectAttemptedRef.current &&
                    autoRedirect?.enabled === true &&
                    autoRedirectProviderId &&
                    !enabled.includes("anonymous") &&
                    enabled.includes(autoRedirectProviderId)
                ) {
                    autoRedirectAttemptedRef.current = true;
                    const suppressedUntil = await TokenStorage.getAuthAutoRedirectSuppressedUntil();
                    if (Date.now() < suppressedUntil) return;
                    await createAccountViaProvider(autoRedirectProviderId);
                }
            } catch {
                if (mounted) setSignupMode({ kind: "anonymous" });
            }
        })();
        return () => {
            mounted = false;
        };
    }, []);

    const createAccount = async () => {
        try {
            const secret = await getRandomBytesAsync(32);
            const token = await authGetToken(secret);
            if (token && secret) {
                await auth.login(token, encodeBase64(secret, 'base64url'));
                trackAccountCreated();
            }
        } catch (error) {
            await Modal.alert(t('common.error'), t('errors.operationFailed'));
        }
    }

    const createAccountViaProvider = async (providerId: string) => {
        try {
            const secretBytes = await getRandomBytesAsync(32);
            const secret = encodeBase64(secretBytes, "base64url");
            await TokenStorage.setPendingExternalAuth({ provider: providerId, secret });

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
            await Linking.openURL(url);
        } catch (error) {
            await TokenStorage.clearPendingExternalAuth();
            await Modal.alert(t('common.error'), t('errors.operationFailed'));
        }
    };

    const signupTitle =
        signupMode.kind === "anonymous"
            ? t("welcome.createAccount")
            : t("welcome.signUpWithProvider", {
                  provider: getAuthProvider(signupMode.providerId)?.displayName ?? signupMode.providerId,
              });
    const signupAction =
        signupMode.kind === "anonymous"
            ? createAccount
            : () => createAccountViaProvider(signupMode.providerId);
    const terminalConnectIntentBlock = hasPendingTerminalConnect ? (
        <View style={styles.intentBlock}>
            <Text style={styles.intentTitle}>{t('terminal.connectTerminal')}</Text>
            <Text style={styles.intentBody}>{t('modals.pleaseSignInFirst')}</Text>
        </View>
    ) : null;

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
            {Platform.OS !== 'android' && Platform.OS !== 'ios' ? (
                <>
                    <View style={styles.buttonContainer}>
                        <RoundButton
                            title={t('welcome.loginWithMobileApp')}
                            onPress={() => {
                                trackAccountRestored();
                                router.push('/restore');
                            }}
                        />
                    </View>
                    <View style={styles.buttonContainerSecondary}>
                        <RoundButton
                            size="normal"
                            title={signupTitle}
                            action={signupAction}
                            display="inverted"
                        />
                    </View>
                </>
            ) : (
                <>
                    <View style={styles.buttonContainer}>
                        <RoundButton
                            title={signupTitle}
                            action={signupAction}
                        />
                    </View>
                    <View style={styles.buttonContainerSecondary}>
                        <RoundButton
                            size="normal"
                            title={t('welcome.linkOrRestoreAccount')}
                            onPress={() => {
                                trackAccountRestored();
                                router.push('/restore');
                            }}
                            display="inverted"
                        />
                    </View>
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
                    {Platform.OS !== 'android' && Platform.OS !== 'ios'
                        ? (<>
                            <View style={styles.landscapeButtonContainer}>
                                <RoundButton
                                    title={t('welcome.loginWithMobileApp')}
                                    onPress={() => {
                                        trackAccountRestored();
                                        router.push('/restore');
                                    }}
                                />
                            </View>
                            <View style={styles.landscapeButtonContainerSecondary}>
                                <RoundButton
                                    size="normal"
                                    title={signupTitle}
                                    action={signupAction}
                                    display="inverted"
                                />
                            </View>
                        </>)
                        : (<>
                            <View style={styles.landscapeButtonContainer}>
                                <RoundButton
                                    title={signupTitle}
                                    action={signupAction}
                                />
                            </View>
                            <View style={styles.landscapeButtonContainerSecondary}>
                                <RoundButton
                                    size="normal"
                                    title={t('welcome.linkOrRestoreAccount')}
                                    onPress={() => {
                                        trackAccountRestored();
                                        router.push('/restore');
                                    }}
                                    display="inverted"
                                />
                            </View>
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
    buttonContainer: {
        maxWidth: 280,
        width: '100%',
        marginBottom: 16,
    },
    buttonContainerSecondary: {
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
        width: 280,
        marginBottom: 16,
    },
    landscapeButtonContainerSecondary: {
        width: 280,
    },
}));
