import * as React from 'react';
import { Keyboard, Platform, Pressable, StyleSheet as RNStyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    useAnimatedReaction,
    useAnimatedStyle,
    useFrameCallback,
    useSharedValue,
    withSpring,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { useCockpitBarScrolls } from '@/components/navigation/mobile/chrome/bars/cockpitBarScrollState';
import { useSessionSwitcherState } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { resolveFloatingTabBarBottomPadding } from '@/components/ui/navigation/floatingTabBarBottomInset';
import { hapticsLight, hapticsMedium, hapticsSelection } from '@/components/ui/theme/haptics';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { SessionNavigationDirection } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import {
    SESSION_SWITCHER_ACTIVATION_PX,
    SESSION_SWITCHER_HOLD_MS,
    SESSION_SWITCHER_HOLD_SLOP_PX,
    SESSION_SWITCHER_LIFT_GAIN,
    SESSION_SWITCHER_LOCK_PX,
    resolveSessionSwitcherAutoScrollRate,
    resolveSessionSwitcherEdgeHitSlop,
    resolveSessionSwitcherLift,
    resolveSessionSwitcherRelease,
    resolveSessionSwitcherScrub,
    resolveSessionSwitcherStart,
    type SessionSwitcherPhase,
} from './sessionSwitcherGesture';
import { resolveSessionSwitcherRevealScroll } from './sessionSwitcherMotion';
import {
    SESSION_SWITCHER_ROW_HEIGHT,
    layoutSessionSwitcherPanel,
    type SessionSwitcherPanelLayout,
} from './sessionSwitcherPanelLayout';
import type { SessionSwitcherRow } from './sessionSwitcherRows';
import { SessionSwitcherPanel, SessionSwitcherStayPill } from './SessionSwitcherPanel';
import { useSessionSwitcher, type SessionSwitcherMode, type SessionSwitcherPrepared } from './useSessionSwitcher';

/**
 * The session bar's gestures, and the switcher they open. Wraps the bar the chrome host renders on
 * a session; every switch from the bar goes through here, with the decisions in
 * `sessionSwitcherGesture` and the rows and navigation in `useSessionSwitcher`.
 *
 * One Pan claims a stroke on either axis after 12 pt; a LongPress beside it arms "hold to dock".
 * Each gesture has its own setting, and a setting that is off removes only its gesture.
 */

export const SESSION_SWITCHER_GESTURE_TEST_ID = 'session-cockpit-lateral-swipe';
export const SESSION_SWITCHER_SCRIM_TEST_ID = 'session-switcher-scrim';

/** Room the switcher leaves above it for the peek and the session header. */
const PEEK_ROOM = 132;
const PANEL_GAP = 8;
const MIN_VIEWPORT = 200;

export type SessionSwitcherBandControls = Readonly<{
    /** Opens the switcher for tapping — the hold's result, and the screen-reader path. */
    dock: () => void;
    /** One step sideways, for the band's accessibility actions. */
    step: (direction: SessionNavigationDirection) => boolean;
}>;

/** Exported for the bar's suites, which supply controls without mounting the gesture. */
export const SessionSwitcherBandContext = React.createContext<SessionSwitcherBandControls | null>(null);

export function useSessionSwitcherBand(): SessionSwitcherBandControls | null {
    return React.useContext(SessionSwitcherBandContext);
}

type PanelState = Readonly<{
    mode: SessionSwitcherMode;
    docked: boolean;
    prepared: SessionSwitcherPrepared;
    layout: SessionSwitcherPanelLayout;
    viewportHeight: number;
}>;

const styles = StyleSheet.create((theme) => ({
    scrim: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: theme.colors.overlay.scrimSoft,
    },
    panelSlot: {
        position: 'absolute',
        left: 12,
        right: 12,
        bottom: '100%',
        marginBottom: PANEL_GAP,
    },
    stay: {
        position: 'absolute',
        left: 16,
        right: 16,
        top: 4,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

function finishSettle(value: { value: number }, to: number, reducedMotion: boolean): void {
    'worklet';
    value.value = reducedMotion ? to : withSpring(to, reanimatedMotionTokens.spring.travel);
}

export function SessionSwitcherBand(props: Readonly<{
    sessionId: string;
    serverId: string | null;
    children: React.ReactNode;
}>): React.ReactElement {

    const router = useRouter();
    const deviceType = useDeviceType();
    const window = useWindowDimensions();
    const insets = useChromeSafeAreaInsets();
    const reducedMotion = useReducedMotionPreference();
    const barScrolls = useCockpitBarScrolls();
    const sidewaysEnabled = useSetting('sessionCockpitSwipeNavigationEnabled') === true;
    const dragUpEnabled = useSetting('sessionSwitcherDragUpEnabled') !== false;
    const flickEnabled = useSetting('sessionSwitcherFlickEnabled') !== false;
    const holdEnabled = useSetting('sessionSwitcherHoldToDockEnabled') !== false;
    const syncOn = useSetting('workspaceTabsSyncEnabled') !== false;
    const switcher = useSessionSwitcher({ sessionId: props.sessionId, serverId: props.serverId });
    const shared = useSessionSwitcherState();
    const { open, ghost, lift, index, scroll } = shared;

    // The gesture must not arm over a raised keyboard: the bar sits on it and the room belongs to text.
    const [keyboardVisible, setKeyboardVisible] = React.useState(false);
    React.useEffect(() => {
        const shown = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboardVisible(true));
        const hidden = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardVisible(false));
        return () => { shown.remove(); hidden.remove(); };
    }, []);

    // Native phones only: on mobile web the browser owns the edges and the bottom of the screen.
    const gestureEnabled = Platform.OS !== 'web' && deviceType === 'phone' && !keyboardVisible
        && (sidewaysEnabled || dragUpEnabled || flickEnabled || holdEnabled);

    const [panel, setPanel] = React.useState<PanelState | null>(null);
    const [selected, setSelected] = React.useState<SessionSwitcherRow | null>(null);
    const [locked, setLocked] = React.useState(false);
    const preparedRef = React.useRef<SessionSwitcherPrepared | null>(null);
    const panelRef = React.useRef<PanelState | null>(null);
    panelRef.current = panel;
    const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const phase = useSharedValue<SessionSwitcherPhase>('idle');
    const anchorY = useSharedValue(0);
    const anchorIndex = useSharedValue(0);
    const count = useSharedValue(0);
    const countUp = useSharedValue(0);
    const countNext = useSharedValue(0);
    const countPrevious = useSharedValue(0);
    const scrubbed = useSharedValue(false);
    const maxAbsX = useSharedValue(0);
    const lastY = useSharedValue(0);
    const autoAccumulator = useSharedValue(0);
    const rowBottoms = useSharedValue<number[]>([]);
    const viewportHeight = useSharedValue(0);
    const contentHeight = useSharedValue(0);
    const bandTop = useSharedValue(window.height);

    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        bandTop.value = window.height - event.nativeEvent.layout.height;
    }, [bandTop, window.height]);

    const measureViewport = React.useCallback((mode: SessionSwitcherMode, docked: boolean, content: number) => {
        const bandHeight = window.height - bandTop.value;
        const rise = mode === 'up' && !docked ? SESSION_SWITCHER_LOCK_PX * SESSION_SWITCHER_LIFT_GAIN : 0;
        const room = window.height - insets.top - bandHeight - PANEL_GAP - rise - PEEK_ROOM;
        return Math.max(Math.min(MIN_VIEWPORT, content), Math.min(content + (docked ? 52 : 0), room));
    }, [bandTop, insets.top, window.height]);

    const prepare = React.useCallback(() => {
        if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
        const prepared = switcher.prepare();
        preparedRef.current = prepared;
        countUp.value = prepared.rows.up.length;
        countNext.value = prepared.rows.next.length;
        countPrevious.value = prepared.rows.previous.length;
        return prepared;
    }, [countNext, countPrevious, countUp, switcher]);

    const reveal = React.useCallback(() => {
        'worklet';
        const at = index.value;
        const bottom = at >= 0 ? rowBottoms.value[at] : 0;
        if (bottom === undefined) return;
        const to = resolveSessionSwitcherRevealScroll({
            scroll: scroll.value, rowBottom: bottom, rowHeight: SESSION_SWITCHER_ROW_HEIGHT,
            viewportHeight: viewportHeight.value, contentHeight: contentHeight.value,
        });
        if (to !== scroll.value) scroll.value = reducedMotion ? to : withSpring(to, reanimatedMotionTokens.spring.travel);
    }, [contentHeight, index, reducedMotion, rowBottoms, scroll, viewportHeight]);

    const frame = useFrameCallback((info) => {
        'worklet';
        const p = phase.value;
        if (p !== 'scrub' && p !== 'side') { autoAccumulator.value = 0; return; }
        const listBottom = bandTop.value - PANEL_GAP - lift.value;
        const rate = resolveSessionSwitcherAutoScrollRate({
            y: lastY.value,
            listTop: listBottom - viewportHeight.value,
            listBottom,
            index: index.value,
            minIndex: -1,
            scrolled: scroll.value > 2,
        });
        if (rate === 0) { autoAccumulator.value = 0; return; }
        const dt = (info.timeSincePreviousFrame ?? 16) / 1000;
        autoAccumulator.value += dt * (rate < 0 ? -rate : rate);
        const direction = rate > 0 ? 1 : -1;
        while (autoAccumulator.value >= 1) {
            autoAccumulator.value -= 1;
            const next = index.value + direction;
            if (next < -1 || next > count.value - 1) { autoAccumulator.value = 0; break; }
            anchorIndex.value += direction;
            index.value = next;
            reveal();
            scrubbed.value = true;
            scheduleOnRN(hapticsSelection);
        }
    }, false);

    const showPanel = React.useCallback((mode: SessionSwitcherMode, docked: boolean) => {
        const prepared = preparedRef.current ?? prepare();
        const rows = prepared.rows[mode];
        const layout = layoutSessionSwitcherPanel({
            mode, rows, current: prepared.current, source: prepared.sources[mode], syncOn,
        });
        const height = measureViewport(mode, docked, layout.contentHeight);
        rowBottoms.value = [...layout.rowBottoms];
        contentHeight.value = layout.contentHeight;
        viewportHeight.value = height - (docked ? 52 : 0);
        count.value = rows.length;
        reveal();
        setLocked(mode !== 'up' || docked);
        setPanel({ mode, docked, prepared, layout, viewportHeight: height });
        if (!docked) frame.setActive(true);
    }, [contentHeight, count, frame, measureViewport, prepare, reveal, rowBottoms, syncOn, viewportHeight]);

    const hidePanel = React.useCallback(() => {
        frame.setActive(false);
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
        // The panel fades on the UI thread; it leaves React once it is gone.
        closeTimerRef.current = setTimeout(() => {
            closeTimerRef.current = null;
            setPanel(null);
            setSelected(null);
            setLocked(false);
            preparedRef.current = null;
        }, reducedMotion ? 0 : 320);
    }, [frame, reducedMotion]);

    const closeNow = React.useCallback(() => {
        finishSettle(open, 0, reducedMotion);
        finishSettle(ghost, 0, reducedMotion);
        finishSettle(lift, 0, reducedMotion);
        index.value = -1;
        phase.value = 'idle';
        hidePanel();
    }, [ghost, hidePanel, index, lift, open, phase, reducedMotion]);

    const openRow = React.useCallback((row: SessionSwitcherRow) => {
        switcher.open(row);
        void hapticsLight();
        closeNow();
    }, [closeNow, switcher]);

    const dock = React.useCallback(() => {
        prepare();
        index.value = -1;
        scroll.value = 0;
        showPanel('up', true);
        finishSettle(open, 1, reducedMotion);
        finishSettle(ghost, 1, reducedMotion);
        lift.value = 0;
        phase.value = 'idle';
    }, [ghost, index, lift, open, phase, prepare, reducedMotion, scroll, showPanel]);

    const finish = React.useCallback((kind: 'open' | 'flick' | 'dock' | 'cancel', at: number, direction: SessionNavigationDirection | null) => {
        const current = panelRef.current;
        if (kind === 'open' && current) {
            const row = current.prepared.rows[current.mode][at];
            if (row) { openRow(row); return; }
        }
        if (kind === 'flick' && direction) {
            if (switcher.flick(direction)) void hapticsLight();
            closeNow();
            return;
        }
        if (kind === 'dock') { dock(); return; }
        closeNow();
    }, [closeNow, dock, openRow, switcher]);

    const lockReached = React.useCallback(() => {
        setLocked(true);
        void hapticsMedium();
    }, []);

    // The JS mirror of the selection: once per row crossed, for the peek.
    const selectIndex = React.useCallback((at: number) => {
        const current = panelRef.current;
        setSelected(current && at >= 0 ? current.prepared.rows[current.mode][at] ?? null : null);
    }, []);
    useAnimatedReaction(() => index.value, (at, previous) => {
        if (at !== previous) scheduleOnRN(selectIndex, at);
    }, [selectIndex]);

    const settings = React.useMemo(() => ({
        sideways: sidewaysEnabled, dragUp: dragUpEnabled, flick: flickEnabled, holdToDock: holdEnabled,
    }), [dragUpEnabled, flickEnabled, holdEnabled, sidewaysEnabled]);

    const gesture = React.useMemo(() => {
        const scrub = (y: number) => {
            'worklet';
            lastY.value = y;
            const next = resolveSessionSwitcherScrub({ y, anchorY: anchorY.value, anchorIndex: anchorIndex.value, count: count.value, minIndex: -1 });
            anchorY.value = next.anchorY;
            if (next.index !== index.value) {
                index.value = next.index;
                scrubbed.value = true;
                scheduleOnRN(hapticsSelection);
                reveal();
            }
        };

        const pan = Gesture.Pan()
            .withTestId(SESSION_SWITCHER_GESTURE_TEST_ID)
            .enabled(gestureEnabled)
            .hitSlop(resolveSessionSwitcherEdgeHitSlop(Platform.OS))
            .cancelsTouchesInView(true)
            .onBegin(() => {
                'worklet';
                if (phase.value !== 'held') phase.value = 'idle';
                scrubbed.value = false;
                maxAbsX.value = 0;
                scheduleOnRN(prepare);
            })
            .onStart((event) => {
                'worklet';
                const start = resolveSessionSwitcherStart({
                    translationX: event.translationX,
                    translationY: event.translationY,
                    held: phase.value === 'held',
                    settings,
                    barScrolls,
                });
                if (start.phase === 'side' && start.direction) {
                    const available = start.direction === 'next' ? countNext.value : countPrevious.value;
                    phase.value = 'side';
                    count.value = available;
                    index.value = available > 0 ? 0 : -1;
                    anchorY.value = event.absoluteY;
                    anchorIndex.value = 0;
                    lastY.value = event.absoluteY;
                    scroll.value = 0;
                    ghost.value = 1;
                    finishSettle(open, 1, reducedMotion);
                    scheduleOnRN(showPanel, start.direction, false);
                    // The end of the list answers with a firmer tick, then springs back on release.
                    scheduleOnRN(available > 0 ? hapticsSelection : hapticsMedium);
                    return;
                }
                if (start.phase === 'lift') {
                    phase.value = 'lift';
                    count.value = countUp.value;
                    index.value = countUp.value > 0 ? 0 : -1;
                    scroll.value = 0;
                    scheduleOnRN(showPanel, 'up', false);
                    return;
                }
                phase.value = start.phase;
            })
            .onUpdate((event) => {
                'worklet';
                const p = phase.value;
                if (p === 'side') {
                    const x = event.translationX < 0 ? -event.translationX : event.translationX;
                    if (x > maxAbsX.value) maxAbsX.value = x;
                    scrub(event.absoluteY);
                    return;
                }
                if (p === 'lift') {
                    const next = resolveSessionSwitcherLift(-event.translationY);
                    lift.value = next.lift;
                    ghost.value = next.progress;
                    open.value = next.progress;
                    if (next.locked) {
                        phase.value = 'scrub';
                        anchorY.value = event.absoluteY;
                        anchorIndex.value = 0;
                        lastY.value = event.absoluteY;
                        scheduleOnRN(lockReached);
                    }
                    return;
                }
                if (p === 'scrub') scrub(event.absoluteY);
            })
            .onEnd((event, success) => {
                'worklet';
                const release = resolveSessionSwitcherRelease({
                    phase: phase.value,
                    index: index.value,
                    scrubbed: scrubbed.value,
                    translationX: event.translationX,
                    translationY: event.translationY,
                    velocityX: event.velocityX,
                    velocityY: event.velocityY,
                    maxAbsTranslationX: maxAbsX.value,
                    flickEnabled: settings.flick,
                    cancelled: success === false,
                });
                phase.value = 'idle';
                scheduleOnRN(
                    finish,
                    release.kind,
                    release.kind === 'open' ? release.index : 0,
                    release.kind === 'flick' ? release.direction : null,
                );
            })
            .onFinalize((_event, success) => {
                'worklet';
                // A stroke the system took away before it ended still has to put everything back.
                if (!success && phase.value !== 'idle' && phase.value !== 'held') {
                    phase.value = 'idle';
                    scheduleOnRN(finish, 'cancel', 0, null);
                }
            });
        if (barScrolls) {
            // The bar scrolls its tools sideways, so this gesture owns only the vertical axis.
            pan.activeOffsetY([-SESSION_SWITCHER_ACTIVATION_PX, SESSION_SWITCHER_ACTIVATION_PX])
                .failOffsetX([-SESSION_SWITCHER_ACTIVATION_PX, SESSION_SWITCHER_ACTIVATION_PX]);
        } else {
            pan.activeOffsetX([-SESSION_SWITCHER_ACTIVATION_PX, SESSION_SWITCHER_ACTIVATION_PX])
                .activeOffsetY([-SESSION_SWITCHER_ACTIVATION_PX, SESSION_SWITCHER_ACTIVATION_PX]);
        }

        const hold = Gesture.LongPress()
            .enabled(gestureEnabled && holdEnabled)
            .minDuration(SESSION_SWITCHER_HOLD_MS)
            .maxDistance(SESSION_SWITCHER_HOLD_SLOP_PX)
            .onStart(() => {
                'worklet';
                if (phase.value !== 'idle') return;
                phase.value = 'held';
                scheduleOnRN(hapticsMedium);
            })
            .onEnd((_event, success) => {
                'worklet';
                if (success && phase.value === 'held') {
                    phase.value = 'idle';
                    scheduleOnRN(finish, 'dock', 0, null);
                }
            });
        return Gesture.Simultaneous(pan, hold);
    }, [
        anchorIndex, anchorY, barScrolls, contentHeight, count, countNext, countPrevious, countUp, finish, gestureEnabled,
        ghost, holdEnabled, index, lastY, lift, lockReached, maxAbsX, open, phase, prepare, reducedMotion, rowBottoms,
        reveal, scroll, scrubbed, settings, showPanel, viewportHeight,
    ]);

    // Docked, the list scrolls by dragging; a drag that moves cancels the row press under it.
    const dockedScrollStart = useSharedValue(0);
    const dockedScroll = React.useMemo(() => Gesture.Pan()
        .enabled(panel?.docked === true)
        .activeOffsetY([-SESSION_SWITCHER_HOLD_SLOP_PX, SESSION_SWITCHER_HOLD_SLOP_PX])
        .onBegin(() => {
            'worklet';
            dockedScrollStart.value = scroll.value;
        })
        .onUpdate((event) => {
            'worklet';
            const max = contentHeight.value - viewportHeight.value > 0 ? contentHeight.value - viewportHeight.value : 0;
            const next = dockedScrollStart.value + event.translationY;
            scroll.value = next < 0 ? 0 : next > max ? max : next;
        }), [contentHeight, dockedScrollStart, panel?.docked, scroll, viewportHeight]);

    const scrimStyle = useAnimatedStyle(() => ({ opacity: open.value }), [open]);
    const barStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -lift.value }] }), [lift]);
    const stayStyle = useAnimatedStyle(() => ({
        // From the lock on, the bar says what letting go on it does.
        opacity: phase.value === 'scrub' ? 1 : 0,
        transform: [{ translateY: -lift.value }],
    }), [index, lift, phase]);

    const controls = React.useMemo<SessionSwitcherBandControls>(() => ({ dock, step: switcher.step }), [dock, switcher.step]);
    const current = panel?.prepared.current ?? null;
    const bottomPadding = resolveFloatingTabBarBottomPadding(insets.bottom, Platform.OS === 'ios');

    return (
        <SessionSwitcherBandContext.Provider value={controls}>
            <View onLayout={handleLayout} pointerEvents="box-none">
                {panel ? (
                    <Animated.View
                        pointerEvents={panel.docked ? 'auto' : 'none'}
                        style={[styles.scrim, { height: window.height }, scrimStyle]}
                        testID={SESSION_SWITCHER_SCRIM_TEST_ID}
                    >
                        {panel.docked ? (
                            <Pressable
                                style={RNStyleSheet.absoluteFill}
                                onPress={closeNow}
                                accessibilityRole="button"
                                accessibilityLabel={t('phoneNav.switcher.close')}
                            />
                        ) : null}
                    </Animated.View>
                ) : null}
                <GestureDetector gesture={gesture}>
                    <Animated.View pointerEvents="box-none" style={barStyle}>
                        {/* The band's empty pixels beside the capsule take the stroke too, but only while a gesture exists. */}
                        <View pointerEvents={gestureEnabled ? 'auto' : 'none'} style={RNStyleSheet.absoluteFill} />
                        {props.children}
                    </Animated.View>
                </GestureDetector>
                {panel && panel.mode === 'up' && !panel.docked && current ? (
                    <Animated.View pointerEvents="none" style={[styles.stay, { bottom: bottomPadding }, stayStyle]}>
                        <SessionSwitcherStayPill title={current.title} />
                    </Animated.View>
                ) : null}
                {panel ? (
                    <GestureDetector gesture={dockedScroll}>
                    <View pointerEvents="box-none" style={styles.panelSlot}>
                        <SessionSwitcherPanel
                            mode={panel.mode}
                            docked={panel.docked}
                            layout={panel.layout}
                            viewportHeight={panel.viewportHeight}
                            selected={locked ? selected : null}
                            ghost={ghost}
                            lift={lift}
                            index={index}
                            scroll={scroll}
                            reducedMotion={reducedMotion}
                            onOpenRow={openRow}
                            onAllSessions={() => { closeNow(); router.navigate('/'); }}
                        />
                    </View>
                    </GestureDetector>
                ) : null}
            </View>
        </SessionSwitcherBandContext.Provider>
    );
}
