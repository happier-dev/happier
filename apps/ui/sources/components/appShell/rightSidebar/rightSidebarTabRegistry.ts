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
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { PluginUiProjectionPhase } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import type { SelectedPaneDestinationV1 } from '@/components/appShell/panes/model/selectedPaneDestination';
import {
    resolveRightSidebarPluginTabs,
    type RightSidebarPluginTabRuntimeAdmission,
} from './rightSidebarPluginTabs';
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
    runtimeAdmission?: RightSidebarPluginTabRuntimeAdmission;
    localize?: PluginLocalizedTextResolver;
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
        ...(input.localize ? { localize: input.localize } : {}),
        ...(input.runtimeAdmission === undefined ? {} : { runtimeAdmission: input.runtimeAdmission }),
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

export type RightSidebarTabSelection<TTab extends string = string> =
    | Readonly<{ kind: 'available'; tab: RightSidebarTabDefinitionFor<TTab> }>
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'unresolved'; tabId: string }>
    | Readonly<{ kind: 'unavailable'; tabId: string; reason: string }>;

/**
 * Resolve the persisted right-sidebar selection without silently replacing a
 * plugin destination while its projection is still loading. A bare built-in
 * selection may use the host default; a qualified plugin selection either
 * mounts exactly, waits for current projection facts, or stays an explicit
 * tombstone. Callers must not write the returned fallback back to persistence.
 */
export function resolveRightSidebarTabSelection<TTab extends string>(input: Readonly<{
    activeTabId: string | null | undefined;
    selectedDestination?: SelectedPaneDestinationV1 | null;
    tabs: readonly RightSidebarTabDefinition[];
    projectionPhase: PluginUiProjectionPhase;
    scope?: RightSidebarScope;
}>): RightSidebarTabSelection<TTab> {
    const activeTabId = input.activeTabId ?? null;
    if (input.scope === 'app' && activeTabId === null && input.selectedDestination == null) {
        return { kind: 'none' };
    }
    const selectedPluginDestination = input.selectedDestination?.kind === 'plugin'
        ? input.selectedDestination.destination
        : null;
    const selectedIsPlugin = selectedPluginDestination !== null || activeTabId?.startsWith('plugin:') === true;
    const selected = selectedPluginDestination
        ? input.tabs.find((tab) => (
            tab.owner === 'plugin'
            && tab.placement.binding.destination.pluginId === selectedPluginDestination.pluginId
            && tab.placement.binding.destination.localId === selectedPluginDestination.localId
        )) ?? null
        : activeTabId
            ? input.tabs.find((tab) => tab.id === activeTabId) ?? null
            : null;
    // An app union may still be establishing another machine while this exact
    // selected tab has a published current origin. The union producer stamps
    // that fact on the entry; consume it here instead of inventing another
    // currentness decision or blanking a known-current destination.
    const selectedProjectionPhase = selected?.owner === 'plugin'
        ? readPluginUiContributionOrigin(selected.placement)?.phase ?? input.projectionPhase
        : input.projectionPhase;

    if (selectedIsPlugin && selectedProjectionPhase === 'establishing') {
        return {
            kind: 'unresolved',
            tabId: activeTabId
                ?? (selectedPluginDestination
                    ? `plugin:${selectedPluginDestination.pluginId}:${selectedPluginDestination.localId}`
            : ''),
        };
    }
    if (
        selectedIsPlugin
        && selectedProjectionPhase !== 'current'
        && selectedProjectionPhase !== 'retainedOffline'
    ) {
        return {
            kind: 'unavailable',
            tabId: activeTabId
                ?? (selectedPluginDestination
                    ? `plugin:${selectedPluginDestination.pluginId}:${selectedPluginDestination.localId}`
                    : ''),
            reason: 'plugin_destination_unavailable',
        };
    }

    if (selected && !selected.disabledReason) {
        return { kind: 'available', tab: selected as RightSidebarTabDefinitionFor<TTab> };
    }
    if (selected && selected.disabledReason) {
        return {
            kind: 'unavailable',
            tabId: selected.id,
            reason: selected.disabledReason,
        };
    }
    if (selectedIsPlugin) {
        return {
            kind: 'unavailable',
            tabId: activeTabId
                ?? (selectedPluginDestination
                    ? `plugin:${selectedPluginDestination.pluginId}:${selectedPluginDestination.localId}`
                    : ''),
            reason: 'plugin_destination_unavailable',
        };
    }

    const fallback = input.tabs.find((tab) => !tab.disabledReason) ?? null;
    if (fallback) {
        return { kind: 'available', tab: fallback as RightSidebarTabDefinitionFor<TTab> };
    }
    return {
        kind: 'unavailable',
        tabId: activeTabId ?? '',
        reason: 'right_sidebar_destination_unavailable',
    };
}

export function resolveRightSidebarActiveTab<TTab extends string>(
    activeTabId: string | null | undefined,
    tabs: readonly RightSidebarTabDefinition[],
): TTab {
    const resolved = resolveRightSidebarTabSelection<TTab>({
        activeTabId,
        tabs,
        projectionPhase: 'current',
    });
    if (resolved.kind === 'available') {
        return resolved.tab.id;
    }

    // This compatibility helper predates the persisted-selection result. Its
    // callers only need an in-memory display default, while the panels above
    // retain a selected plugin tombstone through `resolveRightSidebarTabSelection`.
    const fallback = tabs.find((tab) => !tab.disabledReason);
    if (!fallback) {
        throw new Error('Right sidebar has no available tabs');
    }
    return fallback.id as TTab;
}

export function resolveRightSidebarMobileSurface(
    tab: RightSidebarTabDefinition,
    scope: RightSidebarScope,
): RightSidebarMobileSurface | null {
    return resolveProjectedRightSidebarMobileSurface(tab, scope);
}
