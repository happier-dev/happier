import React, { useState, useEffect, useRef } from 'react';
import { View, ScrollView } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '@/auth/context/AuthContext';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Typography } from '@/constants/Typography';
import { encodeBase64 } from '@/encryption/base64';
import { generateAuthKeyPair, authQRStart } from '@/auth/flows/qrStart';
import { authQRWait } from '@/auth/flows/qrWait';
import { buildAccountConnectDeepLink } from '@/auth/pairing/accountConnectUrl';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { QRCode } from '@/components/qr/QRCode';
import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { getAuthProvider } from '@/auth/providers/registry';
import type { RestoreRedirectReason, RestoreRedirectNotice } from '@/auth/providers/types';
import { Text } from '@/components/ui/text/Text';
import { canUseCurrentDeviceQrScanner } from '@/utils/platform/qrScannerSupport';
import { trackAccountRestored } from '@/track';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

const stylesheet = StyleSheet.create((theme) => ({
    scrollView: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
    },
    container: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: 24,
    },
    embeddedContainer: {
        flex: 0,
        paddingHorizontal: 0,
    },
    contentWrapper: {
        width: '100%',
        maxWidth: 560,
        paddingVertical: 28,
    },
    embeddedContentWrapper: {
        paddingVertical: 0,
    },
    noticeCard: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 14,
        paddingHorizontal: 16,
        paddingVertical: 14,
        backgroundColor: theme.colors.surface.base,
    },
    noticeTitle: {
        fontSize: 16,
        color: theme.colors.text.primary,
        marginBottom: 6,
        ...Typography.default('semiBold'),
    },
    noticeBody: {
        fontSize: 14,
        color: theme.colors.text.secondary,
        lineHeight: 20,
        ...Typography.default(),
    },
    sectionLead: {
        fontSize: 16,
        color: theme.colors.text.secondary,
        marginTop: 12,
        marginBottom: 12,
        textAlign: 'center',
        lineHeight: 24,
        ...Typography.default(),
    },
    embeddedSectionLead: {
        marginTop: 0,
        marginBottom: 8,
    },
    qrBlock: {
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        paddingVertical: 10,
    },
    embeddedQrBlock: {
        paddingVertical: 6,
    },
    footer: {
        marginTop: 16,
        alignItems: 'center',
        width: '100%',
    },
    embeddedFooter: {
        marginTop: 8,
    },
    footerButton: {
        width: '100%',
        maxWidth: 320,
    },
    footerButtonSpacer: {
        height: 10,
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        padding: 16,
        borderRadius: 8,
        marginBottom: 24,
        fontFamily: 'IBMPlexMono-Regular',
        fontSize: 14,
        minHeight: 120,
        textAlignVertical: 'top',
        color: theme.colors.input.text,
    },
}));

function paramString(params: Record<string, unknown>, key: string): string | null {
    const value = params[key];
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : null;
    return typeof value === 'string' ? value : null;
}

function parseRestoreRedirectReason(value: unknown): RestoreRedirectReason | null {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (raw === 'provider_already_linked') return raw;
    return null;
}

export type RestoreQrViewProps = Readonly<{
    embedded?: boolean;
    onBack?: () => void;
    onOpenSecretKeyLogin?: () => void;
    onOpenScanQr?: () => void;
}>;

