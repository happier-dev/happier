import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { GlassLivePictureBackdropContext } from '@/components/ui/glass/livePictureBackdrop';
import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { Icon } from '@/components/ui/icons/Icon';
import { RecordingElapsed } from '@/components/ui/media/recording/RecordingElapsed';
import { WordCrossFade } from '@/components/ui/motion/WordCrossFade';
import type { NativeRecordingSnapshot } from '@/desktop/capture/nativeCapture';
import { useRecordingElapsedTime } from '@/hooks/ui/useRecordingElapsedTime';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { t } from '@/text';

/** Lab `rc` BAR: a 44 pt pill of 36 pt controls. */
export const RECORDING_CONTROL_HEIGHT = 44;
const CONTROL_SIZE = 36;
const DIVIDER_HEIGHT = 20;
const ROW_GAP = 2;

/** The second hand ticks here and nowhere else. */
function Elapsed(props: Readonly<{ snapshot: NativeRecordingSnapshot }>) {
    const seconds = useRecordingElapsedTime(props.snapshot.timing);
    return <RecordingElapsed seconds={seconds} paused={props.snapshot.phase === 'paused'} size="control" />;
}

/**
 * The control under the recorded area (lab `rc` BAR, MIS §7): steady dot, tabular timer, Pause, Stop (the
 * one filled control), Discard, and × to hide it while the recording goes on. It is kept out of the recording by the native capture filter.
 */
export function RecordingControlBar(props: Readonly<{
    snapshot: NativeRecordingSnapshot;
    onPause: () => void;
    onResume: () => void;
    onStop: () => void;
    onDiscard: () => void;
    /** Hides the control; the admitted recording keeps going. */
    onHide?: () => void;
}>) {
    const { theme } = useUnistyles();
    const { snapshot } = props;
    const paused = snapshot.phase === 'paused';
    const live = snapshot.phase === 'recording' || paused;
    const finalizing = snapshot.phase === 'finalizing';
    const toggleLabel = paused ? t('screenCapture.recording.resume') : t('screenCapture.recording.pause');
    return (
        <GlassLivePictureBackdropContext.Provider value>
            <GlassPanel surfaceGroup="content" shadowLevel={2} innerShadow={false} radius={RECORDING_CONTROL_HEIGHT / 2} style={styles.pill} testID="recording-control">
                <View role="toolbar" aria-label={t('screenCapture.recording.title')} style={styles.row}>
                    <View style={styles.elapsed}><Elapsed snapshot={snapshot} /></View>
                    <IconButton
                        variant="plain"
                        size={CONTROL_SIZE}
                        icon={(
                            <WordCrossFade wordKey={paused ? 'resume' : 'pause'}>
                                <Icon name={paused ? 'play' : 'pause'} weight="fill" size={18} color={theme.colors.text.primary} />
                            </WordCrossFade>
                        )}
                        accessibilityLabel={toggleLabel}
                        tooltip={toggleLabel}
                        tooltipPlacement="top"
                        disabled={!live}
                        interactiveTargetGapPx={ROW_GAP}
                        onPress={paused ? props.onResume : props.onPause}
                        testID="recording-control-pause"
                    />
                    <IconButton
                        fill="primary"
                        size={CONTROL_SIZE}
                        icon={<Icon name="stop" weight="fill" size={14} color={theme.colors.button.primary.tint} />}
                        accessibilityLabel={t('screenCapture.recording.stop')}
                        tooltip={finalizing ? t('screenCapture.recording.saving') : t('screenCapture.recording.stopShort')}
                        tooltipPlacement="top"
                        busy={finalizing}
                        disabled={snapshot.phase === 'preparing'}
                        interactiveTargetGapPx={ROW_GAP}
                        onPress={props.onStop}
                        testID="recording-control-stop"
                    />
                    <View style={styles.divider} />
                    <IconButton
                        variant="plain"
                        size={CONTROL_SIZE}
                        iconName="trash"
                        iconSize={18}
                        accessibilityLabel={t('screenCapture.window.discard')}
                        tooltip={t('screenCapture.window.discard')}
                        tooltipPlacement="top"
                        disabled={finalizing}
                        interactiveTargetGapPx={ROW_GAP}
                        onPress={props.onDiscard}
                        testID="recording-control-discard"
                    />
                    {props.onHide ? (
                        <IconButton
                            variant="plain"
                            size={CONTROL_SIZE}
                            iconName="x"
                            iconSize={16}
                            accessibilityLabel={t('screenCapture.recording.hideControl')}
                            tooltip={t('screenCapture.recording.hideControl')}
                            tooltipPlacement="top"
                            interactiveTargetGapPx={ROW_GAP}
                            onPress={props.onHide}
                            testID="recording-control-hide"
                        />
                    ) : null}
                </View>
            </GlassPanel>
        </GlassLivePictureBackdropContext.Provider>
    );
}

const styles = StyleSheet.create((theme) => ({
    pill: {
        height: RECORDING_CONTROL_HEIGHT,
        justifyContent: 'center',
        paddingLeft: theme.space.s12,
        paddingRight: theme.space.s4,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: ROW_GAP,
    },
    elapsed: {
        paddingRight: theme.space.s8,
    },
    divider: {
        width: StyleSheet.hairlineWidth * 2,
        height: DIVIDER_HEIGHT,
        marginHorizontal: theme.space.s4,
        backgroundColor: theme.colors.border.surface,
    },
}));
