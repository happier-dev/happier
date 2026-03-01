import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';

import { useAuth } from '@/auth/context/AuthContext';
import { authAccountApprove } from '@/auth/flows/accountApprove';
import { buildAccountLinkResponse } from '@/auth/flows/buildAccountLinkResponse';
import { usePairingSession } from '@/hooks/auth/usePairingSession';
import { pairingConsume } from '@/sync/api/account/apiPairingAuth';
import { decodeBase64 } from '@/encryption/base64';
import { QRCode } from '@/components/qr/QRCode';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { Typography } from '@/constants/Typography';

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
        marginBottom: 8,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        lineHeight: 20,
        ...Typography.default(),
    },
    qrBlock: {
        marginTop: 18,
        marginBottom: 10,
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        paddingVertical: 10,
    },
    linkRow: {
        marginTop: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 10,
        backgroundColor: theme.colors.surface,
    },
    linkText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        lineHeight: 16,
        ...Typography.mono(),
    },
    linkActionsRow: {
        marginTop: 12,
        flexDirection: 'row',
        gap: 12,
    },
    actionButton: {
        flex: 1,
    },
    requestCard: {
        marginTop: 18,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 14,
        paddingHorizontal: 16,
        paddingVertical: 14,
        backgroundColor: theme.colors.surface,
    },
    requestTitle: {
        fontSize: 15,
        color: theme.colors.text,
        marginBottom: 8,
        ...Typography.default('semiBold'),
    },
    requestBody: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        lineHeight: 20,
        ...Typography.default(),
    },
    confirmCode: {
        marginTop: 10,
        fontSize: 18,
        color: theme.colors.text,
        letterSpacing: 1,
        ...Typography.mono(),
    },
    footer: {
        marginTop: 16,
    },
}));

