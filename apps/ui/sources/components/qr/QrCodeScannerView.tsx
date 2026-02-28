import * as React from 'react';
import { ActivityIndicator, AppState, Linking, Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { isRunningOnMac } from '@/utils/platform/platform';
import { isWebQrScannerSupported } from '@/utils/platform/qrScannerSupport';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    camera: {
        ...StyleSheet.absoluteFillObject,
    },
    overlay: {
        ...StyleSheet.absoluteFillObject,
        paddingHorizontal: 20,
        paddingTop: 18,
        paddingBottom: 18,
        justifyContent: 'space-between',
    },
    topRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    closeButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.overlay.scrim,
    },
    titleBlock: {
        flex: 1,
        paddingHorizontal: 12,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 18,
        color: theme.colors.overlay.text,
        textAlign: 'center',
    },
    subtitle: {
        ...Typography.default(),
        marginTop: 6,
        fontSize: 13,
        color: theme.colors.overlay.textSecondary,
        textAlign: 'center',
        lineHeight: 18,
    },
    spacer: {
        width: 40,
        height: 40,
    },
    footer: {
        width: '100%',
        alignItems: 'center',
        gap: 10,
    },
    footerButton: {
        width: '100%',
        maxWidth: 360,
    },
    permissionsCard: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
        gap: 14,
    },
    permissionsTitle: {
        ...Typography.default('semiBold'),
        fontSize: 18,
        color: theme.colors.text,
        textAlign: 'center',
    },
    permissionsBody: {
        ...Typography.default(),
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        lineHeight: 20,
    },
}));

export interface QrCodeScannerViewProps {
    title: string;
    subtitle?: string;
    permissionRequiredMessage: string;
    unavailableMessage?: string;
    onScan: (data: string) => void | Promise<void>;
    onCancel: () => void;
    footer?: React.ReactNode;
    testIDPrefix: string;
}

export const QrCodeScannerView = React.memo(function QrCodeScannerView(props: QrCodeScannerViewProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { width, height } = useWindowDimensions();

    const [permission, requestPermission] = useCameraPermissions();
    const isProcessingRef = React.useRef(false);

    const canUseCamera = React.useMemo(() => {
        if (isRunningOnMac()) return false;
        if (Platform.OS !== 'web') return true;
        if (!isWebQrScannerSupported()) return false;
        return isWebMobileLikeQrScannerHost({ width, height });
    }, [height, width]);

    React.useEffect(() => {
        if (!canUseCamera) return;
        if (Platform.OS === 'web') return;
        if (permission?.granted) return;
        void requestPermission().catch(() => {});
    }, [canUseCamera, permission?.granted, requestPermission]);

    React.useEffect(() => {
        if (!canUseCamera) return;
        if (Platform.OS === 'web') return;
        if (permission?.granted) return;

        const sub = AppState.addEventListener('change', (state) => {
            if (state === 'active') {
                void requestPermission().catch(() => {});
            }
        });

        return () => {
            sub.remove();
        };
    }, [canUseCamera, permission?.granted, requestPermission]);

    const onBarcodeScanned = React.useCallback(
        async (result: BarcodeScanningResult) => {
            if (!canUseCamera) return;
            if (isProcessingRef.current) return;
            isProcessingRef.current = true;
            try {
                await props.onScan(String(result?.data ?? ''));
            } finally {
                isProcessingRef.current = false;
            }
        },
        [canUseCamera, props],
    );

    if (!canUseCamera) {
        return (
            <View style={styles.permissionsCard}>
                <Text style={styles.permissionsTitle}>{props.title}</Text>
                <Text style={styles.permissionsBody}>{props.unavailableMessage ?? t('modals.qrScannerUnavailable')}</Text>
                {props.footer ? <View style={styles.footer}>{props.footer}</View> : null}
                <View style={styles.footerButton}>
                    <RoundButton
                        testID={`${props.testIDPrefix}-cancel`}
                        size="normal"
                        title={t('common.back')}
                        action={async () => props.onCancel()}
                    />
                </View>
            </View>
        );
    }

    if (!permission) {
        return (
            <View style={styles.permissionsCard}>
                <ActivityIndicator size="small" color={theme.colors.text} />
                <Text style={styles.permissionsBody}>{t('common.loading')}</Text>
            </View>
        );
    }

    if (!permission.granted) {
        return (
            <View style={styles.permissionsCard}>
                <Text style={styles.permissionsTitle}>{props.title}</Text>
                <Text style={styles.permissionsBody}>{props.permissionRequiredMessage}</Text>
                <View style={styles.footerButton}>
                    <RoundButton
                        testID={`${props.testIDPrefix}-retry-permission`}
                        size="normal"
                        title={t('common.retry')}
                        action={async () => {
                            await requestPermission().catch(() => {});
                        }}
                    />
                </View>
                {Platform.OS !== 'web' ? (
                    <View style={styles.footerButton}>
                        <RoundButton
                            testID={`${props.testIDPrefix}-open-settings`}
                            size="small"
                            title={t('modals.openSettings')}
                            display="inverted"
                            action={async () => {
                                await Linking.openSettings().catch(() => {});
                            }}
                        />
                    </View>
                ) : null}
                <View style={styles.footerButton}>
                    <RoundButton
                        testID={`${props.testIDPrefix}-cancel`}
                        size="small"
                        title={t('common.cancel')}
                        display="inverted"
                        action={async () => props.onCancel()}
                    />
                </View>
                {props.footer ? <View style={styles.footer}>{props.footer}</View> : null}
            </View>
        );
    }

    return (
        <View style={styles.root}>
            <CameraView
                style={styles.camera}
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={onBarcodeScanned}
                testID={`${props.testIDPrefix}-camera`}
            />
            <View style={styles.overlay} pointerEvents="box-none">
                <View style={styles.topRow} pointerEvents="box-none">
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('common.cancel')}
                        testID={`${props.testIDPrefix}-close`}
                        onPress={props.onCancel}
                        style={styles.closeButton}
                    >
                        <Ionicons name="close" size={22} color={theme.colors.overlay.text} />
                    </Pressable>
                    <View style={styles.titleBlock} pointerEvents="none">
                        <Text style={styles.title}>{props.title}</Text>
                        {props.subtitle ? <Text style={styles.subtitle}>{props.subtitle}</Text> : null}
                    </View>
                    <View style={styles.spacer} pointerEvents="none" />
                </View>

                <View style={styles.footer} pointerEvents="box-none">
                    {props.footer}
                </View>
            </View>
        </View>
    );
});
