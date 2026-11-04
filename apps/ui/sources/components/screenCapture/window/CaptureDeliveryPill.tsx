import * as React from 'react';
import { Image, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { WordCrossFade } from '@/components/ui/motion/WordCrossFade';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { CaptureDelivery } from './CaptureWindowScreen';

export const CAPTURE_PILL_HEIGHT = 52;

export type CapturePillState = (
    | Readonly<{ kind: 'sending'; session: string }>
    | Readonly<{ kind: 'adding'; session: string }>
    | Readonly<{ kind: 'starting' }>
    | Readonly<{ kind: 'started' }>
    | Readonly<{ kind: 'sent'; session: string; detail: string }>
    | Readonly<{ kind: 'added'; session: string; imageNumber: number; waiting: number }>
    | Readonly<{ kind: 'failed'; session: string; cause: string; operation?: CaptureDelivery | 'discard'; phase?: 'preparation' | 'delivery' }>
    | Readonly<{ kind: 'discarded'; title?: string }>
) & Readonly<{ cleanupWarning?: string }>;

/** A failure stays until the person answers it; what is still under way has not settled yet (MIS §6). */
export function capturePillLeavesOnItsOwn(state: CapturePillState): boolean {
    return !state.cleanupWarning && (state.kind === 'sent' || state.kind === 'added' || state.kind === 'started' || state.kind === 'discarded');
}

function pillLines(state: CapturePillState): Readonly<{ title: string; detail: string | null }> {
    switch (state.kind) {
        case 'sending': return { title: t('screenCapture.pill.sending', { session: state.session }), detail: null };
        case 'adding': return { title: t('screenCapture.pill.adding'), detail: state.session };
        case 'starting': return { title: t('screenCapture.pill.starting'), detail: null };
        case 'started': return { title: t('screenCapture.pill.started'), detail: null };
        case 'sent': return { title: t('screenCapture.pill.sent', { session: state.session }), detail: state.detail };
        case 'added': return {
            title: t('screenCapture.pill.added', { number: state.imageNumber }),
            detail: state.waiting > 1 ? t('screenCapture.pill.waiting', { session: state.session, count: state.waiting }) : state.session,
        };
        // One line per failed step, so Retry plainly repeats the step the title names.
        case 'failed': return {
            title: state.phase === 'preparation' ? t('screenCapture.pill.notPrepared')
                : state.operation === 'addToDraft' ? t('screenCapture.pill.notAdded')
                : t('screenCapture.pill.failed'),
            detail: state.cause,
        };
        case 'discarded': return { title: state.title ?? t('screenCapture.pill.discarded'), detail: null };
    }
}

/**
 * What the window folds into (MIS §6): a thumbnail of what went, a line that names where, and the way
 * back. The one status region of the delivery; it announces itself once per state.
 */
export const CaptureDeliveryPill = React.memo(function CaptureDeliveryPill(props: Readonly<{
    state: CapturePillState;
    thumbnailUri: string | null;
    onOpen?: () => void;
    onRetry?: () => void;
    onEdit?: () => void;
    onUndo?: () => void;
}>) {
    const { theme } = useUnistyles();
    const { state } = props;
    const baseLines = pillLines(state);
    const lines = state.cleanupWarning
        ? { ...baseLines, detail: [baseLines.detail, state.cleanupWarning].filter(Boolean).join(' · ') }
        : baseLines;
    const busy = state.kind === 'sending' || state.kind === 'adding' || state.kind === 'starting';
    const failed = state.kind === 'failed';
    return (
        <View style={[styles.row, state.kind === 'discarded' ? styles.rowPlain : null]} accessibilityRole="none" accessibilityLiveRegion="polite" role="status" testID="capture-delivery-pill">
            {props.thumbnailUri && state.kind !== 'discarded' ? (
                <View style={styles.thumbFrame}>
                    <Image source={{ uri: props.thumbnailUri }} style={styles.thumb} resizeMode="cover" />
                </View>
            ) : null}
            <View style={styles.lines}>
                <WordCrossFade wordKey={lines.title} style={styles.titleRow}>
                    {busy
                        ? <ActivitySpinner size={14} color={theme.colors.text.secondary} />
                        : state.kind === 'discarded'
                            ? null
                            : <Icon name={failed ? 'warning' : 'check-circle'} size={14} color={failed ? theme.colors.state.danger.foreground : theme.colors.text.secondary} />}
                    <Text variant="body" emphasis="semiBold" numberOfLines={1} style={styles.title}>{lines.title}</Text>
                </WordCrossFade>
                {lines.detail ? <Text variant="meta" numberOfLines={1} style={styles.detail}>{lines.detail}</Text> : null}
            </View>
            {failed ? (
                <View style={styles.actions}>
                    {props.onEdit ? <RoundButton size="small" capsuleHeight={36} display="secondary" title={t('screenCapture.pill.edit')} onPress={props.onEdit} /> : null}
                    {props.onRetry ? <RoundButton size="small" capsuleHeight={36} title={t('common.retry')} onPress={props.onRetry} /> : null}
                </View>
            ) : state.kind === 'discarded' ? (
                props.onUndo ? <RoundButton size="small" capsuleHeight={36} display="secondary" title={t('common.undo')} onPress={props.onUndo} /> : null
            ) : state.kind !== 'started' && props.onOpen ? (
                <RoundButton size="small" capsuleHeight={36} display="secondary" title={t('screenCapture.pill.open')} onPress={props.onOpen} />
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    row: {
        height: CAPTURE_PILL_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        paddingLeft: theme.space.s8,
        paddingRight: theme.space.s8,
    },
    rowPlain: {
        paddingLeft: theme.space.s20,
    },
    thumbFrame: {
        width: 52,
        height: 36,
        borderRadius: theme.borderRadius.sm,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.base,
    },
    thumb: {
        width: '100%',
        height: '100%',
    },
    lines: {
        flexShrink: 1,
        flexGrow: 1,
        minWidth: 0,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    title: {
        flexShrink: 1,
        color: theme.colors.text.primary,
    },
    detail: {
        color: theme.colors.text.secondary,
    },
    actions: {
        flexDirection: 'row',
        gap: theme.space.s6,
    },
}));
