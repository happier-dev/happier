import * as React from 'react';
import { AppState, Linking, Platform, useWindowDimensions, View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { canUseCurrentDeviceQrScanner } from '@/utils/platform/qrScannerSupport';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    camera: {
        ...StyleSheet.absoluteFillObject,
    },
    overlay: {
        ...StyleSheet.absoluteFillObject,
        paddingHorizontal: theme.space.s20,
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
        backgroundColor: theme.colors.overlay.foreground,
    },
    titleBlock: {
        flex: 1,
        paddingHorizontal: theme.space.s12,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 18,
        color: theme.colors.overlay.foreground,
        textAlign: 'center',
    },
    subtitle: {
        marginTop: theme.space.s6,
        ...Typography.variant('body'),
        color: theme.colors.overlay.secondaryForeground,
        textAlign: 'center',
    },
    spacer: {
        width: 40,
        height: 40,
    },
    footer: {
        width: '100%',
        alignItems: 'center',
        gap: theme.space.s10,
    },
    footerButton: {
        width: '100%',
        maxWidth: 360,
    },
    // On a step column the action spans the column like every other step's primary.
    embeddedFooterButton: {
        width: '100%',
    },
    permissionsCard: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: theme.space.s24,
        gap: 14,
    },
    permissionsTitle: {
        ...Typography.default('semiBold'),
        fontSize: 18,
        color: theme.colors.text.primary,
        textAlign: 'center',
    },
    permissionsBody: {
        ...Typography.default(),
        fontSize: 14,
        color: theme.colors.text.secondary,
        textAlign: 'center',
        lineHeight: 20,
    },
    // Embedded, the state is a paragraph and its actions on the host's column: it starts at the
    // column's edge under the host's heading instead of centring itself in a box of its own.
    embeddedPermissions: {
        width: '100%',
        alignItems: 'flex-start',
        gap: theme.space.s16,
    },
    embeddedPermissionsBody: {
        ...Typography.variant('reading'),
        color: theme.colors.text.secondary,
    },
    embeddedFooter: {
        width: '100%',
        alignItems: 'flex-start',
        gap: theme.space.s12,
    },
}));

export interface QrCodeScannerViewProps {
    previewRef?: React.Ref<View>;
    active?: boolean;
    title: string;
    subtitle?: string;
    permissionRequiredMessage: string;
    unavailableMessage?: string;
    onScan: (data: string) => void | Promise<void>;
    /** Leaves the scanner. Omitted when the host already draws the way back (the welcome pane's chevron). */
    onCancel?: () => void;
    footer?: React.ReactNode;
    testIDPrefix: string;
    /**
     * When true, suppresses the view's own title/subtitle chrome so callers can render
     * a consistent outer shell (e.g. the onboarding wizard modal) without duplicate headers.
     */
    embedded?: boolean;
}

