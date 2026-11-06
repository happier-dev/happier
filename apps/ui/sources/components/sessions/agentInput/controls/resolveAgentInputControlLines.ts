import type { AgentInputActionBarLayout } from '@/components/sessions/agentInput/layout/actionBarLogic';
import {
    EMPTY_NAVIGATION_PLACEMENT_PREFERENCES,
    resolveNavigationPlacements,
    type NavigationPlacementPreferences,
    type NavigationSurfacePlacementsV1,
} from '@/sync/domains/settings/mobileSurfacePinning';

import {
    type AgentInputResolvedControlLines,
    type AgentInputPlacementDescriptor,
} from './agentInputControlTypes';

/** The composer's saved placements, read from the local navigation placement setting. */
export const selectComposerPlacementPreferences = (value: NavigationSurfacePlacementsV1) => value?.composer ?? EMPTY_NAVIGATION_PLACEMENT_PREFERENCES;

export function resolveAgentInputControlLines(params: Readonly<{
    layout?: AgentInputActionBarLayout;
    controls: readonly AgentInputPlacementDescriptor[];
    preferences?: NavigationPlacementPreferences;
    /** An existing session's composer is one rail: its location controls ride the same rail. */
    singleRow?: boolean;
}>): AgentInputResolvedControlLines {
    const resolved = resolveNavigationPlacements(params.controls, params.preferences);
    const row = resolved.pinned.filter(control => control.slot === 'chip');
    return {
        layout: params.layout,
        controls: params.controls,
        primary: row.filter(control => params.singleRow || control.line === 'primary').map(control => control.id),
        secondary: params.singleRow ? [] : row.filter(control => control.line === 'secondary').map(control => control.id),
        collapsed: resolved.overflow.map(control => control.id),
        accessories: resolved.pinned.filter(control => control.slot === 'fieldAccessory').map(control => control.id),
        hidden: resolved.hidden.map(control => control.id),
        effectivePlacements: resolved.effectivePlacements,
    };
}