export const RestoreQrView = React.memo(function RestoreQrView(props: RestoreQrViewProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const auth = useAuth();
    const router = useRouter();
    const params = useLocalSearchParams() as Readonly<Record<string, string | string[] | undefined>>;
    const [authReady, setAuthReady] = useState(false);
    const [providerResetEnabled, setProviderResetEnabled] = useState(false);
    const isCancelledRef = useRef(false);
    const handleBack = React.useCallback(() => {
        if (props.onBack) {
            props.onBack();
            return;
        }
        router.back();
    }, [props.onBack, router]);

    const embedded = props.embedded === true;
    const canOpenScanner = typeof props.onOpenScanQr === 'function' && canUseCurrentDeviceQrScanner();
    const qrSize = embedded ? 220 : 260;
    const scrollViewStyle: StyleProp<ViewStyle> = embedded
        ? [styles.scrollView, { backgroundColor: 'transparent' }]
        : styles.scrollView;

    const restoreRedirectNotice: RestoreRedirectNotice | null = React.useMemo(() => {
        const providerId = (paramString(params, 'provider') ?? '').trim().toLowerCase();
        const reason = parseRestoreRedirectReason(paramString(params, 'reason'));
        if (!providerId || !reason) return null;

        const provider = getAuthProvider(providerId);
        if (!provider?.getRestoreRedirectNotice) return null;
        return provider.getRestoreRedirectNotice({ reason });
    }, [params]);

    const keypair = React.useMemo(() => generateAuthKeyPair(), []);

    useEffect(() => {
        let mounted = true;
        fireAndForget((async () => {
            const features = await getReadyServerFeatures({ timeoutMs: 800 });
            const enabled = features?.features?.auth?.recovery?.providerReset?.enabled === true;
            if (mounted) setProviderResetEnabled(enabled);
        })(), { tag: 'RestoreQrView.loadProviderResetEnabled' });
        return () => {
            mounted = false;
        };
    }, []);

    useEffect(() => {
        const startQRAuth = async () => {
            try {
                const success = await authQRStart(keypair);
                if (!success) {
                    Modal.alert(t('common.error'), t('errors.authenticationFailed'));
                    return;
                }

                setAuthReady(true);

                const credentials = await authQRWait(
                    keypair,
                    undefined,
                    () => isCancelledRef.current,
                );

                if (credentials && !isCancelledRef.current) {
                    const secretString = encodeBase64(credentials.secret, 'base64url');
                    await auth.login(credentials.token, secretString);
                    trackAccountRestored();
                    if (!isCancelledRef.current) {
                        handleBack();
                    }
                } else if (!isCancelledRef.current) {
                    Modal.alert(t('common.error'), t('errors.authenticationFailed'));
                }

            } catch {
                if (!isCancelledRef.current) {
                    Modal.alert(t('common.error'), t('errors.authenticationFailed'));
                }
            } finally {
                if (!isCancelledRef.current) {
                    setAuthReady(false);
                }
            }
        };

        startQRAuth();

        return () => {
            isCancelledRef.current = true;
        };
    }, [keypair]);

    const content = (
        <View style={[styles.container, embedded ? styles.embeddedContainer : null]}>
            <View style={[styles.contentWrapper, embedded ? styles.embeddedContentWrapper : null]}>
                {restoreRedirectNotice ? (
                    <View style={styles.noticeCard}>
                        <Text style={styles.noticeTitle}>{restoreRedirectNotice.title}</Text>
                        <Text style={styles.noticeBody}>{restoreRedirectNotice.body}</Text>
                    </View>
                ) : null}

                <Text style={[styles.sectionLead, embedded ? styles.embeddedSectionLead : null]}>
                    {t('connect.restoreQrInstructions')}
                </Text>

                <View style={[styles.qrBlock, embedded ? styles.embeddedQrBlock : null]}>
                    {!authReady ? (
                        <View style={{ width: qrSize, height: qrSize, alignItems: 'center', justifyContent: 'center' }}>
                            <ActivitySpinner size="small" color={theme.colors.text.primary} />
                        </View>
                    ) : (
                        <QRCode
                            data={buildAccountConnectDeepLink({ publicKeyB64Url: encodeBase64(keypair.publicKey, 'base64url') })}
                            size={qrSize}
                            foregroundColor={theme.colors.text.primary}
                            backgroundColor={theme.colors.surface.base}
                        />
                    )}
                </View>

                <View style={[styles.footer, embedded ? styles.embeddedFooter : null]}>
                    {canOpenScanner ? (
                        <>
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-open-scan-qr"
                                    size="small"
                                    title={t('connect.scanQrCodeOnDevice')}
                                    display="inverted"
                                    onPress={props.onOpenScanQr}
                                />
                            </View>
                            <View style={styles.footerButtonSpacer} />
                        </>
                    ) : null}
                    <View style={styles.footerButton}>
                        <RoundButton
                            testID="restore-open-manual"
                            size="normal"
                            title={t('connect.restoreWithSecretKeyInstead')}
                            display="inverted"
                            onPress={() => {
                                if (embedded && props.onOpenSecretKeyLogin) {
                                    props.onOpenSecretKeyLogin();
                                    return;
                                }
                                router.push('/restore/manual');
                            }}
                        />
                    </View>
                    {providerResetEnabled ? (
                        <>
                            <View style={styles.footerButtonSpacer} />
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-open-lost-access"
                                    size="small"
                                    title={t('connect.lostAccessLink')}
                                    display="inverted"
                                    onPress={() => router.push('/restore/lost-access')}
                                />
                            </View>
                        </>
                    ) : null}
                </View>
            </View>
        </View>
    );

    if (embedded) {
        return content;
    }

    return (
        <ScrollView style={scrollViewStyle} contentContainerStyle={{ flexGrow: 1 }}>
            {content}
        </ScrollView>
    );
});
