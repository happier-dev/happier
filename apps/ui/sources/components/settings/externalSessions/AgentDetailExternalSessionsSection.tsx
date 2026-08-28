import * as React from 'react';
import { useRouter } from 'expo-router';

import { resolveAgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import { buildExternalSessionsAgentBrowseHref } from '@/components/sessions/external/browse/externalSessionBrowseNavigation';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSetting } from '@/sync/domains/state/storage';

import { ExternalSessionsAgentSettingsSection } from './ExternalSessionsAgentSettingsSection';
import { useExternalSessionsIntegrationController } from './externalSessionsIntegrationController';
import { useExternalSessionsAutoLinkSources } from './useExternalSessionsAutoLinkSources';
import type { ExternalSessionsQualifiedAgent } from './externalSessionsIntegrationModel';

/**
 * The Agent-detail half of External Sessions: one controller, one auto-link
 * source read, one inventory state and one section, for whichever Agent detail
 * screen is rendering.
 *
 * Reachability is a property of the AGENT — Protocol admits an auxiliary-only
 * Agent that declares the `externalSessions` surface with no runtime and no
 * auth UI — so this composition must not be nested inside the branch that
 * decides whether the Agent also has a bundled runtime carrier or a login
 * screen. It owns nothing the global hub does not: the same controller, model,
 * actions and writer path, filtered to this Agent and the selected machine.
 */
export const AgentDetailExternalSessionsSection = React.memo(function AgentDetailExternalSessionsSection(
    props: Readonly<{
        /** The route's resolved Agent projection id, used for the Browse href. */
        agentId: string;
        /** The Agent id whose UI behavior declares the External Sessions surface. */
        behaviorAgentId: string;
        agentTitle: string;
        machineId: string | null;
        daemonStateVersion: number | null;
        serverId: string | null;
        agent: ExternalSessionsQualifiedAgent | null;
        browseAvailable: boolean;
        refreshKey: string | null;
        /** The selected machine's daemon projection phase. */
        projectionPhase: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';
    }>,
) {
    const router = useRouter();
    const rawExternalSessionsSettings = useSetting('externalSessionsSettingsV1');
    const enabled = useFeatureEnabled('sessions.direct');
    const { agentId, behaviorAgentId, agentTitle, machineId, serverId, agent, browseAvailable } = props;

    // This screen is scoped to ONE execution target and compares against that
    // machine's daemon projection, so the declaration it compares with has to
    // come from the same machine. An installed Agent held at different versions
    // on two machines otherwise borrows whichever machine sorts first and turns
    // a machine that legitimately contributes no External Sessions Agent into a
    // false unavailable/unsupported banner.
    const expected = React.useMemo(
        () => resolveAgentUiBehavior(behaviorAgentId, machineId).externalSessions !== undefined,
        [behaviorAgentId, machineId],
    );

    const controllerAgent = React.useMemo(() => (
        agent ? { agent, agentTitle } : null
    ), [agent, agentTitle]);

    const controller = useExternalSessionsIntegrationController({
        machineId,
        serverId,
        projectionGeneration: `${props.refreshKey ?? ''}:${props.daemonStateVersion ?? 0}`,
        agent: controllerAgent,
        enabled: enabled && agent !== null && machineId !== null,
    });

    const inventoryState = React.useMemo(() => {
        if (!enabled || !machineId || agent || !expected) {
            return controller.inventoryState;
        }
        if (props.projectionPhase === 'loading') {
            return {
                status: 'loading' as const,
                diagnosticCodes: [],
            };
        }
        return {
            status: 'error' as const,
            diagnosticCodes: [
                props.projectionPhase === 'unsupported'
                    ? 'external_sessions_projection_unsupported'
                    : 'external_sessions_projection_unavailable',
            ],
        };
    }, [agent, controller.inventoryState, enabled, expected, machineId, props.projectionPhase]);

    const autoLinkKnownAgents = React.useMemo(
        () => controllerAgent ? [controllerAgent] : [],
        [controllerAgent],
    );
    const autoLinkSources = useExternalSessionsAutoLinkSources({
        rawSettings: rawExternalSessionsSettings,
        knownAgents: autoLinkKnownAgents,
        enabled: machineId !== null && agent !== null,
        ...(machineId && agent ? { scope: { machineId, agent } } : {}),
    });

    if (!enabled) return null;

    return (
        <ExternalSessionsAgentSettingsSection
            machineId={machineId}
            agent={agent}
            agentTitle={agentTitle}
            integrations={controller.integrations}
            autoLinkSources={autoLinkSources}
            operations={controller.operations}
            inventoryState={inventoryState}
            onRetryInventory={agent ? controller.retryInventory : null}
            hasMoreInventory={controller.hasMoreInventory}
            loadingMoreInventory={controller.loadingMoreInventory}
            onLoadMoreInventory={controller.loadMoreInventory}
            onBrowse={
                machineId && agent && browseAvailable
                    ? () => {
                        router.push(buildExternalSessionsAgentBrowseHref({
                            machineId,
                            serverId,
                            agentId,
                            agent,
                        }));
                    }
                    : null
            }
            onManageAll={() => {
                router.push({
                    pathname: '/settings/external-sessions',
                    params: { machineId: machineId ?? '' },
                });
            }}
        />
    );
});
