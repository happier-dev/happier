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
    const keyboardHeightForInset = useSharedValue(0);
    const keyboardHeightAbsolute = useSharedValue(0);
    const keyboardHeightLive = useSharedValue(0);
    const keyboardProgress = useSharedValue(0);
    const lastKeyboardEventHeightAbsolute = useSharedValue(0);
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

    const notifyListBottomInset = React.useCallback((height: number) => {
        for (const listener of listBottomInsetSubscribersRef.current) {
            listener(height);
        }
    }, []);

    const subscribeListBottomInset = React.useCallback((listener: (height: number) => void) => {
        listBottomInsetSubscribersRef.current.add(listener);
        listener(listBottomInset.value);
        return () => {
            listBottomInsetSubscribersRef.current.delete(listener);
        };
    }, [listBottomInset]);

    const recomputeStaticLayout = React.useCallback(() => {
        const liveKeyboardHeight = isKeyboardLiftSuppressed.value
            ? 0
            : resolveKeyboardHeightWithinScaffold(keyboardHeightAbsolute.value, layoutBottomInsetValue.value);
        keyboardHeightLive.value = liveKeyboardHeight;
        if (isKeyboardLiftSuppressed.value || !isInteractiveDismissActive.value) {
            keyboardHeightForInset.value = liveKeyboardHeight;
        }
        notifyKeyboardHeight(liveKeyboardHeight);
        const insetKeyboardHeight = isKeyboardLiftSuppressed.value ? 0 : keyboardHeightForInset.value;
        bottomInset.value = resolveComposerBottomOffset({
            keyboardHeight: liveKeyboardHeight,
            safeAreaBottom: safeAreaBottomValue.value,
        });
        listBottomInset.value = resolveListBottomInset({
            composerHeight: composerHeight.value,
            keyboardHeightForInset: insetKeyboardHeight,
            safeAreaBottom: safeAreaBottomValue.value,
        });
        notifyListBottomInset(listBottomInset.value);
        const absoluteKeyboardHeight = isKeyboardLiftSuppressed.value ? 0 : keyboardHeightAbsolute.value;
        availablePanelHeight.value = resolveAvailablePanelHeight({
            viewportHeight: viewportHeight.value,
            headerHeight: headerHeightValue.value,
            keyboardHeight: absoluteKeyboardHeight,
            maxHeight: availablePanelMaxHeightValue.value,
            reservedHeight: absoluteKeyboardHeight > 0 ? 0 : layoutBottomInsetValue.value,
            safeAreaBottom: safeAreaBottomValue.value,
        });
        notifyAvailablePanelHeight(availablePanelHeight.value);
    }, [
        availablePanelHeight,
        availablePanelMaxHeightValue,
        bottomInset,
        composerHeight,
        headerHeightValue,
        isInteractiveDismissActive,
        isKeyboardLiftSuppressed,
        keyboardHeightAbsolute,
        keyboardHeightForInset,
        keyboardHeightLive,
        layoutBottomInsetValue,
        listBottomInset,
        notifyAvailablePanelHeight,
        notifyKeyboardHeight,
        notifyListBottomInset,
        safeAreaBottomValue,
        viewportHeight,
    ]);

    const applyFinalKeyboardHeightFromJS = React.useCallback((height: number) => {
        const absoluteKeyboardHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
        isInteractiveDismissActive.value = false;
        lastKeyboardEventHeightAbsolute.value = absoluteKeyboardHeight;
        keyboardHeightAbsolute.value = isKeyboardLiftSuppressed.value ? 0 : absoluteKeyboardHeight;
        const liveKeyboardHeight = isKeyboardLiftSuppressed.value
            ? 0
            : resolveKeyboardHeightWithinScaffold(keyboardHeightAbsolute.value, layoutBottomInsetValue.value);
        keyboardHeightLive.value = liveKeyboardHeight;
        keyboardHeightForInset.value = liveKeyboardHeight;
        keyboardProgress.value = liveKeyboardHeight > 0 ? 1 : 0;
        recomputeStaticLayout();
    }, [
        isInteractiveDismissActive,
        isKeyboardLiftSuppressed,
        keyboardHeightAbsolute,
        keyboardHeightForInset,
        keyboardHeightLive,
        keyboardProgress,
        lastKeyboardEventHeightAbsolute,
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
            if (!isKeyboardLiftRetained.value) return;
            if (lastKeyboardEventHeightAbsolute.value !== 0) return;
            applyFinalKeyboardHeightFromJS(0);
        }, RETAINED_KEYBOARD_HIDE_SETTLE_MS);
    }, [
        applyFinalKeyboardHeightFromJS,
        cancelRetainedKeyboardHideDrop,
        isKeyboardLiftRetained,
        lastKeyboardEventHeightAbsolute,
    ]);

    React.useEffect(() => cancelRetainedKeyboardHideDrop, [cancelRetainedKeyboardHideDrop]);

    React.useEffect(() => {
        if (Platform.OS === 'android') return undefined;

        const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
            if (keyboardRetentionCountRef.current > 0) return;
            applyFinalKeyboardHeightFromJS(0);
        });

        return () => {
            hideSubscription.remove();
        };
    }, [applyFinalKeyboardHeightFromJS]);

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
        recomputeStaticLayout();
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
            lastKeyboardEventHeightAbsolute.value = nextHeight;
            const retainedHeight = !isKeyboardLiftSuppressed.value
                && (isKeyboardLiftRetained.value || shouldRetainOpenKeyboardStartFrame)
                ? Math.max(nextHeight, keyboardHeightAbsolute.value)
                : nextHeight;
            keyboardHeightAbsolute.value = isKeyboardLiftSuppressed.value ? 0 : retainedHeight;
            const storedHeight = isKeyboardLiftSuppressed.value
                ? 0
                : resolveKeyboardHeightWithinScaffold(retainedHeight, layoutBottomInsetValue.value);
            keyboardHeightLive.value = storedHeight;
            keyboardHeightForInset.value = storedHeight;
            runOnJS(notifyKeyboardHeight)(storedHeight);
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
            lastKeyboardEventHeightAbsolute.value = rawAbsoluteLiveHeight;
            const absoluteLiveHeight = !keyboardLiftIsSuppressed && isKeyboardLiftRetained.value
                ? Math.max(rawAbsoluteLiveHeight, keyboardHeightAbsolute.value)
                : rawAbsoluteLiveHeight;
            keyboardHeightAbsolute.value = keyboardLiftIsSuppressed ? 0 : absoluteLiveHeight;
            const liveHeight = keyboardLiftIsSuppressed
                ? 0
                : resolveKeyboardHeightWithinScaffold(absoluteLiveHeight, layoutBottomInsetValue.value);
            const insetHeight = isInteractiveDismissActive.value ? keyboardHeightForInset.value : liveHeight;
            keyboardHeightLive.value = liveHeight;
            if (keyboardLiftIsSuppressed || !isInteractiveDismissActive.value) {
                keyboardHeightForInset.value = insetHeight;
            }
            runOnJS(notifyKeyboardHeight)(liveHeight);
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
            const keyboardLiftIsSuppressed = isKeyboardLiftSuppressed.value;
            isInteractiveDismissActive.value = !keyboardLiftIsSuppressed;
            const eventHeight = Math.max(0, Math.abs(event.height));
            if (eventHeight > 0) {
                runOnJS(cancelRetainedKeyboardHideDrop)();
            }
            lastKeyboardEventHeightAbsolute.value = eventHeight;
            const liveHeight = !keyboardLiftIsSuppressed && isKeyboardLiftRetained.value
                ? Math.max(eventHeight, keyboardHeightAbsolute.value)
                : eventHeight;
            keyboardHeightAbsolute.value = keyboardLiftIsSuppressed ? 0 : liveHeight;
            const effectiveLiveHeight = keyboardLiftIsSuppressed
                ? 0
                : resolveKeyboardHeightWithinScaffold(liveHeight, layoutBottomInsetValue.value);
            keyboardHeightLive.value = effectiveLiveHeight;
            if (keyboardLiftIsSuppressed) {
                keyboardHeightForInset.value = 0;
            }
            runOnJS(notifyKeyboardHeight)(effectiveLiveHeight);
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
            isInteractiveDismissActive.value = false;
            const nextHeight = Math.max(0, Math.abs(event.height));
            const shouldScheduleRetainedHideDrop =
                !isKeyboardLiftSuppressed.value
                && isKeyboardLiftRetained.value
                && nextHeight === 0;
            if (nextHeight > 0) {
                runOnJS(cancelRetainedKeyboardHideDrop)();
            }
            lastKeyboardEventHeightAbsolute.value = nextHeight;
            const retainedHeight = !isKeyboardLiftSuppressed.value && isKeyboardLiftRetained.value
                ? Math.max(nextHeight, keyboardHeightAbsolute.value)
                : nextHeight;
            keyboardHeightAbsolute.value = isKeyboardLiftSuppressed.value ? 0 : retainedHeight;
            const effectiveHeight = isKeyboardLiftSuppressed.value
                ? 0
                : resolveKeyboardHeightWithinScaffold(retainedHeight, layoutBottomInsetValue.value);
            keyboardHeightLive.value = effectiveHeight;
            keyboardHeightForInset.value = effectiveHeight;
            runOnJS(notifyKeyboardHeight)(effectiveHeight);
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
        availablePanelMaxHeightValue,
        cancelRetainedKeyboardHideDrop,
        keyboardAnimation.height,
        notifyAvailablePanelHeight,
        notifyKeyboardHeight,
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
            if (keyboardRetentionCountRef.current === 0) {
                isInteractiveDismissActive.value = false;
                const latestHeight = Math.max(0, lastKeyboardEventHeightAbsolute.value);
                keyboardHeightAbsolute.value = latestHeight;
                const latestLiveHeight = resolveKeyboardHeightWithinScaffold(latestHeight, layoutBottomInsetValue.value);
                keyboardHeightLive.value = latestLiveHeight;
                keyboardHeightForInset.value = latestLiveHeight;
                if (latestHeight === 0) {
                    keyboardProgress.value = 0;
                }
            }
            recomputeStaticLayout();
        };
    }, [
        isInteractiveDismissActive,
        isKeyboardLiftRetained,
        cancelRetainedKeyboardHideDrop,
        keyboardHeightAbsolute,
        keyboardHeightForInset,
        keyboardHeightLive,
        keyboardProgress,
        lastKeyboardEventHeightAbsolute,
        layoutBottomInsetValue,
        recomputeStaticLayout,
    ]);

    const setComposerMeasuredHeight = React.useCallback((height: number) => {
        const nextHeight = typeof height === 'number' && Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0;
        if (composerHeight.value === nextHeight) return;
        composerHeight.value = nextHeight;
        recomputeStaticLayout();
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
        setComposerMeasuredHeight,
        subscribeAvailablePanelHeight,
        subscribeKeyboardHeight,
        subscribeListBottomInset,
    ]);
}
