import type * as React from 'react';
import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/targets';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiProjectionPhase } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { WorkspaceFileOpenInput } from '@happier-dev/protocol/actions/workspaceActionFamily';
import type { PluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import type { PluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import type { SelectedPaneDestinationV1 } from './model/selectedPaneDestination';
import type { ProjectWidgetAreaContextV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';

export type PaneId = 'right' | 'details' | 'bottom';

export type PaneScopeId = string;

/**
 * The exact target and projection facts for one active AppPane scope. The pane
 * scope id is intentionally opaque: Session and Project identities arrive from
 * their registered scope adapter rather than being reconstructed from that id
 * or copied into persisted pane selection.
 */
export type PaneSurfaceScope =
    | Readonly<{
        targetKind: 'session';
        sessionId: string;
        agentId?: string | null;
        pluginUiProjection?: PluginUiProjectionModel | null;
        pluginBrowserProjection?: PluginBrowserProjectionModel | null;
        accountLifetime?: ServerAccountScopeLifetime | null;
        projectionPhase: PluginUiProjectionPhase;
        machineId?: string | null;
        serverId?: string | null;
        platform?: LocalServicePreviewPlatform;
        interactionEnabled?: boolean;
    }>
    | Readonly<{
        targetKind: 'project';
        /** Exact accepted checkout address for checkout-scoped resources, when selected. */
        projectId?: string | null;
        projectContext?: ProjectWidgetAreaContextV1 | null;
        policyContext?: PluginUiPolicyEvaluationContext;
        pluginUiProjection?: PluginUiProjectionModel | null;
        accountLifetime?: ServerAccountScopeLifetime | null;
        projectionPhase: PluginUiProjectionPhase;
        machineId?: string | null;
        serverId?: string | null;
        platform?: LocalServicePreviewPlatform;
        interactionEnabled?: boolean;
    }>;

/**
 * A host-owned built-in pane adapter. It participates in the same selected
 * destination arbitration as a plugin binding: an unknown built-in id is not
 * permission to render a different incumbent pane.
 */
export type PaneBuiltinAdapter = Readonly<{
    destinationIds: readonly string[];
    /** Used only when this slot has no saved selection. */
    defaultDestinationId?: string;
    render: (context: Readonly<{
        scopeId: PaneScopeId;
        destinationId: string;
    }>) => React.ReactNode;
}>;

/**
 * The incumbent right-sidebar shell is a container adapter, not a fallback
 * pane node. It owns its own host tab rail and accepts only a destination the
 * selected-destination resolver has already proved belongs to `rightSidebarTab`.
 */
export type PaneRightSidebarAdapter = Readonly<{
    /** The catalog owner may retain its selected pane while offering no tab to open. */
    available?: boolean;
    /** Command-time admission of an App panel selection; never execution authority or persisted state. */
    readContinuingDestination?: (selection: SelectedPaneDestinationV1) => PluginUiDestinationBindingV1 | null;
    renderActionRail?: (context: Readonly<{ scopeId: PaneScopeId }>) => React.ReactNode;
    render: (context: Readonly<{ scopeId: PaneScopeId }>) => React.ReactNode;
}>;

export type PaneResource =
    | Readonly<{ kind: 'file' } & Omit<WorkspaceFileOpenInput, 'target'>>
    | Readonly<{ kind: 'commit'; commitHash: string }>
    | Readonly<{ kind: 'diff'; path: string; baseRef?: string | null }>;

export type PaneDriver = Readonly<{
    scopeId: PaneScopeId;
    /** Reveal the reducer's accepted terminal selection on the mounted surface, if needed. */
    onTerminalWorkspaceReveal?: (selection: Readonly<{ tabId: string; terminalId: string }>) => void;
    /** The registered scope owns exact target/projection facts for plugin panes. */
    surfaceScope?: PaneSurfaceScope;
    /** Borrowed current host binding; the pane host remains its sole producer. */
    resourceNavigation?: PluginSurfaceDestinationNavigationBinding | null;
    rightPaneBuiltinAdapter?: PaneBuiltinAdapter;
    rightSidebarAdapter?: PaneRightSidebarAdapter;
    detailsPaneBuiltinAdapter?: PaneBuiltinAdapter;
    /** False where an enclosing presenter shows Details itself (the phone cockpit's File scene). */
    detailsPaneEnabled?: boolean;
    bottomPaneBuiltinAdapter?: PaneBuiltinAdapter;
    openResource?: (resource: PaneResource, options?: Readonly<{ intent?: 'preview' | 'pinned'; present?: boolean }>) => boolean;
    onScopeDeactivated?: () => void;
}>;
