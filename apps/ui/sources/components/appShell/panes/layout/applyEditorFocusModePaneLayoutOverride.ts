import type { ResolvedPaneLayout } from '@/components/ui/panels/paneBreakpoints';

export function applyEditorFocusModePaneLayoutOverride(input: Readonly<{
    editorFocusModeEnabled: boolean;
    rightOpen: boolean;
    detailsOpen: boolean;
    baseLayout: ResolvedPaneLayout;
}>): ResolvedPaneLayout {
    if (!input.editorFocusModeEnabled) return input.baseLayout;
    if (!input.rightOpen && !input.detailsOpen) return input.baseLayout;

    // In focus mode we hide the main region, so overlay presentations can leave blank space
    // (overlays are positioned relative to the main region). Force visible panes to be docked.
    if (input.rightOpen && input.detailsOpen) {
        return { kind: 'threePane', right: 'docked', details: 'docked' };
    }
    if (input.rightOpen) {
        return { kind: 'twoPane', right: 'docked', details: 'hidden' };
    }
    return { kind: 'twoPane', right: 'hidden', details: 'docked' };
}
