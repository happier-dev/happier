import {
    RIGHT_SIDEBAR_BUILTIN_TABS,
    type RightSidebarAvailabilityInput,
    type RightSidebarBuiltInTabId,
    type RightSidebarBuiltinTabDefinition,
    type RightSidebarMobileSurface,
    type RightSidebarPresentation,
    type RightSidebarScope,
    type RightSidebarTabDefinition,
    type RightSidebarTabDefinitionFor,
} from './rightSidebarBuiltinTabs';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { resolveRightSidebarPluginTabs } from './rightSidebarPluginTabs';
import { resolveRightSidebarMobileSurface as resolveProjectedRightSidebarMobileSurface } from './rightSidebarMobileProjection';

export type {
    RightSidebarAvailabilityInput,
    RightSidebarBuiltInTabId,
    RightSidebarBuiltinTabDefinition,
    RightSidebarTabDefinition,
    RightSidebarMobileSurface,
    RightSidebarPresentation,
    RightSidebarScope,
} from './rightSidebarBuiltinTabs';

export type ResolveRightSidebarTabsInput = Readonly<{
    scope: RightSidebarScope;
    terminalTabAvailable?: boolean;
    presentation?: RightSidebarPresentation;
    pluginPlacements?: readonly PluginUiSurfacePlacementProjection[];
    projectionGeneration?: number | null;
}>;

export type SessionRightSidebarTabId =
    | Extract<RightSidebarBuiltInTabId, 'git' | 'files' | 'navigation' | 'agents' | 'terminal' | 'browser' | 'services'>
    | `plugin:${string}`;

export type ProjectRightSidebarTabId =
    | Extract<RightSidebarBuiltInTabId, 'git' | 'files' | 'browser' | 'services'>
    | `plugin:${string}`;

export type { RightSidebarTabDefinitionFor };

export function getRightSidebarBuiltinTab(id: RightSidebarBuiltInTabId): RightSidebarBuiltinTabDefinition {
    const tab = RIGHT_SIDEBAR_BUILTIN_TABS.find((entry) => entry.id === id);
    if (!tab) {
        throw new Error(`Unknown right sidebar built-in tab: ${id}`);
    }
    return tab;
}

function isTabAvailable(
    tab: RightSidebarBuiltinTabDefinition,
    input: RightSidebarAvailabilityInput,
): boolean {
    if (!tab.scopes.includes(input.scope)) {
        return false;
    }
    return tab.available ? tab.available(input) : true;
}

export function resolveRightSidebarTabs(
    input: ResolveRightSidebarTabsInput,
): readonly RightSidebarTabDefinition[] {
    const availabilityInput: RightSidebarAvailabilityInput = {
        scope: input.scope,
        terminalTabAvailable: input.terminalTabAvailable === true,
        presentation: input.presentation ?? 'desktop',
    };
    const builtInTabs = RIGHT_SIDEBAR_BUILTIN_TABS
        .filter((tab) => isTabAvailable(tab, availabilityInput))
        .slice();
    const pluginTabs = resolveRightSidebarPluginTabs({
        scope: input.scope,
        placements: input.pluginPlacements,
        projectionGeneration: input.projectionGeneration,
    });
    return Object.freeze([...builtInTabs, ...pluginTabs]
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)));
}

export function resolveSessionRightSidebarTabs(
    input: Omit<ResolveRightSidebarTabsInput, 'scope'> = {},
): readonly RightSidebarTabDefinitionFor<SessionRightSidebarTabId>[] {
    return resolveRightSidebarTabs({
        ...input,
        scope: 'session',
    }) as readonly RightSidebarTabDefinitionFor<SessionRightSidebarTabId>[];
}

export function resolveProjectRightSidebarTabs(
    input: Omit<ResolveRightSidebarTabsInput, 'scope'> = {},
): readonly RightSidebarTabDefinitionFor<ProjectRightSidebarTabId>[] {
    return resolveRightSidebarTabs({
        ...input,
        scope: 'project',
    }) as readonly RightSidebarTabDefinitionFor<ProjectRightSidebarTabId>[];
}

export function resolveRightSidebarActiveTab<TTab extends string>(
    activeTabId: string | null | undefined,
    tabs: readonly RightSidebarTabDefinition[],
): TTab {
    const fallback = tabs.find((tab) => !tab.disabledReason)?.id;
    const selected = tabs.find((tab) => tab.id === activeTabId && !tab.disabledReason)?.id ?? fallback;
    if (!selected) {
        throw new Error('Right sidebar has no available tabs');
    }
    return selected as TTab;
}

export function resolveRightSidebarMobileSurface(
    tab: RightSidebarTabDefinition,
    scope: RightSidebarScope,
): RightSidebarMobileSurface | null {
    return resolveProjectedRightSidebarMobileSurface(tab, scope);
}
