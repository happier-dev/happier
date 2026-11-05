import * as React from 'react';
import type { AtmospherePlace } from '@happier-dev/protocol/account/settings/accountSettings';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { useProjectAccountWorkspaceRef } from '@/sync/domains/workspaces/projectAccountRows';
import type { AtmosphereProject, AtmosphereSurface } from './resolveAtmosphere';

export type AtmosphereRouteContext =
    | Readonly<{ place: AtmospherePlace; project?: AtmosphereProject }>
    | Readonly<{ place: 'sessions' | 'pages'; session: Readonly<{ serverId: string; sessionId: string }> }>
    | Readonly<{ place: 'projects' | 'pages'; workspace: Readonly<{ serverId: string; workspaceRefId: string }> }>;

/**
 * The destination owner supplies its place and qualified route operands. A Project route's
 * workspaceRefId selects its admitted checkout, exactly as ProjectDetailScreen does; paths and
 * display titles are never membership evidence. Session association is read by useAtmosphere.
 */
export function useAtmosphereRouteSurface(context: AtmosphereRouteContext): AtmosphereSurface {
    const workspace = 'workspace' in context ? context.workspace : undefined;
    const ref = useProjectAccountWorkspaceRef(workspace?.workspaceRefId ?? null, workspace?.serverId);
    const project = 'project' in context ? context.project : ref ? projectWorkspaceRefV1(ref) : undefined;
    const session = 'session' in context ? context.session : undefined;
    return React.useMemo<AtmosphereSurface>(() => project ? { place: context.place, project }
        : session ? { place: context.place as 'sessions' | 'pages', session } : context.place,
        [context.place, project?.serverId, project?.projectKey, session?.serverId, session?.sessionId]);
}
