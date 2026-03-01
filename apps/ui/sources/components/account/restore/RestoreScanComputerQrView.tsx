import * as React from 'react';
import { ActivityIndicator, Platform, ScrollView, View } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useAuth } from '@/auth/context/AuthContext';
import { generateAuthKeyPair, authQRStart } from '@/auth/flows/qrStart';
import { authQRWait } from '@/auth/flows/qrWait';
import { buildPairingDeepLink, parsePairingDeepLink } from '@/auth/pairing/pairingUrl';
import { encodeBase64 } from '@/encryption/base64';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { pairingRequest } from '@/sync/api/account/apiPairingAuth';
import { getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import { normalizeServerUrl, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Typography } from '@/constants/Typography';
import { QrCodeScannerView } from '@/components/qr/QrCodeScannerView';

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
    title: {
        fontSize: 18,
        color: theme.colors.text,
        marginBottom: 10,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    subtitle: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        lineHeight: 20,
        textAlign: 'center',
        ...Typography.default(),
    },
    statusCard: {
        marginTop: 18,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 14,
        paddingHorizontal: 16,
        paddingVertical: 14,
        backgroundColor: theme.colors.surface,
    },
    codeLabel: {
        marginTop: 12,
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    codeValue: {
        marginTop: 6,
        fontSize: 18,
        color: theme.colors.text,
        letterSpacing: 1,
        ...Typography.mono(),
    },
    footer: {
        marginTop: 18,
        alignItems: 'center',
        width: '100%',
        gap: 12,
    },
    footerButton: {
        width: '100%',
        maxWidth: 360,
    },
}));

function resolveDeviceLabel(): string | null {
    const name = Constants.deviceName ?? '';
    const trimmed = String(name).trim();
    if (trimmed) return trimmed;
    if (Platform.OS === 'ios') return 'iPhone';
    if (Platform.OS === 'android') return 'Android';
    return null;
}

