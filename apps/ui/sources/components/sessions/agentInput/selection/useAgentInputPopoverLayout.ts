import * as React from 'react';
import { Platform, useWindowDimensions } from 'react-native';

import { useComposerKeyboardLayout } from '@/components/sessions/keyboardAvoidance/ComposerKeyboardContext';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';

const DEFAULT_POPOVER_MAX_HEIGHT = 400;
const NATIVE_KEYBOARD_VISIBLE_POPOVER_FRACTION = 0.5;
const DEFAULT_POPOVER_GAP = 8;
const MOBILE_AGENT_INPUT_POPOVER_EDGE_PADDING = { horizontal: 12 } as const;

/**
 * Single owner of the agent-input popover's horizontal edge padding. Exported
 * only for the surfaces that render an agent-input popover while it is CLOSED
 * and therefore cannot call this hook; every open surface reads
 * `useAgentInputPopoverLayout(...).edgePadding` so the command menu and the
 * chip/selection popover can never disagree about it.
 */
export const AGENT_INPUT_POPOVER_EDGE_PADDING = { horizontal: 16 } as const;

export type AgentInputPopoverLayout = Readonly<{
    maxHeightCap?: number;
    keyboardBottomInset: number;
    placement: 'top';
    gap: number;
    edgePadding: Readonly<{ horizontal: number }>;
}>;

export function useAgentInputPopoverLayout(input: Readonly<{
    open: boolean;
    maxHeightCap?: number;
}>): AgentInputPopoverLayout {
    const keyboardHeight = useKeyboardHeight();
    const composerKeyboardLayout = useComposerKeyboardLayout();
    const { height: windowHeight, width: windowWidth } = useWindowDimensions();
    const [composerKeyboardHeight, setComposerKeyboardHeight] = React.useState(
        () => composerKeyboardLayout?.getKeyboardHeight?.() ?? 0,
    );

    React.useEffect(() => {
        setComposerKeyboardHeight(composerKeyboardLayout?.getKeyboardHeight?.() ?? 0);
        return composerKeyboardLayout?.subscribeKeyboardHeight?.(setComposerKeyboardHeight);
    }, [composerKeyboardLayout]);

    const liveKeyboardHeight = Math.max(keyboardHeight, composerKeyboardHeight);

    // Both live sources read 0 while the keyboard is still ON SCREEN: iOS's
    // `keyboardWillHide` fires at the START of the dismissal animation
    // (`useKeyboardHeight`), and the composer scaffold publishes the live
    // animated height, which passes through 0 on its way out. Taking that
    // transient zero at face value collapses the popover's inset and cap in a
    // single commit AND releases `retainKeyboardLift`, whose release path zeroes
    // the composer lift outright once the last keyboard event was a hide (see
    // `useComposerKeyboardLayout.native.ts`). So the retention this hook exists
    // to hold would be dropped by the very reading it is gated on.
    //
    // Hold the last non-zero live height for as long as the popover is open.
    // Web has no keyboard inset at all, and a close resets the floor so a reopen
    // never inherits a stale lift.
    const retainedKeyboardHeightRef = React.useRef(0);
    React.useEffect(() => {
        if (Platform.OS === 'web' || !input.open) {
            retainedKeyboardHeightRef.current = 0;
            return;
        }
        if (liveKeyboardHeight > 0) {
            retainedKeyboardHeightRef.current = liveKeyboardHeight;
        }
    }, [liveKeyboardHeight, input.open]);

    const effectiveKeyboardHeight = liveKeyboardHeight > 0
        ? liveKeyboardHeight
        : (Platform.OS !== 'web' && input.open ? retainedKeyboardHeightRef.current : 0);

    const edgePadding = Platform.OS === 'web' && isMobileLayoutWidth(windowWidth)
        ? MOBILE_AGENT_INPUT_POPOVER_EDGE_PADDING
        : AGENT_INPUT_POPOVER_EDGE_PADDING;

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

    return {
        maxHeightCap,
        keyboardBottomInset: Platform.OS === 'web' ? 0 : effectiveKeyboardHeight,
        placement: 'top',
        // The popover now anchors correctly on every platform (Popover resolves the portal-relative
        // anchor via window-deltas on Android — see `resolvePortalRelativeAnchorRect`), so the gap is
        // the same snug value everywhere. Previously Android over-padded (32) to mask an anchor that
        // was resolved in the wrong coordinate space and overlapped the chip.
        gap: DEFAULT_POPOVER_GAP,
        edgePadding,
    };
}
