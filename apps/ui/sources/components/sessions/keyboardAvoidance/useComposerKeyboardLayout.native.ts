import * as React from 'react';
import { Keyboard, Platform, useWindowDimensions } from 'react-native';
import { useKeyboardHandler, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { runOnJS, useSharedValue } from 'react-native-reanimated';

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
// shared values is a lost update whenever the JS thread is behind the keyboard: a composer
// measurement processed after a dismissal replays the keyboard-raised geometry and re-seats the
// composer over the transcript. It never heals, because `ignoreKeyboardFramesUntilComposerFocus`
// stops every keyboard worklet from re-deriving the layout until the composer is refocused.
// (Measured 2026-08-08: ~36% of sends on device.) Callers therefore pass only the fields they
// own; everything else comes from the record.
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

function clampAvailablePanelHeightToMax(height: number, maxHeight: number | undefined): number {
    'worklet';
    if (typeof maxHeight !== 'number' || !Number.isFinite(maxHeight) || maxHeight <= 0) {
        return height;
    }
    return Math.min(height, maxHeight);
}

const RETAINED_KEYBOARD_HIDE_SETTLE_MS = 160;

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
    const viewportHeight = useSharedValue(dimensions.height);
    const availablePanelHeightSubscribersRef = React.useRef(new Set<(height: number) => void>());
    const keyboardHeightSnapshotRef = React.useRef(0);
    const keyboardHeightSubscribersRef = React.useRef(new Set<(height: number) => void>());
    const listBottomInsetSubscribersRef = React.useRef(new Set<(height: number) => void>());
    const keyboardRetentionCountRef = React.useRef(0);
    const retainedKeyboardHideDropTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const notifyAvailablePanelHeight = React.useCallback((height: number) => {
        for (const listener of availablePanelHeightSubscribersRef.current) {
            listener(height);
        }
    }, []);

    const subscribeAvailablePanelHeight = React.useCallback((listener: (height: number) => void) => {
        availablePanelHeightSubscribersRef.current.add(listener);
        listener(availablePanelHeight.value);
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
        viewportHeight: dimensions.height,
    });

    // Raw height of the last keyboard event, before retention substitutes the held lift. Owned on
    // the UI thread and mirrored here for the same reason as the record above: the retention
    // release and the retained-hide settle both read it to decide whether the keyboard is
    // genuinely gone, and a stale read there holds the composer at the retained lift for good.
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
        // Reads nothing back: every input comes from the JS-owned record, which each writer
        // updates in the same pass as its shared-value write.
        const inputs: ComposerStaticLayoutInputs = { ...staticLayoutInputsRef.current, ...overrides };
        const effectiveComposerHeight = Math.max(0, Math.round(inputs.composerHeight));
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
            viewportHeight: inputs.viewportHeight,
            headerHeight: inputs.headerHeight,
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
        notifyAvailablePanelHeight,
        notifyKeyboardHeight,
        notifyListBottomInset,
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

    const cancelRetainedKeyboardHideDrop = React.useCallback(() => {
        if (retainedKeyboardHideDropTimerRef.current === null) return;
        clearTimeout(retainedKeyboardHideDropTimerRef.current);
        retainedKeyboardHideDropTimerRef.current = null;
    }, []);

    const scheduleRetainedKeyboardHideDrop = React.useCallback(() => {
        cancelRetainedKeyboardHideDrop();
        retainedKeyboardHideDropTimerRef.current = setTimeout(() => {
            retainedKeyboardHideDropTimerRef.current = null;
            // Both conditions read their JS-thread owners: the retention count and the mirrored
            // last event height. Reading the shared values here observed the last SYNCHRONIZED
            // write, which under a busy JS thread is exactly the state this settle exists to
            // correct.
            if (keyboardRetentionCountRef.current === 0) return;
            if (lastKeyboardEventHeightAbsoluteRef.current !== 0) return;
            applyFinalKeyboardHeightFromJS(0);
        }, RETAINED_KEYBOARD_HIDE_SETTLE_MS);
    }, [
        applyFinalKeyboardHeightFromJS,
        cancelRetainedKeyboardHideDrop,
    ]);

    React.useEffect(() => cancelRetainedKeyboardHideDrop, [cancelRetainedKeyboardHideDrop]);

    React.useEffect(() => {
        if (Platform.OS === 'android') return undefined;

        const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
            if (keyboardRetentionCountRef.current > 0) {
                // Retention holds the composer at the lifted SEAT across a hide so focus can
                // transfer to the overlay; it is not a reason to keep believing the keyboard is
                // still there. Under retention this event is frequently the ONLY report that the
                // keyboard settled: an interactive dismissal that runs to completion leaves the
                // keyboard already at rest, so the animation never restarts and `onStart`/`onEnd`
                // never arrive. Discarding it latched `isInteractiveDismissActive`, which freezes
                // `keyboardHeightForInset` — read by the transcript inset and by nothing that
                // seats the composer — and left the JS-owned last event height at its stale
                // mid-gesture value, so the retention release re-seated the composer at a keyboard
                // height that no longer existed. Record the settled hide exactly as a zero-height
                // `onEnd` does and let the retained-hide settle drop the lift, so a re-show inside
                // the settle window still cancels it. Deliberately NOT the non-retained path: that
                // one also latches `ignoreKeyboardFramesUntilComposerFocus` and collapses at once,
                // which would defeat the retention the overlay is holding.
                lastKeyboardEventHeightAbsoluteRef.current = 0;
                isInteractiveDismissActive.value = false;
                recomputeStaticLayout({ isInteractiveDismissActive: false });
                scheduleRetainedKeyboardHideDrop();
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
        scheduleRetainedKeyboardHideDrop,
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
        headerHeight,
        headerHeightValue,
        isInteractiveDismissActive,
        isKeyboardLiftSuppressed,
        keyboardHeightAbsolute,
        keyboardHeightForInset,
        keyboardHeightLive,
        keyboardLiftSuppressed,
        keyboardProgress,
        layoutBottomInset,
        layoutBottomInsetValue,
        recomputeStaticLayout,
        safeAreaBottom,
        safeAreaBottomValue,
        viewportHeight,
    ]);

    const shouldRetainAndroidZeroProgressStartFrame = Platform.OS === 'android';

    useKeyboardHandler({
        onStart: (event) => {
            'worklet';
            if (ignoreKeyboardFramesUntilComposerFocus.value) return;
            isInteractiveDismissActive.value = false;
            const nextHeight = Math.max(0, Math.abs(event.height));
            if (nextHeight > 0) {
                runOnJS(cancelRetainedKeyboardHideDrop)();
            }
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
                ? Math.max(nextHeight, keyboardHeightAbsolute.value)
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
            const startFrameLiveHeight = nextProgress <= 0 && !shouldRetainOpenKeyboardStartFrame
                ? 0
                : storedHeight;
            bottomInset.value = Math.max(safeAreaBottomValue.value, startFrameLiveHeight);
            const nextListBottomInset = composerHeight.value + Math.max(safeAreaBottomValue.value, storedHeight);
            listBottomInset.value = nextListBottomInset;
            runOnJS(notifyListBottomInset)(nextListBottomInset);
            const nextAvailablePanelHeight = clampAvailablePanelHeightToMax(Math.max(
                0,
                viewportHeight.value
                    - headerHeightValue.value
                    - Math.max(safeAreaBottomValue.value, keyboardHeightAbsolute.value)
                    - (keyboardHeightAbsolute.value > 0 ? 0 : layoutBottomInsetValue.value),
            ), availablePanelMaxHeightValue.value);
            availablePanelHeight.value = nextAvailablePanelHeight;
            runOnJS(notifyAvailablePanelHeight)(nextAvailablePanelHeight);
        },
        onMove: (event) => {
            'worklet';
            if (ignoreKeyboardFramesUntilComposerFocus.value) return;
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
            if (rawAbsoluteLiveHeight > 0) {
                runOnJS(cancelRetainedKeyboardHideDrop)();
            }
            const absoluteLiveHeight = !keyboardLiftIsSuppressed && isKeyboardLiftRetained.value
                ? Math.max(rawAbsoluteLiveHeight, keyboardHeightAbsolute.value)
                : rawAbsoluteLiveHeight;
            const absoluteHeight = keyboardLiftIsSuppressed ? 0 : absoluteLiveHeight;
            keyboardHeightAbsolute.value = absoluteHeight;
            const liveHeight = keyboardLiftIsSuppressed
                ? 0
                : resolveKeyboardHeightWithinScaffold(absoluteLiveHeight, layoutBottomInsetValue.value);
            const interactiveDismissActive = !keyboardLiftIsSuppressed && isInteractiveDismissActive.value;
            const insetHeight = interactiveDismissActive ? keyboardHeightForInset.value : liveHeight;
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
            bottomInset.value = Math.max(safeAreaBottomValue.value, liveHeight);
            const nextListBottomInset = composerHeight.value + Math.max(
                safeAreaBottomValue.value,
                keyboardLiftIsSuppressed ? 0 : insetHeight,
            );
            listBottomInset.value = nextListBottomInset;
            runOnJS(notifyListBottomInset)(nextListBottomInset);
            const nextAvailablePanelHeight = clampAvailablePanelHeightToMax(Math.max(
                0,
                viewportHeight.value
                    - headerHeightValue.value
                    - Math.max(safeAreaBottomValue.value, keyboardHeightAbsolute.value)
                    - (keyboardHeightAbsolute.value > 0 ? 0 : layoutBottomInsetValue.value),
            ), availablePanelMaxHeightValue.value);
            availablePanelHeight.value = nextAvailablePanelHeight;
            runOnJS(notifyAvailablePanelHeight)(nextAvailablePanelHeight);
        },
        onInteractive: (event) => {
            'worklet';
            if (ignoreKeyboardFramesUntilComposerFocus.value) return;
            const keyboardLiftIsSuppressed = isKeyboardLiftSuppressed.value;
            const interactiveDismissActive = !keyboardLiftIsSuppressed;
            isInteractiveDismissActive.value = interactiveDismissActive;
            const eventHeight = Math.max(0, Math.abs(event.height));
            if (eventHeight > 0) {
                runOnJS(cancelRetainedKeyboardHideDrop)();
            }
            const liveHeight = !keyboardLiftIsSuppressed && isKeyboardLiftRetained.value
                ? Math.max(eventHeight, keyboardHeightAbsolute.value)
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
            const nextAvailablePanelHeight = clampAvailablePanelHeightToMax(Math.max(
                0,
                viewportHeight.value
                    - headerHeightValue.value
                    - Math.max(safeAreaBottomValue.value, keyboardHeightAbsolute.value)
                    - (keyboardHeightAbsolute.value > 0 ? 0 : layoutBottomInsetValue.value),
            ), availablePanelMaxHeightValue.value);
            availablePanelHeight.value = nextAvailablePanelHeight;
            runOnJS(notifyAvailablePanelHeight)(nextAvailablePanelHeight);
        },
        onEnd: (event) => {
            'worklet';
            if (ignoreKeyboardFramesUntilComposerFocus.value) return;
            isInteractiveDismissActive.value = false;
            const nextHeight = Math.max(0, Math.abs(event.height));
            const shouldScheduleRetainedHideDrop =
                !isKeyboardLiftSuppressed.value
                && isKeyboardLiftRetained.value
                && nextHeight === 0;
            if (nextHeight > 0) {
                runOnJS(cancelRetainedKeyboardHideDrop)();
            }
            const retainedHeight = !isKeyboardLiftSuppressed.value && isKeyboardLiftRetained.value
                ? Math.max(nextHeight, keyboardHeightAbsolute.value)
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
            const nextAvailablePanelHeight = clampAvailablePanelHeightToMax(Math.max(
                0,
                viewportHeight.value
                    - headerHeightValue.value
                    - Math.max(safeAreaBottomValue.value, keyboardHeightAbsolute.value)
                    - (keyboardHeightAbsolute.value > 0 ? 0 : layoutBottomInsetValue.value),
            ), availablePanelMaxHeightValue.value);
            availablePanelHeight.value = nextAvailablePanelHeight;
            runOnJS(notifyAvailablePanelHeight)(nextAvailablePanelHeight);
            if (shouldScheduleRetainedHideDrop) {
                runOnJS(scheduleRetainedKeyboardHideDrop)();
            }
        },
    }, [
        applyKeyboardFrameFromUI,
        availablePanelMaxHeightValue,
        cancelRetainedKeyboardHideDrop,
        ignoreKeyboardFramesUntilComposerFocus,
        keyboardAnimation.height,
        notifyAvailablePanelHeight,
        notifyListBottomInset,
        scheduleRetainedKeyboardHideDrop,
        shouldRetainAndroidZeroProgressStartFrame,
    ]);

    const retainKeyboardLift = React.useCallback(() => {
        let released = false;
        keyboardRetentionCountRef.current += 1;
        isKeyboardLiftRetained.value = keyboardRetentionCountRef.current > 0;

        return () => {
            if (released) return;
            released = true;
            cancelRetainedKeyboardHideDrop();
            keyboardRetentionCountRef.current = Math.max(0, keyboardRetentionCountRef.current - 1);
            isKeyboardLiftRetained.value = keyboardRetentionCountRef.current > 0;
            if (keyboardRetentionCountRef.current > 0) {
                recomputeStaticLayout();
                return;
            }
            isInteractiveDismissActive.value = false;
            const latestHeight = Math.max(0, lastKeyboardEventHeightAbsoluteRef.current);
            keyboardHeightAbsolute.value = latestHeight;
            const latestLiveHeight = resolveKeyboardHeightWithinScaffold(
                latestHeight,
                staticLayoutInputsRef.current.layoutBottomInset,
            );
            keyboardHeightLive.value = latestLiveHeight;
            keyboardHeightForInset.value = latestLiveHeight;
            if (latestHeight === 0) {
                keyboardProgress.value = 0;
            }
            // The collapse written just above must reach the recompute as locals: a read-back
            // would replay the retained keyboard height for one more step.
            recomputeStaticLayout({
                isInteractiveDismissActive: false,
                keyboardHeightAbsolute: latestHeight,
                keyboardHeightForInset: latestLiveHeight,
            });
        };
    }, [
        isInteractiveDismissActive,
        isKeyboardLiftRetained,
        cancelRetainedKeyboardHideDrop,
        keyboardHeightAbsolute,
        keyboardHeightForInset,
        keyboardHeightLive,
        keyboardProgress,
        recomputeStaticLayout,
    ]);

    const setComposerInputFocused = React.useCallback((focused: boolean) => {
        if (Platform.OS !== 'ios') return;
        if (focused) {
            ignoreKeyboardFramesUntilComposerFocus.value = false;
        }
    }, [ignoreKeyboardFramesUntilComposerFocus]);

    const lastMeasuredComposerHeightRef = React.useRef<number | null>(null);
    const setComposerMeasuredHeight = React.useCallback((height: number) => {
        const nextHeight = typeof height === 'number' && Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0;
        if (lastMeasuredComposerHeightRef.current === nextHeight) return;
        lastMeasuredComposerHeightRef.current = nextHeight;
        composerHeight.value = nextHeight;
        recomputeStaticLayout({ composerHeight: nextHeight });
    }, [composerHeight, recomputeStaticLayout]);

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
        retainKeyboardLift,
        setComposerInputFocused,
        setComposerMeasuredHeight,
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
        retainKeyboardLift,
        setComposerInputFocused,
        setComposerMeasuredHeight,
        subscribeAvailablePanelHeight,
        subscribeKeyboardHeight,
        subscribeListBottomInset,
    ]);
}
