import * as React from 'react';
import { Keyboard, Platform, useWindowDimensions } from 'react-native';
import { useKeyboardHandler, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { runOnJS, useDerivedValue, useSharedValue } from 'react-native-reanimated';

import {
    resolveAvailablePanelHeight,
    resolveComposerBottomOffset,
    resolveListBottomInset,
} from './composerKeyboardGeometry';
import type { ComposerKeyboardLayout } from './ComposerKeyboardContext';

export type ComposerKeyboardLayoutOptions = Readonly<{
    availablePanelMaxHeight?: number;
    headerHeight?: number;
    keyboardLiftSuppressed?: boolean;
    layoutBottomInset?: number;
    safeAreaBottom?: number;
}>;

type KeyboardFinalFrameCoordinates = Readonly<{
    height?: number;
    screenY?: number;
}>;

// Complete input set for a static layout recompute. The recompute runs on the JS thread, so the
// set is OWNED there, in `staticLayoutInputsRef`. Shared-value reads return the last synchronized
// value (guest-runtime writes are async in Reanimated 4 — see
// `useComposerKeyboardLayout.native.sharedValueLag.test.ts`), so reading the set back from the
// shared values is a lost update whenever the JS thread is behind the keyboard: a composer or
// scaffold measurement processed after a dismissal replays the keyboard-raised geometry and
// re-seats the composer over the transcript. It never heals, because
// `ignoreKeyboardFramesUntilComposerFocus` stops every keyboard worklet from re-deriving the
// layout until the composer is refocused. (Measured 2026-08-08: ~36% of sends on device.)
// Callers therefore pass only the fields they own; everything else comes from the record.
type ComposerStaticLayoutInputs = Readonly<{
    availablePanelMaxHeight: number | undefined;
    composerHeight: number;
    headerHeight: number;
    isInteractiveDismissActive: boolean;
    isKeyboardLiftSuppressed: boolean;
    keyboardHeightAbsolute: number;
    keyboardHeightForInset: number;
    layoutBottomInset: number;
    safeAreaBottom: number;
    scaffoldHeight: number;
    viewportHeight: number;
}>;

// The keyboard-owned slice of that record. These fields are written by the keyboard worklets on
// the UI thread, so the JS record cannot observe them any other way. The worklets already cross
// to JS once per frame to notify the keyboard height; that same crossing carries the slice, so
// keeping the record authoritative costs no additional UI-thread work.
type KeyboardFrameState = Readonly<{
    absoluteHeight: number;
    insetHeight: number;
    interactiveDismissActive: boolean;
    lastEventHeight: number;
    liveHeight: number;
}>;

function resolveAndroidFinalFrameKeyboardHeight(
    coordinates: KeyboardFinalFrameCoordinates | undefined,
    viewportHeight: number,
): number {
    const reportedHeight = typeof coordinates?.height === 'number' && Number.isFinite(coordinates.height)
        ? Math.max(0, coordinates.height)
        : 0;
    const heightFromScreenY =
        typeof coordinates?.screenY === 'number'
        && Number.isFinite(coordinates.screenY)
        && Number.isFinite(viewportHeight)
            ? Math.max(0, viewportHeight - coordinates.screenY)
            : 0;

    return Math.max(reportedHeight, heightFromScreenY);
}

function resolveKeyboardHeightWithinScaffold(keyboardHeight: number, layoutBottomInset: number): number {
    'worklet';
    return Math.max(0, keyboardHeight - Math.max(0, layoutBottomInset));
}

/**
 * Should this keyboard frame be ignored, and does it re-open the gate?
 *
 * `ignoreKeyboardFramesUntilComposerFocus` is set on every settled hide so that keyboard activity
 * belonging to some OTHER input cannot re-seat our composer. Opening it only on a fresh `onFocus`
 * was too narrow: the keyboard can leave and come back while our input keeps first responder — a
 * transient system presentation over a focused field (the edit/Paste bubble), an interactive
 * dismiss that springs back, a hardware-keyboard toggle, background/foreground — and none of those
 * emit `onFocus`. The gate then stays shut, `bottomInset` never rises, and the composer (absolutely
 * positioned at `bottom: 0`, lifted only by `translateY: -bottomInset`) sits behind the keyboard
 * until the user blurs and refocuses it. A frame that arrives while our input still holds focus IS
 * ours, so it re-opens the gate instead of being dropped.
 */
function shouldIgnoreKeyboardFrame(
    ignoreFramesUntilComposerFocus: { value: boolean },
    composerInputFocused: { value: boolean },
): boolean {
    'worklet';
    if (!ignoreFramesUntilComposerFocus.value) return false;
    if (!composerInputFocused.value) return true;
    ignoreFramesUntilComposerFocus.value = false;
    return false;
}

function clampAvailablePanelHeightToMax(height: number, maxHeight: number | undefined): number {
    'worklet';
    if (typeof maxHeight !== 'number' || !Number.isFinite(maxHeight) || maxHeight <= 0) {
        return height;
    }
    return Math.min(height, maxHeight);
}

function resolveMeasuredViewportHeight(scaffoldHeight: number, fallbackViewportHeight: number): number {
    'worklet';
    return scaffoldHeight > 0 ? scaffoldHeight : fallbackViewportHeight;
}

function resolveMeasuredHeaderHeight(scaffoldHeight: number, fallbackHeaderHeight: number): number {
    'worklet';
    return scaffoldHeight > 0 ? 0 : fallbackHeaderHeight;
}

export function useComposerKeyboardLayout(options: ComposerKeyboardLayoutOptions = {}): ComposerKeyboardLayout {
    const dimensions = useWindowDimensions();
    const safeAreaBottom = options.safeAreaBottom ?? 0;
    const headerHeight = options.headerHeight ?? 0;
    const layoutBottomInset = typeof options.layoutBottomInset === 'number' && Number.isFinite(options.layoutBottomInset)
        ? Math.max(0, options.layoutBottomInset)
        : 0;
    const availablePanelMaxHeight = typeof options.availablePanelMaxHeight === 'number' && Number.isFinite(options.availablePanelMaxHeight)
        ? Math.max(0, options.availablePanelMaxHeight)
        : undefined;
    const keyboardLiftSuppressed = options.keyboardLiftSuppressed === true;

    const keyboardAnimation = useReanimatedKeyboardAnimation();
    const availablePanelHeight = useSharedValue(resolveAvailablePanelHeight({
        viewportHeight: dimensions.height,
        headerHeight,
        keyboardHeight: 0,
        maxHeight: availablePanelMaxHeight,
        reservedHeight: layoutBottomInset,
        safeAreaBottom,
    }));
    const bottomInset = useSharedValue(resolveComposerBottomOffset({ keyboardHeight: 0, safeAreaBottom }));
    const composerHeight = useSharedValue(0);
    const isInteractiveDismissActive = useSharedValue(false);
    const isKeyboardLiftSuppressed = useSharedValue(keyboardLiftSuppressed);
    const isKeyboardLiftRetained = useSharedValue(false);
    const ignoreKeyboardFramesUntilComposerFocus = useSharedValue(false);
    const isComposerInputFocused = useSharedValue(false);
    const keyboardHeightForInset = useSharedValue(0);
    const keyboardHeightAbsolute = useSharedValue(0);
    const keyboardHeightLive = useSharedValue(0);
    const keyboardProgress = useSharedValue(0);
    const listBottomInset = useSharedValue(resolveListBottomInset({
        composerHeight: 0,
        keyboardHeightForInset: 0,
        safeAreaBottom,
    }));
    const safeAreaBottomValue = useSharedValue(safeAreaBottom);
    const layoutBottomInsetValue = useSharedValue(layoutBottomInset);
    const availablePanelMaxHeightValue = useSharedValue(availablePanelMaxHeight);
    const headerHeightValue = useSharedValue(headerHeight);
    const scaffoldMeasuredHeight = useSharedValue(0);
    const viewportHeight = useSharedValue(dimensions.height);
    const availablePanelHeightSubscribersRef = React.useRef(new Set<(height: number) => void>());
    const keyboardHeightSnapshotRef = React.useRef(0);
    const keyboardHeightSubscribersRef = React.useRef(new Set<(height: number) => void>());
    const listBottomInsetSubscribersRef = React.useRef(new Set<(height: number) => void>());
    const keyboardRetentionCountRef = React.useRef(0);

    // JS mirror of the last notified panel height: subscribe replay must not read the shared
    // value (guest-runtime writes are async, so `.value` can lag the last computed height).
    const availablePanelHeightSnapshotRef = React.useRef<number | null>(null);
    const notifyAvailablePanelHeight = React.useCallback((height: number) => {
        availablePanelHeightSnapshotRef.current = height;
        for (const listener of availablePanelHeightSubscribersRef.current) {
            listener(height);
        }
    }, []);

    const subscribeAvailablePanelHeight = React.useCallback((listener: (height: number) => void) => {
        availablePanelHeightSubscribersRef.current.add(listener);
        listener(availablePanelHeightSnapshotRef.current ?? availablePanelHeight.value);
        return () => {
            availablePanelHeightSubscribersRef.current.delete(listener);
        };
    }, [availablePanelHeight]);

    const notifyKeyboardHeight = React.useCallback((height: number) => {
        const nextHeight = typeof height === 'number' && Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
        if (keyboardHeightSnapshotRef.current === nextHeight) return;
        keyboardHeightSnapshotRef.current = nextHeight;
        for (const listener of keyboardHeightSubscribersRef.current) {
            listener(nextHeight);
        }
    }, []);

    const getKeyboardHeight = React.useCallback(() => keyboardHeightSnapshotRef.current, []);

    const subscribeKeyboardHeight = React.useCallback((listener: (height: number) => void) => {
        keyboardHeightSubscribersRef.current.add(listener);
        listener(keyboardHeightSnapshotRef.current);
        return () => {
            keyboardHeightSubscribersRef.current.delete(listener);
        };
    }, []);

    // JS mirror of the last notified inset: subscribe replay must not read the shared value
    // (guest-runtime writes are async, so `.value` can lag the last computed inset).
    const listBottomInsetSnapshotRef = React.useRef<number | null>(null);
    const notifyListBottomInset = React.useCallback((height: number) => {
        listBottomInsetSnapshotRef.current = height;
        for (const listener of listBottomInsetSubscribersRef.current) {
            listener(height);
        }
    }, []);

    const subscribeListBottomInset = React.useCallback((listener: (height: number) => void) => {
        listBottomInsetSubscribersRef.current.add(listener);
        listener(listBottomInsetSnapshotRef.current ?? listBottomInset.value);
        return () => {
            listBottomInsetSubscribersRef.current.delete(listener);
        };
    }, [listBottomInset]);

    // Authoritative JS-thread record of the static layout inputs — see ComposerStaticLayoutInputs
    // for why this cannot be read back from the shared values.
    const staticLayoutInputsRef = React.useRef<ComposerStaticLayoutInputs>({
        availablePanelMaxHeight,
        composerHeight: 0,
        headerHeight,
        isInteractiveDismissActive: false,
        isKeyboardLiftSuppressed: keyboardLiftSuppressed,
        keyboardHeightAbsolute: 0,
        keyboardHeightForInset: 0,
        layoutBottomInset,
        safeAreaBottom,
        scaffoldHeight: 0,
        viewportHeight: dimensions.height,
    });

    // Raw height of the last keyboard event, before retention substitutes the held lift. Owned on
    // the UI thread and mirrored here for the same reason as the record above: the retention
    // release reads it to decide whether the keyboard is genuinely gone, and a stale read there
    // holds the composer at the retained lift for good.
    const lastKeyboardEventHeightAbsoluteRef = React.useRef(0);

    const applyKeyboardFrameFromUI = React.useCallback((frame: KeyboardFrameState) => {
        lastKeyboardEventHeightAbsoluteRef.current = frame.lastEventHeight;
        staticLayoutInputsRef.current = {
            ...staticLayoutInputsRef.current,
            isInteractiveDismissActive: frame.interactiveDismissActive,
            keyboardHeightAbsolute: frame.absoluteHeight,
            keyboardHeightForInset: frame.insetHeight,
        };
        notifyKeyboardHeight(frame.liveHeight);
    }, [notifyKeyboardHeight]);

    const recomputeStaticLayout = React.useCallback((overrides: Partial<ComposerStaticLayoutInputs> = {}) => {
        // Guest-runtime (JS-thread) shared-value writes are async in Reanimated 4: a read
        // immediately after a write observes the PREVIOUS value. Every value that is written
        // and then consumed within this pass must therefore flow through a local, and every
        // subscriber notification must carry the freshly computed local — never a `.value`
        // read-back. (Live-diagnosed 2026-07-09: read-back notifies left the transcript
        // composer inset one growth step behind, rendering rows under the composer.) This
        // recompute therefore reads nothing back: every input comes from the JS-owned record,
        // which each writer updates in the same pass as its shared-value write.
        const inputs: ComposerStaticLayoutInputs = { ...staticLayoutInputsRef.current, ...overrides };
        const effectiveComposerHeight = Math.max(0, Math.round(inputs.composerHeight));
        const effectiveScaffoldHeight = Math.max(0, Math.round(inputs.scaffoldHeight));
        const effectiveViewportHeight = resolveMeasuredViewportHeight(effectiveScaffoldHeight, inputs.viewportHeight);
        const effectiveHeaderHeight = resolveMeasuredHeaderHeight(effectiveScaffoldHeight, inputs.headerHeight);
        const liveKeyboardHeight = inputs.isKeyboardLiftSuppressed
            ? 0
            : resolveKeyboardHeightWithinScaffold(inputs.keyboardHeightAbsolute, inputs.layoutBottomInset);
        keyboardHeightLive.value = liveKeyboardHeight;
        const shouldRefreshInsetKeyboardHeight = inputs.isKeyboardLiftSuppressed || !inputs.isInteractiveDismissActive;
        if (shouldRefreshInsetKeyboardHeight) {
            keyboardHeightForInset.value = liveKeyboardHeight;
        }
        staticLayoutInputsRef.current = shouldRefreshInsetKeyboardHeight
            ? { ...inputs, keyboardHeightForInset: liveKeyboardHeight }
            : inputs;
        notifyKeyboardHeight(liveKeyboardHeight);
        const insetKeyboardHeight = inputs.isKeyboardLiftSuppressed
            ? 0
            : (shouldRefreshInsetKeyboardHeight ? liveKeyboardHeight : inputs.keyboardHeightForInset);
        bottomInset.value = resolveComposerBottomOffset({
            keyboardHeight: liveKeyboardHeight,
            safeAreaBottom: inputs.safeAreaBottom,
        });
        const nextListBottomInset = resolveListBottomInset({
            composerHeight: effectiveComposerHeight,
            keyboardHeightForInset: insetKeyboardHeight,
            safeAreaBottom: inputs.safeAreaBottom,
        });
        listBottomInset.value = nextListBottomInset;
        notifyListBottomInset(nextListBottomInset);
        const absoluteKeyboardHeight = inputs.isKeyboardLiftSuppressed ? 0 : inputs.keyboardHeightAbsolute;
        const nextAvailablePanelHeight = resolveAvailablePanelHeight({
            viewportHeight: effectiveViewportHeight,
            headerHeight: effectiveHeaderHeight,
            keyboardHeight: absoluteKeyboardHeight,
            maxHeight: inputs.availablePanelMaxHeight,
            reservedHeight: absoluteKeyboardHeight > 0 ? 0 : inputs.layoutBottomInset,
            safeAreaBottom: inputs.safeAreaBottom,
        });
        availablePanelHeight.value = nextAvailablePanelHeight;
        notifyAvailablePanelHeight(nextAvailablePanelHeight);
    }, [
        availablePanelHeight,
        bottomInset,
        keyboardHeightForInset,
        keyboardHeightLive,
        listBottomInset,
        notifyKeyboardHeight,
        notifyListBottomInset,
        notifyAvailablePanelHeight,
    ]);

    // The settled keyboard height reported by the platform's own hide/show event. This is the
    // authority on where the keyboard ended up, so it writes the record and then runs the one
    // recompute rather than carrying a second copy of the same geometry.
    const applyFinalKeyboardHeightFromJS = React.useCallback((height: number) => {
        const absoluteKeyboardHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
        const liftIsSuppressed = staticLayoutInputsRef.current.isKeyboardLiftSuppressed;
        const effectiveAbsoluteKeyboardHeight = liftIsSuppressed ? 0 : absoluteKeyboardHeight;
        lastKeyboardEventHeightAbsoluteRef.current = absoluteKeyboardHeight;
        isInteractiveDismissActive.value = false;
        keyboardHeightAbsolute.value = effectiveAbsoluteKeyboardHeight;
        keyboardProgress.value = resolveKeyboardHeightWithinScaffold(
            effectiveAbsoluteKeyboardHeight,
            staticLayoutInputsRef.current.layoutBottomInset,
        ) > 0 ? 1 : 0;
        recomputeStaticLayout({
            isInteractiveDismissActive: false,
            keyboardHeightAbsolute: effectiveAbsoluteKeyboardHeight,
        });
    }, [
        isInteractiveDismissActive,
        keyboardHeightAbsolute,
        keyboardProgress,
        recomputeStaticLayout,
    ]);

    React.useEffect(() => {
        if (Platform.OS === 'android') return undefined;

        const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
            if (keyboardRetentionCountRef.current > 0) {
                // Retention holds the composer at the lifted SEAT across a hide so focus can
                // transfer; it is not a reason to keep believing the keyboard is still there.
                // Recording the settled hide is what releases the interactive-dismiss freeze,
                // which otherwise outlives the keyboard: `onStart`/`onEnd` only arrive while the
                // keyboard is moving, and it has stopped, so nothing else can release it. The
                // freeze holds `keyboardHeightForInset` — read by the transcript inset on both
                // threads and by nothing that seats the composer — so a stuck freeze leaves the
                // composer correctly docked and the transcript stranded at a keyboard-sized
                // inset until the composer is refocused. (Measured 2026-08-08: the transcript
                // spacer re-expanded 258 px after a correct collapse in 4/32 device sends.)
                isInteractiveDismissActive.value = false;
                recomputeStaticLayout({ isInteractiveDismissActive: false });
                return;
            }
            ignoreKeyboardFramesUntilComposerFocus.value = true;
            applyFinalKeyboardHeightFromJS(0);
        });

        return () => {
            hideSubscription.remove();
        };
    }, [
        applyFinalKeyboardHeightFromJS,
        ignoreKeyboardFramesUntilComposerFocus,
        isInteractiveDismissActive,
        recomputeStaticLayout,
    ]);

    React.useEffect(() => {
        if (Platform.OS !== 'android') return undefined;

        const showSubscription = Keyboard.addListener('keyboardDidShow', (event) => {
            applyFinalKeyboardHeightFromJS(resolveAndroidFinalFrameKeyboardHeight(
                event.endCoordinates,
                dimensions.height,
            ));
        });
        const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
            applyFinalKeyboardHeightFromJS(0);
        });

        return () => {
            showSubscription.remove();
            hideSubscription.remove();
        };
    }, [applyFinalKeyboardHeightFromJS, dimensions.height]);

    React.useEffect(() => {
        // Every value written below is consumed by the recompute in this same pass, so it is
        // handed to the recompute directly; reading it back would replay the previous safe area /
        // header / viewport / suppression state and leave the transcript inset a growth step
        // behind.
        safeAreaBottomValue.value = safeAreaBottom;
        layoutBottomInsetValue.value = layoutBottomInset;
        availablePanelMaxHeightValue.value = availablePanelMaxHeight;
        headerHeightValue.value = headerHeight;
        viewportHeight.value = dimensions.height;
        isKeyboardLiftSuppressed.value = keyboardLiftSuppressed;
        if (keyboardLiftSuppressed) {
            isInteractiveDismissActive.value = false;
            keyboardHeightAbsolute.value = 0;
            keyboardHeightLive.value = 0;
            keyboardHeightForInset.value = 0;
            keyboardProgress.value = 0;
        }
        recomputeStaticLayout({
            availablePanelMaxHeight,
            headerHeight,
            isKeyboardLiftSuppressed: keyboardLiftSuppressed,
            layoutBottomInset,
            safeAreaBottom,
            viewportHeight: dimensions.height,
            ...(keyboardLiftSuppressed
                ? { isInteractiveDismissActive: false, keyboardHeightAbsolute: 0, keyboardHeightForInset: 0 }
                : {}),
        });
    }, [
        dimensions.height,
        availablePanelMaxHeight,
        availablePanelMaxHeightValue,
        availablePanelHeight,
        bottomInset,
        headerHeight,
        headerHeightValue,
        isInteractiveDismissActive,
        isKeyboardLiftSuppressed,
        keyboardHeightAbsolute,
        keyboardHeightForInset,
        keyboardHeightLive,
        keyboardLiftSuppressed,
        keyboardProgress,
        listBottomInset,
        recomputeStaticLayout,
        layoutBottomInset,
        layoutBottomInsetValue,
        safeAreaBottom,
        safeAreaBottomValue,
        viewportHeight,
    ]);

    const shouldRetainAndroidZeroProgressStartFrame = Platform.OS === 'android';

    useKeyboardHandler({
        onStart: (event) => {
            'worklet';
            if (shouldIgnoreKeyboardFrame(ignoreKeyboardFramesUntilComposerFocus, isComposerInputFocused)) return;
            isInteractiveDismissActive.value = false;
            const nextHeight = Math.max(0, Math.abs(event.height));
            const nextProgress = typeof event.progress === 'number' && Number.isFinite(event.progress)
                ? Math.max(0, event.progress)
                : 0;
            const shouldRetainOpenKeyboardStartFrame = shouldRetainAndroidZeroProgressStartFrame
                && !isKeyboardLiftSuppressed.value
                && nextHeight === 0
                && nextProgress <= 0
                && keyboardHeightAbsolute.value > 0;
            const retainedHeight = !isKeyboardLiftSuppressed.value
                && (isKeyboardLiftRetained.value || shouldRetainOpenKeyboardStartFrame)
                && nextHeight === 0
                ? keyboardHeightAbsolute.value
                : nextHeight;
            const absoluteHeight = isKeyboardLiftSuppressed.value ? 0 : retainedHeight;
            keyboardHeightAbsolute.value = absoluteHeight;
            const storedHeight = isKeyboardLiftSuppressed.value
                ? 0
                : resolveKeyboardHeightWithinScaffold(retainedHeight, layoutBottomInsetValue.value);
            keyboardHeightLive.value = storedHeight;
            keyboardHeightForInset.value = storedHeight;
            runOnJS(applyKeyboardFrameFromUI)({
                absoluteHeight,
                insetHeight: storedHeight,
                interactiveDismissActive: false,
                lastEventHeight: nextHeight,
                liveHeight: storedHeight,
            });
            keyboardProgress.value = isKeyboardLiftSuppressed.value ? 0 : nextProgress;
            const effectiveLiveHeight = storedHeight;
            const startFrameLiveHeight = nextProgress <= 0 && !shouldRetainOpenKeyboardStartFrame
                ? 0
                : effectiveLiveHeight;
            bottomInset.value = Math.max(safeAreaBottomValue.value, startFrameLiveHeight);
            const nextListBottomInset = composerHeight.value + Math.max(safeAreaBottomValue.value, effectiveLiveHeight);
            listBottomInset.value = nextListBottomInset;
            runOnJS(notifyListBottomInset)(nextListBottomInset);
            const effectiveViewportHeight = resolveMeasuredViewportHeight(scaffoldMeasuredHeight.value, viewportHeight.value);
            const effectiveHeaderHeight = resolveMeasuredHeaderHeight(scaffoldMeasuredHeight.value, headerHeightValue.value);
            const nextAvailablePanelHeight = clampAvailablePanelHeightToMax(Math.max(
                0,
                effectiveViewportHeight
                    - effectiveHeaderHeight
                    - Math.max(safeAreaBottomValue.value, keyboardHeightAbsolute.value)
                    - (keyboardHeightAbsolute.value > 0 ? 0 : layoutBottomInsetValue.value),
            ), availablePanelMaxHeightValue.value);
            availablePanelHeight.value = nextAvailablePanelHeight;
            runOnJS(notifyAvailablePanelHeight)(nextAvailablePanelHeight);
        },
        onMove: (event) => {
            'worklet';
            if (shouldIgnoreKeyboardFrame(ignoreKeyboardFramesUntilComposerFocus, isComposerInputFocused)) return;
            const eventHeight = Math.max(0, Math.abs(event.height));
            const eventProgress = typeof event.progress === 'number' && Number.isFinite(event.progress)
                ? Math.max(0, event.progress)
                : 0;
            const reanimatedHeight = Math.max(0, Math.abs(keyboardAnimation.height.value));
            const keyboardLiftIsSuppressed = isKeyboardLiftSuppressed.value;
            if (keyboardLiftIsSuppressed) {
                isInteractiveDismissActive.value = false;
            }
            const eventReportsClosedFrame = eventHeight === 0 && eventProgress <= 0;
            const rawAbsoluteLiveHeight = eventReportsClosedFrame
                ? 0
                : Math.max(eventHeight, reanimatedHeight);
            const absoluteLiveHeight = !keyboardLiftIsSuppressed
                && isKeyboardLiftRetained.value
                && rawAbsoluteLiveHeight === 0
                ? keyboardHeightAbsolute.value
                : rawAbsoluteLiveHeight;
            const absoluteHeight = keyboardLiftIsSuppressed ? 0 : absoluteLiveHeight;
            keyboardHeightAbsolute.value = absoluteHeight;
            const liveHeight = keyboardLiftIsSuppressed
                ? 0
                : resolveKeyboardHeightWithinScaffold(absoluteLiveHeight, layoutBottomInsetValue.value);
            const interactiveDismissActive = !keyboardLiftIsSuppressed && isInteractiveDismissActive.value;
            const insetHeight = interactiveDismissActive ? keyboardHeightForInset.value : liveHeight;
            const effectiveLiveHeight = liveHeight;
            const effectiveInsetHeight = keyboardLiftIsSuppressed ? 0 : insetHeight;
            keyboardHeightLive.value = liveHeight;
            if (!interactiveDismissActive) {
                keyboardHeightForInset.value = insetHeight;
            }
            runOnJS(applyKeyboardFrameFromUI)({
                absoluteHeight,
                insetHeight,
                interactiveDismissActive,
                lastEventHeight: rawAbsoluteLiveHeight,
                liveHeight,
            });
            keyboardProgress.value = keyboardLiftIsSuppressed ? 0 : eventProgress;
            bottomInset.value = Math.max(safeAreaBottomValue.value, effectiveLiveHeight);
            const nextListBottomInset = composerHeight.value + Math.max(safeAreaBottomValue.value, effectiveInsetHeight);
            listBottomInset.value = nextListBottomInset;
            runOnJS(notifyListBottomInset)(nextListBottomInset);
            const effectiveViewportHeight = resolveMeasuredViewportHeight(scaffoldMeasuredHeight.value, viewportHeight.value);
            const effectiveHeaderHeight = resolveMeasuredHeaderHeight(scaffoldMeasuredHeight.value, headerHeightValue.value);
            const nextAvailablePanelHeight = clampAvailablePanelHeightToMax(Math.max(
                0,
                effectiveViewportHeight
                    - effectiveHeaderHeight
                    - Math.max(safeAreaBottomValue.value, keyboardHeightAbsolute.value)
                    - (keyboardHeightAbsolute.value > 0 ? 0 : layoutBottomInsetValue.value),
            ), availablePanelMaxHeightValue.value);
            availablePanelHeight.value = nextAvailablePanelHeight;
            runOnJS(notifyAvailablePanelHeight)(nextAvailablePanelHeight);
        },
        onInteractive: (event) => {
            'worklet';
            if (shouldIgnoreKeyboardFrame(ignoreKeyboardFramesUntilComposerFocus, isComposerInputFocused)) return;
            const keyboardLiftIsSuppressed = isKeyboardLiftSuppressed.value;
            const interactiveDismissActive = !keyboardLiftIsSuppressed;
            isInteractiveDismissActive.value = interactiveDismissActive;
            const eventHeight = Math.max(0, Math.abs(event.height));
            const liveHeight = !keyboardLiftIsSuppressed
                && isKeyboardLiftRetained.value
                && eventHeight === 0
                ? keyboardHeightAbsolute.value
                : eventHeight;
            const absoluteHeight = keyboardLiftIsSuppressed ? 0 : liveHeight;
            keyboardHeightAbsolute.value = absoluteHeight;
            const effectiveLiveHeight = keyboardLiftIsSuppressed
                ? 0
                : resolveKeyboardHeightWithinScaffold(liveHeight, layoutBottomInsetValue.value);
            keyboardHeightLive.value = effectiveLiveHeight;
            if (keyboardLiftIsSuppressed) {
                keyboardHeightForInset.value = 0;
            }
            runOnJS(applyKeyboardFrameFromUI)({
                absoluteHeight,
                insetHeight: keyboardLiftIsSuppressed ? 0 : keyboardHeightForInset.value,
                interactiveDismissActive,
                lastEventHeight: eventHeight,
                liveHeight: effectiveLiveHeight,
            });
            keyboardProgress.value = keyboardLiftIsSuppressed ? 0 : event.progress;
            bottomInset.value = Math.max(safeAreaBottomValue.value, effectiveLiveHeight);
            const nextListBottomInset = composerHeight.value + Math.max(
                safeAreaBottomValue.value,
                keyboardLiftIsSuppressed ? 0 : keyboardHeightForInset.value,
            );
            listBottomInset.value = nextListBottomInset;
            runOnJS(notifyListBottomInset)(nextListBottomInset);
            const effectiveViewportHeight = resolveMeasuredViewportHeight(scaffoldMeasuredHeight.value, viewportHeight.value);
            const effectiveHeaderHeight = resolveMeasuredHeaderHeight(scaffoldMeasuredHeight.value, headerHeightValue.value);
            const nextAvailablePanelHeight = clampAvailablePanelHeightToMax(Math.max(
                0,
                effectiveViewportHeight
                    - effectiveHeaderHeight
                    - Math.max(safeAreaBottomValue.value, keyboardHeightAbsolute.value)
                    - (keyboardHeightAbsolute.value > 0 ? 0 : layoutBottomInsetValue.value),
            ), availablePanelMaxHeightValue.value);
            availablePanelHeight.value = nextAvailablePanelHeight;
            runOnJS(notifyAvailablePanelHeight)(nextAvailablePanelHeight);
        },
        onEnd: (event) => {
            'worklet';
            if (shouldIgnoreKeyboardFrame(ignoreKeyboardFramesUntilComposerFocus, isComposerInputFocused)) return;
            isInteractiveDismissActive.value = false;
            const nextHeight = Math.max(0, Math.abs(event.height));
            const retainedHeight = !isKeyboardLiftSuppressed.value
                && isKeyboardLiftRetained.value
                && nextHeight === 0
                ? keyboardHeightAbsolute.value
                : nextHeight;
            const absoluteHeight = isKeyboardLiftSuppressed.value ? 0 : retainedHeight;
            keyboardHeightAbsolute.value = absoluteHeight;
            const effectiveHeight = isKeyboardLiftSuppressed.value
                ? 0
                : resolveKeyboardHeightWithinScaffold(retainedHeight, layoutBottomInsetValue.value);
            keyboardHeightLive.value = effectiveHeight;
            keyboardHeightForInset.value = effectiveHeight;
            runOnJS(applyKeyboardFrameFromUI)({
                absoluteHeight,
                insetHeight: effectiveHeight,
                interactiveDismissActive: false,
                lastEventHeight: nextHeight,
                liveHeight: effectiveHeight,
            });
            keyboardProgress.value = isKeyboardLiftSuppressed.value ? 0 : event.progress;
            bottomInset.value = Math.max(safeAreaBottomValue.value, effectiveHeight);
            const nextListBottomInset = composerHeight.value + Math.max(safeAreaBottomValue.value, effectiveHeight);
            listBottomInset.value = nextListBottomInset;
            runOnJS(notifyListBottomInset)(nextListBottomInset);
            const effectiveViewportHeight = resolveMeasuredViewportHeight(scaffoldMeasuredHeight.value, viewportHeight.value);
            const effectiveHeaderHeight = resolveMeasuredHeaderHeight(scaffoldMeasuredHeight.value, headerHeightValue.value);
            const nextAvailablePanelHeight = clampAvailablePanelHeightToMax(Math.max(
                0,
                effectiveViewportHeight
                    - effectiveHeaderHeight
                    - Math.max(safeAreaBottomValue.value, keyboardHeightAbsolute.value)
                    - (keyboardHeightAbsolute.value > 0 ? 0 : layoutBottomInsetValue.value),
            ), availablePanelMaxHeightValue.value);
            availablePanelHeight.value = nextAvailablePanelHeight;
            runOnJS(notifyAvailablePanelHeight)(nextAvailablePanelHeight);
        },
    }, [
        applyKeyboardFrameFromUI,
        ignoreKeyboardFramesUntilComposerFocus,
        keyboardAnimation.height,
        notifyAvailablePanelHeight,
        notifyListBottomInset,
        scaffoldMeasuredHeight,
        shouldRetainAndroidZeroProgressStartFrame,
    ]);

    // `listBottomInset` above is the SETTLED total. Every keyboard transition opens with
    // `onStart`, which reports the target frame, so that total reaches its end value before the
    // keyboard has moved a pixel — and it then travels to the renderer as React state on the JS
    // thread. Measured 2026-08-01 across 11 real sends
    // (`.project/reviews/2026-08-01-send-transition/traces/S7.csv` t=25605, `S11.csv` t=22917):
    // the transcript's bottom spacer collapsed 258 px in a single frame while the keyboard was
    // still animating away, and every visible row translated with it, because the JS thread was
    // stalled 0.7-3.6 s across the send.
    //
    // This derived value is the same quantity recomputed on the UI thread from the keyboard's
    // own animation, so the rendered spacer tracks the keyboard frame by frame no matter what
    // the JS thread is doing. It applies the same guards as `onMove` — suppression, the
    // post-hide latch, retained lift and the interactive-dismiss freeze — because it reads the
    // raw animation value, which honours none of them on its own.
    const listBottomInsetAnimated = useDerivedValue(() => {
        const liftIsSuppressed = isKeyboardLiftSuppressed.value;
        const framesAreIgnored = ignoreKeyboardFramesUntilComposerFocus.value;
        const interactiveDismissIsActive = isInteractiveDismissActive.value;
        const liftIsRetained = isKeyboardLiftRetained.value;
        const settledInsetKeyboardHeight = keyboardHeightForInset.value;
        const retainedAbsoluteHeight = keyboardHeightAbsolute.value;
        const measuredComposerHeight = composerHeight.value;
        const safeArea = safeAreaBottomValue.value;
        const animatedAbsoluteHeight = Math.max(0, Math.abs(keyboardAnimation.height.value));
        const absoluteHeight = liftIsRetained && animatedAbsoluteHeight === 0
            ? retainedAbsoluteHeight
            : animatedAbsoluteHeight;
        const liveKeyboardHeight = resolveKeyboardHeightWithinScaffold(absoluteHeight, layoutBottomInsetValue.value);
        const insetKeyboardHeight = liftIsSuppressed
            ? 0
            : (framesAreIgnored || interactiveDismissIsActive ? settledInsetKeyboardHeight : liveKeyboardHeight);
        return resolveListBottomInset({
            composerHeight: measuredComposerHeight,
            keyboardHeightForInset: insetKeyboardHeight,
            safeAreaBottom: safeArea,
        });
    }, [keyboardAnimation.height]);

    const retainKeyboardLift = React.useCallback(() => {
        let released = false;
        keyboardRetentionCountRef.current += 1;
        isKeyboardLiftRetained.value = keyboardRetentionCountRef.current > 0;

        return () => {
            if (released) return;
            released = true;
            keyboardRetentionCountRef.current = Math.max(0, keyboardRetentionCountRef.current - 1);
            isKeyboardLiftRetained.value = keyboardRetentionCountRef.current > 0;
            const shouldReleaseKeyboardLift = keyboardRetentionCountRef.current === 0
                && lastKeyboardEventHeightAbsoluteRef.current === 0;
            if (shouldReleaseKeyboardLift) {
                isInteractiveDismissActive.value = false;
                keyboardHeightAbsolute.value = 0;
                keyboardHeightLive.value = 0;
                keyboardHeightForInset.value = 0;
                keyboardProgress.value = 0;
            }
            // The collapse written just above must reach the recompute as locals: a read-back
            // would replay the retained keyboard height for one more step.
            recomputeStaticLayout(shouldReleaseKeyboardLift
                ? {
                    isInteractiveDismissActive: false,
                    keyboardHeightAbsolute: 0,
                    keyboardHeightForInset: 0,
                }
                : {});
        };
    }, [
        isInteractiveDismissActive,
        isKeyboardLiftRetained,
        keyboardHeightAbsolute,
        keyboardHeightForInset,
        keyboardHeightLive,
        keyboardProgress,
        recomputeStaticLayout,
    ]);

    const setComposerInputFocused = React.useCallback((focused: boolean) => {
        if (Platform.OS !== 'ios') return;
        isComposerInputFocused.value = focused;
        if (focused) {
            ignoreKeyboardFramesUntilComposerFocus.value = false;
        }
    }, [ignoreKeyboardFramesUntilComposerFocus, isComposerInputFocused]);

    // Dedupe guards use plain JS mirrors: guest-runtime shared-value writes are async, so a
    // `.value` read-back cannot see a measurement committed earlier in the same frame.
    const lastMeasuredComposerHeightRef = React.useRef<number | null>(null);
    const setComposerMeasuredHeight = React.useCallback((height: number) => {
        const nextHeight = typeof height === 'number' && Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0;
        if (lastMeasuredComposerHeightRef.current === nextHeight) return;
        lastMeasuredComposerHeightRef.current = nextHeight;
        composerHeight.value = nextHeight;
        recomputeStaticLayout({ composerHeight: nextHeight });
    }, [composerHeight, recomputeStaticLayout]);

    const lastMeasuredScaffoldHeightRef = React.useRef<number | null>(null);
    const setScaffoldMeasuredHeight = React.useCallback((height: number) => {
        const nextHeight = typeof height === 'number' && Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0;
        if (lastMeasuredScaffoldHeightRef.current === nextHeight) return;
        lastMeasuredScaffoldHeightRef.current = nextHeight;
        scaffoldMeasuredHeight.value = nextHeight;
        recomputeStaticLayout({ scaffoldHeight: nextHeight });
    }, [recomputeStaticLayout, scaffoldMeasuredHeight]);

    return React.useMemo(() => ({
        availablePanelHeight,
        bottomInset,
        composerHeight,
        getKeyboardHeight,
        isKeyboardLiftSuppressed,
        keyboardHeightForInset,
        keyboardHeightLive,
        keyboardProgress,
        listBottomInset,
        listBottomInsetAnimated,
        retainKeyboardLift,
        setComposerInputFocused,
        setComposerMeasuredHeight,
        setScaffoldMeasuredHeight,
        subscribeAvailablePanelHeight,
        subscribeKeyboardHeight,
        subscribeListBottomInset,
    }), [
        availablePanelHeight,
        bottomInset,
        composerHeight,
        getKeyboardHeight,
        isKeyboardLiftSuppressed,
        keyboardHeightForInset,
        keyboardHeightLive,
        keyboardProgress,
        listBottomInset,
        listBottomInsetAnimated,
        retainKeyboardLift,
        setComposerInputFocused,
        setComposerMeasuredHeight,
        setScaffoldMeasuredHeight,
        subscribeAvailablePanelHeight,
        subscribeKeyboardHeight,
        subscribeListBottomInset,
    ]);
}
