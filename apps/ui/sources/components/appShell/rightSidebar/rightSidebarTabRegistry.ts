import { t } from '@/text';
import { resolveDetailNavigationItems, type DetailNavigationItem } from './detailNavigationItems';
export { resolveDetailNavigationItems, resolveDetailNavigationProjection, type DetailNavigationItem } from './detailNavigationItems';
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
import type { RightSidebarPluginTabRuntimeAdmission } from './rightSidebarPluginTabs';
import { resolveRightSidebarMobileSurface as resolveProjectedRightSidebarMobileSurface } from './rightSidebarMobileProjection';
import type { ProjectPageV1 } from '@/components/projects/detail/projectRouteState';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';

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
    arrangement?: 'session' | 'editor';
    computerAvailable?: boolean;
    computerDisabledReason?: string;
    /** Suppresses only the matching Project launcher; the selection catalog is retained. */
    activePage?: ProjectPageV1;
    terminalTabAvailable?: boolean;
    /** The exact Home's `sessions.board` decision; omitted means disabled. */
    boardFeatureEnabled?: boolean;
    /** The exact Home's Browser decision; omitted means disabled. */
    browserFeatureEnabled?: boolean;
    sessionSharingAvailable?: boolean;
    /** Omitted means available; see `RightSidebarAvailabilityInput.sourceControlTabAvailable`. */
    sourceControlTabAvailable?: boolean;
    /** Omitted means unavailable; see `RightSidebarAvailabilityInput.sessionProjectCheckoutAvailable`. */
    sessionProjectCheckoutAvailable?: boolean;
    /** A File page of this pane registered its language features (P7 Problems / References). */
    codeIntelligenceAvailable?: boolean;
    presentation?: RightSidebarPresentation;
    pluginPlacements?: readonly PluginUiSurfacePlacementProjection[];
    policyContext?: PluginUiPolicyEvaluationContext;
    runtimeAdmission?: RightSidebarPluginTabRuntimeAdmission;
    localize?: PluginLocalizedTextResolver;
    /**
     * The App's own panels (`rightSidebarTab × app`) from the app-shell projection. A Session's or
     * Project's right sidebar lists them after its own tabs (design §3.3); the App's own sidebar
     * already has them as its plugin placements.
     */
    appPluginPlacements?: readonly PluginUiSurfacePlacementProjection[];
    appLocalize?: PluginLocalizedTextResolver;
}>;

export type SessionRightSidebarTabId =
    | Extract<RightSidebarBuiltInTabId, 'chat' | 'tabs' | 'companion' | 'review' | 'computer' | 'info' | 'git' | 'files' | 'problems' | 'references' | 'scripts' | 'navigation' | 'agents' | 'collaboration' | 'skills' | 'board' | 'terminal' | 'browser' | 'services'>
    | `plugin:${string}`;

export type ProjectRightSidebarTabId =
    | Extract<RightSidebarBuiltInTabId, 'git' | 'files' | 'problems' | 'references' | 'scripts' | 'widgets' | 'terminal' | 'browser' | 'services'>
    | `plugin:${string}`;

export type { RightSidebarTabDefinitionFor };

export type RightSidebarTabPlacementContext = Readonly<{
    scope: RightSidebarScope;
    arrangement: 'session' | 'editor';
    presentation?: RightSidebarPresentation;
}>;

/** The existing session group follows its composer in Editor first; selection remains pane-owned. */
export function resolveRightSidebarTabPlacement(
    tab: RightSidebarTabDefinition,
    _context: RightSidebarTabPlacementContext,
): 'main' | 'side' {
    return tab.navigation?.kind === 'both' ? 'main' : 'side';
}

export function getRightSidebarBuiltinTab(id: RightSidebarBuiltInTabId): RightSidebarBuiltinTabDefinition {
    const tab = RIGHT_SIDEBAR_BUILTIN_TABS.find((entry) => entry.id === id);
    if (!tab) {
        throw new Error(`Unknown right sidebar built-in tab: ${id}`);
    }
    return tab;
}

/** Delegating compatibility entry for App, Project and Discussion while their units migrate. */
export function resolveRightSidebarTabs(input: ResolveRightSidebarTabsInput): readonly DetailNavigationItem[] {
    return resolveDetailNavigationItems(input);
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
    hasEstablishingMembers?: boolean;
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

    if (selectedIsPlugin && (selectedProjectionPhase === 'establishing'
        || (!selected && input.hasEstablishingMembers))) {
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

    // Catalog presentation order is independent of the incumbent initial content selection.
    const fallback = input.tabs.find(tab => tab.id === 'git' && !tab.disabledReason)
        ?? input.tabs.find((tab) => !tab.disabledReason) ?? null;
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
    const fallback = resolveRightSidebarTabSelection<TTab>({ activeTabId: null, tabs, projectionPhase: 'current' });
    if (fallback.kind !== 'available') {
        throw new Error('Right sidebar has no available tabs');
    }
    return fallback.tab.id;
}

export function resolveRightSidebarMobileSurface(
    tab: RightSidebarTabDefinition,
    scope: RightSidebarScope,
): RightSidebarMobileSurface | null {
    return resolveProjectedRightSidebarMobileSurface(tab, scope);
}

export function getRightSidebarTabLabel(tab: RightSidebarTabDefinition): string {
    return tab.owner === 'builtin' ? t(tab.labelKey) : tab.label;
}
