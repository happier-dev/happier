import type * as React from 'react';
import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/targets';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiProjectionPhase } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';

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
        projectionPhase: PluginUiProjectionPhase;
        machineId?: string | null;
        serverId?: string | null;
        platform?: LocalServicePreviewPlatform;
        interactionEnabled?: boolean;
    }>
    | Readonly<{
        targetKind: 'project';
        projectId: string;
        pluginUiProjection?: PluginUiProjectionModel | null;
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
    render: (context: Readonly<{ scopeId: PaneScopeId }>) => React.ReactNode;
}>;

export type PaneResource =
    | Readonly<{ kind: 'file'; path: string }>
    | Readonly<{ kind: 'commit'; commitHash: string }>
    | Readonly<{ kind: 'diff'; path: string; baseRef?: string | null }>
    | Readonly<{ kind: string; [key: string]: unknown }>;

export type PaneDriver = Readonly<{
    scopeId: PaneScopeId;
    /** The registered scope owns exact target/projection facts for plugin panes. */
    surfaceScope?: PaneSurfaceScope;
    rightPaneBuiltinAdapter?: PaneBuiltinAdapter;
    rightSidebarAdapter?: PaneRightSidebarAdapter;
    detailsPaneBuiltinAdapter?: PaneBuiltinAdapter;
    bottomPaneBuiltinAdapter?: PaneBuiltinAdapter;
    openResource?: (resource: PaneResource) => void;
    onScopeDeactivated?: () => void;
}>;
