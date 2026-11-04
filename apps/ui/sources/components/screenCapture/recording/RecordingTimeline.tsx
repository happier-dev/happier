import * as React from 'react';
import { Image, Pressable, View, type LayoutChangeEvent, type PointerEvent as NativePointerEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { isEmptyEdit } from '@happier-dev/protocol/sessions/media/imageMarksV1';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { Text } from '@/components/ui/text/Text';
import { formatPlaybackTime } from '@/components/workspaces/files/file/filePageMediaFacts';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import { useRecordingClockSeconds, type RecordingClock } from './recordingClock';
import { moveRecordingTrim, projectRecordingDocument, type RecordingDocument } from './recordingDocument';
import { layoutRecordingPins } from './recordingEditorProjection';
import type { RecordingMediaAccess } from './useRecordingEditor';

/** Lab `rc` ED: the strip's own geometry; nothing else on the surface shares these lengths. */
const STRIP_HEIGHT = 44;
const HANDLE_WIDTH = 10;
const HANDLE_REACH = 8;
const PLAY_SIZE = 32;
const PIN_HEIGHT = 20;
const PIN_GAP = 4;
const NOTE_PIN_CHROME = 30;
const NOTE_PIN_CHARACTER = 7;
const KEY_STEP_MS = 1000;
const FINE_KEY_STEP_MS = 100;

type Pin = Readonly<{ id: string; sourceTimeMs: number; kind: 'note' | 'mark' | 'pin' | 'default'; label: string; note?: string; width: number }>;

function projectPins(document: RecordingDocument): readonly Pin[] {
    const pins: Pin[] = [];
    const { defaultPinMs } = projectRecordingDocument(document);
    if (defaultPinMs !== null) {
        const label = formatPlaybackTime(defaultPinMs / 1000);
        pins.push({ id: 'default', sourceTimeMs: defaultPinMs, kind: 'default', label,
            width: NOTE_PIN_CHROME + label.length * NOTE_PIN_CHARACTER });
    }
    for (const entry of document.frames) {
        if (isEmptyEdit(entry.document)) continue;
        // A marked frame wears the neutral pin with the pen glyph and its count, so it never reads as a numbered step.
        const label = String(entry.document.marks.length);
        pins.push({
            id: `frame:${entry.sourceTimeMs}`, sourceTimeMs: entry.sourceTimeMs, kind: 'mark',
            label, width: NOTE_PIN_CHROME + label.length * NOTE_PIN_CHARACTER,
        });
    }
    for (const note of document.notes) {
        const label = formatPlaybackTime(note.sourceTimeMs / 1000);
        pins.push({ id: `note:${note.id}`, sourceTimeMs: note.sourceTimeMs, kind: 'note', label, note: note.text,
            width: NOTE_PIN_CHROME + label.length * NOTE_PIN_CHARACTER });
    }
    for (const sourceTimeMs of document.pins) {
        const label = formatPlaybackTime(sourceTimeMs / 1000);
        pins.push({ id: `pin:${sourceTimeMs}`, sourceTimeMs, kind: 'pin', label, width: NOTE_PIN_CHROME + label.length * NOTE_PIN_CHARACTER });
    }
    return pins;
}

function Readout(props: Readonly<{ clock: RecordingClock; durationMs: number }>) {
    const seconds = useRecordingClockSeconds(props.clock);
    return (
        <Text variant="meta" style={styles.time} numberOfLines={1}>
            <Text variant="meta" emphasis="semiBold" style={styles.timeNow}>{formatPlaybackTime(seconds)}</Text>
            {` / ${formatPlaybackTime(props.durationMs / 1000)}`}
        </Text>
    );
}

/** The clip's own frames, read once for the tiles in view by a finite decoder that never touches the player. */
function useFilmstrip(media: RecordingMediaAccess, durationMs: number, count: number, tileWidth: number) {
    const [tiles, setTiles] = React.useState<readonly (string | undefined)[]>([]);
    React.useEffect(() => {
        if (count === 0) return;
        const lifetime = new AbortController();
        void media.withFrames(async (player) => {
            for (let index = 0; index < count; index += 1) {
                const timeSeconds = ((index + 0.5) / count) * (durationMs / 1000);
                const frame = await player.readFrame({ timeSeconds, width: tileWidth, signal: lifetime.signal });
                if (lifetime.signal.aborted) return;
                setTiles((previous) => {
                    const next = previous.slice();
                    next[index] = frame.uri;
                    return next;
                });
            }
        }, lifetime.signal).catch(() => undefined);
        return () => lifetime.abort();
    }, [count, durationMs, media, tileWidth]);
    return tiles;
}

/**
 * Play, time and the filmstrip (lab `rc` ED, MIS RC-ed): scrubbing moves the playhead 1:1, the ink handles
 * trim, and pins for notes and marks stand above. A gesture commits once, on release.
 */
export function RecordingTimeline(props: Readonly<{
    document: RecordingDocument;
    clock: RecordingClock;
    playing: boolean;
    aspectRatio: number;
    media: RecordingMediaAccess;
    onTogglePlaying: () => void;
    onScrub: (timeMs: number) => void;
    onSettle: (timeMs: number) => void;
    onSeek: (timeMs: number) => void;
    onTrim: (startMs: number, endMs: number) => void;
    onMoveDefaultPin: (sourceTimeMs: number) => void;
}>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const { document, clock, onScrub, onSettle, onTrim } = props;
    const { durationMs } = document;
    const trackRef = React.useRef<View>(null);
    const playheadRef = React.useRef<View>(null);
    const [trackWidth, setTrackWidth] = React.useState(0);
    const [held, setHeld] = React.useState<RecordingDocument['trim'] | null>(null);
    const releaseDrag = React.useRef<(() => void) | null>(null);
    React.useEffect(() => () => releaseDrag.current?.(), []);
    const trim = held ?? document.trim;
    const span = Math.max(1, durationMs);
    const toX = (timeMs: number) => (timeMs / span) * trackWidth;
    const toTime = (clientX: number) => {
        const rect = (trackRef.current as unknown as HTMLElement).getBoundingClientRect();
        return Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * span);
    };

    // Position and its accessible value follow the clock in place; nothing around them renders.
    React.useEffect(() => {
        const place = (timeMs: number) => {
            const node = playheadRef.current as unknown as HTMLElement | null;
            if (node) node.style.transform = `translateX(${(timeMs / span) * trackWidth}px)`;
            const track = trackRef.current as unknown as HTMLElement | null;
            if (track) {
                track.setAttribute('aria-valuenow', String(timeMs));
                track.setAttribute('aria-valuetext', formatPlaybackTime(timeMs / 1000));
            }
        };
        place(clock.read());
        return clock.subscribe(place);
    }, [clock, span, trackWidth, reducedMotion]);

    const tileHeight = STRIP_HEIGHT;
    const tileWidth = Math.round(tileHeight * props.aspectRatio);
    const count = trackWidth > 0 ? Math.ceil(trackWidth / tileWidth) : 0;
    const tiles = useFilmstrip(props.media, durationMs, count, tileWidth * 2);

    const pins = React.useMemo(() => projectPins(document), [document]);
    const placed = React.useMemo(() => new Map(layoutRecordingPins(pins, { durationMs, trackWidth, gap: PIN_GAP }).map(({ id, x }) => [id, x])),
        [durationMs, pins, trackWidth]);

    const drag = (start: NativePointerEvent, move: (timeMs: number) => void, end: (timeMs: number) => void,
        cancel = () => onSettle(clock.read())) => {
        const target = start.currentTarget;
        if (!(target instanceof HTMLElement)) return;
        const moved = (event: PointerEvent) => move(toTime(event.clientX));
        const release = () => {
            target.removeEventListener('pointermove', moved);
            target.removeEventListener('pointerup', finished);
            target.removeEventListener('pointercancel', cancelled);
            releaseDrag.current = null;
        };
        const finished = (event: PointerEvent) => {
            release();
            end(toTime(event.clientX));
        };
        const cancelled = () => { release(); cancel(); };
        releaseDrag.current = release;
        target.setPointerCapture(start.nativeEvent.pointerId);
        target.addEventListener('pointermove', moved);
        target.addEventListener('pointerup', finished);
        target.addEventListener('pointercancel', cancelled);
    };

    const onStripDown = (event: NativePointerEvent) => {
        const clamp = (timeMs: number) => Math.max(trim.startMs, Math.min(trim.endMs, timeMs));
        onScrub(clamp(toTime(event.nativeEvent.clientX)));
        drag(event, (timeMs) => onScrub(clamp(timeMs)), (timeMs) => onSettle(clamp(timeMs)));
    };
    const trimBoundary = (edge: 'start' | 'end', timeMs: number) => moveRecordingTrim(document, edge, timeMs);
    const onHandleDown = (edge: 'start' | 'end') => (event: NativePointerEvent) => {
        event.stopPropagation();
        const take = (timeMs: number) => {
            const next = trimBoundary(edge, timeMs);
            setHeld(next);
            onScrub(edge === 'start' ? next.startMs : next.endMs);
            return next;
        };
        drag(event, take, (timeMs) => {
            const next = take(timeMs);
            setHeld(null);
            onTrim(Math.round(next.startMs), Math.round(next.endMs));
            onSettle(edge === 'start' ? Math.round(next.startMs) : Math.round(next.endMs));
        }, () => { setHeld(null); onSettle(clock.read()); });
    };
    const onHandleKey = (edge: 'start' | 'end') => (event: React.KeyboardEvent<HTMLElement>) => {
        const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
        if (direction === 0) return;
        event.preventDefault();
        const step = (event.shiftKey ? FINE_KEY_STEP_MS : KEY_STEP_MS) * direction;
        const next = trimBoundary(edge, (edge === 'start' ? trim.startMs : trim.endMs) + step);
        onTrim(Math.round(next.startMs), Math.round(next.endMs));
    };
    const onStripKey = (event: React.KeyboardEvent<HTMLElement>) => {
        const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
        if (direction === 0) return;
        event.preventDefault();
        const step = (event.shiftKey ? FINE_KEY_STEP_MS : KEY_STEP_MS) * direction;
        props.onSeek(Math.max(trim.startMs, Math.min(trim.endMs, clock.read() + step)));
    };
    const handleProps = (edge: 'start' | 'end') => ({
        role: 'slider',
        tabIndex: 0,
        'aria-label': edge === 'start' ? t('screenCapture.recording.trimStart') : t('screenCapture.recording.trimEnd'),
        'aria-valuemin': 0,
        'aria-valuemax': durationMs,
        'aria-valuenow': edge === 'start' ? trim.startMs : trim.endMs,
        'aria-valuetext': formatPlaybackTime((edge === 'start' ? trim.startMs : trim.endMs) / 1000),
        onPointerDown: onHandleDown(edge),
        onKeyDown: onHandleKey(edge),
    }) as unknown as React.ComponentProps<typeof View>;
    const left = toX(trim.startMs);
    const right = trackWidth - toX(trim.endMs);
    const onTrackLayout = (event: LayoutChangeEvent) => setTrackWidth(event.nativeEvent.layout.width);
    return (
        <View style={styles.root} testID="recording-timeline">
            <View style={styles.pinsRow}>
                <View style={styles.lead} />
                <View style={styles.pins} accessibilityLabel={t('screenCapture.recording.pins')}>
                    {pins.map((pin) => {
                        const face = (
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={pin.note ? `${pin.label} ${pin.note}` : pin.label}
                                onPress={pin.kind === 'default' ? undefined : () => props.onSeek(pin.sourceTimeMs)}
                                {...(pin.kind === 'default' ? {
                                    onPointerDown: (event: NativePointerEvent) => {
                                        event.stopPropagation();
                                        const startedAt = toTime(event.nativeEvent.clientX);
                                        const position = (timeMs: number) => Math.max(trim.startMs, Math.min(trim.endMs, pin.sourceTimeMs + timeMs - startedAt));
                                        onScrub(pin.sourceTimeMs);
                                        drag(event, timeMs => onScrub(position(timeMs)), timeMs => {
                                            props.onMoveDefaultPin(position(timeMs));
                                            onSettle(position(timeMs));
                                        });
                                    },
                                    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
                                        if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault(); event.stopPropagation();
                                            props.onSeek(pin.sourceTimeMs);
                                            return;
                                        }
                                        const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
                                        if (!direction) return;
                                        event.preventDefault(); event.stopPropagation();
                                        const timeMs = Math.max(trim.startMs, Math.min(trim.endMs,
                                            pin.sourceTimeMs + direction * (event.shiftKey ? FINE_KEY_STEP_MS : KEY_STEP_MS)));
                                        props.onMoveDefaultPin(timeMs);
                                        props.onSeek(timeMs);
                                    },
                                } : {})}
                                style={[styles.pin, styles.notePin]}
                                testID={`recording-pin-${pin.id}`}
                            >
                                <Icon name={pin.kind === 'mark' ? 'pencil-simple' : 'chat-circle'} size={11} color={theme.colors.surface.base} />
                                <Text variant="micro" emphasis="semiBold" style={styles.pinText}>{pin.label}</Text>
                            </Pressable>
                        );
                        return (
                            <View key={pin.id} style={[styles.pinPlace, { left: placed.get(pin.id) ?? 0 }]}>
                                {pin.note ? <Tooltip label={pin.note} focusable={false}>{face}</Tooltip> : face}
                            </View>
                        );
                    })}
                </View>
            </View>
            <View style={styles.row}>
                <View style={styles.leadRow}>
                    <IconButton
                        fill="neutral"
                        size={PLAY_SIZE}
                        icon={<Icon name={props.playing ? 'pause' : 'play'} weight="fill" size={16} color={theme.colors.text.primary} />}
                        accessibilityLabel={props.playing ? t('screenCapture.recording.pause') : t('screenCapture.recording.play')}
                        onPress={props.onTogglePlaying}
                        testID="recording-play"
                    />
                    <Readout clock={clock} durationMs={durationMs} />
                </View>
                <View
                    ref={trackRef}
                    collapsable={false}
                    style={styles.track}
                    onLayout={onTrackLayout}
                    role="slider"
                    aria-label={t('screenCapture.recording.timeline')}
                    {...({ tabIndex: 0, onPointerDown: onStripDown, onKeyDown: onStripKey, 'aria-valuemin': trim.startMs, 'aria-valuemax': trim.endMs } as object)}
                    testID="recording-strip"
                >
                    <View style={styles.film} pointerEvents="none">
                        {Array.from({ length: count }, (_, index) => (
                            <View key={index} style={styles.tile}>
                                {tiles[index] ? <Image source={{ uri: tiles[index] }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
                            </View>
                        ))}
                    </View>
                    <View pointerEvents="none" style={[styles.out, styles.outStart, { width: left }]} />
                    <View pointerEvents="none" style={[styles.out, styles.outEnd, { width: right }]} />
                    <View pointerEvents="none" style={[styles.trimFrame, { left, right }]} />
                    <View style={[styles.handle, styles.handleStart, { left }]} {...handleProps('start')} testID="recording-trim-start">
                        <View style={styles.handleReachStart} />
                        <View style={styles.grip} />
                    </View>
                    <View style={[styles.handle, styles.handleEnd, { right }]} {...handleProps('end')} testID="recording-trim-end">
                        <View style={styles.handleReachEnd} />
                        <View style={styles.grip} />
                    </View>
                    <View ref={playheadRef} collapsable={false} pointerEvents="none" style={styles.playhead}>
                        <View style={styles.playheadKnob} />
                    </View>
                </View>
            </View>
        </View>
    );
}

