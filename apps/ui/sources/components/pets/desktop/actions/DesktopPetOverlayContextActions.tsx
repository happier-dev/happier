import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import {
    Pressable,
    View,
    type StyleProp,
    type ViewStyle,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ContextMenu, type ContextMenuItem } from '@/components/ui/forms/dropdown/ContextMenu';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

const noDragProps = {
    'data-pet-no-drag': 'true',
    dataSet: { petNoDrag: 'true' },
    className: 'no-drag',
} as const;

const CONTEXT_BUTTON_SIZE_PX = 24;
const CONTEXT_BUTTON_HIT_SLOP_PX = 8;

type DesktopPetOverlayContextMenuEvent = Readonly<{
    preventDefault?: () => void;
    stopPropagation?: () => void;
}>;

type DesktopPetOverlayWebViewProps = React.ComponentProps<typeof View> & React.RefAttributes<View> & Readonly<{
    'data-pet-no-drag': 'true';
    dataSet: Readonly<{ petNoDrag: 'true' }>;
    className: 'no-drag';
    onContextMenu?: (event?: DesktopPetOverlayContextMenuEvent) => void;
}>;

export function DesktopPetOverlayContextActions(props: Readonly<{
    trayCount: number;
    trayOpen: boolean;
    onTrayOpenChange: (open: boolean) => void;
    onTuck: () => void;
    style?: StyleProp<ViewStyle>;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const hasTrayItems = props.trayCount > 0;
    const bubbleTheme = theme.colors.desktopPetOverlay?.bubble ?? {
        background: theme.colors.surface.base,
        backgroundPressed: theme.colors.surface.pressed,
        text: theme.colors.text.primary,
        textSecondary: theme.colors.text.secondary,
        controlBackground: theme.colors.surface.base,
        controlBackgroundPressed: theme.colors.surface.pressed,
    };
    const items = React.useMemo<readonly ContextMenuItem[]>(() => [
        {
            id: 'tuck',
            title: t('settingsPets.overlayClosePetAction'),
            icon: <Ionicons name="close" size={18} color={theme.colors.text.secondary} />,
        },
    ], [theme.colors.text.secondary]);
    const openContextMenu = React.useCallback((event?: DesktopPetOverlayContextMenuEvent) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        setOpen(true);
    }, []);
    const handleSelect = React.useCallback((itemId: string) => {
        setOpen(false);
        if (itemId === 'tuck') {
            props.onTuck();
        }
    }, [props]);

    const anchorProps: DesktopPetOverlayWebViewProps = {
        ...noDragProps,
        ref: anchorRef,
        testID: 'desktop-pet-overlay-context-anchor',
        onContextMenu: openContextMenu,
        style: [styles.root, props.style],
    };

    return (
        <View {...anchorProps}>
            <Pressable
                {...noDragProps}
                testID="desktop-pet-overlay-context-toggle"
                data-pet-tray-open={props.trayOpen ? 'true' : 'false'}
                data-pet-tray-count={String(props.trayCount)}
                accessibilityRole="button"
                accessibilityLabel={hasTrayItems ? t('settingsPets.overlayTrayTitle') : t('settingsPets.overlayClosePetAction')}
                hitSlop={CONTEXT_BUTTON_HIT_SLOP_PX}
                onLongPress={() => openContextMenu()}
                onPress={(event) => {
                    event?.stopPropagation?.();
                    if (hasTrayItems) {
                        props.onTrayOpenChange(!props.trayOpen);
                        return;
                    }
                    openContextMenu();
                }}
                style={({ pressed }) => [
                    styles.button,
                    {
                        backgroundColor: !props.trayOpen && hasTrayItems
                            ? theme.colors.status.connected
                            : pressed ? bubbleTheme.backgroundPressed : bubbleTheme.background,
                    },
                ]}
            >
                {!props.trayOpen && hasTrayItems ? (
                    <Text
                        disableUiFontScaling={true}
                        style={[styles.countText, { color: theme.colors.overlay.foreground }]}
                    >
                        {Math.min(props.trayCount, 99)}
                    </Text>
                ) : (
                    <Ionicons name="chevron-down" size={14} color={bubbleTheme.textSecondary} />
                )}
            </Pressable>
            <ContextMenu
                anchorRef={anchorRef}
                open={open}
                onOpenChange={setOpen}
                items={items}
                onSelect={handleSelect}
                closeOnSelect={true}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    root: {
        position: 'absolute',
        zIndex: 5,
    },
    button: {
        width: CONTEXT_BUTTON_SIZE_PX,
        minWidth: CONTEXT_BUTTON_SIZE_PX,
        height: CONTEXT_BUTTON_SIZE_PX,
        borderWidth: 0,
        borderRadius: CONTEXT_BUTTON_SIZE_PX / 2,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 0,
    },
    countText: {
        fontSize: 11,
        fontWeight: '700',
    },
});