export const AddPhoneSettingsView = React.memo(function AddPhoneSettingsView() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const auth = useAuth();
    const pairingDecision = useFeatureDecision('auth.pairing.desktopQrMobileScan');
    const pairingState = pairingDecision?.state ?? 'unknown';
    const pairingEnabled = pairingState === 'enabled';

    const { deepLink, status, isExpired, isStarting: starting, startPairing } = usePairingSession({
        enabled: pairingEnabled,
        isAuthenticated: auth.isAuthenticated,
    });

    const [approving, setApproving] = React.useState(false);

    const startPairingWithAlert = React.useCallback(async () => {
        const res = await startPairing();
        if (!res.ok && auth.isAuthenticated && pairingEnabled) {
            await Modal.alertAsync(t('common.error'), t('errors.operationFailed'));
        }
    }, [auth.isAuthenticated, pairingEnabled, startPairing]);

    React.useEffect(() => {
        if (!auth.isAuthenticated) return;
        if (!pairingEnabled) return;
        void startPairingWithAlert();
    }, [auth.isAuthenticated, pairingEnabled, startPairingWithAlert]);

    const approve = React.useCallback(async () => {
        if (!auth.credentials) return;
        if (!status || status.state !== 'requested') return;

        setApproving(true);
        try {
            const requestedPublicKeyBytes = decodeBase64(status.requestedPublicKey, 'base64');
            const encrypted = buildAccountLinkResponse(auth.credentials, requestedPublicKeyBytes);

            await authAccountApprove(auth.credentials.token, requestedPublicKeyBytes, encrypted);

            await pairingConsume({ pairId: status.pairId }).catch(() => {});

            await Modal.alertAsync(t('common.success'), t('common.done'));
            void startPairingWithAlert();
        } catch (e) {
            await Modal.alertAsync(t('common.error'), t('errors.operationFailed'));
        } finally {
            setApproving(false);
        }
    }, [auth.credentials, status, startPairingWithAlert]);

    const isAuthenticated = auth.isAuthenticated;
    const canRenderPairing = pairingEnabled && isAuthenticated;

    return (
        <ScrollView style={styles.scrollView} contentContainerStyle={{ flexGrow: 1 }}>
            <View style={styles.container}>
                <View style={styles.contentWrapper}>
                    <Text style={styles.title}>{t('settings.addYourPhone')}</Text>
                    <Text style={styles.subtitle}>{t('connect.addPhoneQrInstructions')}</Text>

                    {!isAuthenticated ? (
                        <View style={styles.requestCard}>
                            <Text style={styles.requestBody}>{t('modals.pleaseSignInFirst')}</Text>
                        </View>
                    ) : null}

                    {isAuthenticated && pairingState === 'unknown' ? (
                        <View style={styles.requestCard}>
                            <Text style={styles.requestBody}>{t('common.loading')}</Text>
                        </View>
                    ) : null}

                    {isAuthenticated && pairingState !== 'unknown' && !pairingEnabled ? (
                        <View style={styles.requestCard}>
                            <Text style={styles.requestBody}>{t('common.unavailable')}</Text>
                        </View>
                    ) : null}

                    {canRenderPairing ? (
                        <>
                            <View style={styles.qrBlock}>
                                <View testID="add-phone-qr" style={{ width: 260, height: 260, alignItems: 'center', justifyContent: 'center' }}>
                                {starting ? (
                                    <ActivityIndicator size="small" color={theme.colors.text} />
                                ) : deepLink ? (
                                    <QRCode
                                        data={deepLink}
                                        size={260}
                                        foregroundColor={theme.colors.text}
                                        backgroundColor={theme.colors.surface}
                                    />
                                ) : (
                                    <Text style={styles.requestBody}>
                                        {isExpired ? t('connect.pairingQrExpired') : t('common.unavailable')}
                                    </Text>
                                )}
                                </View>
                            </View>

                            {deepLink ? (
                                <Pressable
                                    testID="add-phone-pairing-link"
                                    accessibilityRole="button"
                                    onPress={async () => {
                                        await Clipboard.setStringAsync(deepLink);
                                        await Modal.alertAsync(t('common.success'), t('common.copied'));
                                    }}
                                    style={styles.linkRow}
                                >
                                    <Text style={styles.linkText} numberOfLines={3}>
                                        {deepLink}
                                    </Text>
                                </Pressable>
                            ) : null}

                            <View style={styles.linkActionsRow}>
                                <View style={styles.actionButton}>
                                    <RoundButton
                                        size="small"
                                        title={t('connect.generateNewQrCode')}
                                        action={startPairingWithAlert}
                                        display="inverted"
                                        disabled={starting}
                                    />
                                </View>
                            </View>

                            {status?.state === 'requested' ? (
                                <View testID="add-phone-request-card" style={styles.requestCard}>
                                    <Text style={styles.requestTitle}>{t('connect.pairingRequestTitle')}</Text>
                                    {status.requestedDeviceLabel ? (
                                        <Text style={styles.requestBody}>
                                            {t('connect.deviceLabel')}: <Text testID="add-phone-request-device-label">{status.requestedDeviceLabel}</Text>
                                        </Text>
                                    ) : null}
                                    <Text style={[styles.requestBody, { marginTop: status.requestedDeviceLabel ? 10 : 0 }]}>
                                        {t('connect.pairingRequestBody')}
                                    </Text>
                                    <Text style={[styles.requestBody, { marginTop: 10 }]}>{t('connect.confirmCodeLabel')}</Text>
                                    <Text testID="add-phone-request-confirm-code" style={styles.confirmCode}>{status.confirmCode}</Text>
                                    <View style={styles.footer}>
                                        <RoundButton
                                            testID="add-phone-approve"
                                            size="normal"
                                            title={t('connect.approveButton')}
                                            action={approve}
                                            disabled={approving}
                                            loading={approving}
                                        />
                                    </View>
                                </View>
                            ) : null}
                        </>
                    ) : null}
                </View>
            </View>
        </ScrollView>
    );
});
