import * as React from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

type ChartTooltipProps = Readonly<{
    children: React.ReactNode;
    title: string;
    subtitle?: string;
    value: string;
    accentColor: string;
    testID?: string;
    triggerTestID?: string;
    disabled?: boolean;
    accessibilityLabel?: string;
    /** Select the neutral datum without adding a nested interactive control. */
    onSelect?: () => void;
    keyboard?: boolean;
    /** Existing chart controls retain their own keyboard navigation, selection and hit areas. */
    renderTrigger?: (interaction: Readonly<{
        onHoverChange: (hovered: boolean) => void;
        onFocusChange: (focused: boolean) => void;
        onPress: () => void;
    }>) => React.ReactNode;
    /**
     * Layout style for the trigger wrapper — charts whose marks own their flex
     * sizing (e.g. 100%-stacked composition segments with `flexGrow`) pass it
     * here so wrapping a mark in the tooltip never changes the chart layout.
     */
    triggerStyle?: StyleProp<ViewStyle>;
}>;

const styles = StyleSheet.create((theme) => ({
    trigger: {
        minWidth: 0,
        // Fill the parent's cross axis (RN's default) rather than shrinking to
        // content. `flex-start` here made the trigger shrink-to-fit, which on
        // web collapsed any percentage-width fill child (bar tracks, meters) to
        // width 0 — the fill's `width:'100%'` resolved against a 0-width parent
        // and never painted. `stretch` lets those fills resolve to the track
        // width; fixed-size children are unaffected (they keep their own width,
        // stretch only governs the otherwise-auto cross size).
        alignSelf: 'stretch',
    },
    tooltipContent: {
        minWidth: 156,
        gap: theme.space.s6,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s10,
    },
    tooltipTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    tooltipDot: {
        width: 8,
        height: 8,
        borderRadius: 999,
    },
    tooltipTitle: {
        flex: 1,

        ...Typography.variant('body', 'semiBold'),

        color: theme.colors.text.primary,
    },
    tooltipSubtitle: {

        ...Typography.variant('meta'),

        color: theme.colors.text.secondary,
    },
    tooltipValue: {

        ...Typography.variant('heading'),

        color: theme.colors.text.primary,
    },
}));

export function ChartTooltip(props: ChartTooltipProps): React.ReactElement {
    const {
        children,
        title,
        subtitle,
        value,
        accentColor,
        testID,
        triggerTestID,
        disabled = false,
        triggerStyle,
    } = props;
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    // On pointer devices a press is always preceded by hover-in (which already
    // opened the tooltip) — the press must then KEEP it open, or every click
    // instantly toggles the hover-opened tooltip away and reads as "tooltips
    // never show" (D-R4-3 root cause #3). Touch devices emit no hover events,
    // so the ref stays false there and press keeps plain toggle semantics.
    const hoveredRef = React.useRef(false);
    const focusedRef = React.useRef(false);
    const openedByFocusRef = React.useRef(false);
    const resolvedTriggerTestID = triggerTestID ?? (testID ? `${testID}-trigger` : undefined);

    if (disabled) {
        return <>{children}</>;
    }

    const interaction = {
        onPress: () => {
            props.onSelect?.();
            // Touch on web may focus before pressing. That first press keeps its newly opened value visible.
            const keepOpen = hoveredRef.current || openedByFocusRef.current;
            openedByFocusRef.current = false;
            setOpen((current) => keepOpen ? true : !current);
        },
        onFocusChange: (focused: boolean) => {
            focusedRef.current = focused;
            openedByFocusRef.current = focused;
            if (focused) { props.onSelect?.(); setOpen(true); }
            else if (!hoveredRef.current) setOpen(false);
        },
        onHoverChange: (hovered: boolean) => {
            hoveredRef.current = hovered;
            if (hovered) { props.onSelect?.(); setOpen(true); }
            else if (!focusedRef.current) setOpen(false);
        },
    };

    return (
        <>
            {props.renderTrigger ? <View ref={anchorRef} collapsable={false} pointerEvents="box-none" style={[styles.trigger, triggerStyle]}>
                {props.renderTrigger(interaction)}
            </View> : <Pressable
                    ref={anchorRef}
                    collapsable={false}
                    testID={resolvedTriggerTestID}
                    accessibilityRole="button"
                    focusable={props.keyboard !== false}
                    accessible={props.keyboard !== false}
                    accessibilityLabel={props.accessibilityLabel ?? `${title}: ${value}`}
                    onPress={(event) => { event?.stopPropagation?.(); interaction.onPress(); }}
                    onFocus={() => interaction.onFocusChange(true)}
                    onBlur={() => interaction.onFocusChange(false)}
                    onHoverIn={() => interaction.onHoverChange(true)}
                    onHoverOut={() => interaction.onHoverChange(false)}
                    style={[styles.trigger, triggerStyle]}
                >
                    {children}
                </Pressable>}
            <Popover
                open={open}
                anchorRef={anchorRef}
                placement="top"
                gap={8}
                portal={{ web: true, native: true, matchAnchorWidth: false, anchorAlign: 'center' }}
                maxWidthCap={260}
                maxHeightCap={180}
                onRequestClose={() => setOpen(false)}
            >
                {() => (
                    <FloatingOverlay scrollEnabled={false}>
                        <View testID={testID} style={styles.tooltipContent}>
                            <View style={styles.tooltipTitleRow}>
                                <View style={[styles.tooltipDot, { backgroundColor: accentColor }]} />
                                <Text numberOfLines={2} style={styles.tooltipTitle}>{title}</Text>
                            </View>
                            {subtitle ? <Text style={styles.tooltipSubtitle}>{subtitle}</Text> : null}
                            <Text style={styles.tooltipValue}>{value}</Text>
                        </View>
                    </FloatingOverlay>
                )}
            </Popover>
        </>
    );
}
