import * as React from 'react';
import { AccessibilityInfo, Platform, Pressable, View, findNodeHandle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { ModalCardFrame } from '@/modal/components/card/ModalCardFrame';
import { t } from '@/text';
import { useNowMs } from '@/hooks/time/useNowMs';
import { actionOperationReentry } from '@/sync/domains/actionOperations/actionOperationReentry';

import {
    resolveActionOperationDetailContent,
    resolveActionOperationPresentation,
    type ActionOperationObservationPresentation,
    type ActionOperationPresentationStatus,
} from './actionOperationPresentation';
import { focusActionOperationHeading } from './focusActionOperationHeading';

export type ActionOperationDetailProps = Readonly<{
    operation: ActionOperationSnapshotV1 | null;
    observation: ActionOperationObservationPresentation;
    onClose: () => void;
    onOpenSession?: (sessionId: string) => void;
    onCancel?: () => void;
    cancelPending?: boolean;
    cancelFailed?: boolean;
}>;

function statusLabel(status: ActionOperationPresentationStatus): string {
    switch (status) {
        case 'accepted': return t('inbox.actionOperations.status.accepted');
        case 'running': return t('inbox.actionOperations.status.running');
        case 'succeeded': return t('inbox.actionOperations.status.succeeded');
        case 'failed': return t('inbox.actionOperations.status.failed');
        case 'cancelled': return t('inbox.actionOperations.status.cancelled');
        case 'reconnecting': return t('inbox.actionOperations.status.reconnecting');
        case 'status_unavailable': return t('inbox.actionOperations.status.unavailable');
        case 'setup_needs_attention': return t('inbox.actionOperations.status.setupNeedsAttention');
    }
}

function DetailField(props: Readonly<{ label: string; value: string; mono?: boolean }>) {
    return (
        <View style={styles.field}>
            <Text style={styles.fieldLabel}>{props.label}</Text>
            <Text selectable={true} style={[styles.fieldValue, props.mono ? styles.mono : null]}>{props.value}</Text>
        </View>
    );
}

function DetailStatusGlyph(props: Readonly<{ status: ActionOperationPresentationStatus }>) {
    const { theme } = useUnistyles();
    if (props.status === 'accepted' || props.status === 'running' || props.status === 'reconnecting') {
        return (
            <ActivitySpinner
                size={iconMatchedSpinnerSize(ICON_SIZE.md)}
                color={theme.colors.text.secondary}
                animationEnabled={props.status !== 'reconnecting'}
            />
        );
    }
    const icon = props.status === 'succeeded'
        ? 'check-circle'
        : props.status === 'failed'
            ? 'warning-circle'
            : props.status === 'cancelled'
                ? 'x-circle'
                : 'warning';
    const color = props.status === 'succeeded'
        ? theme.colors.state.success.foreground
        : props.status === 'failed'
            ? theme.colors.state.danger.foreground
            : theme.colors.text.secondary;
    return <Icon name={icon} size={ICON_SIZE.md} color={color} />;
}

function forkStrategyLabel(strategy: string): string {
    if (strategy === 'native') return t('session.forking.strategy.native.title');
    if (strategy === 'replay') return t('session.forking.strategy.replay.title');
    return strategy;
}

export const ActionOperationDetail = React.memo(function ActionOperationDetail(props: ActionOperationDetailProps) {
    React.useSyncExternalStore(
        actionOperationReentry.subscribe,
        actionOperationReentry.getRevision,
        actionOperationReentry.getRevision,
    );
    const { theme } = useUnistyles();
    const headingRef = React.useRef<React.ElementRef<typeof Text> | null>(null);
    const nowMs = useNowMs(30_000);

    React.useEffect(() => {
        focusActionOperationHeading(
            headingRef.current as unknown as Readonly<{ focus?: () => void }> | null,
            {
                platform: Platform.OS,
                setNativeFocus: (target) => {
                    const handle = findNodeHandle(target as never);
                    if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle);
                },
            },
        );
    }, []);

    if (!props.operation) {
        return (
            <ModalCardFrame
                testID="action-operation-detail"
                size="dialog"
                bodyStyle={styles.body}
                footer={<ActionOperationDetailFooter terminal={true} onClose={props.onClose} />}
            >
                <View style={styles.header}>
                    <Icon name="warning" size={ICON_SIZE.lg} color={theme.colors.text.secondary} />
                    <Text ref={headingRef} accessibilityRole="header" style={styles.title}>
                        {t('inbox.actionOperations.status.unavailable')}
                    </Text>
                </View>
                <Text accessibilityLiveRegion="polite" style={styles.unavailableCopy}>
                    {t('inbox.actionOperations.status.unavailable')}
                </Text>
            </ModalCardFrame>
        );
    }

    const presentation = resolveActionOperationPresentation(props.operation, props.observation, nowMs);
    const status = statusLabel(presentation.status);
    const detail = resolveActionOperationDetailContent(props.operation);
    const progress = [presentation.progressLabel, presentation.progressValue].filter(Boolean).join('  ');
    const liveMeta = [progress, presentation.timeValue].filter(Boolean).join('  ·  ');

    return (
        <ModalCardFrame
            testID="action-operation-detail"
            size="dialog"
            bodyScroll="auto"
            bodyStyle={styles.body}
            footer={(
                <ActionOperationDetailFooter
                    terminal={presentation.terminal}
                    canCancel={!presentation.terminal && props.operation.cancellation === 'supported'}
                    cancelPending={props.cancelPending}
                    onCancel={props.onCancel}
                    openSessionId={presentation.openSessionId}
                    onOpenSession={props.onOpenSession}
                    onClose={props.onClose}
                />
            )}
        >
            <View style={styles.header}>
                <View style={styles.iconSurface}>
                    <Icon name={detail.iconName} size={ICON_SIZE.md} color={theme.colors.text.primary} />
                </View>
                <View style={styles.titleColumn}>
                    <Text
                        ref={headingRef}
                        testID="action-operation-detail-heading"
                        accessibilityRole="header"
                        style={styles.title}
                    >
                        {props.operation.title}
                    </Text>
                    <Text style={styles.actionId}>{props.operation.actionId}</Text>
                </View>
            </View>

            <View accessibilityLiveRegion="polite" style={styles.statusHero}>
                <View style={styles.statusGlyph}>
                    <DetailStatusGlyph status={presentation.status} />
                </View>
                <View style={styles.statusCopy}>
                    <Text style={styles.statusLabel}>{status}</Text>
                    {liveMeta ? <Text style={styles.statusProgress}>{liveMeta}</Text> : null}
                </View>
            </View>

            {props.cancelFailed ? (
                <Text accessibilityLiveRegion="polite" style={styles.cancelError}>
                    {t('inbox.actionOperations.stopFailed')}
                </Text>
            ) : null}

            <View style={styles.fields}>
                {props.operation.error?.error ? (
                    <DetailField label={t('inbox.actionOperations.detail.error')} value={props.operation.error.error} />
                ) : null}
                {detail.warning ? (
                    <DetailField label={t('inbox.actionOperations.detail.warning')} value={detail.warning} />
                ) : null}
                {detail.resultSummary ? (
                    <DetailField label={t('inbox.actionOperations.detail.result')} value={detail.resultSummary} mono={true} />
                ) : null}
                {detail.forkStrategy ? (
                    <DetailField
                        label={t('session.forking.strategy.title')}
                        value={forkStrategyLabel(detail.forkStrategy)}
                    />
                ) : null}
            </View>
        </ModalCardFrame>
    );
});

