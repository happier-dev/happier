import * as React from 'react';
import { View, type BlurEvent, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import { useDesktopWindowDragMouseProps } from '@/components/navigation/desktopWindowChrome/DesktopWindowDragRegion';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';

import { GlassLivePictureBackdropContext } from '@/components/ui/glass/livePictureBackdrop';
import { GlassPanel } from '@/components/ui/glass/GlassPanel';

import { CaptureDeliveryPill, CAPTURE_PILL_HEIGHT } from '../window/CaptureDeliveryPill';
import type { CaptureRect } from '../window/resolveCaptureWindowFrame';
import { RecordingControlBar, RECORDING_CONTROL_HEIGHT } from './RecordingControlBar';
import { resolveRecordingControlPlace } from './recordingEditorProjection';
import type { NativeRecordingSnapshot } from '@/desktop/capture/nativeCapture';

const DISCARD_PILL_WIDTH = 280;

/**
 * The Capture window while recording (MIS §7): only the control, under the area, rising into place. The
 * native window is exactly this small, so everything around it stays the person's to click.
 */
export function RecordingControlWindow(props: Readonly<{
    /** Null once the movie is finalized and only the discard hold remains. */
    snapshot: NativeRecordingSnapshot | null;
    area: CaptureRect | null;
    workArea: CaptureRect;
    /** The discarded recording, held until Undo or the pill's hold ends. */
    discarded: boolean;
    /** Presents the window at the pill's frame; the pill fills it, so the app's glass follows its radius. */
    onPresent: (frame: CaptureRect, glassRadius: number) => void;
    onPause: () => void;
    onResume: () => void;
    onStop: () => void;
    onDiscard: () => void;
    onUndoDiscard?: () => void;
    onDiscardHoldEnded: () => void;
    /** Closing the control does not stop the admitted recording. Also used by its close affordance. */
    onClose?: () => void;
}>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const dragProps = useDesktopWindowDragMouseProps();
    useEscapeLayer({ priority: ESCAPE_LAYER_PRIORITIES.overlay, enabled: props.onClose !== undefined,
        allowEditableTarget: true, onEscape: () => { props.onClose?.(); return true; } });
    const { area, discarded, onPresent, workArea } = props;
    const holdEnded = React.useRef(props.onDiscardHoldEnded);
    holdEnded.current = props.onDiscardHoldEnded;
    const pillRef = React.useRef<View>(null);
    const [focused, setFocused] = React.useState(false);
    useKeyboardShortcutHandlers(focused && !discarded ? {
        'screenCapture.recording.playPause': () => {
            if (props.snapshot?.phase === 'recording') props.onPause();
            else if (props.snapshot?.phase === 'paused') props.onResume();
            else return false;
            return true;
        },
    } : {});
    const [width, setWidth] = React.useState(0);
    const onLayout = (event: LayoutChangeEvent) => setWidth(Math.ceil(event.nativeEvent.layout.width));
    const pillWidth = discarded ? DISCARD_PILL_WIDTH : width;
    const pillHeight = discarded ? CAPTURE_PILL_HEIGHT : RECORDING_CONTROL_HEIGHT;
    const place = React.useMemo(() => pillWidth > 0 ? resolveRecordingControlPlace({
        area, pill: { width: pillWidth, height: pillHeight }, workArea, gap: theme.space.s16,
    }) : null, [area, pillHeight, pillWidth, theme.space.s16, workArea]);
    const frame = React.useMemo(() => place ? {
        x: place.x, y: place.y,
        width: pillWidth, height: pillHeight,
    } : null, [pillHeight, pillWidth, place]);
    React.useEffect(() => { if (frame) onPresent(frame, frame.height / 2); }, [frame, onPresent]);

    const risen = React.useRef(false);
    React.useLayoutEffect(() => {
        if (!frame || risen.current) return;
        risen.current = true;
        const { enterMs, fromDistance } = motionTokens.overlay.popover;
        (pillRef.current as unknown as HTMLElement | null)?.animate(
            reducedMotion
                ? [{ opacity: 0 }, { opacity: 1 }]
                : [{ opacity: 0, translate: `0 ${fromDistance}px` }, { opacity: 1, translate: '0 0' }],
            { duration: enterMs, easing: motionTokens.easingCss.standard },
        );
    }, [frame, reducedMotion]);

    React.useEffect(() => {
        if (!discarded) return;
        const timer = setTimeout(() => holdEnded.current(), motionTokens.undoHoldMs);
        return () => clearTimeout(timer);
    }, [discarded]);

    return (
        <View style={styles.root} pointerEvents="box-none">
            <View ref={pillRef} collapsable={false} onLayout={discarded ? undefined : onLayout} style={[styles.place, { opacity: frame ? 1 : 0 }]} {...dragProps}
                {...{ tabIndex: 0, onFocus: () => setFocused(true), onBlur: (event: BlurEvent) => {
                    const target = event.currentTarget;
                    if (target instanceof HTMLElement && 'relatedTarget' in event) {
                        const next = event.relatedTarget;
                        if (!(next instanceof Node) || !target.contains(next)) setFocused(false);
                    }
                } }} testID="capture-recording-chrome">
                {discarded || !props.snapshot ? (
                    // Floats over the desktop like the control it replaces: the same glass and lift.
                    <GlassLivePictureBackdropContext.Provider value>
                    <GlassPanel surfaceGroup="content" shadowLevel={2} innerShadow={false} radius={CAPTURE_PILL_HEIGHT / 2} style={styles.discarded}>
                        <CaptureDeliveryPill
                            state={{ kind: 'discarded', title: t('screenCapture.recording.discarded') }}
                            thumbnailUri={null}
                            {...(props.onUndoDiscard ? { onUndo: props.onUndoDiscard } : {})}
                        />
                    </GlassPanel>
                    </GlassLivePictureBackdropContext.Provider>
                ) : (
                    <RecordingControlBar
                        snapshot={props.snapshot}
                        onPause={props.onPause}
                        onResume={props.onResume}
                        onStop={props.onStop}
                        onDiscard={props.onDiscard}
                        {...(props.onClose ? { onHide: props.onClose } : {})}
                    />
                )}
            </View>
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    root: {
        position: 'absolute',
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    },
    place: {
        position: 'absolute',
        left: 0,
        top: 0,
    },
    discarded: {
        width: DISCARD_PILL_WIDTH,
        height: CAPTURE_PILL_HEIGHT,
    },
}));
