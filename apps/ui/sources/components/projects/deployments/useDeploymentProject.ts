import * as React from 'react';
import { createDeploymentReadControllerV1, isDeploymentReadDemandActiveV1, type DeploymentReadControllerV1, type DeploymentReadDemandV1, type DeploymentCollectionQueryV1 } from '@happier-dev/deployments';
import { readDeploymentAccountChangeV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { isAccountCurrentnessEntityIdV1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { readServerAccountScopeOwnerLifetime, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange, type HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { createDeploymentReadTransport } from './deploymentReadTransport';
import { useDeploymentCollection } from './useDeploymentReads';

type ProjectOwner = Readonly<{
    controller: DeploymentReadControllerV1;
    acquireDemand(): () => void;
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
    let presentedBorrowers = 0;
    function retire() {
        if (retired) return;
        retired = true;
        stopChanges();
        controller.retire();
        if (sources?.get(projectSourceId) === owner) sources.delete(projectSourceId);
    }
    const owner: ProjectOwner = {
        controller,
        acquireDemand() {
            if (retired) return () => {};
            presentedBorrowers++;
            if (presentedBorrowers === 1) replaceChangeSubscription(true);
            return () => {
                presentedBorrowers--;
                if (!retired && presentedBorrowers === 0) replaceChangeSubscription(false);
            };
        },
    };
    // Keep the content-free invalidation owner across navigation. The controller
    // records stale retained pages; only presented borrowers demand its Home transport.
    const onChange = (event: HomeAccountChangeEvent) => {
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
    };
    let stopChanges = subscribeHomeAccountChange(onChange, { reconnect: 'refresh' });
    function replaceChangeSubscription(demanded: boolean) {
        stopChanges();
        stopChanges = subscribeHomeAccountChange(onChange, {
            ...(demanded ? { serverIds: [lifetime.scope.serverId] } : {}), reconnect: 'refresh',
        });
    }
    sources.set(projectSourceId, owner);
    lifetime.onRetire(retire);
    return owner;
}

/** Account-wide and selected-Source consumers share the same lifetime/push owner. */
function useDeploymentOwner(lifetime: ServerAccountScopeLifetime | null, projectSourceId: string | undefined,
    enabled: boolean, demand: DeploymentReadDemandV1) {
    const [binding, setBinding] = React.useState<Readonly<{
        lifetime: ServerAccountScopeLifetime; projectSourceId: string | undefined; owner: ProjectOwner;
    }> | null>(null);
    React.useEffect(() => {
        if (!lifetime?.isCurrent() || !enabled) return;
        setBinding({ lifetime, projectSourceId, owner: readProject(lifetime, projectSourceId) });
    }, [lifetime, projectSourceId, enabled]);
    const owner = enabled && binding?.lifetime === lifetime && binding?.projectSourceId === projectSourceId ? binding.owner : null;
    const presented = isDeploymentReadDemandActiveV1(demand);
    React.useEffect(() => {
        if (presented) return owner?.acquireDemand();
    }, [owner, presented]);
    return { controller: owner?.controller ?? null };
}

/** One Source shares its demand owner only within the captured Account lifetime. */
export function useDeploymentProject(lifetime: ServerAccountScopeLifetime | null, projectSourceId: string | null,
    demand: DeploymentReadDemandV1) {
    return useDeploymentOwner(lifetime, projectSourceId ?? undefined, projectSourceId !== null, demand);
}

/** The Account-wide owner alone, for a consumer that reads one known Environment (an API token's grant). */
export function useDeploymentAccountController(lifetime: ServerAccountScopeLifetime | null, enabled: boolean, demand: DeploymentReadDemandV1) {
    return useDeploymentOwner(lifetime, undefined, enabled, demand).controller;
}

/** Store Installed consumes one admitted page, with native coverage and explicit continuation. */
export function useDeploymentInventory(lifetime: ServerAccountScopeLifetime | null, demand: DeploymentReadDemandV1,
    query: DeploymentCollectionQueryV1 & Readonly<{ projectSourceId?: string }> = {}) {
    const { controller } = useDeploymentOwner(lifetime, query.projectSourceId, true, demand);
    const read = useDeploymentCollection(controller, demand, { machineId: query.machineId, cursor: query.cursor, environmentIds: query.environmentIds,
        previewRepositoryId: query.previewRepositoryId, previewPullRequestIds: query.previewPullRequestIds,
        previewTemplateEnvironmentId: query.previewTemplateEnvironmentId });
    return { ...read, controller };
}