export function ActionOperationDetailFooter(props: Readonly<{
    terminal: boolean;
    canCancel?: boolean;
    cancelPending?: boolean;
    onCancel?: () => void;
    openSessionId?: string | null;
    onOpenSession?: (sessionId: string) => void;
    onClose: () => void;
}>) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.footer}>
            {props.canCancel && props.onCancel ? (
                <Pressable
                    testID="action-operation-stop"
                    accessibilityRole="button"
                    disabled={props.cancelPending}
                    onPress={props.onCancel}
                    style={({ pressed }) => [
                        styles.button,
                        styles.stopButton,
                        pressed ? styles.buttonPressed : null,
                        props.cancelPending ? styles.buttonDisabled : null,
                    ]}
                >
                    <Icon name="stop" size={ICON_SIZE.sm} color={theme.colors.text.primary} />
                    <Text style={styles.buttonLabel}>
                        {props.cancelPending ? t('runs.stop.stoppingLabel') : t('inbox.actionOperations.stop')}
                    </Text>
                </Pressable>
            ) : null}
            {props.openSessionId && props.onOpenSession ? (
                <Pressable
                    testID="action-operation-open-session"
                    accessibilityRole="button"
                    onPress={() => props.onOpenSession?.(props.openSessionId!)}
                    style={({ pressed }) => [
                        styles.button,
                        styles.primaryButton,
                        { backgroundColor: theme.colors.button.primary.background },
                        pressed ? styles.buttonPressed : null,
                    ]}
                >
                    <Text style={[styles.buttonLabel, { color: theme.colors.button.primary.tint }]}>
                        {t('runs.openSession')}
                    </Text>
                    <Icon name="arrow-square-out" size={ICON_SIZE.sm} color={theme.colors.button.primary.tint} />
                </Pressable>
            ) : null}
            <Pressable
                testID="action-operation-close"
                accessibilityRole="button"
                onPress={props.onClose}
                style={({ pressed }) => [styles.button, styles.secondaryButton, pressed ? styles.buttonPressed : null]}
            >
                <Text style={styles.buttonLabel}>
                    {props.terminal ? t('common.done') : t('common.collapse')}
                </Text>
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    body: {
        paddingHorizontal: 20,
        paddingTop: 18,
        paddingBottom: 20,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        marginBottom: 18,
    },
    iconSurface: {
        width: 40,
        height: 40,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.elevated,
    },
    titleColumn: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        color: theme.colors.text.primary,
        fontSize: 18,
        lineHeight: 23,
        ...Typography.default('semiBold'),
    },
    actionId: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 18,
        marginTop: 2,
    },
    statusHero: {
        minHeight: 62,
        borderRadius: 14,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 14,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: theme.colors.surface.elevated,
    },
    statusGlyph: {
        width: 28,
        alignItems: 'center',
        justifyContent: 'center',
    },
    statusCopy: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    statusLabel: {
        color: theme.colors.text.primary,
        fontSize: 15,
        lineHeight: 20,
        ...Typography.default('semiBold'),
    },
    statusProgress: {
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
    },
    cancelError: {
        color: theme.colors.state.danger.foreground,
        fontSize: 13,
        lineHeight: 18,
        marginBottom: 10,
    },
    fields: {
        borderRadius: 14,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.elevated,
    },
    field: {
        gap: 4,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
    },
    fieldLabel: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    fieldValue: {
        color: theme.colors.text.primary,
        fontSize: 14,
        lineHeight: 20,
    },
    mono: {
        fontFamily: 'monospace',
        fontSize: 11.5,
        lineHeight: 17,
        fontVariant: ['tabular-nums'],
    },
    unavailableCopy: {
        color: theme.colors.text.secondary,
        fontSize: 15,
        lineHeight: 21,
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        flexWrap: 'wrap',
        gap: 8,
        paddingHorizontal: 14,
        paddingVertical: 12,
    },
    button: {
        minHeight: 40,
        paddingHorizontal: 14,
        borderRadius: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    primaryButton: {},
    stopButton: {
        backgroundColor: theme.colors.surface.elevated,
        marginRight: 'auto',
    },
    secondaryButton: {
        backgroundColor: theme.colors.surface.elevated,
    },
    buttonPressed: {
        transform: [{ scale: 0.96 }],
        opacity: 0.84,
    },
    buttonDisabled: {
        opacity: 0.48,
    },
    buttonLabel: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
}));
