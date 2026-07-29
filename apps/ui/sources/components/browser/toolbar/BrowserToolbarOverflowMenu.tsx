import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, Popover } from '@/components/ui/popover';
import { t } from '@/text';

export type BrowserToolbarOverflowItem = Readonly<{
    id: string;
    iconName: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
    onPress: () => void;
    disabled?: boolean;
    disabledReason?: string | null;
    /** Marks a destructive/active state (e.g. an in-progress recording) so it reads with warning tone. */
    tone?: 'default' | 'active';
}>;

const stylesheet = StyleSheet.create((theme) => ({
    trigger: {
        width: 34,
        height: 34,
        borderRadius: 6,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    triggerDisabled: {
        opacity: 0.45,
    },
    body: {
        paddingVertical: 6,
        minWidth: 220,
    },
    item: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    itemPressed: {
        backgroundColor: theme.colors.surface.inset,
    },
    itemDisabled: {
        opacity: 0.45,
    },
    itemLabel: {
        color: theme.colors.text.primary,
        fontSize: 14,
        flexShrink: 1,
    },
    itemTextStack: {
        flexShrink: 1,
        minWidth: 0,
    },
    itemReason: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        flexShrink: 1,
    },
}));

/**
 * Consolidates the browser toolbar's SECONDARY controls (devtools, attach-context, annotation,
 * recording, automation) into one overflow Popover so the toolbar stops wrapping onto a second row
 * in narrow panes (Lunel-parity gap #52). Mirrors the canonical `BrowserPrivacyPopover` Popover +
 * `FloatingOverlay` pattern; primary navigation (back/forward/reload/stop/address) stays inline.
 */
export function BrowserToolbarOverflowMenu(props: Readonly<{
    items: readonly BrowserToolbarOverflowItem[];
    testID: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<View>(null);

    if (props.items.length === 0) {
        return null;
    }

    return (
        <>
            <Pressable
                ref={anchorRef}
                testID={props.testID}
                accessibilityRole="button"
                accessibilityLabel={t('browserShell.overflow.open')}
                accessibilityState={{ expanded: open }}
                onPress={() => setOpen((value) => !value)}
                style={stylesheet.trigger}
            >
                <Ionicons name="ellipsis-horizontal" size={18} color={theme.colors.text.primary} />
            </Pressable>
            {open ? (
                <Popover
                    open={open}
                    anchorRef={anchorRef}
                    placement="bottom"
                    gap={6}
                    maxHeightCap={420}
                    maxWidthCap={320}
                    onRequestClose={() => setOpen(false)}
                    backdrop={{ enabled: false }}
                    portal={MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
                >
                    {({ maxHeight }) => (
                        <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme">
                            <View testID={`${props.testID}-panel`} style={stylesheet.body}>
                                {props.items.map((item) => (
                                    <Pressable
                                        key={item.id}
                                        testID={`${props.testID}-item-${item.id}`}
                                        accessibilityRole="button"
                                        accessibilityLabel={item.label}
                                        accessibilityHint={item.disabled === true && item.disabledReason ? item.disabledReason : undefined}
                                        accessibilityState={{ disabled: item.disabled === true }}
                                        disabled={item.disabled === true}
                                        onPress={() => {
                                            if (item.disabled === true) {
                                                return;
                                            }
                                            setOpen(false);
                                            item.onPress();
                                        }}
                                        style={({ pressed }) => [
                                            stylesheet.item,
                                            pressed ? stylesheet.itemPressed : null,
                                            item.disabled ? stylesheet.itemDisabled : null,
                                        ]}
                                    >
                                        <Ionicons
                                            name={item.iconName}
                                            size={18}
                                            color={item.tone === 'active'
                                                ? theme.colors.state.warning.foreground
                                                : theme.colors.text.primary}
                                        />
                                        <View style={stylesheet.itemTextStack}>
                                            <Text numberOfLines={1} style={stylesheet.itemLabel}>{item.label}</Text>
                                            {item.disabled === true && item.disabledReason ? (
                                                <Text numberOfLines={1} style={stylesheet.itemReason}>
                                                    {item.disabledReason}
                                                </Text>
                                            ) : null}
                                        </View>
                                    </Pressable>
                                ))}
                            </View>
                        </FloatingOverlay>
                    )}
                </Popover>
            ) : null}
        </>
    );
}