export const QrCodeScannerView = React.memo(function QrCodeScannerView(props: QrCodeScannerViewProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { height } = useWindowDimensions();
    const closeIconColor = theme.dark ? theme.colors.background.canvas : theme.colors.text.primary;
    const scannerActive = props.active ?? true;

    const canQueryCameraPermission = Platform.OS !== 'web'
        || (typeof navigator !== 'undefined' && typeof navigator.permissions?.query === 'function');
    const [permission, requestPermission] = useCameraPermissions({ get: canQueryCameraPermission });
    const isProcessingRef = React.useRef(false);

    const canUseCamera = scannerActive && canUseCurrentDeviceQrScanner();
    const previewMinHeight = React.useMemo(() => {
        if (Platform.OS !== 'web' && !props.embedded) return null;
        return Math.max(280, Math.min(Math.round(height * 0.6), 520));
    }, [height, props.embedded]);

    React.useEffect(() => {
        if (!canUseCamera) return;
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
            if (!scannerActive) return;
            if (!canUseCamera) return;
            if (isProcessingRef.current) return;
            isProcessingRef.current = true;
            try {
                await props.onScan(String(result?.data ?? ''));
            } finally {
                isProcessingRef.current = false;
            }
        },
        [canUseCamera, props, scannerActive],
    );

    if (!scannerActive) {
        return <View style={styles.root} />;
    }

    const embedded = props.embedded === true;
    const stateStyle = embedded ? styles.embeddedPermissions : styles.permissionsCard;
    const bodyStyle = embedded ? styles.embeddedPermissionsBody : styles.permissionsBody;
    const footerStyle = embedded ? styles.embeddedFooter : styles.footer;
    const onCancel = props.onCancel;

    if (!canUseCamera) {
        return (
            <View style={stateStyle}>
                {embedded ? null : <Text style={styles.permissionsTitle}>{props.title}</Text>}
                <Text style={bodyStyle}>{props.unavailableMessage ?? t('modals.qrScannerUnavailable')}</Text>
                {props.footer ? <View style={footerStyle}>{props.footer}</View> : null}
                {onCancel ? (
                    <View style={styles.footerButton}>
                        <RoundButton
                            testID={`${props.testIDPrefix}-cancel`}
                            size="normal"
                            title={t('common.back')}
                            action={async () => onCancel()}
                        />
                    </View>
                ) : null}
            </View>
        );
    }

    if (!permission) {
        return (
            <View style={stateStyle}>
                <ActivitySpinner size="small" color={theme.colors.text.primary} />
                <Text style={bodyStyle}>{t('common.loading')}</Text>
                {/*
                 * The platform has not answered yet, and an unanswered request stays here.
                 * Pasting the pairing link and leaving must stay reachable exactly as they
                 * are once the answer is "denied"; a spinner is not an exit.
                 */}
                {props.footer ? <View style={footerStyle}>{props.footer}</View> : null}
                {onCancel ? (
                    <View style={styles.footerButton}>
                        <RoundButton
                            testID={`${props.testIDPrefix}-cancel`}
                            size="small"
                            title={t('common.cancel')}
                            display="inverted"
                            action={async () => onCancel()}
                        />
                    </View>
                ) : null}
            </View>
        );
    }

    if (!permission.granted) {
        return (
            <View style={stateStyle}>
                {embedded ? null : <Text style={styles.permissionsTitle}>{props.title}</Text>}
                <Text style={bodyStyle}>{props.permissionRequiredMessage}</Text>
                <View style={embedded ? styles.embeddedFooterButton : styles.footerButton}>
                    <RoundButton
                        testID={`${props.testIDPrefix}-retry-permission`}
                        // Embedded, it is the step's one primary: the pane's action tier, not a dialog button.
                        size={embedded ? 'large' : 'normal'}
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
                {onCancel ? (
                    <View style={styles.footerButton}>
                        <RoundButton
                            testID={`${props.testIDPrefix}-cancel`}
                            size="small"
                            title={t('common.cancel')}
                            display="inverted"
                            action={async () => onCancel()}
                        />
                    </View>
                ) : null}
                {props.footer ? <View style={footerStyle}>{props.footer}</View> : null}
            </View>
        );
    }

    return (
        <View
            style={[
                styles.root,
                previewMinHeight != null
                    ? {
                        width: '100%',
                        minHeight: previewMinHeight,
                    }
                    : null,
            ]}
        >
            <View ref={props.previewRef} style={StyleSheet.absoluteFill} collapsable={props.previewRef == null}
                accessible={props.previewRef != null} accessibilityRole={props.previewRef ? 'image' : undefined}
                accessibilityLabel={props.previewRef ? props.title : undefined}>
                <CameraView
                    style={styles.camera}
                    barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                    onBarcodeScanned={onBarcodeScanned}
                    testID={`${props.testIDPrefix}-camera`}
                />
            </View>
            <View style={styles.overlay} pointerEvents="box-none">
                <View style={styles.topRow} pointerEvents="box-none">
                    {onCancel ? (
                        <HappierPressable
                            accessibilityRole="button"
                            accessibilityLabel={t('common.cancel')}
                            testID={`${props.testIDPrefix}-close`}
                            onPress={onCancel}
                            style={styles.closeButton}
                        >
                            <Icon
                                testID={`${props.testIDPrefix}-close-icon`}
                                name="x"
                                size={20}
                                color={closeIconColor}
                            />
                        </HappierPressable>
                    ) : (
                        <View style={styles.spacer} pointerEvents="none" />
                    )}
                    {props.embedded ? (
                        <View style={styles.spacer} pointerEvents="none" />
                    ) : (
                        <View style={styles.titleBlock} pointerEvents="none">
                            <Text style={styles.title}>{props.title}</Text>
                            {props.subtitle ? <Text style={styles.subtitle}>{props.subtitle}</Text> : null}
                        </View>
                    )}
                    <View style={styles.spacer} pointerEvents="none" />
                </View>

                <View style={styles.footer} pointerEvents="box-none">
                    {props.footer}
                </View>
            </View>
        </View>
    );
});
