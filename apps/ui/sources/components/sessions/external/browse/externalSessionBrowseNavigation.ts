type RouteParam = string | string[] | undefined;

export type ExternalSessionsAgentBrowseRouteScope = Readonly<{
    machineId: string;
    serverId?: string | null;
    agentId: string;
    agent: Readonly<{
        pluginId: string;
        localId: string;
    }>;
}>;

export type ExternalSessionsAgentBrowseRouteScopeResolution =
    | Readonly<{ kind: 'unscoped' }>
    | Readonly<{ kind: 'invalid' }>
    | Readonly<{ kind: 'scoped'; scope: ExternalSessionsAgentBrowseRouteScope }>;

function readRouteParam(value: RouteParam): string | null {
    const candidate = Array.isArray(value) ? value[0] : value;
    if (typeof candidate !== 'string') return null;
    const normalized = candidate.trim();
    return normalized.length > 0 ? normalized : null;
}

export function buildExternalSessionsAgentBrowseHref(
    scope: ExternalSessionsAgentBrowseRouteScope,
) {
    return {
        pathname: '/external/browse' as const,
        params: {
            machineId: scope.machineId,
            ...(scope.serverId ? { serverId: scope.serverId } : {}),
            agentId: scope.agentId,
            agentPluginId: scope.agent.pluginId,
            agentLocalId: scope.agent.localId,
        },
    };
}

export function resolveExternalSessionsAgentBrowseRouteScope(
    params: Readonly<{
        machineId?: RouteParam;
        serverId?: RouteParam;
        agentId?: RouteParam;
        agentPluginId?: RouteParam;
        agentLocalId?: RouteParam;
    }>,
): ExternalSessionsAgentBrowseRouteScopeResolution {
    const machineId = readRouteParam(params.machineId);
    const serverId = readRouteParam(params.serverId);
    const agentId = readRouteParam(params.agentId);
    const agentPluginId = readRouteParam(params.agentPluginId);
    const agentLocalId = readRouteParam(params.agentLocalId);
    if (!machineId && !serverId && !agentId && !agentPluginId && !agentLocalId) {
        return { kind: 'unscoped' };
    }
    if (!machineId || !agentId || !agentPluginId || !agentLocalId) {
        return { kind: 'invalid' };
    }
    return {
        kind: 'scoped',
        scope: {
            machineId,
            serverId,
            agentId,
            agent: {
                pluginId: agentPluginId,
                localId: agentLocalId,
            },
        },
    };
}
