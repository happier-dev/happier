import * as React from 'react';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';

export type RightPanelPlacement = 'separate' | 'line' | 'shadow';
export const RIGHT_PANEL_PLACEMENTS: readonly RightPanelPlacement[] = ['separate', 'line', 'shadow'];
/** The setting's default (owner 11-01): joined to the page with a soft shadow. */
export const DEFAULT_RIGHT_PANEL_PLACEMENT: RightPanelPlacement = 'shadow';

/**
 * The person's choice of how the docked right panel stands against the page (calm-shell R4-2, R11-3):
 * `separate`, its own sheet on the canvas beside the page, or joined to the page and divided by a `line`
 * or a soft `shadow` (the default). Read and written by the Appearance row and the Look panel; the shell
 * frame alone resolves what it means for a window.
 */
export function useRightPanelPlacement() {
    const value = useLocalSetting('rightPanelPlacement');
    const applyLocalSettings = useApplyLocalSettings();
    const placement: RightPanelPlacement = value === 'separate' || value === 'line' || value === 'shadow' ? value : DEFAULT_RIGHT_PANEL_PLACEMENT;
    const setPlacement = React.useCallback((next: RightPanelPlacement) => {
        applyLocalSettings({ rightPanelPlacement: next });
    }, [applyLocalSettings]);
    return React.useMemo(() => ({ placement, setPlacement }), [placement, setPlacement]);
}
