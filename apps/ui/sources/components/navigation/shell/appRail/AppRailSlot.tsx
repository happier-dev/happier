import { useHappierThemeSurfaceOverridesEnabled } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { themeSurfaceDataSet } from '@happier-dev/plugin-ui';
import { themeSurfaceStyles } from '@/theme/css/themeSurfaceStyles';
import { StyleSheet } from 'react-native-unistyles';

import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';

import { APP_RAIL_ITEM_SLOT_PX, APP_RAIL_WIDTH_PX } from './appRailMetrics';
import { sidebarWrapperPaint } from './sidebarPaint';

type SlotChildren = React.ComponentProps<typeof WorkspaceDestinationRow>['children'];

/**
 * The rail's one slot: the 56 x 40 box one rail glyph stands in, centred. It renders the glyph's
 * button and its badge together, because `APP_RAIL_BADGE` measures from this box; a badge drawn in any
 * other parent lands off its glyph. Every rail entry stands in a slot; an entry that moved into the
 * More menu is a menu row instead and has none.
 */
export function AppRailSlot(props: Readonly<{
    children: SlotChildren;
    /** The glyph's badge (`AppRailBadge`), or nothing. */
    badge?: React.ReactNode;
    /** The destination the slot opens (modifier-click, middle click, context menu, drag), or none. */
    href?: string | null;
    existingMenu?: boolean;
    dragSource?: boolean;
}>) {
    const surfaceOverridesEnabled = useHappierThemeSurfaceOverridesEnabled();
    const { children, badge } = props;
    return (
        <WorkspaceDestinationRow
            dataSet={themeSurfaceDataSet('sidebar', 'row', 'default')}
            style={[styles.slot, themeSurfaceStyles.surface(surfaceOverridesEnabled ? { surface: 'sidebar', part: 'row' } : undefined)]}
            href={props.href ?? null}
            existingMenu={props.existingMenu}
            dragSource={props.dragSource}
        >
            {typeof children === 'function'
                ? (actions) => <>{children(actions)}{badge}</>
                : <>{children}{badge}</>}
        </WorkspaceDestinationRow>
    );
}

const styles = StyleSheet.create({
    slot: {
        backgroundColor: sidebarWrapperPaint().color,
        width: APP_RAIL_WIDTH_PX,
        height: APP_RAIL_ITEM_SLOT_PX,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
