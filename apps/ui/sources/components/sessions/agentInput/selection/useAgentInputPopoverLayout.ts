import * as React from 'react';
import { Keyboard, Platform, useWindowDimensions } from 'react-native';

import {
    MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
    type PopoverPortalOptions,
} from '@/components/ui/popover';
import { POPOVER_PREFERRED_ROOM_PX } from '@/components/ui/popover/popoverPreferredRoom';
import { useComposerKeyboardLayout } from '@/components/sessions/keyboardAvoidance/ComposerKeyboardContext';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { DESKTOP_MAIN_CONTENT_DRAG_HEIGHT_PX } from '@/components/navigation/shell/desktopChrome/desktopChromeMetrics';
import { SUBMENU_POPOVER_GAP_PX } from '@/components/ui/forms/dropdown/useSubmenuHoverIntent';
import { AgentInputActionMenuSubmenuContext } from './agentInputActionMenuSubmenu';

const MOBILE_AGENT_INPUT_POPOVER_EDGE_PADDING = 12;
const DEFAULT_AGENT_INPUT_POPOVER_EDGE_PADDING = 16;
const DEFAULT_POPOVER_MAX_HEIGHT = 400;
const NATIVE_KEYBOARD_VISIBLE_POPOVER_FRACTION = 0.5;
const DEFAULT_POPOVER_GAP = 8;
/**
 * A caret-anchored menu (slash/@ autocomplete) opens toward the roomier side of the composer: no
 * side is "enough" on its own, so the bottom placement flips whenever the top has more.
 */
const AGENT_INPUT_CARET_MENU_ROOMIER_SIDE_WINS = Number.POSITIVE_INFINITY;

/**
 * The composer a caret-anchored menu belongs to. That menu opens beyond the composer's edge, never
 * over the text being written. Chip pickers ignore it: they hang directly above their chip.
 */
export const AgentInputPopoverClearanceContext = React.createContext<React.RefObject<any> | undefined>(undefined);

/**
 * True inside a document composer (`AgentInput` `panelPresentation="document"`): a form card in a page or
 * a floating form, not the chat composer at the bottom of the window.
 */
export const AgentInputDocumentPanelContext = React.createContext(false);

/** The composer's own column (the card, not the full-width row around it): the width a chip picker stays within. */
export const AgentInputPopoverColumnContext = React.createContext<React.RefObject<any> | undefined>(undefined);

/**
 * How wide a chip picker may run. `column` (default): within the composer's own column. `window`: where the
 * composer floats as a narrow card in a corner of the window (Docked New), so its pickers extend past the card
 * and only the window bounds them. The presentation that places the composer decides it once.
 */
export const AgentInputPopoverWidthContext = React.createContext<'column' | 'window'>('column');

export type AgentInputPopoverLayout = Readonly<{
    maxHeightCap?: number;
    keyboardBottomInset: number;
    /**
     * Chip popovers: above the chip unless that room cannot hold them. Caret menus on web: the roomier side.
     * A + menu row's picker: beside its row, on the side with room, like every shared submenu.
     */
    placement: 'top' | 'bottom' | 'auto-horizontal';
    /** See `Popover.placementMinSpace`: for a caret menu on web, the roomier side always wins. */
    placementMinSpace?: number;
    /** See `Popover.flip`: a chip popover moves below its chip when the room above is short of `placementMinSpace`. */
    flip: boolean;
    gap: number;
    edgePadding: Readonly<{ horizontal: number; vertical: number; top?: number }>;
    portal: PopoverPortalOptions;
    clearanceRef?: React.RefObject<any>;
    /** Chip pickers stay within the composer's width: a chip near its end does not hang a wide picker past it. */
    horizontalBoundaryRef?: React.RefObject<any>;
}>;

