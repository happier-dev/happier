import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { CaptureWindowTextView } from './captureWindowTextView';

const ACTION_HEIGHT = 32;
const NOTICE_WIDTH = 320;
const QUESTION_WIDTH = 360;

/** The three things the chip can say out loud (lab `wt` B, BW, P). The rule decides when; this draws them. */
export function CaptureWindowTextAsk(props: Readonly<{
    ask: CaptureWindowTextView['ask'];
    anchorRef: React.RefObject<View | null>;
    boundaryRef: React.RefObject<View | null>;
    onResolveBlurWarning: (include: boolean) => void;
    onOpenPermissionSettings: () => void;
    onDeclinePermission: () => void;
}>) {
    const { theme } = useUnistyles();
    const keepOffRef = React.useRef<unknown>(null);
    // Popover keeps its last child through the exit; the ask that left stays drawn while it fades.
    const [shown, setShown] = React.useState<Exclude<CaptureWindowTextView['ask'], 'none'>>('blurred');
    if (props.ask !== 'none' && props.ask !== shown) setShown(props.ask);
    const dismiss = shown === 'includeBlurred' ? () => props.onResolveBlurWarning(false)
        : shown === 'permission' ? props.onDeclinePermission : undefined;
    return (
        <Popover
            open={props.ask !== 'none'}
            anchorRef={props.anchorRef}
            boundaryRef={props.boundaryRef}
            placement="top"
            gap={theme.space.s8}
            maxWidthCap={shown === 'blurred' ? NOTICE_WIDTH : QUESTION_WIDTH}
            portal={MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
            backdrop={false}
            accessibilityLabel={shown === 'permission' ? t('screenCapture.windowText.permissionTitle') : t('screenCapture.window.wholeWindowText')}
            containerStyle={styles.container}
            {...(shown === 'includeBlurred' ? { autoFocusOnOpen: true, initialFocusRef: keepOffRef } : {})}
            {...(dismiss ? { onRequestClose: dismiss } : {})}
        >
            {() => (
                <FloatingOverlay maxHeight={480} surfaceChrome="theme" scrollEnabled={false}>
                    {shown === 'blurred' ? (
                        <Body icon="lock" title={t('screenCapture.windowText.lockedTitle')} body={t('screenCapture.windowText.lockedBody')} role="status" />
                    ) : shown === 'includeBlurred' ? (
                        <Body icon="warning" iconColor={theme.colors.state.attention.foreground} title={t('screenCapture.windowText.includeTitle')} body={t('screenCapture.windowText.includeBody')} role="alertdialog">
                            <View style={styles.actions}>
                                <RoundButton controlRef={(node) => { keepOffRef.current = node; }} size="small" capsuleHeight={ACTION_HEIGHT} title={t('screenCapture.windowText.keepOff')} onPress={() => props.onResolveBlurWarning(false)} testID="capture-window-text-keep-off" />
                                <RoundButton size="small" capsuleHeight={ACTION_HEIGHT} display="secondary" title={t('screenCapture.windowText.includeText')} onPress={() => props.onResolveBlurWarning(true)} testID="capture-window-text-include" />
                            </View>
                        </Body>
                    ) : (
                        <Body icon="eye" title={t('screenCapture.windowText.permissionTitle')} body={t('screenCapture.windowText.permissionBody')} role="dialog">
                            <View style={styles.steps}>
                                <Step number={1} text={t('screenCapture.windowText.permissionOpen')} />
                                <Step number={2} text={t('screenCapture.windowText.permissionEnable')} />
                            </View>
                            <View style={styles.waiting}>
                                <ActivitySpinner size={14} color={theme.colors.text.secondary} />
                                <Text variant="meta" style={styles.waitingText}>{t('screenCapture.windowText.permissionWaiting')}</Text>
                            </View>
                            <View style={styles.actions}>
                                <RoundButton size="small" capsuleHeight={ACTION_HEIGHT} title={t('screenCapture.permission.openSettings')} onPress={props.onOpenPermissionSettings} testID="capture-window-text-open-settings" />
                                <TextLinkButton label={t('screenCapture.permission.notNow')} onPress={props.onDeclinePermission} testID="capture-window-text-not-now" />
                            </View>
                        </Body>
                    )}
                </FloatingOverlay>
            )}
        </Popover>
    );
}

function Body(props: Readonly<{
    icon: IconName;
    iconColor?: string;
    title: string;
    body: string;
    role: 'status' | 'alertdialog' | 'dialog';
    children?: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.body} role={props.role} aria-label={props.title} testID={`capture-window-text-ask-${props.role}`}>
            <View style={styles.glyph}>
                <Icon name={props.icon} size={16} color={props.iconColor ?? theme.colors.text.secondary} />
            </View>
            <View style={styles.column}>
                <Text variant="body" emphasis="semiBold" style={styles.title}>{props.title}</Text>
                <Text variant="body" style={styles.text}>{props.body}</Text>
                {props.children}
            </View>
        </View>
    );
}

function Step(props: Readonly<{ number: number; text: string }>) {
    return (
        <View style={styles.step}>
            <View style={styles.stepNumber}><Text variant="micro" style={styles.text}>{props.number}</Text></View>
            <Text variant="meta" style={styles.text}>{props.text}</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        paddingHorizontal: 0,
    },
    body: {
        flexDirection: 'row',
        gap: theme.space.s10,
        padding: theme.space.s16,
    },
    glyph: {
        paddingTop: theme.space.s2,
    },
    column: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        color: theme.colors.text.primary,
    },
    text: {
        color: theme.colors.text.secondary,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        marginTop: theme.space.s12,
    },
    steps: {
        gap: theme.space.s6,
        marginTop: theme.space.s10,
    },
    step: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    stepNumber: {
        width: 18,
        height: 18,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: theme.colors.border.strong,
        alignItems: 'center',
        justifyContent: 'center',
    },
    waiting: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        marginTop: theme.space.s10,
    },
    waitingText: {
        color: theme.colors.text.secondary,
    },
}));
