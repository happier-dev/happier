import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
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
    /** The glyph's size; the rail passes its one rail-icon size. */
    iconSizePx?: number;
    /** The popover's width when its content needs more than the default (the Usage popover's meters). */
    popoverWidthPx?: number;
    renderContent: (content: SidebarFooterPopoverContentProps) => React.ReactNode;
    /** The same control may be a full menu row when its rail slot moves into More. */
    renderTrigger?: SidebarFooterPopoverTrigger;
}>) {
    const { theme } = useUnistyles();
    const popoverWidthPx = props.popoverWidthPx ?? POPOVER_WIDTH_PX;
    const anchorRef = React.useRef<View>(null);
    const hoverPreview = props.hoverPreview === true && Platform.OS === 'web';
    const { mode, toggle, close, hoverProps } = useHoverPreviewPopover({ enabled: hoverPreview });
    // The control a press came from: Escape returns focus there (the anchor view is not focusable).
    const focusReturnRef = React.useRef<FocusReturnTarget>(null);
    const onPress = React.useCallback((event?: unknown) => {
        focusReturnRef.current = readPressFocusReturnTarget(event);
        toggle();
    }, [toggle]);

    return (
        <View ref={anchorRef} collapsable={false} style={styles.anchor} {...hoverProps}>
            {props.renderTrigger ? props.renderTrigger({ onPress, open: mode !== 'closed' }) : <IconButton
                testID={props.testID}
                variant="plain"
                size={props.buttonSizePx ?? SIDEBAR_FOOTER_ICON_BUTTON_SIZE_PX}
                interactiveTargetGapPx={SIDEBAR_FOOTER_GAP_PX}
                accessibilityLabel={props.label}
                // A previewing button needs no tooltip: resting on it shows the popover itself.
                tooltip={hoverPreview ? undefined : props.label}
                tooltipHidden={mode !== 'closed'}
                tooltipPlacement={props.placement ?? 'top'}
                selected={mode !== 'closed'}
                icon={<Icon name={props.iconName} size={props.iconSizePx ?? SIDEBAR_FOOTER_ICON_GLYPH_SIZE_PX} color={theme.colors.text.secondary} />}
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
                    portal={{ web: true, native: true, matchAnchorWidth: false, anchorAlign: 'start' }}
                    maxWidthCap={popoverWidthPx}
                    maxHeightCap={POPOVER_MAX_HEIGHT_PX}
                    onRequestClose={close}
                >
                    {({ maxHeight, maxWidth }) => (
                        <View testID={`${props.testID}-popover`} {...hoverProps}>
                            <FloatingOverlay
                                maxHeight={Math.min(maxHeight, POPOVER_MAX_HEIGHT_PX)}
                                edgeFades={{ top: true, bottom: true, size: 18 }}
                                edgeIndicators
                                surfaceChrome="theme"
                                keyboardShouldPersistTaps="always"
                                containerStyle={{ width: Math.min(maxWidth, popoverWidthPx) }}
                            >
                                {props.renderContent({
                                    close,
                                    maxHeight: Math.min(maxHeight, POPOVER_MAX_HEIGHT_PX),
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