export function useAgentInputPopoverLayout(input: Readonly<{
    open: boolean;
    maxHeightCap?: number;
    portalTopBottomLayout?: 'anchored' | 'boundary';
    /**
     * `chip` (default): a composer picker opens directly above its chip and may overlap the composer
     * (the 0.2 composition, owner 2026-10-18). `caret`: the slash/@ menu clears the whole composer.
     */
    anchor?: 'chip' | 'caret';
    /**
     * The room the content needs to show whole, when it is known up front (a list that keeps its whole
     * height needs its whole cap). A chip popover whose side above cannot hold it opens below when that
     * side has more room. Otherwise a side counts as enough once it has the usual popover room.
     */
    contentRoom?: number;
}>): AgentInputPopoverLayout {
    const keyboardHeight = useKeyboardHeight();
    const composerKeyboardLayout = useComposerKeyboardLayout();
    const clearanceRef = React.useContext(AgentInputPopoverClearanceContext);
    const columnRef = React.useContext(AgentInputPopoverColumnContext);
    const pickerWidth = React.useContext(AgentInputPopoverWidthContext);
    const submenu = React.useContext(AgentInputActionMenuSubmenuContext) !== null;
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

    // A chip picker takes the room the keyboard held (UI refinements ruling 2026-11-10, NATIVE-SWEEP L12): opening
    // it dismisses the keyboard; the draft stays, and a tap on the field brings the keyboard back. The slash/@ menu
    // is written at the caret, so it keeps the keyboard and the composer's lift.
    const dismissesKeyboard = Platform.OS !== 'web' && input.anchor !== 'caret' && !submenu;
    React.useEffect(() => {
        if (input.open && dismissesKeyboard) Keyboard.dismiss();
    }, [dismissesKeyboard, input.open]);

    React.useEffect(() => {
        if (Platform.OS === 'web') {
            retainedNativeKeyboardHeightRef.current = 0;
            return;
        }
        if (!input.open || dismissesKeyboard) {
            retainedNativeKeyboardHeightRef.current = 0;
            return;
        }
        if (normalizedKeyboardHeight > 0) {
            retainedNativeKeyboardHeightRef.current = normalizedKeyboardHeight;
        }
    }, [dismissesKeyboard, normalizedKeyboardHeight, input.open]);

    const effectiveKeyboardHeight =
        Platform.OS === 'web'
            ? 0
            : normalizedKeyboardHeight > 0
                ? normalizedKeyboardHeight
                : composerKeyboardHeight > 0
                    ? composerKeyboardHeight
                    : input.open && !dismissesKeyboard
                        ? retainedNativeKeyboardHeightRef.current
                        : 0;

    // One margin on every side: a tall popover stops short of the window's top and bottom edges as
    // it does of the sides (for a top/bottom placement the vertical inset only bounds its height).
    const edgePadding = React.useMemo(() => {
        const inset = Platform.OS === 'web' && isMobileLayoutWidth(windowWidth)
            ? MOBILE_AGENT_INPUT_POPOVER_EDGE_PADDING
            : DEFAULT_AGENT_INPUT_POPOVER_EDGE_PADDING;
        // A desktop-width web window keeps its title strip (tabs, window controls) clear above.
        const top = Platform.OS === 'web' && !isMobileLayoutWidth(windowWidth)
            ? Math.max(inset, DESKTOP_MAIN_CONTENT_DRAG_HEIGHT_PX)
            : inset;
        return top === inset ? { horizontal: inset, vertical: inset } : { horizontal: inset, vertical: inset, top };
    }, [windowWidth]);

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
        if (!input.open || dismissesKeyboard) return undefined;
        if (effectiveKeyboardHeight <= 0) return undefined;
        return composerKeyboardLayout?.retainKeyboardLift?.();
    }, [composerKeyboardLayout, dismissesKeyboard, effectiveKeyboardHeight, input.open]);

    const portal = React.useMemo((): PopoverPortalOptions => {
        // A submenu starts at its row's top edge, as the shared dropdown's submenus do.
        if (submenu) return { ...MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, anchorAlignVertical: 'start' };
        if (!input.portalTopBottomLayout) {
            return MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS;
        }
        return {
            ...MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
            topBottomLayout: input.portalTopBottomLayout,
        };
    }, [input.portalTopBottomLayout, submenu]);

    if (submenu) {
        return {
            maxHeightCap,
            keyboardBottomInset: effectiveKeyboardHeight,
            placement: 'auto-horizontal',
            placementMinSpace: POPOVER_PREFERRED_ROOM_PX,
            flip: true,
            gap: SUBMENU_POPOVER_GAP_PX,
            edgePadding,
            portal,
        };
    }

    const caretAnchored = input.anchor === 'caret';
    // A chip's popover opens above its chip (owner 2026-10-18). A composer high in the window (first-run Home,
    // New Session, a Run now form under the page header) leaves less room there than a popover's content needs:
    // it then opens below instead of clipping to a sliver (calm-shell ruling 2026-11-01). One rule for every chip:
    // "enough" is what the content needs when it is known (`contentRoom`), else the usual popover room.
    return {
        maxHeightCap,
        keyboardBottomInset: effectiveKeyboardHeight,
        placement: caretAnchored && Platform.OS === 'web' ? 'bottom' : 'top',
        ...(caretAnchored && Platform.OS === 'web' ? { placementMinSpace: AGENT_INPUT_CARET_MENU_ROOMIER_SIDE_WINS }
            : { placementMinSpace: input.contentRoom ?? POPOVER_PREFERRED_ROOM_PX }),
        flip: true,
        // The popover now anchors correctly on every platform (Popover resolves the portal-relative
        // anchor via window-deltas on Android — see `resolvePortalRelativeAnchorRect`), so the gap is
        // the same snug value everywhere. Previously Android over-padded (32) to mask an anchor that
        // was resolved in the wrong coordinate space and overlapped the chip.
        gap: DEFAULT_POPOVER_GAP,
        edgePadding,
        portal,
        ...(caretAnchored ? { clearanceRef } : pickerWidth === 'window' ? {} : { horizontalBoundaryRef: columnRef }),
    };
}