export const RestoreScanComputerQrView = React.memo(function RestoreScanComputerQrView() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const auth = useAuth();
    const pairingDecision = useFeatureDecision('auth.pairing.desktopQrMobileScan');
    const pairingState = pairingDecision?.state ?? 'unknown';

    const [phase, setPhase] = React.useState<'idle' | 'requesting' | 'waiting'>('idle');
    const [confirmCode, setConfirmCode] = React.useState<string | null>(null);
    const [waitingDots, setWaitingDots] = React.useState(0);
    const isCancelledRef = React.useRef(false);

    const processPairingLink = React.useCallback(
        async (rawUrl: string) => {
            const parsed = parsePairingDeepLink(rawUrl.trim());
            if (!parsed) {
                await Modal.alertAsync(t('common.error'), t('modals.invalidAuthUrl'));
                return;
            }

            setPhase('requesting');
            setConfirmCode(null);

            try {
                if (parsed.serverUrl) {
                    const target = normalizeServerUrl(parsed.serverUrl);
                    const current = normalizeServerUrl(getActiveServerUrl());
                    if (target && current !== target) {
                        await upsertActivateAndSwitchServer({
                            serverUrl: target,
                            source: 'url',
                            scope: 'device',
                            refreshAuth: auth.refreshFromActiveServer,
                        });
                    }
                }

                const keypair = generateAuthKeyPair();
                const started = await authQRStart(keypair);
                if (!started) {
                    await Modal.alertAsync(t('common.error'), t('errors.authenticationFailed'));
                    setPhase('idle');
                    return;
                }

                const pairingRes = await pairingRequest({
                    pairId: parsed.pairId,
                    secret: parsed.secret,
                    publicKey: encodeBase64(keypair.publicKey),
                    deviceLabel: resolveDeviceLabel() ?? undefined,
                });

                if (!pairingRes.ok) {
                    if (pairingRes.reason === 'not_found') {
                        await Modal.alertAsync(t('modals.authRequestExpired'), t('modals.authRequestExpiredDescription'));
                    } else if (pairingRes.reason === 'already_requested') {
                        await Modal.alertAsync(
                            t('connect.pairingAlreadyRequestedTitle'),
                            t('connect.pairingAlreadyRequestedBody'),
                        );
                    } else {
                        await Modal.alertAsync(t('common.error'), t('errors.operationFailed'));
                    }
                    setPhase('idle');
                    return;
                }

                setConfirmCode(pairingRes.data.confirmCode);

                setPhase('waiting');
                const credentials = await authQRWait(
                    keypair,
                    (dots) => setWaitingDots(dots),
                    () => isCancelledRef.current,
                );

                if (credentials && !isCancelledRef.current) {
                    const secretString = encodeBase64(credentials.secret, 'base64url');
                    await auth.login(credentials.token, secretString);
                    if (!isCancelledRef.current) {
                        router.replace('/');
                    }
                } else if (!isCancelledRef.current) {
                    await Modal.alertAsync(t('common.error'), t('errors.authenticationFailed'));
                    setPhase('idle');
                }
            } catch {
                if (!isCancelledRef.current) {
                    await Modal.alertAsync(t('common.error'), t('errors.authenticationFailed'));
                }
                setPhase('idle');
            }
        },
        [auth, router],
    );

    React.useEffect(() => {
        return () => {
            isCancelledRef.current = true;
        };
    }, []);

    const waitingSuffix = phase === 'waiting' ? '.'.repeat(waitingDots % 4) : '';
    const statusText =
        phase === 'idle'
            ? t('connect.scanComputerQrInstructions')
                : phase === 'requesting'
                    ? t('common.loading')
                    : `${t('connect.waitingForApproval')}${waitingSuffix}`;

    if (pairingState === 'unknown') {
        return (
            <ScrollView style={styles.scrollView} contentContainerStyle={{ flexGrow: 1 }}>
                <View style={styles.container}>
                    <View style={styles.contentWrapper}>
                        <Text style={styles.title}>{t('connect.restoreAccount')}</Text>
                        <Text style={styles.subtitle}>{t('common.loading')}</Text>

                        <View style={styles.statusCard}>
                            <ActivityIndicator size="small" color={theme.colors.text} />
                        </View>

                        <View style={styles.footer}>
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-open-manual"
                                    size="small"
                                    title={t('connect.restoreWithSecretKeyInstead')}
                                    display="inverted"
                                    action={async () => {
                                        router.push('/restore/manual');
                                    }}
                                />
                            </View>
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-show-qr-instead"
                                    size="small"
                                    title={t('connect.showQrInstead')}
                                    display="inverted"
                                    action={async () => {
                                        router.push('/restore/show-qr');
                                    }}
                                />
                            </View>
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-scan-cancel"
                                    size="small"
                                    title={t('common.back')}
                                    display="inverted"
                                    action={async () => {
                                        router.back();
                                    }}
                                />
                            </View>
                        </View>
                    </View>
                </View>
            </ScrollView>
        );
    }

    if (pairingState !== 'enabled') {
        return (
            <ScrollView style={styles.scrollView} contentContainerStyle={{ flexGrow: 1 }}>
                <View style={styles.container}>
                    <View style={styles.contentWrapper}>
                        <Text style={styles.title}>{t('connect.restoreAccount')}</Text>
                        <Text style={styles.subtitle}>{t('connect.scanComputerQrUnavailableBody')}</Text>

                        <View style={styles.statusCard}>
                            <Text style={styles.codeLabel}>{t('connect.scanComputerQrUnavailableTitle')}</Text>
                        </View>

                        <View style={styles.footer}>
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-open-manual"
                                    size="small"
                                    title={t('connect.restoreWithSecretKeyInstead')}
                                    display="inverted"
                                    action={async () => {
                                        router.push('/restore/manual');
                                    }}
                                />
                            </View>
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-show-qr-instead"
                                    size="small"
                                    title={t('connect.showQrInstead')}
                                    display="inverted"
                                    action={async () => {
                                        router.push('/restore/show-qr');
                                    }}
                                />
                            </View>
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-scan-cancel"
                                    size="small"
                                    title={t('common.back')}
                                    display="inverted"
                                    action={async () => {
                                        router.back();
                                    }}
                                />
                            </View>
                        </View>
                    </View>
                </View>
            </ScrollView>
        );
    }

    if (phase === 'idle') {
        return (
            <QrCodeScannerView
                testIDPrefix="restore-scan"
                title={t('connect.restoreAccount')}
                subtitle={t('connect.scanComputerQrInstructions')}
                permissionRequiredMessage={t('modals.cameraPermissionsRequiredToScanQr')}
                onCancel={() => router.back()}
                onScan={async (data) => {
                    if (typeof data === 'string' && data.trim()) {
                        await processPairingLink(data.trim());
                    }
                }}
                footer={
                    <>
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-enter-pairing-link"
                                size="normal"
                                title={t('connect.enterUrlManually')}
                                action={async () => {
                                    const url = await Modal.prompt(
                                        t('connect.enterUrlManually'),
                                        undefined,
                                        {
                                            placeholder: buildPairingDeepLink({
                                                pairId: '…',
                                                secret: '…',
                                                serverUrl: getActiveServerUrl(),
                                            }),
                                            confirmText: t('common.continue'),
                                            cancelText: t('common.cancel'),
                                        },
                                    );
                                    if (typeof url === 'string' && url.trim()) {
                                        await processPairingLink(url.trim());
                                    }
                                }}
                            />
                        </View>
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-open-manual"
                                size="small"
                                title={t('connect.restoreWithSecretKeyInstead')}
                                display="inverted"
                                action={async () => {
                                    router.push('/restore/manual');
                                }}
                            />
                        </View>
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-show-qr-instead"
                                size="small"
                                title={t('connect.showQrInstead')}
                                display="inverted"
                                action={async () => {
                                    router.push('/restore/show-qr');
                                }}
                            />
                        </View>
                    </>
                }
            />
        );
    }

    return (
        <ScrollView style={styles.scrollView} contentContainerStyle={{ flexGrow: 1 }}>
            <View style={styles.container}>
                <View style={styles.contentWrapper}>
                    <Text style={styles.title}>{t('connect.restoreAccount')}</Text>
                    <Text style={styles.subtitle}>{statusText}</Text>

                    <View style={styles.statusCard}>
                        <ActivityIndicator size="small" color={theme.colors.text} />
                        {confirmCode ? (
                            <>
                                <Text style={styles.codeLabel}>{t('connect.confirmCodeLabel')}</Text>
                                <Text style={styles.codeValue}>{confirmCode}</Text>
                            </>
                        ) : null}
                    </View>

                    <View style={styles.footer}>
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-enter-pairing-link"
                                size="small"
                                title={t('connect.enterUrlManually')}
                                display="inverted"
                                action={async () => {
                                    const url = await Modal.prompt(
                                        t('connect.enterUrlManually'),
                                        undefined,
                                        {
                                            placeholder: buildPairingDeepLink({
                                                pairId: '…',
                                                secret: '…',
                                                serverUrl: getActiveServerUrl(),
                                            }),
                                            confirmText: t('common.continue'),
                                            cancelText: t('common.cancel'),
                                        },
                                    );
                                    if (typeof url === 'string' && url.trim()) {
                                        await processPairingLink(url.trim());
                                    }
                                }}
                            />
                        </View>
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-open-manual"
                                size="small"
                                title={t('connect.restoreWithSecretKeyInstead')}
                                display="inverted"
                                action={async () => {
                                    router.push('/restore/manual');
                                }}
                            />
                        </View>
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-show-qr-instead"
                                size="small"
                                title={t('connect.showQrInstead')}
                                display="inverted"
                                action={async () => {
                                    router.push('/restore/show-qr');
                                }}
                            />
                        </View>
                    </View>
                </View>
            </View>
        </ScrollView>
    );
});
