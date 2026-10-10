import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CompanionWidgetAddPopover, type CompanionWidgetAddSource } from '@/components/widgets/add/CompanionWidgetAddPopover';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * The one way to add to the Companion: the "Add to Companion" row at the end of
 * the column (desktop) or the + in the phone's navigation bar, both opening the
 * shared widget Add popover (Glances · On this board · Panes). Every choice is one
 * reference through the Companion's one add path; the Board stays the one
 * authority for its own content.
 */

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        marginTop: 8,
        paddingHorizontal: 8,
        borderRadius: 10,
    },
    rowActive: { backgroundColor: theme.colors.surface.selected },
    rowPressed: { backgroundColor: theme.colors.surface.pressed },
    rowLabel: { ...Typography.default(), color: theme.colors.text.secondary, fontSize: 13 },
    rowLabelActive: { ...Typography.default('semiBold'), color: theme.colors.text.primary },
    anchor: { height: 1, alignSelf: 'center', width: 1 },
    icon: {
        alignItems: 'center',
        justifyContent: 'center',
        width: resolveMinimumInteractiveTargetSize(Platform.OS),
        height: resolveMinimumInteractiveTargetSize(Platform.OS),
    },
}));

export type SessionCompanionAddBinding = CompanionWidgetAddSource & Readonly<{
    acquireBoardContent?: () => () => void;
}>;

export function SessionCompanionAddControl(props: Readonly<{
    binding: SessionCompanionAddBinding;
    /** `anchor` draws nothing: it only anchors a popover opened from elsewhere ("Choose a widget…"). */
    variant: 'row' | 'icon' | 'anchor';
    /** Lets the empty state's "Choose a widget…" open this same popover. */
    openRequest?: number;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View | null>(null);
    const [open, setOpen] = React.useState(false);
    const acquireBoardContent = props.binding.acquireBoardContent;
    React.useEffect(() => {
        if (!open) return;
        return acquireBoardContent?.();
    }, [acquireBoardContent, open]);
    React.useEffect(() => {
        if (props.openRequest) setOpen(true);
    }, [props.openRequest]);
    const close = React.useCallback(() => setOpen(false), []);

    const label = t('sessionCompanion.picker.open');
    return (
        <>
            {props.variant === 'row' ? (
                <Pressable
                    ref={anchorRef}
                    testID={props.testID}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    accessibilityState={{ expanded: open }}
                    onPress={() => setOpen((value) => !value)}
                    style={({ pressed }) => [
                        stylesheet.row,
                        { minHeight: Math.max(34, resolveMinimumInteractiveTargetSize(Platform.OS)) },
                        open ? stylesheet.rowActive : pressed ? stylesheet.rowPressed : null,
                    ]}
                >
                    <Icon name="plus" size={15} color={open ? theme.colors.text.primary : theme.colors.text.secondary} />
                    <Text style={[stylesheet.rowLabel, open ? stylesheet.rowLabelActive : null]}>{label}</Text>
                </Pressable>
            ) : props.variant === 'icon' ? (
                <Pressable
                    ref={anchorRef}
                    testID={props.testID}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    accessibilityState={{ expanded: open }}
                    onPress={() => setOpen((value) => !value)}
                    style={stylesheet.icon}
                    hitSlop={4}
                >
                    <Icon name="plus" size={20} color={theme.colors.text.primary} />
                </Pressable>
            ) : (
                <View ref={anchorRef} testID={props.testID} style={stylesheet.anchor} />
            )}
            <CompanionWidgetAddPopover
                open={open}
                anchorRef={anchorRef}
                // The row sits at the end of the column, so the popover opens above it; the phone's +
                // sits in the navigation bar, so it opens below.
                placement={props.variant === 'icon' ? 'bottom' : 'top'}
                onRequestClose={close}
                source={props.binding}
                testID={`${props.testID}-picker`}
            />
        </>
    );
}
