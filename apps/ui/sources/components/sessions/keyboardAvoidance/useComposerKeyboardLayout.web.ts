import * as React from 'react';
import { useWindowDimensions } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';

import {
    isWebKeyboardEditableElementFocused,
    isWebMobileLikeViewportWidth,
    resolveWebVisualViewportKeyboardInset,
} from '@/hooks/ui/resolveWebVisualViewportKeyboardInset';
import {
    resolveWebKeyboardReferenceViewportHeight,
    updateWebVisualViewportKeyboardReference,
    type WebVisualViewportKeyboardReference,
} from '@/hooks/ui/webVisualViewportKeyboardReference';
import {
    resolveAvailablePanelHeight,
    resolveComposerBottomOffset,
} from './composerKeyboardGeometry';
import type { ComposerKeyboardLayout } from './ComposerKeyboardContext';
import type { ComposerKeyboardLayoutOptions } from './useComposerKeyboardLayout.native';

function isEditableElementFocused(): boolean {
    if (typeof document === 'undefined') return false;
    return isWebKeyboardEditableElementFocused(document);
}

function readVisualViewportKeyboardInset(keyboardReferenceRef: React.MutableRefObject<WebVisualViewportKeyboardReference | null>): number {
    if (typeof window === 'undefined') return 0;
    const visualViewport = window.visualViewport;
    if (!visualViewport) return 0;
    const isEditableFocused = isEditableElementFocused();
    // `window.innerHeight` cannot be the unoccluded-viewport reference: Firefox Android reports
    // a layout viewport taller than the visual viewport can ever reach, so the difference
    // counts browser chrome as keyboard. The canonical reference is the largest visual bottom
    // observed while nothing editable was focused (see webVisualViewportKeyboardReference.ts).
    const reference = updateWebVisualViewportKeyboardReference(keyboardReferenceRef.current, {
        width: visualViewport.width,
        visualBottom: visualViewport.height + visualViewport.offsetTop,
        layoutViewportHeight: window.innerHeight,
        isEditableElementFocused: isEditableFocused,
    });
    keyboardReferenceRef.current = reference;
    return resolveWebVisualViewportKeyboardInset({
        layoutViewportHeight: resolveWebKeyboardReferenceViewportHeight(reference, {
            layoutViewportHeight: window.innerHeight,
            currentVisualBottom: visualViewport.height + visualViewport.offsetTop,
        }),
        visualViewportHeight: visualViewport.height,
        visualViewportOffsetTop: visualViewport.offsetTop,
        isEditableElementFocused: isEditableFocused,
        isMobileLikeHost: isWebMobileLikeViewportWidth(visualViewport.width),
    });
}

export function useComposerKeyboardLayout(options: ComposerKeyboardLayoutOptions = {}): ComposerKeyboardLayout {
    const dimensions = useWindowDimensions();
    const safeAreaBottom = options.safeAreaBottom ?? 0;
    const headerHeight = options.headerHeight ?? 0;
    const availablePanelMaxHeight = typeof options.availablePanelMaxHeight === 'number' && Number.isFinite(options.availablePanelMaxHeight)
        ? Math.max(0, options.availablePanelMaxHeight)
        : undefined;
    const keyboardLiftSuppressed = options.keyboardLiftSuppressed === true;
    const availablePanelHeight = useSharedValue(0);
    const bottomInset = useSharedValue(resolveComposerBottomOffset({ keyboardHeight: 0, safeAreaBottom }));
    const composerHeight = useSharedValue(0);
    const isKeyboardLiftSuppressed = useSharedValue(keyboardLiftSuppressed);
    const keyboardHeightForInset = useSharedValue(0);
    const keyboardHeightLive = useSharedValue(0);
    const keyboardProgress = useSharedValue(0);
    const listBottomInset = useSharedValue(0);
    const availablePanelHeightSubscribersRef = React.useRef(new Set<(height: number) => void>());
    const keyboardHeightSnapshotRef = React.useRef(0);
    const keyboardHeightSubscribersRef = React.useRef(new Set<(height: number) => void>());
    const listBottomInsetSubscribersRef = React.useRef(new Set<(height: number) => void>());
    const keyboardReferenceRef = React.useRef<WebVisualViewportKeyboardReference | null>(null);

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

    const recompute = React.useCallback((keyboardHeight: number) => {
        const effectiveKeyboardHeight = keyboardLiftSuppressed ? 0 : keyboardHeight;
        isKeyboardLiftSuppressed.value = keyboardLiftSuppressed;
        keyboardHeightLive.value = keyboardHeight;
        keyboardHeightForInset.value = keyboardHeight;
        keyboardProgress.value = keyboardHeight > 0 ? 1 : 0;
        notifyKeyboardHeight(effectiveKeyboardHeight);
        bottomInset.value = resolveComposerBottomOffset({ keyboardHeight: effectiveKeyboardHeight, safeAreaBottom });
        listBottomInset.value = 0;
        notifyListBottomInset(0);
        availablePanelHeight.value = resolveAvailablePanelHeight({
            viewportHeight: dimensions.height,
            headerHeight,
            keyboardHeight: effectiveKeyboardHeight,
            maxHeight: availablePanelMaxHeight,
            safeAreaBottom,
        });
        notifyAvailablePanelHeight(availablePanelHeight.value);
    }, [
        availablePanelHeight,
        availablePanelMaxHeight,
        bottomInset,
        composerHeight,
        dimensions.height,
        headerHeight,
        isKeyboardLiftSuppressed,
        keyboardHeightForInset,
        keyboardHeightLive,
        keyboardLiftSuppressed,
        keyboardProgress,
        listBottomInset,
        notifyKeyboardHeight,
        notifyListBottomInset,
        notifyAvailablePanelHeight,
        safeAreaBottom,
    ]);

    React.useEffect(() => {
        const update = () => {
            recompute(readVisualViewportKeyboardInset(keyboardReferenceRef));
        };
        update();
        if (typeof window === 'undefined') return undefined;
        const visualViewport = window.visualViewport;
        visualViewport?.addEventListener('resize', update);
        visualViewport?.addEventListener('scroll', update);
        window.addEventListener('focusin', update);
        window.addEventListener('focusout', update);
        return () => {
            visualViewport?.removeEventListener('resize', update);
            visualViewport?.removeEventListener('scroll', update);
            window.removeEventListener('focusin', update);
            window.removeEventListener('focusout', update);
        };
    }, [recompute]);

    const setComposerMeasuredHeight = React.useCallback((height: number) => {
        const nextHeight = typeof height === 'number' && Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0;
        if (composerHeight.value === nextHeight) return;
        composerHeight.value = nextHeight;
        recompute(keyboardHeightForInset.value);
    }, [composerHeight, keyboardHeightForInset, recompute]);

    const retainKeyboardLift = React.useCallback(() => () => {}, []);

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
        // On web the composer sits in normal layout flow and the visual-viewport inset is
        // applied synchronously on the only thread there is, so the settled total is already
        // the continuously tracked one.
        listBottomInsetAnimated: listBottomInset,
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
