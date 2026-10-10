import * as React from 'react';

import type { PaneSurfaceScope } from '@/components/appShell/panes/types';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { useSessionServerId } from '@/sync/store/hooks';

export type SessionPaneSurfaceScope = Extract<PaneSurfaceScope, Readonly<{ targetKind: 'session' }>>;

export type SessionPluginRuntimeState = PluginUiProjectionCurrentness;

/**
 * Admit a registered AppPane scope for one exact Home-qualified Session.
 *
 * A Session id is only Home-local: two Homes can hold the same id, so matching
 * it alone would let a retained pane snapshot from another Home supply this
 * Session's machine, projection and interaction facts. A scope that names a
 * different Home — or carries no Home at all — is unavailable, never permission
 * to fall back to a second target.
 */
export function admitSessionPaneSurfaceScopeForAddress(
    address: SessionAddress | null,
    scope: SessionPaneSurfaceScope | undefined,
): SessionPaneSurfaceScope | null {
    if (!address || scope?.targetKind !== 'session') return null;
    return scope.sessionId === address.sessionId && scope.serverId === address.serverId
        ? scope
        : null;
}

/**
 * The one exact-Session plugin runtime lookup, shared by every Session host:
 * registered AppPanes, the Session info route, Agent inline surfaces and Board
 * widgets. It is placement-neutral on purpose — a second copy of this
 * resolution is how the pane and Agent paths previously drifted apart under
 * handoff and multi-Home routing.
 *
 * Driver-rendered panes consume their exact registered scope; direct callers
 * omit it and resolve the requested `SessionAddress`. A supplied stale or wrong
 * scope is unavailable, never permission to reconstruct a competing target, and
 * a qualified caller never falls back to the focused Home.
 */
export function useSessionPluginRuntime(params: Readonly<{
    /** `null` when the Session is not Home-qualifiable yet: no plugin runtime. */
    address: SessionAddress | null;
    paneSurfaceScope?: SessionPaneSurfaceScope;
    pluginUiProjection?: PluginUiProjectionModel | null;
    platform?: LocalServicePreviewPlatform;
}>): SessionPluginRuntimeState {
    const machineTarget = useSessionMachineTarget(params.address);
    const hasRegisteredPaneScope = params.paneSurfaceScope !== undefined;
    const registeredPaneScope = admitSessionPaneSurfaceScopeForAddress(
        params.address,
        params.paneSurfaceScope,
    );
    const directMachineId = params.address ? machineTarget?.machineId ?? null : null;
    const directServerId = params.address?.serverId ?? null;
    // Keep the direct-route hooks unconditional. Once AppPane passes a scope,
    // disable their projection path entirely: its target is null, so the
    // currentness owner cannot subscribe, describe, or settle a second local
    // snapshot. Every registered-pane fact below instead comes from the exact
    // driver snapshot AppPane admitted.
    const scopedProjection = useScopedPluginUiProjection(hasRegisteredPaneScope
        ? { machineId: null, serverId: null, enabled: false }
        : { machineId: directMachineId, serverId: directServerId });
    const machineId = hasRegisteredPaneScope
        ? registeredPaneScope?.machineId ?? null
        : directMachineId;
    const serverId = hasRegisteredPaneScope
        ? registeredPaneScope?.serverId ?? null
        : directServerId;
    const explicitProjectionProvided = params.pluginUiProjection !== undefined;
    const pluginUiProjection = hasRegisteredPaneScope
        ? registeredPaneScope?.pluginUiProjection ?? null
        : explicitProjectionProvided
            ? params.pluginUiProjection ?? null
            : scopedProjection.pluginUiProjection;
    const interactionEnabled = hasRegisteredPaneScope
        ? registeredPaneScope?.interactionEnabled === true
        : scopedProjection.interactionEnabled;
    const phase = hasRegisteredPaneScope
        ? registeredPaneScope?.projectionPhase ?? 'unavailable'
        : scopedProjection.phase;
    const pluginBrowserProjection = hasRegisteredPaneScope
        ? registeredPaneScope?.pluginBrowserProjection ?? null
        : scopedProjection.pluginBrowserProjection;
    const accountLifetime = hasRegisteredPaneScope
        ? registeredPaneScope?.accountLifetime ?? null
        : scopedProjection.accountLifetime ?? null;
    const platform = resolveLocalServicePreviewPlatform(
        hasRegisteredPaneScope ? registeredPaneScope?.platform : params.platform,
    );

    return React.useMemo(() => ({
        pluginUiProjection,
        pluginBrowserProjection,
        phase,
        interactionEnabled,
        machineId,
        serverId,
        platform,
        accountLifetime,
    }), [
        interactionEnabled,
        machineId,
        phase,
        platform,
        pluginUiProjection,
        pluginBrowserProjection,
        serverId,
        accountLifetime,
    ]);
}

/**
 * Qualify a Home-local Session id once, at a caller's entry boundary, through
 * the canonical Session server owner. This deliberately does not consult the
 * active/preferred Home: an unqualifiable Session has no plugin runtime, and
 * silently borrowing the focused Home's projection is the exact routing bug
 * this consolidation removes.
 */
export function useSessionAddressForSessionId(
    sessionId: string,
    explicitServerId?: string | null,
): SessionAddress | null {
    const discoveredServerId = useSessionServerId(sessionId, explicitServerId == null);
    const serverId = explicitServerId ?? discoveredServerId;
    return React.useMemo(
        () => normalizeSessionAddress(serverId, sessionId),
        [serverId, sessionId],
    );
}

/** Project the shell-owned runtime into the exact facts its pane driver and chrome consume. */
export function createSessionPaneSurfaceScope(sessionId: string, runtime: SessionPluginRuntimeState): SessionPaneSurfaceScope {
    return {
        targetKind: 'session', sessionId,
        machineId: runtime.machineId, serverId: runtime.serverId,
        pluginUiProjection: runtime.pluginUiProjection,
        pluginBrowserProjection: runtime.pluginBrowserProjection,
        accountLifetime: runtime.accountLifetime,
        projectionPhase: runtime.phase, interactionEnabled: runtime.interactionEnabled,
        platform: runtime.platform,
    };
}
