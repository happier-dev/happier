import * as React from 'react';
import { Platform, Pressable, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';

import { LinearGradient } from 'expo-linear-gradient';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Text } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { resolveOverlayPointerEvents } from '@/components/ui/overlays/resolveOverlayPointerEvents';
import { useComposerAvailablePanelHeight } from '@/components/sessions/keyboardAvoidance';
import { Typography } from '@/constants/Typography';
import { restoreFocusToBestTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';
import { t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

import {
    ControlRow,
    TactilePressable,
    VoiceTransport,
    type VoiceControlAction,
    type VoiceControlId,
} from '@/components/voice/controls/VoiceControls';
import { Bloom, Grain, PlanetLimb, VoiceWaveform } from '@/components/voice/light/VoiceLight';
import { useVoiceEnergy, useVoiceEnergyPresence } from '@/components/voice/light/useVoiceEnergy';
import {
    VOICE_MOTION,
    light,
    useVoiceLightTokens,
} from '@/components/voice/light/voiceLightTokens';

import { resolveVoiceSurfaceStatusPresentation } from '../resolveVoiceSurfaceStatusPresentation';
import {
    resolveVoiceHorizonHeights,
    VOICE_HORIZON_ACTIONS_BLOCK_HEIGHT,
    VOICE_HORIZON_STATUS_ROW_HEIGHT,
} from './resolveVoiceHorizonHeights';
import { TranscriptStream, type VoiceTranscriptRow } from '../VoiceTranscriptStream';
import type { VoiceSurfaceTranscriptEntry } from '../mergeVoiceSurfaceTranscriptEntries';
import type { VoiceSurfaceViewModel } from '../useVoiceSurfaceModel';

const EASE_SPATIAL = Easing.bezier(...(VOICE_MOTION.spatial.bezier as [number, number, number, number]));
const MINIMUM_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);

/**
 * Inner horizontal padding. The vertical budget belongs to
 * `resolveVoiceHorizonHeights`, which owns every number the vessel's height is
 * made of (§2.7).
 */
const PAD = 12;
/** Vessel border. Mirrored in the height owner — change both together. */
const BORDER = 1;

function projectTranscriptRows(
    entries: readonly VoiceSurfaceTranscriptEntry[],
): readonly VoiceTranscriptRow[] {
    return entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind === 'user'
            ? 'spoken-user'
            : entry.kind === 'assistant'
                ? 'spoken-assistant'
                : 'work',
        text: entry.text,
        provenance: null,
        provisional: entry.transcriptState === 'partial',
        at: formatEntryClockTime(entry.createdAt),
    }));
}

function formatEntryClockTime(createdAt: number): string {
    if (!Number.isFinite(createdAt) || createdAt <= 0) return '';
    return formatWithCachedDateTimeFormatter(new Date(createdAt), undefined, {
        hour: '2-digit',
        minute: '2-digit',
    });
}

/**
 * HORIZON — Voice as a window onto the Happier planet, docked in the sidebar.
 *
 * A second consumer of the `VoiceSurfaceViewModel` seam (§5.2), not a second
 * owner of anything: every fact it draws and every action it fires comes from
 * the model, and the status vocabulary comes from the one shared projection.
 *
 * Three things it deliberately does **not** do:
 *
 *  - **No live region.** §5.4a — one app-shell announcer owns automatic
 *    announcements. Horizon exposes labels, states and actions only; giving it
 *    a region of its own would announce every transition twice the moment the
 *    Orb is also mounted.
 *  - **No start-vs-stop derivation.** `attemptControl.onPrimaryAction` is selected by the
 *    placement-neutral attempt projection and owns the haptic (§5.5).
 *  - **No recovery-replaces-transport.** §12.2 defect 2: recovery is an
 *    addition, never a replacement. A recoverable error on a *live* session
 *    still renders the transport, so the user can always stop it.
 */