const LEAD_WIDTH = PLAY_SIZE + 10 + 84;

const styles = StyleSheet.create((theme) => ({
    root: {
        gap: theme.space.s12,
        paddingBottom: theme.space.s16,
    },
    pinsRow: {
        flexDirection: 'row',
        height: PIN_HEIGHT + theme.space.s2,
        gap: theme.space.s10,
    },
    lead: {
        width: LEAD_WIDTH,
    },
    pins: {
        flex: 1,
        position: 'relative',
    },
    pinPlace: {
        position: 'absolute',
        top: 0,
    },
    pin: {
        height: PIN_HEIGHT,
        borderRadius: PIN_HEIGHT / 2,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space.s4,
    },
    notePin: {
        paddingHorizontal: theme.space.s6,
        backgroundColor: theme.colors.text.primary,
    },
    pinText: {
        color: theme.colors.surface.base,
        fontVariant: ['tabular-nums'],
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
    },
    leadRow: {
        width: LEAD_WIDTH,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
    },
    time: {
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    timeNow: {
        color: theme.colors.text.primary,
    },
    track: {
        flex: 1,
        height: STRIP_HEIGHT,
        position: 'relative',
        cursor: 'pointer',
        touchAction: 'none',
    } as never,
    film: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        flexDirection: 'row',
        gap: 1,
        borderRadius: theme.borderRadius.md,
        overflow: 'hidden',
        backgroundColor: theme.colors.border.surface,
    },
    tile: {
        flex: 1,
        backgroundColor: theme.colors.surface.inset,
        overflow: 'hidden',
    },
    out: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        backgroundColor: theme.colors.surface.base,
        opacity: 0.7,
    },
    outStart: {
        left: 0,
        borderTopLeftRadius: theme.borderRadius.md,
        borderBottomLeftRadius: theme.borderRadius.md,
    },
    outEnd: {
        right: 0,
        borderTopRightRadius: theme.borderRadius.md,
        borderBottomRightRadius: theme.borderRadius.md,
    },
    trimFrame: {
        position: 'absolute',
        top: -theme.space.s2,
        bottom: -theme.space.s2,
        borderRadius: theme.borderRadius.md + 1,
        borderWidth: 2,
        borderColor: theme.colors.text.primary,
    },
    handle: {
        position: 'absolute',
        top: -theme.space.s2,
        bottom: -theme.space.s2,
        width: HANDLE_WIDTH,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.text.primary,
        cursor: 'ew-resize',
        touchAction: 'none',
    } as never,
    handleStart: {
        borderTopLeftRadius: theme.borderRadius.md,
        borderBottomLeftRadius: theme.borderRadius.md,
    },
    handleEnd: {
        borderTopRightRadius: theme.borderRadius.md,
        borderBottomRightRadius: theme.borderRadius.md,
    },
    /** The press reaches past the drawn handle, out over the strip's trimmed end (MIS RC-ed). */
    handleReachStart: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: -HANDLE_REACH,
        width: HANDLE_REACH + HANDLE_WIDTH,
    },
    handleReachEnd: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        right: -HANDLE_REACH,
        width: HANDLE_REACH + HANDLE_WIDTH,
    },
    grip: {
        width: 2,
        height: 14,
        borderRadius: 1,
        backgroundColor: theme.colors.surface.base,
    },
    playhead: {
        position: 'absolute',
        left: -1,
        top: -theme.space.s8,
        bottom: -theme.space.s8,
        width: 2,
        borderRadius: 1,
        backgroundColor: theme.colors.state.danger.foreground,
    },
    playheadKnob: {
        position: 'absolute',
        top: -theme.space.s2,
        left: -4,
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: theme.colors.state.danger.foreground,
    },
}));
