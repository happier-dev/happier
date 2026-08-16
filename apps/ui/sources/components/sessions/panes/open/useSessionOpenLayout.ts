import * as React from 'react';
import { Platform, useWindowDimensions } from 'react-native';

import { resolveMultiPaneDeviceType } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';

import {
    canLayoutDockSessionPane,
    type SessionOpenLayout,
    type SessionPaneSlot,
} from './sessionOpenTarget';

/**
 * The layout every session-pane decision is measured against, read exactly once.
 *
 * Both halves of the decision need the same three facts, and both used to gather them themselves:
 * the open side through `useOpenSessionTarget`, the return side (`/file`, `/commit` handing back to
 * a details pane) through raw `useDeviceType()` and a raw `uiMultiPanePanelsEnabled` read. Those two
 * readings disagreed on real viewports — a narrow browser window is `phone` to `useDeviceType` and
 * `tablet` to the pane host, and the multi-pane setting is `undefined` until the user has an
 * opinion, which a truthy read calls "off". So a route could refuse to hand back to a pane the host
 * would happily have drawn.
 *
 * One reading, used in both directions.
 */
export function useSessionOpenLayout(): SessionOpenLayout {
    const { width: containerWidthPx } = useWindowDimensions();
    const rawDeviceType = useDeviceType();
    // `AppPaneScopeHost` — the authority that decides whether a pane is drawn at all — treats web as
    // `tablet` so a narrow browser window still gets overlay panes.
    const deviceType = React.useMemo(
        () => resolveMultiPaneDeviceType({ platform: Platform.OS, deviceType: rawDeviceType }),
        [rawDeviceType],
    );
    // `!== false` rather than a truthy read: the setting is undefined until the user has an opinion,
    // and multi-pane is on by default. A falsy read would send every desktop press to a full screen.
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;

    return React.useMemo(
        () => ({ containerWidthPx, deviceType, multiPaneEnabled }),
        [containerWidthPx, deviceType, multiPaneEnabled],
    );
}

/**
 * Whether a full-screen route should hand its content back to a docked pane. See
 * `canLayoutDockSessionPane` for why this is a stricter question than "can a pane exist here".
 */
export function useCanDockSessionPane(slot: SessionPaneSlot): boolean {
    const layout = useSessionOpenLayout();
    return canLayoutDockSessionPane(layout, slot);
}