export const VoiceHorizon = React.memo(function VoiceHorizon(props: Readonly<{
    model: VoiceSurfaceViewModel;
}>) {
    const model = props.model;
    const tokens = useVoiceLightTokens();
    const energy = useVoiceEnergy();
    const presence = useVoiceEnergyPresence();
    const window = useWindowDimensions();
    const safeArea = useChromeSafeAreaInsets();
    const composerAvailablePanelHeight = useComposerAvailablePanelHeight();
    const isWeb = Platform.OS === 'web';
    const decorativePointerEvents = resolveOverlayPointerEvents('none');
    const attemptControl = model.attemptControl;

    // Presence is how a mounted surface tells the one clock it is on screen;
    // the clock still refuses to run without a live attempt (§2.4a).
    React.useEffect(() => {
        presence.acquire();
        return () => presence.release();
    }, [presence]);

    const statusPresentation = resolveVoiceSurfaceStatusPresentation(attemptControl.surfaceState);
    const statusLabel = t(statusPresentation.labelKey);
    const stop = attemptControl.stop;
    const stopSecondary = stop === 'warm'
        ? 'blush'
        : stop === 'blush'
            ? 'warm'
            : stop === 'violet'
                ? 'cool'
                : 'violet';

    /*
     * §8.2 — the second channel. `subtitle` was narrowed to target/error precisely
     * so agent-authored `display_status` ("Codex is editing X") could be drawn as
     * what it is: work Voice handed to a session, still running. Flattening the two
     * back into one string is the defect the narrowing removed, so this is a line
     * of its own and never replaces the target label.
     *
     * A delegated session that is thinking without an authored status still has
     * something to say — that it is working — which is why the fallback exists
     * rather than rendering an empty row.
     */
    const delegatedText = model.delegatedWork
        ? model.delegatedWork.statusText ?? t('voiceSurface.delegatedWorking')
        : null;
    const statusAccessibilityLabel = [statusLabel, model.subtitle, delegatedText]
        .filter((part): part is string => Boolean(part))
        .join('. ');

    const live = attemptControl.canStop;
    const conversational = model.expanded && model.activityFeedEnabled;
    /*
     * §5.3's `showStartStopAction = surfaceState !== 'error'`, consumed rather
     * than re-derived: a hard, non-retryable error offers recovery, not a Start
     * that cannot succeed.
     *
     * Composed with `live` on purpose — that composition **is** the fix for
     * §12.2 defect 2. Removing the transport wholesale on `canRecover` would
     * strand a user in a *recoverable* error on a *live* session with no way to
     * stop it. Here the transport survives whenever a session is running, and
     * recovery is rendered beside it.
     */
    const showTransport = attemptControl.surfaceState !== 'error' || live;

    const [width, setWidth] = React.useState(296);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = Math.round(event.nativeEvent.layout.width);
        setWidth((previous) => (previous === next ? previous : next));
    }, []);

    /*
     * §2.7 — the status row is measured rather than assumed. `286` and `36` are
     * default-scale target dimensions; at 200% web text, Dynamic Type or a long
     * translation the row is taller and the vessel grows with it. Measuring the
     * row is safe because it is the one child that is not `flex: 1`, so it never
     * stretches to the height it just reported.
     */
    const [statusRowHeight, setStatusRowHeight] = React.useState(VOICE_HORIZON_STATUS_ROW_HEIGHT);
    const onStatusRowLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = Math.max(VOICE_HORIZON_STATUS_ROW_HEIGHT, Math.round(event.nativeEvent.layout.height));
        setStatusRowHeight((previous) => (previous === next ? previous : next));
    }, []);

    /*
     * The actions block is measured for exactly the same reason, and it is the
     * half that was missing: recovery, cancel-turn, open-conversation, teleport
     * and — when a hard error withholds the transport — the only remaining route
     * off this surface all live there. Its height is not a constant either. A
     * recovery button is a 44pt (48 on Android) target against a 20pt meter, and
     * contextual controls wrap on a long locale. Budgeting the 28pt default-scale
     * meter row for all of that is how End Voice and Retry get clipped by
     * `overflow: hidden` under a short viewport.
     *
     * Measuring it is safe for the same reason measuring the status row is: it is
     * not `flex: 1`, so it never stretches to the height it just reported. The
     * transcript above it is the child that gives way, and it is the surface's one
     * scroll owner (§2.7).
     */
    const showActions = live || attemptControl.recoveryAvailable || conversational || !showTransport;
    const [measuredActionsHeight, setMeasuredActionsHeight] = React.useState(0);
    const onActionsBlockLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = Math.round(event.nativeEvent.layout.height);
        setMeasuredActionsHeight((previous) => (previous === next ? previous : next));
    }, []);
    /*
     * Floored at the default-scale row while the block renders — so the first
     * frame, before layout has reported anything, is not visibly short — and left
     * at whatever was measured when there is nothing down there to protect. A
     * collapsed idle vessel must not reserve a row it is not drawing.
     */
    const actionsBlockHeight = showActions
        ? Math.max(VOICE_HORIZON_ACTIONS_BLOCK_HEIGHT, measuredActionsHeight)
        : measuredActionsHeight;

    const { desiredHeight, availableHeight } = resolveVoiceHorizonHeights({
        statusRowHeight,
        actionsBlockHeight,
        conversational,
        viewportHeight: window.height,
        safeAreaBottom: safeArea.bottom,
        availablePanelHeight: model.variant === 'session'
            ? composerAvailablePanelHeight
            : undefined,
    });

    const animatedHeight = useSharedValue(desiredHeight);
    const availableHeightShared = useSharedValue(availableHeight);
    React.useEffect(() => {
        availableHeightShared.set(availableHeight);
    }, [availableHeight, availableHeightShared]);
    React.useEffect(() => {
        animatedHeight.set(
            energy.reduced
                ? desiredHeight
                : withTiming(desiredHeight, {
                    duration: VOICE_MOTION.spatial.durationMs,
                    easing: EASE_SPATIAL,
                }),
        );
    }, [animatedHeight, desiredHeight, energy.reduced]);

    const vesselStyle = useAnimatedStyle(() => ({
        height: Math.min(animatedHeight.get(), availableHeightShared.get()),
    }));
    const skyStyle = useAnimatedStyle(() => {
        'worklet';
        return { opacity: 0.2 + energy.luminosity.get() * 0.8 };
    });

    const inner = Math.max(1, width - 24);

    const recoveryActionRef = React.useRef<FocusReturnTarget>(null);
    const onPrimaryActionWithRecoveryFocus = useRecoveryFocusLatch({
        canRecover: attemptControl.recoveryAvailable,
        canStop: attemptControl.canStop,
        onToggle: attemptControl.onPrimaryAction,
        recoveryActionRef,
    });

    const contextualControls = React.useMemo<readonly VoiceControlAction[]>(() => {
        const controls: VoiceControlAction[] = [];
        if (model.canBargeIn) {
            controls.push({ id: 'bargeIn', label: t('voiceSurface.a11y.bargeIn'), weight: 'secondary' });
        }
        if (model.canCancelTurn) {
            controls.push({ id: 'cancelTurn', label: t('voiceSurface.a11y.cancelTurn'), weight: 'secondary' });
        }
        if (model.canOpenConversation) {
            controls.push({ id: 'openConversation', label: t('voiceSurface.a11y.openConversation'), weight: 'secondary' });
        }
        if (model.canTeleportToSessionRoot) {
            controls.push({ id: 'returnToSession', label: t('voiceSurface.a11y.teleport'), weight: 'secondary' });
        }
        return controls;
    }, [
        model.canBargeIn,
        model.canCancelTurn,
        model.canOpenConversation,
        model.canTeleportToSessionRoot,
    ]);

    // §5.5 — the lab's control ids map onto the model's handlers here, at the
    // boundary. The presentation never re-derives which handler an id means.
    const onAction = React.useCallback((id: VoiceControlId) => {
        switch (id) {
            case 'bargeIn':
                model.onBargeIn();
                return;
            case 'cancelTurn':
                model.onCancelTurn();
                return;
            case 'openConversation':
                model.onOpenConversation();
                return;
            case 'returnToSession':
                model.onTeleport();
                return;
            case 'retry':
            case 'settings':
                attemptControl.onRecover();
                return;
            default:
                return;
        }
    }, [attemptControl, model]);

    /*
     * Copy comes from the model, never from a `t(...)` inside the shared control
     * primitive (§16.5 L1 deferral note). `startStopLabel` and `muteLabel`
     * already carry the live/idle and muted/unmuted branch, so the transport is
     * handed the same string for both sides rather than inventing a second
     * vocabulary — and no key is minted here that a locale file does not have.
     */
    const transportLabels = React.useMemo(() => ({
        start: model.startStopLabel,
        end: model.startStopLabel,
        startHint: model.startStopLabel,
        endHint: model.startStopLabel,
        startText: model.startStopLabel,
        endText: model.startStopLabel,
        mute: model.muteLabel,
        unmute: model.muteLabel,
        micState: model.micStateLabel,
    }), [model.micStateLabel, model.muteLabel, model.startStopLabel]);

    const transcriptRows = React.useMemo(
        // Already newest-first: `visibleTranscriptEntries` is the reversed tail
        // (`useVoiceSurfaceConversationState.ts:144-150`). Reading the canonical
        // order here instead would silently flip batch order.
        () => projectTranscriptRows(model.visibleTranscriptEntries),
        [model.visibleTranscriptEntries],
    );

    const surfaceTestId = `voice-surface:${model.variant}`;
    const modeTestId = `voice-surface-mode:${model.variant}:${model.mode}`;
    const statusTestId = `voice-surface-status:${model.variant}:${model.status}`;
    const statusBlockTestId = `voice-surface-status-block:${model.variant}`;
    const statusContent = (
        <>
            <Text
                testID={statusTestId}
                {...(isWeb ? { 'data-testid': statusTestId } : {})}
                numberOfLines={2}
                style={{
                    ...Typography.default('semiBold'),
                    fontSize: 15,
                    lineHeight: 19,
                    letterSpacing: -0.15,
                    color: tokens.ink,
                }}
            >
                {statusLabel}
            </Text>
            {model.subtitle ? (
                <Text
                    numberOfLines={2}
                    style={{
                        ...Typography.default(),
                        fontSize: 12,
                        lineHeight: 16,
                        color: tokens.inkMuted,
                        marginTop: 1,
                    }}
                >
                    {model.subtitle}
                </Text>
            ) : null}
            {delegatedText ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 }}>
                    <View
                        style={{
                            width: 4,
                            height: 4,
                            borderRadius: 2,
                            backgroundColor: light(stop, 1, tokens),
                            opacity: model.delegatedWork?.thinking ? 1 : 0.5,
                        }}
                    />
                    <Text
                        testID={`voice-surface-delegated:${model.variant}`}
                        {...(isWeb ? { 'data-testid': `voice-surface-delegated:${model.variant}` } : {})}
                        numberOfLines={1}
                        style={{
                            ...Typography.default(),
                            flex: 1,
                            minWidth: 0,
                            fontSize: 12,
                            lineHeight: 16,
                            color: tokens.ink,
                        }}
                    >
                        {delegatedText}
                    </Text>
                </View>
            ) : null}
        </>
    );

    return (
        <View
            testID={surfaceTestId}
            // Required: Android flattens a plain container away and the testID
            // disappears with it (§5.4).
            collapsable={false}
            {...(isWeb ? { 'data-testid': surfaceTestId } : {})}
            style={{ paddingHorizontal: 12, paddingTop: 10 }}
            onLayout={onLayout}
        >
            {/* The hidden mode marker E2E reads. Never visible, never announced. */}
            <View
                testID={modeTestId}
                collapsable={false}
                {...(isWeb ? { 'data-testid': modeTestId } : {})}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
            />
            <Animated.View
                testID={`voice-surface-vessel:${model.variant}`}
                style={[
                    {
                        borderRadius: 18,
                        overflow: 'hidden',
                        borderWidth: BORDER,
                        borderColor: tokens.rule,
                        backgroundColor: tokens.dark ? 'rgba(16,15,22,0.9)' : 'rgba(252,251,253,0.96)',
                        justifyContent: 'flex-start',
                    },
                    vesselStyle,
                ]}
            >
                {/* The sky inside the vessel. Decorative: it carries no state alone. */}
                <Animated.View
                    pointerEvents={decorativePointerEvents.nativePointerEvents}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={[
                        { position: 'absolute', inset: 0, overflow: 'hidden' },
                        skyStyle,
                        decorativePointerEvents.webStyle,
                    ]}
                >
                    <Bloom
                        size={inner * 1.4}
                        blur={inner * 0.3}
                        stop={stop}
                        alpha={0.42}
                        polarity={1}
                        reactivity={1}
                        style={{ left: -inner * 0.2, top: desiredHeight * 0.14 }}
                    />
                    <PlanetLimb
                        width={inner}
                        height={desiredHeight}
                        stop={stop}
                        stopSecondary={stopSecondary}
                        crownRatio={conversational ? 0.13 : 0.3}
                    />
                    <LinearGradient
                        colors={[tokens.hostSurface, tokens.hostSurfaceTransparent]}
                        locations={[0, 1]}
                        style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 14 }}
                    />
                    <Grain radius={18} />
                </Animated.View>

                <View style={{ paddingHorizontal: 13, paddingTop: PAD, paddingBottom: PAD, flex: 1 }}>
                    {/*
                      * Status and transport share the top line — that is what
                      * removed ~36pt from the sidebar budget. When a feed exists,
                      * the tap target is the text block only; when it does not,
                      * the same block stays accessible and presentational.
                      * Nothing interactive is nested inside either branch.
                      */}
                    <View
                        onLayout={onStatusRowLayout}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
                    >
                        {model.activityFeedEnabled ? (
                            <TactilePressable
                                static
                                accessibilityLabel={statusAccessibilityLabel}
                                accessibilityHint={model.toggleActivityLabel}
                                /*
                                 * With a feed, the status block IS the disclosure control (§2.1)
                                 * and carries no chevron, so open/closed reaches assistive tech
                                 * through this state rather than a second visual control.
                                 */
                                expanded={model.expanded}
                                onPress={model.onToggleExpanded}
                                testID={`voice-surface-activity-toggle:${model.variant}`}
                                containerStyle={{
                                    flex: 1,
                                    minWidth: 0,
                                    minHeight: MINIMUM_TARGET_SIZE,
                                    justifyContent: 'center',
                                }}
                            >
                                {statusContent}
                            </TactilePressable>
                        ) : (
                            <View
                                accessible
                                accessibilityLabel={statusAccessibilityLabel}
                                testID={statusBlockTestId}
                                {...(isWeb ? { 'data-testid': statusBlockTestId } : {})}
                                style={{
                                    flex: 1,
                                    minWidth: 0,
                                    minHeight: MINIMUM_TARGET_SIZE,
                                    justifyContent: 'center',
                                }}
                            >
                                {statusContent}
                            </View>
                        )}
                        {showTransport ? (
                        <VoiceTransport
                            labels={transportLabels}
                            live={live}
                            canStart={attemptControl.canStart}
                            muted={attemptControl.muted}
                            canMute={attemptControl.canMute}
                            /*
                             * Capture, not the inverse of muted. A half-duplex provider closes the
                             * microphone while it speaks; drawing it open there would be the one
                             * untruthful thing on a surface whose job is to report state.
                             */
                            capturing={model.isMicCaptureActive}
                            onStart={onPrimaryActionWithRecoveryFocus}
                            onEnd={onPrimaryActionWithRecoveryFocus}
                            onToggleMute={attemptControl.onToggleMute}
                            onAction={onAction}
                            /*
                             * Collapsed, the contextual actions ride the transport
                             * (`VoiceControls.tsx` `extra`); expanded, they move
                             * onto the meter row (§2.1). They are never simply
                             * dropped: open-conversation, teleport and cancel-turn
                             * are ways out, and §2.7 says a way out is the one
                             * thing that is never cut.
                             */
                            extra={conversational ? undefined : contextualControls}
                        />
                        ) : null}
                    </View>

                    {conversational ? (
                        <View style={{ flex: 1, marginTop: 10 }}>
                            {/* The one scroll owner on this surface (§2.7). */}
                            <TranscriptStream entries={transcriptRows} compact />
                        </View>
                    ) : null}

                    {/*
                      * Everything below the transcript is measured as one block
                      * (§2.7): the meter, recovery and the contextual controls are
                      * what the vessel's minimum has to reserve for, and each of
                      * them appears and disappears independently.
                      * `testID` so QA can read the block back at 200% text.
                      */}
                    <View
                        testID={`voice-surface-actions:${model.variant}`}
                        // Android flattens a plain container away, and the testID
                        // and the layout callback go with it (§5.4).
                        collapsable={false}
                        {...(isWeb ? { 'data-testid': `voice-surface-actions:${model.variant}` } : {})}
                        onLayout={onActionsBlockLayout}
                    >
                        {/*
                          * §12.2 — recovery is an ADDITION. The transport above is
                          * still rendered during a recoverable error, so a live
                          * session can always be stopped.
                          */}
                        {showActions ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 }}>
                            {/* A meter with no audio behind it is decoration. */}
                            {live ? (
                                <VoiceWaveform stop={stop} height={conversational ? 24 : 20} />
                            ) : (
                                <View style={{ flex: 1 }} />
                            )}
                            {attemptControl.recoveryAvailable ? (
                                /*
                                 * A plain `Pressable`, not `QuietAction`: the focus
                                 * latch has to hold a ref to this exact node, and
                                 * the shared control primitives are `React.memo`
                                 * without `forwardRef`. The visual treatment is
                                 * `QuietAction`'s primary tone, unchanged.
                                 */
                                <Pressable
                                    ref={recoveryActionRef as any}
                                    testID={`voice-surface-recovery:${model.variant}`}
                                    accessibilityRole="button"
                                    accessibilityLabel={attemptControl.recoveryLabel ?? ''}
                                    onPress={attemptControl.onRecover}
                                    style={({ pressed }) => ({
                                        minWidth: MINIMUM_TARGET_SIZE,
                                        minHeight: MINIMUM_TARGET_SIZE,
                                        justifyContent: 'center',
                                        paddingHorizontal: 12,
                                        borderRadius: 8,
                                        opacity: pressed ? 0.72 : 1,
                                        backgroundColor: tokens.dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)',
                                    })}
                                >
                                    <Text
                                        style={{
                                            ...Typography.default('semiBold'),
                                            fontSize: 12,
                                            color: tokens.ink,
                                        }}
                                    >
                                        {attemptControl.recoveryLabel}
                                    </Text>
                                </Pressable>
                            ) : null}
                            {/*
                              * Expanded, the contextual actions live here; with
                              * the transport withheld by a hard error they live
                              * here too, so a way out is never simply absent.
                              */}
                            {conversational || !showTransport ? (
                                <ControlRow controls={contextualControls} onAction={onAction} />
                            ) : null}
                        </View>
                        ) : null}
                    </View>
                </View>
            </Animated.View>
        </View>
    );
});

