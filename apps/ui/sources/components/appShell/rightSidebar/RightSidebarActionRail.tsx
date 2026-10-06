import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PANE_ACTION_RAIL_WIDTH } from '@/components/appShell/panes/PaneActionRailContext';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { t } from '@/text';
import { Modal } from '@/modal';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useNavigationSurfacePlacement } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import { resolveNavigationOverflow, resolveNavigationPlacements, type NavigationPlacement } from '@/sync/domains/settings/mobileSurfacePinning';
import { fireAndForget } from '@/utils/system/fireAndForget';

export type RightSidebarRailAction = Readonly<{
    id: string;
    label: string;
    icon: IconName;
    active: boolean;
    disabled?: boolean;
    onPress: () => void;
    badgeCount?: number;
    badge?: React.ReactNode;
    tooltipContent?: React.ReactNode;
    /**
     * What the action works on (the session rail: code · the session · the machine). A hairline
     * separates consecutive actions of different groups; the order stays the caller's.
     */
    group?: string;
    defaultPlacement?: NavigationPlacement;
}>;

const ACTION_GAP = 4;
const RAIL_PADDING = 4;
const SEPARATOR_MARGIN = 4;

const styles = StyleSheet.create((theme) => ({
    rail: {
        width: PANE_ACTION_RAIL_WIDTH,
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
    },
    actions: { alignItems: 'center', paddingVertical: RAIL_PADDING, gap: ACTION_GAP },
    separator: {
        alignSelf: 'stretch',
        marginHorizontal: 10,
        marginVertical: SEPARATOR_MARGIN,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.border.default,
    },
    marker: {
        position: 'absolute', left: -9, top: 0, bottom: 0,
        width: 2, borderRadius: 1, backgroundColor: theme.colors.text.primary,
    },
}));

export function RightSidebarActionRail(props: Readonly<{
    actions: readonly RightSidebarRailAction[];
    surfaceId: 'sessionRail' | 'workspaceRail';
    testID?: string;
    testIDPrefix?: string;
}>) {
    const { theme } = useUnistyles();
    const prefix = props.testIDPrefix ?? 'right-sidebar-action-rail';
    const { preferences } = useNavigationSurfacePlacement(props.surfaceId);
    const [height, setHeight] = React.useState<number | null>(null);
    const [moreOpen, setMoreOpen] = React.useState(false);
    const size = Platform.OS === 'web' ? 36 : Platform.OS === 'android' ? 48 : 44;
    const placements = resolveNavigationPlacements(props.actions, preferences);
    const visible = resolveNavigationOverflow(placements.pinned, placements.overflow, {
        // Cells include a gap; the content has no trailing gap after the final cell.
        availableSize: height === null ? null : Math.max(0, height - 2 * RAIL_PADDING + ACTION_GAP),
        itemSize: size + ACTION_GAP,
        separatorSize: 2 * SEPARATOR_MARGIN + ACTION_GAP + StyleSheet.hairlineWidth,
    });
    const customize = () => {
        setMoreOpen(false);
        fireAndForget(import('@/components/ui/navigation/NavigationPlacementCustomizer').then(({ NavigationPlacementCustomizer }) => {
            Modal.show({ component: NavigationPlacementCustomizer, props: {
                surfaceId: props.surfaceId,
                items: props.actions.map((action) => ({ id: action.id, title: action.label, icon: action.icon, group: action.group, defaultPlacement: action.defaultPlacement })),
                testID: `${prefix}:customizer`,
            } });
        }), { tag: 'RightSidebarActionRail.customize' });
    };
    const moreItems: readonly DropdownMenuItem[] = [
        ...visible.overflow.map((action) => ({
            id: action.id, title: action.label, disabled: action.disabled,
            testID: `${prefix}:overflow:${action.id}`,
            icon: <Icon name={action.icon} size={18} />,
            rightElement: <>{action.badge}{(action.badgeCount ?? 0) > 0 ? <TabBadge size="compact" variant="count" value={action.badgeCount ?? 0} tone="neutral" /> : null}</>,
        })),
        { id: 'customize', title: t('navigationPlacement.customize'), icon: <Icon name="sliders-horizontal" size={18} />, testID: `${prefix}:customize` },
    ];
    return (
        <View
            testID={props.testID ?? 'right-sidebar-action-rail'}
            accessibilityRole="toolbar"
            accessibilityLabel={t('common.actions')}
            style={styles.rail}
            onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
            {...(Platform.OS === 'web' ? { onContextMenu: (event: { preventDefault(): void }) => { event.preventDefault(); customize(); } } : {})}
        >
            <View style={styles.actions}>
            {visible.shown.map((action, index) => (
                <React.Fragment key={action.id}>
                {index > 0 && action.group !== undefined && action.group !== visible.shown[index - 1]!.group ? (
                    <View testID={`${prefix}:separator:${action.group}`} style={styles.separator} />
                ) : null}
                <IconButton
                    testID={`${prefix}:${action.id}`}
                    accessibilityLabel={action.label}
                    tooltip={action.label}
                    tooltipContent={action.tooltipContent}
                    tooltipPlacement="left"
                    selected={action.active}
                    selectedBackground={false}
                    disabled={action.disabled}
                    onPress={action.onPress}
                    onLongPress={customize}
                    variant="plain"
                    size={size}
                    iconSize={18}
                    icon={(
                        <View pointerEvents="none">
                            {action.active ? <View style={styles.marker} /> : null}
                            <Icon name={action.icon} size={18} color={action.active ? theme.colors.text.primary : theme.colors.text.secondary} />
                            {action.badge}
                            {(action.badgeCount ?? 0) > 0 ? <TabBadge size="compact" variant="count" value={action.badgeCount ?? 0} tone="neutral" testID={`${prefix}:${action.id}:badge`} /> : null}
                        </View>
                    )}
                />
                </React.Fragment>
            ))}
            {visible.overflow.length > 0 || (visible.shown.length === 0 && props.actions.length > 0) ? <DropdownMenu
                open={moreOpen}
                onOpenChange={setMoreOpen}
                items={moreItems}
                selectedId={visible.overflow.find((action) => action.active)?.id ?? null}
                onSelect={(id) => { setMoreOpen(false); if (id === 'customize') customize(); else visible.overflow.find((action) => action.id === id)?.onPress(); }}
                placement="left"
                matchTriggerWidth={false}
                trigger={({ toggle, open }) => <IconButton
                    testID={`${prefix}:more`}
                    accessibilityLabel={t('common.more')}
                    tooltip={t('common.more')}
                    tooltipPlacement="left"
                    expanded={open}
                    selected={visible.overflow.some((action) => action.active)}
                    selectedBackground={false}
                    onPress={toggle}
                    onLongPress={customize}
                    iconName="dots-three"
                    variant="plain"
                    size={size}
                />}
            /> : null}
            </View>
        </View>
    );
}
