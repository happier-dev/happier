import type { ResolvedPaneLayout } from '@/components/ui/panels/paneBreakpoints';

export function applyPaneFocusModeLayoutOverride(input: Readonly<{
    paneFocusModeActive: boolean;
    rightOpen: boolean;
    detailsOpen: boolean;
    baseLayout: ResolvedPaneLayout;
}>): ResolvedPaneLayout {
    if (!input.paneFocusModeActive) return input.baseLayout;
    if (!input.rightOpen && !input.detailsOpen) return input.baseLayout;

    // In pane focus mode we hide the main region, so overlay presentations can leave blank space
    // because overlays are positioned relative to the main region. Force visible panes to dock.
    if (input.rightOpen && input.detailsOpen) {
        return { kind: 'threePane', right: 'docked', details: 'docked' };
    }
    if (input.rightOpen) {
        return { kind: 'twoPane', right: 'docked', details: 'hidden' };
    }
    return { kind: 'twoPane', right: 'hidden', details: 'docked' };
}
