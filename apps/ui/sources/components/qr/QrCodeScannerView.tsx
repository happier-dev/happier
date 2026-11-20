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
import { StepQuietAction } from '@/components/onboarding/unauthShell/StepFormParts';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    camera: {
        ...StyleSheet.absoluteFillObject,
    },
    // A host-sized preview is a window on the page: the camera's dark before the first frame, the card radius.
    // Without a camera the window keeps its size and radius on the page's own surface, so its words read.
    deniedWindow: {
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s24,
    },
    deniedText: {
        ...Typography.variant('reading'),
        textAlign: 'center',
        maxWidth: 320,
    },
    hostedPreview: {
        flexGrow: 0,
        flexShrink: 0,
        flexBasis: 'auto',
        width: '100%',
        overflow: 'hidden',
        borderRadius: theme.borderRadius.xl,
        backgroundColor: theme.colors.overlay.stageImmersive,
    },
    finder: {
        position: 'absolute',
        top: '22%',
        bottom: '22%',
        left: '22%',
        right: '22%',
    },
    finderCorner: {
        position: 'absolute',
        width: 28,
        height: 28,
        borderColor: theme.colors.overlay.foreground,
    },
    finderTopLeft: { top: 0, left: 0, borderTopWidth: 2, borderLeftWidth: 2, borderTopLeftRadius: 10 },
    finderTopRight: { top: 0, right: 0, borderTopWidth: 2, borderRightWidth: 2, borderTopRightRadius: 10 },
    finderBottomLeft: { bottom: 0, left: 0, borderBottomWidth: 2, borderLeftWidth: 2, borderBottomLeftRadius: 10 },
    finderBottomRight: { bottom: 0, right: 0, borderBottomWidth: 2, borderRightWidth: 2, borderBottomRightRadius: 10 },
    overlay: {
        ...StyleSheet.absoluteFillObject,
        paddingHorizontal: theme.space.s20,
        paddingTop: 18,
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
    cameraFooter: {
        position: 'absolute',
        left: theme.space.s20,
        right: theme.space.s20,
        bottom: 18,
        width: 'auto',
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
    /**
     * The preview's height when the host sizes it (a step column that keeps its status and ways under the camera);
     * omitted, the scanner sizes its own preview.
     */
    previewHeight?: number;
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
        if (props.previewHeight != null) return null;
        if (Platform.OS !== 'web' && !props.embedded) return null;
        return Math.max(280, Math.min(Math.round(height * 0.6), 520));
    }, [height, props.embedded, props.previewHeight]);

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
    const cameraVisible = canUseCamera && permission?.granted === true;
    // Permission changes may move this footer, including while Back has focused one of its controls.
    const footer = props.footer ? (
        <View key="scanner-footer" style={cameraVisible ? [styles.footer, styles.cameraFooter] : footerStyle}
            pointerEvents={cameraVisible ? 'box-none' : undefined}>
            {props.footer}
        </View>
    ) : null;

    if (!canUseCamera) {
        return (
            <View style={stateStyle}>
                {embedded ? null : <Text style={styles.permissionsTitle}>{props.title}</Text>}
                <Text style={bodyStyle}>{props.unavailableMessage ?? t('modals.qrScannerUnavailable')}</Text>
                {footer}
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
                {footer}
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

    if (!permission.granted && embedded && props.previewHeight != null) {
        // A step keeps its camera window (lab direction A "Point at your computer"): the reason inside it, and Retry
        // as the window's quiet way, so nothing jumps when the camera answers.
        return (
            <View style={styles.embeddedPermissions}>
                <View testID={`${props.testIDPrefix}-denied`} style={[styles.hostedPreview, styles.deniedWindow, { height: props.previewHeight }]}>
                    <Icon name="camera" size={24} color={theme.colors.text.secondary} />
                    <Text style={[styles.deniedText, { color: theme.colors.text.secondary }]}>
                        {props.permissionRequiredMessage}
                    </Text>
                    <StepQuietAction
                        testID={`${props.testIDPrefix}-retry-permission`}
                        label={t('common.retry')}
                        onPress={() => { void requestPermission().catch(() => {}); }}
                    />
                    {Platform.OS !== 'web' ? (
                        <StepQuietAction
                            testID={`${props.testIDPrefix}-open-settings`}
                            label={t('modals.openSettings')}
                            onPress={() => { void Linking.openSettings().catch(() => {}); }}
                        />
                    ) : null}
                </View>
                {footer}
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
                {footer}
            </View>
        );
    }

    return (
        <View
            testID={`${props.testIDPrefix}-preview`}
            style={[
                styles.root,
                previewMinHeight != null
                    ? {
                        width: '100%',
                        minHeight: previewMinHeight,
                    }
                    : null,
                props.previewHeight != null ? styles.hostedPreview : null,
                props.previewHeight != null ? { height: props.previewHeight } : null,
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
            {/* The finder: four corners that say where the code goes, centred in whatever the preview's size. */}
            <View style={styles.finder} pointerEvents="none" testID={`${props.testIDPrefix}-finder`}>
                <View style={[styles.finderCorner, styles.finderTopLeft]} />
                <View style={[styles.finderCorner, styles.finderTopRight]} />
                <View style={[styles.finderCorner, styles.finderBottomLeft]} />
                <View style={[styles.finderCorner, styles.finderBottomRight]} />
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

            </View>
            {footer}
        </View>
    );
});
