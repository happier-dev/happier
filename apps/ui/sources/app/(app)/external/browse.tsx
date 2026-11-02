import * as React from 'react';
import { useLocalSearchParams, useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';

import { ExternalSessionsBrowseSurface } from '@/components/sessions/external/browse/ExternalSessionsBrowseModal';
import { ExternalSessionsBrowseRouteGate } from '@/components/sessions/external/browse/ExternalSessionsBrowseRouteGate';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { DAEMON_AGENT_CATALOG_SECTIONS } from '@/agents/backendCatalog/agentCatalogSections';
import {
    canBrowseExternalSessions,
    resolveExternalSessionBrowseLockedSource,
} from '@/components/sessions/external/browse/resolveExternalSessionBrowseLockedSourceOption';
import { useSettings } from '@/sync/domains/state/storage';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getConnectedMetadataCatalog } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';
import { useMachine, useProfile } from '@/sync/store/hooks';
import { readMachineName } from '@/utils/sessions/machineDisplayNames';
import { resolveBrowseProjectionFailureCopy } from '@/components/sessions/external/browse/browseProjectionFailureCopy';
import { resolveExternalSessionsAgentBrowseRouteScope } from '@/components/sessions/external/browse/externalSessionBrowseNavigation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

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
    const navigation = useNavigation();
    const settings = useSettings();
    const profile = useProfile();
    const routeScope = props.routeScope;
    const scoped = routeScope.kind !== 'unscoped';
    const resolvedScope = routeScope.kind === 'scoped' ? routeScope.scope : null;
    // Retry re-keys the projection read, the same way Browse's own retry does.
    const [projectionRefreshKey, setProjectionRefreshKey] = React.useState(0);
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: resolvedScope?.machineId ?? null,
        serverId: resolvedScope?.serverId ?? null,
        enabled: resolvedScope !== null,
        refreshKey: projectionRefreshKey,
        sections: DAEMON_AGENT_CATALOG_SECTIONS,
    });
    // The projection owner retains Account-scoped metadata while refreshing.
    // Keep Browse mounted so invalidation cannot discard its query and hits;
    // the screen still requires current daemon authority before opening a row.
    const projection = daemonMergedProjection.inputs?.pluginProjectionV2 ?? null;
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
            || !canBrowseExternalSessions({ agentId, projection, machineId })
        ) {
            return null;
        }
        const accountScope = getActiveServerAccountScope();
        const source = resolveExternalSessionBrowseLockedSource({
            accountScope,
            serverId: serverId ?? null,
            providerId: agentId,
            machineId,
            profile,
            agentSettings: settings,
            labelsByKey: getConnectedMetadataCatalog(accountScope).labelsByKey,
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

    const machine = useMachine(resolvedScope?.machineId ?? '', resolvedScope !== null);
    const retryProjection = React.useCallback(() => {
        setProjectionRefreshKey((current) => current + 1);
    }, []);

    if (scoped && !lockScope) {
        const loading = routeScope.kind === 'scoped'
            && daemonMergedProjection.phase === 'loading';
        // A projection that could not be read is a failure with a way forward, never "no integrations".
        const failedPhase = routeScope.kind === 'scoped'
            && (daemonMergedProjection.phase === 'error' || daemonMergedProjection.phase === 'unsupported')
            ? daemonMergedProjection.phase
            : null;
        if (failedPhase) {
            const copy = resolveBrowseProjectionFailureCopy({
                phase: failedPhase,
                failureReason: daemonMergedProjection.failureReason,
                machineName: readMachineName(machine),
            });
            return (
                <SurfaceStateCard
                    testID="external-sessions-browse-route-projection-failed"
                    kind={failedPhase === 'unsupported' ? 'unavailable' : 'error'}
                    iconName="link-break"
                    accessibilitySemantics="alert"
                    title={copy.title}
                    reason={copy.reason}
                    diagnosticCode={copy.diagnosticCode}
                    action={{ label: t('common.retry'), onPress: retryProjection }}
                    secondaryAction={{
                        label: t('common.close'),
                        onPress: () => router.back(),
                    }}
                />
            );
        }
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
    // Closing leaves the route even when it was the first entry (a deep link): back, else home.
    return (
        <ExternalSessionsBrowseSurface
            lockScope={lockScope}
            onRequestClose={() => safeRouterBack({ router, navigation, fallbackHref: '/' })}
        />
    );
});

export const WorkspaceRouteBody = React.memo(function ExternalSessionsBrowseRoute() {
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

export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