/**
 * §5.4 — the recovery focus latch.
 *
 * A start that fails must land focus on the recovery action when it appears, so
 * a keyboard or screen-reader user is not left on a control that did nothing.
 */
function useRecoveryFocusLatch(params: Readonly<{
    canRecover: boolean;
    canStop: boolean;
    onToggle: () => void;
    recoveryActionRef: React.RefObject<FocusReturnTarget>;
}>): () => void {
    const { canRecover, canStop, onToggle, recoveryActionRef } = params;
    const focusRecoveryAfterStartRef = React.useRef(false);
    const wasRecoverableRef = React.useRef(canRecover);

    React.useLayoutEffect(() => {
        const becameRecoverable = !wasRecoverableRef.current && canRecover;
        wasRecoverableRef.current = canRecover;
        if (!becameRecoverable || !focusRecoveryAfterStartRef.current) return;
        focusRecoveryAfterStartRef.current = false;
        restoreFocusToBestTarget(recoveryActionRef);
    }, [canRecover, recoveryActionRef]);

    React.useEffect(() => {
        if (canStop) {
            focusRecoveryAfterStartRef.current = false;
        }
    }, [canStop]);

    return React.useCallback(() => {
        if (!canStop) {
            focusRecoveryAfterStartRef.current = true;
        }
        onToggle();
    }, [canStop, onToggle]);
}
