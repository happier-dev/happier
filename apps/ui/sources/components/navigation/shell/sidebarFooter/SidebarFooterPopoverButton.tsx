import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { FloatingOverlay, type FloatingOverlayScrollProps } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { useHoverPreviewPopover } from '@/components/ui/popover/useHoverPreviewPopover';
import { readPressFocusReturnTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';

import {
    SIDEBAR_FOOTER_GAP_PX,
    SIDEBAR_FOOTER_ICON_BUTTON_SIZE_PX,
    SIDEBAR_FOOTER_ICON_GLYPH_SIZE_PX,
} from './sidebarFooterLayout';

const POPOVER_WIDTH_PX = 320;
const POPOVER_MAX_HEIGHT_PX = 520;

export type SidebarFooterPopoverContentProps = Readonly<{
    close: () => void;
    maxHeight: number;
    scrollProps?: FloatingOverlayScrollProps;
}>;

export type SidebarFooterPopoverTrigger = (state: Readonly<{ onPress: (event?: unknown) => void; open: boolean; right?: React.ReactNode }>) => React.ReactNode;

/**
 * One icon button in the sidebar footer that opens its popover upwards. Click, Enter or Space opens
 * it and moves focus into it; Escape closes it and returns focus to the button (the Popover owner).
 * `hoverPreview` also opens it, without taking focus, after the pointer rests on the button — never
 * the only way in. The content mounts only while open, so a closed button costs nothing.
 */
export function SidebarFooterPopoverButton(props: Readonly<{
    testID: string;
    iconName: IconName;
    label: string;
    hoverPreview?: boolean;
    /** Where the popover opens: above a footer icon, or beside a rail icon. */
    placement?: 'top' | 'right';
    /** The visible button square; the rail's icons are larger than the footer's. */
    buttonSizePx?: number;
    /** The free space the hit area may reach on each side, where the host tiles buttons itself (the rail); the footer's own gap applies otherwise. */
    interactiveTargetEdgesPx?: Readonly<{ leading: number; trailing: number; top?: number; bottom?: number }>;
    /** The glyph's size; the rail passes its one rail-icon size. */
    iconSizePx?: number;
    /** The popover's width when its content needs more than the default (the Usage popover's meters). */
    popoverWidthPx?: number;
    /** The popover's tallest height when its content is a long roster (the Machines popover); the window still bounds it. */
    popoverMaxHeightPx?: number;
    renderContent: (content: SidebarFooterPopoverContentProps) => React.ReactNode;
    /** The content uses a recycler as the floating surface's single scroll viewport. */
    contentOwnsScroll?: boolean;
    /** The same control may be a full menu row when its rail slot moves into More. */
    renderTrigger?: SidebarFooterPopoverTrigger;
    /**
     * Lets an app-wide entry (the command palette, the phone launcher) open this same popover: the
     * button hands its opener over while mounted and takes it back on unmount.
     */
    registerOpener?: (open: () => void) => () => void;
    /** Beside a rail icon: whether the popover's top meets the icon's top (`start`) or centres on it (default). */
    anchorAlignVertical?: 'start' | 'center';
    /** Overrides the plain glyph (a filled glyph while open on the rail). */
    renderIcon?: (open: boolean) => React.ReactNode;
    /** Shows the button selected while its destination is open (the Machines page's rail door), as well as while its popover is. */
    selected?: boolean;
    /** The person asked to open it (a press, Enter/Space, an app-wide opener, or a hover preview that opened): user intent, never a mount effect. */
    onOpenIntent?: () => void;
}>) {
    const { theme } = useUnistyles();
    const popoverWidthPx = props.popoverWidthPx ?? POPOVER_WIDTH_PX;
    const popoverMaxHeightPx = props.popoverMaxHeightPx ?? POPOVER_MAX_HEIGHT_PX;
    const anchorRef = React.useRef<View>(null);
    const hoverPreview = props.hoverPreview === true && Platform.OS === 'web';
    // The control a press came from: Escape returns focus there (the anchor view is not focusable).
    const focusReturnRef = React.useRef<FocusReturnTarget>(null);
    const { mode, toggle, close, open, hoverProps } = useHoverPreviewPopover({ enabled: hoverPreview });
    const { registerOpener } = props;
    const intents = React.useRef({ open: props.onOpenIntent });
    intents.current = { open: props.onOpenIntent };
    React.useEffect(() => registerOpener?.(() => {
        focusReturnRef.current = null;
        intents.current.open?.();
        open();
    }), [open, registerOpener]);
    // A hover preview is the person opening it too: record it once, when it opens. A press that later
    // pins the same preview moves `preview` to `open` and is not a second opening.
    const previousModeRef = React.useRef(mode);
    React.useEffect(() => {
        const previous = previousModeRef.current;
        previousModeRef.current = mode;
        if (previous === 'closed' && mode === 'preview') intents.current.open?.();
    }, [mode]);
    const onPress = React.useCallback((event?: unknown) => {
        focusReturnRef.current = readPressFocusReturnTarget(event);
        if (mode === 'closed') intents.current.open?.();
        toggle();
    }, [mode, toggle]);
    return (
        <View ref={anchorRef} collapsable={false} style={styles.anchor} {...hoverProps}>
            {props.renderTrigger ? props.renderTrigger({ onPress, open: mode !== 'closed' }) : <IconButton
                testID={props.testID}
                variant="plain"
                size={props.buttonSizePx ?? SIDEBAR_FOOTER_ICON_BUTTON_SIZE_PX}
                interactiveTargetGapPx={SIDEBAR_FOOTER_GAP_PX}
                interactiveTargetEdgesPx={props.interactiveTargetEdgesPx}
                accessibilityLabel={props.label}
                // A previewing button needs no tooltip: resting on it shows the popover itself.
                tooltip={hoverPreview ? undefined : props.label}
                tooltipHidden={mode !== 'closed'}
                tooltipPlacement={props.placement ?? 'top'}
                selected={props.selected === true || mode !== 'closed'}
                icon={props.renderIcon?.(mode !== 'closed') ?? <Icon name={props.iconName} size={props.iconSizePx ?? SIDEBAR_FOOTER_ICON_GLYPH_SIZE_PX} color={theme.colors.text.secondary} />}
                onPress={onPress}
            />}
            {mode !== 'closed' ? (
                <Popover
                    open
                    anchorRef={anchorRef}
                    focusReturnRef={focusReturnRef}
                    autoFocusOnOpen={mode === 'open'}
                    placement={props.placement ?? 'top'}
                    gap={8}
                    edgePadding={{ horizontal: 8, vertical: 8 }}
                    portal={{ web: true, native: true, matchAnchorWidth: false, anchorAlign: 'start',
                        ...(props.anchorAlignVertical ? { anchorAlignVertical: props.anchorAlignVertical } : {}) }}
                    maxWidthCap={popoverWidthPx}
                    maxHeightCap={popoverMaxHeightPx}
                    onRequestClose={close}
                >
                    {({ maxHeight, maxWidth }) => (
                        <View testID={`${props.testID}-popover`} {...hoverProps}>
                            <FloatingOverlay
                                maxHeight={Math.min(maxHeight, popoverMaxHeightPx)}
                                edgeFades={{ top: true, bottom: true, size: 18 }}
                                edgeIndicators
                                surfaceChrome="theme"
                                keyboardShouldPersistTaps="always"
                                containerStyle={{ width: Math.min(maxWidth, popoverWidthPx) }}
                                renderScrollContent={props.contentOwnsScroll ? (scrollProps) => props.renderContent({
                                    close, maxHeight: Math.min(maxHeight, popoverMaxHeightPx), scrollProps,
                                }) : undefined}
                            >
                                {props.contentOwnsScroll ? null : props.renderContent({
                                    close,
                                    maxHeight: Math.min(maxHeight, popoverMaxHeightPx),
                                })}
                            </FloatingOverlay>
                        </View>
                    )}
                </Popover>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    anchor: {
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
