import * as React from 'react';
import { Pressable, View } from 'react-native';
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
}>;

const styles = StyleSheet.create((theme) => ({
    trigger: {
        minWidth: 0,
        alignSelf: 'flex-start',
    },
    tooltipContent: {
        minWidth: 156,
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    tooltipTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    tooltipDot: {
        width: 8,
        height: 8,
        borderRadius: 999,
    },
    tooltipTitle: {
        flex: 1,
        ...Typography.default('semiBold'),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.primary,
    },
    tooltipSubtitle: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
    tooltipValue: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        lineHeight: 20,
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
    } = props;
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const resolvedTriggerTestID = triggerTestID ?? (testID ? `${testID}-trigger` : undefined);

    if (disabled) {
        return <>{children}</>;
    }

    return (
        <>
            <View ref={anchorRef} collapsable={false} style={styles.trigger}>
                <Pressable
                    testID={resolvedTriggerTestID}
                    accessibilityRole="button"
                    onPress={() => setOpen((current) => !current)}
                    onHoverIn={() => setOpen(true)}
                    onHoverOut={() => setOpen(false)}
                    style={styles.trigger}
                >
                    {children}
                </Pressable>
            </View>
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
