import * as React from 'react';
import { createDeploymentReadControllerV1, type DeploymentReadControllerV1, type DeploymentReadDemandV1, type DeploymentCollectionQueryV1 } from '@happier-dev/deployments';
import { readDeploymentAccountChangeV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { isAccountCurrentnessEntityIdV1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { readServerAccountScopeOwnerLifetime, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { createDeploymentReadTransport } from './deploymentReadTransport';
import { useDeploymentCollection } from './useDeploymentReads';

type ProjectOwner = Readonly<{
    controller: DeploymentReadControllerV1;
}>;
const projects = new WeakMap<ServerAccountScopeLifetime, Map<string | undefined, ProjectOwner>>();

function readProject(lifetime: ServerAccountScopeLifetime, projectSourceId: string | undefined) {
    lifetime = readServerAccountScopeOwnerLifetime(lifetime);
    let sources = projects.get(lifetime);
    if (!sources) { sources = new Map(); projects.set(lifetime, sources); }
    const previous = sources.get(projectSourceId);
    if (previous) return previous;
    const controller = createDeploymentReadControllerV1({ scope: {
        serverId: getServerProfileById(lifetime.scope.serverId)?.serverIdentityId ?? lifetime.scope.serverId,
        accountId: lifetime.scope.accountId, projectSourceId,
    }, transport: createDeploymentReadTransport(lifetime) });
    let retired = false;
    function retire() {
        if (retired) return;
        retired = true;
        stopChanges();
        controller.retire();
        if (sources?.get(projectSourceId) === owner) sources.delete(projectSourceId);
    }
    const owner: ProjectOwner = {
        controller,
    };
    // Keep the content-free invalidation owner across navigation. The controller
    // records stale retained pages and fetches only pages with active demand.
    const stopChanges = subscribeHomeAccountChange(event => {
        if (retired || !lifetime.isCurrent() || !areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)) return;
        if (event.changeKinds && !event.changeKinds.includes('account')) return;
        if (!event.entityIds || event.entityIds.some(id => isAccountCurrentnessEntityIdV1(id)
            || id === PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 || id === TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1)) {
            void controller.refreshDemanded();
            return;
        }
        const changes = event.entityIds.flatMap(entityId => {
            const hint = readDeploymentAccountChangeV1({ kind: 'account', entityId });
            return hint ? [hint] : [];
        });
        controller.invalidate(changes);
    }, { serverIds: [lifetime.scope.serverId] });
    sources.set(projectSourceId, owner);
    lifetime.onRetire(retire);
    return owner;
}

/** Account-wide and selected-Source consumers share the same lifetime/push owner. */
function useDeploymentOwner(lifetime: ServerAccountScopeLifetime | null, projectSourceId: string | undefined,
    enabled: boolean) {
    const [binding, setBinding] = React.useState<Readonly<{
        lifetime: ServerAccountScopeLifetime; projectSourceId: string | undefined; owner: ProjectOwner;
    }> | null>(null);
    React.useEffect(() => {
        if (!lifetime?.isCurrent() || !enabled) return;
        setBinding({ lifetime, projectSourceId, owner: readProject(lifetime, projectSourceId) });
    }, [lifetime, projectSourceId, enabled]);
    const owner = enabled && binding?.lifetime === lifetime && binding?.projectSourceId === projectSourceId ? binding.owner : null;
    return { controller: owner?.controller ?? null };
}


/** Store Installed consumes one admitted page, with native coverage and explicit continuation. */
export function useDeploymentInventory(lifetime: ServerAccountScopeLifetime | null, demand: DeploymentReadDemandV1,
    query: DeploymentCollectionQueryV1 & Readonly<{ projectSourceId?: string }> = {}) {
    const { controller } = useDeploymentOwner(lifetime, query.projectSourceId, true);
    const read = useDeploymentCollection(controller, demand, { machineId: query.machineId, cursor: query.cursor, environmentIds: query.environmentIds,
        previewRepositoryId: query.previewRepositoryId, previewPullRequestIds: query.previewPullRequestIds,
        previewTemplateEnvironmentId: query.previewTemplateEnvironmentId });
    return { ...read, controller };
}
