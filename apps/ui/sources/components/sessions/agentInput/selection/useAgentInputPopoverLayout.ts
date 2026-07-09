import * as React from 'react';
import { Platform, useWindowDimensions } from 'react-native';

import {
    MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
    type PopoverPortalOptions,
} from '@/components/ui/popover';
import { useComposerKeyboardLayout } from '@/components/sessions/keyboardAvoidance/ComposerKeyboardContext';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';

const MOBILE_AGENT_INPUT_POPOVER_EDGE_PADDING = 12;
const DEFAULT_AGENT_INPUT_POPOVER_EDGE_PADDING = 16;
const DEFAULT_POPOVER_MAX_HEIGHT = 400;
const NATIVE_KEYBOARD_VISIBLE_POPOVER_FRACTION = 0.5;
const DEFAULT_POPOVER_GAP = 8;

export type AgentInputPopoverLayout = Readonly<{
    maxHeightCap?: number;
    keyboardBottomInset: number;
    placement: 'top';
    gap: number;
    edgePadding: Readonly<{ horizontal: number }>;
    portal: PopoverPortalOptions;
}>;

export function useAgentInputPopoverLayout(input: Readonly<{
    open: boolean;
    maxHeightCap?: number;
    portalTopBottomLayout?: 'anchored' | 'boundary';
}>): AgentInputPopoverLayout {
    const keyboardHeight = useKeyboardHeight();
    const composerKeyboardLayout = useComposerKeyboardLayout();
    const retainedNativeKeyboardHeightRef = React.useRef(0);
    const { height: windowHeight, width: windowWidth } = useWindowDimensions();
    const normalizedKeyboardHeight = Number.isFinite(keyboardHeight)
        ? Math.max(0, keyboardHeight)
        : 0;
    const [composerKeyboardHeight, setComposerKeyboardHeight] = React.useState(
        () => composerKeyboardLayout?.getKeyboardHeight?.() ?? 0,
    );

    React.useEffect(() => {
        setComposerKeyboardHeight(composerKeyboardLayout?.getKeyboardHeight?.() ?? 0);
        return composerKeyboardLayout?.subscribeKeyboardHeight?.(setComposerKeyboardHeight);
    }, [composerKeyboardLayout]);

    React.useEffect(() => {
        if (Platform.OS === 'web') {
            retainedNativeKeyboardHeightRef.current = 0;
            return;
        }
        if (!input.open) {
            retainedNativeKeyboardHeightRef.current = 0;
            return;
        }
        if (normalizedKeyboardHeight > 0) {
            retainedNativeKeyboardHeightRef.current = normalizedKeyboardHeight;
        }
    }, [normalizedKeyboardHeight, input.open]);

    const effectiveKeyboardHeight =
        Platform.OS === 'web'
            ? 0
            : normalizedKeyboardHeight > 0
                ? normalizedKeyboardHeight
                : composerKeyboardHeight > 0
                    ? composerKeyboardHeight
                    : input.open
                        ? retainedNativeKeyboardHeightRef.current
                        : 0;

    const edgePadding = React.useMemo(() => ({
        horizontal:
            Platform.OS === 'web' && isMobileLayoutWidth(windowWidth)
                ? MOBILE_AGENT_INPUT_POPOVER_EDGE_PADDING
                : DEFAULT_AGENT_INPUT_POPOVER_EDGE_PADDING,
    }), [windowWidth]);

    const maxHeightCap = React.useMemo(() => {
        if (Platform.OS === 'web' || effectiveKeyboardHeight <= 0) {
            return input.maxHeightCap;
        }

        const visibleHeight = Math.max(0, windowHeight - effectiveKeyboardHeight);
        if (visibleHeight <= 0) {
            return input.maxHeightCap;
        }

        const requestedCap = input.maxHeightCap ?? DEFAULT_POPOVER_MAX_HEIGHT;
        const shallowViewportCap = Math.floor(visibleHeight * NATIVE_KEYBOARD_VISIBLE_POPOVER_FRACTION);
        return Math.min(requestedCap, shallowViewportCap);
    }, [effectiveKeyboardHeight, input.maxHeightCap, windowHeight]);

    React.useEffect(() => {
        if (Platform.OS === 'web') return undefined;
        if (!input.open) return undefined;
        if (effectiveKeyboardHeight <= 0) return undefined;
        return composerKeyboardLayout?.retainKeyboardLift?.();
    }, [composerKeyboardLayout, effectiveKeyboardHeight, input.open]);

    const portal = React.useMemo(() => {
        if (!input.portalTopBottomLayout) {
            return MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS;
        }
        return {
            ...MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
            topBottomLayout: input.portalTopBottomLayout,
        };
    }, [input.portalTopBottomLayout]);

    return {
        maxHeightCap,
        keyboardBottomInset: effectiveKeyboardHeight,
        placement: 'top',
        // The popover now anchors correctly on every platform (Popover resolves the portal-relative
        // anchor via window-deltas on Android — see `resolvePortalRelativeAnchorRect`), so the gap is
        // the same snug value everywhere. Previously Android over-padded (32) to mask an anchor that
        // was resolved in the wrong coordinate space and overlapped the chip.
        gap: DEFAULT_POPOVER_GAP,
        edgePadding,
        portal,
    };
}
