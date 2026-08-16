import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useAuth } from '@/auth/context/AuthContext';
import { generateAuthKeyPair, authQRStart } from '@/auth/flows/qrStart';
import { authQRWait } from '@/auth/flows/qrWait';
import { buildPairingDeepLink, parsePairingDeepLink } from '@/auth/pairing/pairingUrl';
import { parseAccountConnectDeepLink } from '@/auth/pairing/accountConnectUrl';
import { encodeBase64 } from '@/encryption/base64';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { pairingRequest } from '@/sync/api/account/apiPairingAuth';
import { getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import { normalizeServerUrl, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { resolveEffectiveServerUrlOverride } from '@/sync/domains/server/url/serverUrlOverridePolicy';
import { isLoopbackServerUrl } from '@/sync/domains/server/url/serverUrlClassification';
import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Typography } from '@/constants/Typography';
import { QrCodeScannerView } from '@/components/qr/QrCodeScannerView';
import { trackAccountRestored } from '@/track';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { promptAccountConnectApprovalRequired } from './accountConnectApprovalGuidance';

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
    title: {
        fontSize: 28,
        lineHeight: 34,
        letterSpacing: -0.56,
        color: theme.colors.text.primary,
        marginBottom: 8,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    subtitle: {
        fontSize: 16,
        color: theme.colors.text.secondary,
        lineHeight: 24,
        textAlign: 'center',
        ...Typography.default(),
    },
    statusCard: {
        marginTop: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 14,
        paddingHorizontal: 16,
        paddingVertical: 14,
        backgroundColor: theme.colors.surface.base,
    },
    embeddedStatusCard: {
        marginTop: 10,
    },
    codeLabel: {
        marginTop: 12,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    codeValue: {
        marginTop: 6,
        fontSize: 18,
        color: theme.colors.text.primary,
        letterSpacing: 1,
        ...Typography.mono(),
    },
    footer: {
        marginTop: 12,
        alignItems: 'center',
        width: '100%',
        gap: 12,
    },
    embeddedFooter: {
        marginTop: 10,
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

export type RestoreScanComputerQrViewProps = Readonly<{
    embedded?: boolean;
    onBack?: () => void;
    onOpenSecretKeyLogin?: () => void;
    onShowQrInstead?: () => void;
}>;

export const RestoreScanComputerQrView = React.memo(function RestoreScanComputerQrView(props: RestoreScanComputerQrViewProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const isFocused = useIsFocused();
    const auth = useAuth();
    const embedded = props.embedded === true;
    const pairingDecision = useFeatureDecision('auth.pairing.desktopQrMobileScan');
    const pairingState = pairingDecision?.state ?? 'unknown';

    const [phase, setPhase] = React.useState<'idle' | 'requesting' | 'waiting'>('idle');
    const [confirmCode, setConfirmCode] = React.useState<string | null>(null);
    const [waitingDots, setWaitingDots] = React.useState(0);
    const isCancelledRef = React.useRef(false);

    const handleBack = React.useCallback(() => {
        if (props.onBack) {
            props.onBack();
            return;
        }
        router.back();
    }, [props.onBack, router]);

    const openSecretKeyLogin = React.useCallback(() => {
        if (embedded && props.onOpenSecretKeyLogin) {
            props.onOpenSecretKeyLogin();
            return;
        }
        router.push('/restore/manual');
    }, [embedded, props.onOpenSecretKeyLogin, router]);

    const openShowQrInstead = React.useCallback(() => {
        if (embedded && props.onShowQrInstead) {
            props.onShowQrInstead();
            return;
        }
        router.push('/restore/show-qr');
    }, [embedded, props.onShowQrInstead, router]);

    const scrollViewStyle: StyleProp<ViewStyle> = props.embedded
        ? [styles.scrollView, { backgroundColor: 'transparent' }]
        : styles.scrollView;
    const containerStyle: StyleProp<ViewStyle> = [styles.container, embedded ? styles.embeddedContainer : null];
    const contentWrapperStyle: StyleProp<ViewStyle> = [styles.contentWrapper, embedded ? styles.embeddedContentWrapper : null];

    const processPairingLink = React.useCallback(
        async (rawUrl: string) => {
            if (parseAccountConnectDeepLink(rawUrl.trim())) {
                const action = await promptAccountConnectApprovalRequired();
                if (action === 'showQr') {
                    openShowQrInstead();
                }
                return;
            }

            const parsed = parsePairingDeepLink(rawUrl.trim());
            if (!parsed) {
                await Modal.alertAsync(t('common.error'), t('modals.invalidAuthUrl'));
                return;
            }

            setPhase('requesting');
            setConfirmCode(null);

            try {
                const activeServerUrl = normalizeServerUrl(getActiveServerUrl());
                const activeServerUrlIsLoopback = activeServerUrl ? isLoopbackServerUrl(activeServerUrl) : false;

                if (parsed.serverUrl) {
                    const target = resolveEffectiveServerUrlOverride({
                        requestedServerUrl: parsed.serverUrl,
                        activeServerUrl,
                    });
                    if (target && activeServerUrl !== target) {
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
                        const requestedLoopback = parsed.serverUrl ? isLoopbackServerUrl(parsed.serverUrl) : false;
                        const showServerUrlNotEmbeddedHint = parsed.serverUrl == null || (requestedLoopback && !activeServerUrlIsLoopback);
                        if (showServerUrlNotEmbeddedHint) {
                            await Modal.alertAsync(t('connect.serverUrlNotEmbeddedTitle'), t('connect.serverUrlNotEmbeddedBody'));
                        } else {
                            await Modal.alertAsync(t('modals.authRequestExpired'), t('modals.authRequestExpiredDescription'));
                        }
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
                    trackAccountRestored();
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
        [auth, openShowQrInstead, router],
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
        const frame = (
            <View style={containerStyle}>
                <View style={contentWrapperStyle}>
                    {embedded ? null : <Text style={styles.title}>{t('connect.restoreAccount')}</Text>}
                    <Text style={styles.subtitle}>{t('common.loading')}</Text>

                    <View style={[styles.statusCard, embedded ? styles.embeddedStatusCard : null]}>
                        <ActivitySpinner size="small" color={theme.colors.text.primary} />
                    </View>

                    <View style={[styles.footer, embedded ? styles.embeddedFooter : null]}>
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-open-manual"
                                size="small"
                                title={t('connect.restoreWithSecretKeyInstead')}
                                display="inverted"
                                action={async () => {
                                    openSecretKeyLogin();
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
                                onPress={handleBack}
                            />
                        </View>
                    </View>
                </View>
            </View>
        );

        return embedded ? frame : (
            <ScrollView style={scrollViewStyle} contentContainerStyle={{ flexGrow: 1 }}>
                {frame}
            </ScrollView>
        );
    }

    if (pairingState !== 'enabled') {
        const frame = (
            <View style={containerStyle}>
                <View style={contentWrapperStyle}>
                    {embedded ? null : <Text style={styles.title}>{t('connect.restoreAccount')}</Text>}
                    <Text style={styles.subtitle}>{t('connect.scanComputerQrUnavailableBody')}</Text>

                    <View style={[styles.statusCard, embedded ? styles.embeddedStatusCard : null]}>
                        <Text style={styles.codeLabel}>{t('connect.scanComputerQrUnavailableTitle')}</Text>
                    </View>

                    <View style={[styles.footer, embedded ? styles.embeddedFooter : null]}>
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-open-manual"
                                size="small"
                                title={t('connect.restoreWithSecretKeyInstead')}
                                display="inverted"
                                action={async () => {
                                    openSecretKeyLogin();
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
                                onPress={handleBack}
                            />
                        </View>
                    </View>
                </View>
            </View>
        );

        return embedded ? frame : (
            <ScrollView style={scrollViewStyle} contentContainerStyle={{ flexGrow: 1 }}>
                {frame}
            </ScrollView>
        );
    }

    if (phase === 'idle') {
        return (
            <QrCodeScannerView
                active={isFocused}
                testIDPrefix="restore-scan"
                title={t('connect.restoreAccount')}
                subtitle={t('connect.scanComputerQrInstructions')}
                permissionRequiredMessage={t('modals.cameraPermissionsRequiredToScanQr')}
                embedded={props.embedded}
                onCancel={handleBack}
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
                                    openSecretKeyLogin();
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
                                    openShowQrInstead();
                                }}
                            />
                        </View>
                    </>
                }
            />
        );
    }

    const frame = (
        <View style={containerStyle}>
            <View style={contentWrapperStyle}>
                {embedded ? null : <Text style={styles.title}>{t('connect.restoreAccount')}</Text>}
                <Text style={styles.subtitle}>{statusText}</Text>

                <View style={[styles.statusCard, embedded ? styles.embeddedStatusCard : null]}>
                    <ActivitySpinner size="small" color={theme.colors.text.primary} />
                    {confirmCode ? (
                        <>
                            <Text style={styles.codeLabel}>{t('connect.confirmCodeLabel')}</Text>
                            <Text style={styles.codeValue}>{confirmCode}</Text>
                        </>
                    ) : null}
                </View>

                <View style={[styles.footer, embedded ? styles.embeddedFooter : null]}>
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
                                openSecretKeyLogin();
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
                                openShowQrInstead();
                            }}
                        />
                    </View>
                </View>
            </View>
        </View>
    );

    return embedded ? frame : (
        <ScrollView style={scrollViewStyle} contentContainerStyle={{ flexGrow: 1 }}>
            {frame}
        </ScrollView>
    );
});
