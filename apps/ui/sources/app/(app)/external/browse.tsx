import * as React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { ExternalSessionsBrowseScreen } from '@/components/sessions/external/browse/ExternalSessionsBrowseScreen';
import { ExternalSessionsBrowseRouteGate } from '@/components/sessions/external/browse/ExternalSessionsBrowseRouteGate';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import {
    canBrowseExternalSessions,
    resolveExternalSessionBrowseLockedSource,
} from '@/components/sessions/external/browse/resolveExternalSessionBrowseLockedSourceOption';
import { useSettings } from '@/sync/domains/state/storage';
import { useProfile } from '@/sync/store/hooks';
import { resolveExternalSessionsAgentBrowseRouteScope } from '@/components/sessions/external/browse/externalSessionBrowseNavigation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

type ExternalSessionsBrowseRouteParams = Readonly<{
    machineId?: string | string[];
    serverId?: string | string[];
    agentId?: string | string[];
    agentPluginId?: string | string[];
    agentLocalId?: string | string[];
}>;

type ExternalSessionsBrowseRouteScope = ReturnType<typeof resolveExternalSessionsAgentBrowseRouteScope>;

const ExternalSessionsBrowseRouteContent = React.memo(function ExternalSessionsBrowseRouteContent(props: Readonly<{
    routeScope: ExternalSessionsBrowseRouteScope;
}>) {
    const router = useRouter();
    const settings = useSettings();
    const profile = useProfile();
    const routeScope = props.routeScope;
    const scoped = routeScope.kind !== 'unscoped';
    const resolvedScope = routeScope.kind === 'scoped' ? routeScope.scope : null;
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: resolvedScope?.machineId ?? null,
        serverId: resolvedScope?.serverId ?? null,
        enabled: resolvedScope !== null,
    });
    const projection = daemonMergedProjection.phase === 'ready'
        ? daemonMergedProjection.inputs?.pluginProjectionV2
        : null;
    const lockScope = React.useMemo(() => {
        if (!resolvedScope || !projection) {
            return null;
        }
        const { agentId, agent, machineId, serverId } = resolvedScope;
        const projectedExternalSessions = projection.agentsById[agentId]?.externalSessions;
        if (
            !projectedExternalSessions
            || projectedExternalSessions.generation !== projection.generation
            || projectedExternalSessions.agent.pluginId !== agent.pluginId
            || projectedExternalSessions.agent.localId !== agent.localId
            || !canBrowseExternalSessions({ agentId, projection })
        ) {
            return null;
        }
        const source = resolveExternalSessionBrowseLockedSource({
            providerId: agentId,
            profile,
            settings,
            projection,
        });
        if (!source) return null;
        return {
            machineId,
            serverId,
            providerId: agentId,
            source,
        };
    }, [
        profile,
        projection,
        resolvedScope,
        settings,
    ]);

    if (scoped && !lockScope) {
        const loading = routeScope.kind === 'scoped'
            && daemonMergedProjection.phase === 'loading';
        return (
            <SurfaceStateCard
                testID={loading
                    ? 'external-sessions-browse-route-loading'
                    : 'external-sessions-browse-route-unavailable'}
                kind={loading ? 'loading' : 'unavailable'}
                accessibilitySemantics={loading ? 'status' : 'alert'}
                title={loading
                    ? t('common.loading')
                    : t('externalSessions.settingsIntegrationsUnavailableTitle')}
                reason={loading
                    ? t('externalSessions.settingsIntegrationInventoryLoadingSubtitle')
                    : t('externalSessions.settingsIntegrationsUnavailableSubtitle')}
                {...(loading
                    ? {
                        secondaryAction: {
                            label: t('common.close'),
                            onPress: () => router.back(),
                        },
                    }
                    : {
                        action: {
                            label: t('common.close'),
                            onPress: () => router.back(),
                        },
                    })}
            />
        );
    }
    return (
        <ExternalSessionsBrowseScreen
            lockScope={lockScope}
            onRequestClose={() => router.back()}
        />
    );
});

export default React.memo(function ExternalSessionsBrowseRoute() {
    const params = useLocalSearchParams<ExternalSessionsBrowseRouteParams>();
    const routeScope = React.useMemo(
        () => resolveExternalSessionsAgentBrowseRouteScope(params),
        [
            params.agentId,
            params.agentLocalId,
            params.agentPluginId,
            params.machineId,
            params.serverId,
        ],
    );
    const featureScope = React.useMemo(
        () => routeScope.kind === 'scoped'
            ? { scopeKind: 'spawn' as const, serverId: routeScope.scope.serverId }
            : undefined,
        [routeScope],
    );

    return (
        <ExternalSessionsBrowseRouteGate scope={featureScope}>
            <ExternalSessionsBrowseRouteContent routeScope={routeScope} />
        </ExternalSessionsBrowseRouteGate>
    );
});
