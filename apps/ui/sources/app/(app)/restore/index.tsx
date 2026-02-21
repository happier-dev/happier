import React, { useState, useEffect, useRef } from 'react';
import { View, ScrollView, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '@/auth/context/AuthContext';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Typography } from '@/constants/Typography';
import { encodeBase64 } from '@/encryption/base64';
import { generateAuthKeyPair, authQRStart } from '@/auth/flows/qrStart';
import { authQRWait } from '@/auth/flows/qrWait';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { QRCode } from '@/components/qr/QRCode';
import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { getAuthProvider } from '@/auth/providers/registry';
import type { RestoreRedirectReason, RestoreRedirectNotice } from '@/auth/providers/types';
import { Text } from '@/components/ui/text/Text';


const stylesheet = StyleSheet.create((theme) => ({
    scrollView: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    container: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: 24,
    },
    contentWrapper: {
        width: '100%',
        maxWidth: 560,
        paddingVertical: 28,
    },
    noticeCard: {
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 14,
        paddingHorizontal: 16,
        paddingVertical: 14,
        backgroundColor: theme.colors.surface,
    },
    noticeTitle: {
        fontSize: 16,
        color: theme.colors.text,
        marginBottom: 6,
        ...Typography.default('semiBold'),
    },
    noticeBody: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        lineHeight: 20,
        ...Typography.default(),
    },
    sectionLead: {
        fontSize: 15,
        color: theme.colors.textSecondary,
        marginTop: 18,
        marginBottom: 14,
        textAlign: 'center',
        lineHeight: 21,
        ...Typography.default(),
    },
    qrBlock: {
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        paddingVertical: 10,
    },
    footer: {
        marginTop: 18,
        alignItems: 'center',
        width: '100%',
    },
    footerButton: {
        width: '100%',
        maxWidth: 320,
    },
    footerButtonSpacer: {
        height: 12,
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
    const value = (params as any)[key];
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : null;
    return typeof value === 'string' ? value : null;
}

function parseRestoreRedirectReason(value: unknown): RestoreRedirectReason | null {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (raw === 'provider_already_linked') return raw;
    return null;
}

export default function Restore() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const auth = useAuth();
    const router = useRouter();
    const params = useLocalSearchParams() as any;
    const [restoreKey, setRestoreKey] = useState('');
    const [isWaitingForAuth, setIsWaitingForAuth] = useState(false);
    const [authReady, setAuthReady] = useState(false);
    const [waitingDots, setWaitingDots] = useState(0);
    const [providerResetEnabled, setProviderResetEnabled] = useState(false);
    const isCancelledRef = useRef(false);

    const restoreRedirectNotice: RestoreRedirectNotice | null = React.useMemo(() => {
        const providerId = (paramString(params, 'provider') ?? '').trim().toLowerCase();
        const reason = parseRestoreRedirectReason(paramString(params, 'reason'));
        if (!providerId || !reason) return null;

        const provider = getAuthProvider(providerId);
        if (!provider?.getRestoreRedirectNotice) return null;
        return provider.getRestoreRedirectNotice({ reason });
    }, [params]);

    // Memoize keypair generation to prevent re-creating on re-renders
    const keypair = React.useMemo(() => generateAuthKeyPair(), []);

    // Start QR authentication when component mounts
    useEffect(() => {
        let mounted = true;
        fireAndForget((async () => {
            const features = await getReadyServerFeatures({ timeoutMs: 800 });
            const enabled = features?.features?.auth?.recovery?.providerReset?.enabled === true;
            if (mounted) setProviderResetEnabled(enabled);
        })(), { tag: 'Restore.loadProviderResetEnabled' });
        return () => {
            mounted = false;
        };
    }, []);

    useEffect(() => {
        const startQRAuth = async () => {
            try {
                setIsWaitingForAuth(true);

                // Send authentication request
                const success = await authQRStart(keypair);
                if (!success) {
                    Modal.alert(t('common.error'), t('errors.authenticationFailed'));
                    setIsWaitingForAuth(false);
                    return;
                }

                setAuthReady(true);

                // Start waiting for authentication
                const credentials = await authQRWait(
                    keypair,
                    (dots) => setWaitingDots(dots),
                    () => isCancelledRef.current
                );

                if (credentials && !isCancelledRef.current) {
                    // Convert secret bytes to base64url string for login
                    const secretString = encodeBase64(credentials.secret, 'base64url');
                    await auth.login(credentials.token, secretString);
                    if (!isCancelledRef.current) {
                        router.back();
                    }
                } else if (!isCancelledRef.current) {
                    Modal.alert(t('common.error'), t('errors.authenticationFailed'));
                }

            } catch (error) {
                if (!isCancelledRef.current) {
                    console.error('QR Auth error:', error);
                    Modal.alert(t('common.error'), t('errors.authenticationFailed'));
                }
            } finally {
                if (!isCancelledRef.current) {
                    setIsWaitingForAuth(false);
                    setAuthReady(false);
                }
            }
        };

        startQRAuth();

        // Cleanup function
        return () => {
            isCancelledRef.current = true;
        };
    }, [keypair]);

    return (
        <ScrollView style={styles.scrollView} contentContainerStyle={{ flexGrow: 1 }}>
            <View style={styles.container}>
                <View style={styles.contentWrapper}>
                    {restoreRedirectNotice ? (
                        <View style={styles.noticeCard}>
                            <Text style={styles.noticeTitle}>{restoreRedirectNotice.title}</Text>
                            <Text style={styles.noticeBody}>{restoreRedirectNotice.body}</Text>
                        </View>
                    ) : null}

                    <Text style={styles.sectionLead}>{t('connect.restoreQrInstructions')}</Text>

                    <View style={styles.qrBlock}>
                        {!authReady ? (
                            <View style={{ width: 220, height: 220, alignItems: 'center', justifyContent: 'center' }}>
                                <ActivityIndicator size="small" color={theme.colors.text} />
                            </View>
                        ) : (
                            <QRCode
                                data={'happier:///account?' + encodeBase64(keypair.publicKey, 'base64url')}
                                size={260}
                                foregroundColor={'black'}
                                backgroundColor={'white'}
                            />
                        )}
                    </View>

                    <View style={styles.footer}>
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-open-manual"
                                size="normal"
                                title={t('connect.restoreWithSecretKeyInstead')}
                                display="inverted"
                                onPress={() => router.push('/restore/manual')}
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
        </ScrollView>
    );
}
