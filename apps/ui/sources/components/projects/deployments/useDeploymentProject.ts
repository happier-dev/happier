import * as React from 'react';
import { createDeploymentReadControllerV1, isDeploymentReadDemandActiveV1, type DeploymentReadControllerV1, type DeploymentReadDemandV1, type DeploymentCollectionQueryV1 } from '@happier-dev/deployments';
import { readDeploymentAccountChangeV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { isAccountCurrentnessEntityIdV1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { readServerAccountScopeOwnerLifetime, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { readCurrentServerCredentialAccountScopeLifetime } from '@/sync/domains/scope/serverCredentialAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange, type HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { createDeploymentActions } from './deploymentActions';
import { createDeploymentReadTransport } from './deploymentReadTransport';
import { projectDeploymentEnvironmentTabResult, useDeploymentCollection } from './useDeploymentReads';

type ProjectOwner = Readonly<{
    controller: DeploymentReadControllerV1;
    actions: ReturnType<typeof createDeploymentActions> | null;
    acquireDemand(): () => void;
}>;
const projects = new WeakMap<ServerAccountScopeLifetime, Map<string | undefined, ProjectOwner>>();

/** One routing projection from Home socket wakes to deployment reads. */
export function readDeploymentHomeWake(event: HomeAccountChangeEvent) {
    if (event.changeKinds && !event.changeKinds.includes('account')) return null;
    if (!event.entityIds || event.entityIds.some(id => isAccountCurrentnessEntityIdV1(id)
        || id === PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 || id === TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1)) return 'all';
    return event.entityIds.flatMap(entityId => {
        const hint = readDeploymentAccountChangeV1({ kind: 'account', entityId });
        return hint ? [hint] : [];
    });
}

function findProjectOwner(lifetime: ServerAccountScopeLifetime | null, sourceId: string | undefined) {
    return lifetime?.isCurrent() ? projects.get(lifetime)?.get(sourceId) ?? null : null;
}

export function readDeploymentProjectOwner(lifetime: ServerAccountScopeLifetime, projectSourceId: string | undefined) {
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
        controller, actions: projectSourceId === undefined ? null : createDeploymentActions(lifetime, projectSourceId),
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
        if (event.changeKinds?.includes('savedSecretResource')) controller.invalidateSavedSecrets(event.entityIds);
        const wake = readDeploymentHomeWake(event);
        if (wake === 'all') void controller.refreshDemanded();
        else if (wake) controller.invalidate(wake);
    };
    // The focused Home's changes feed carries Deploy revisions and grant changes.
    // Runtime health has its own Machine watch and recovery.
    let stopChanges = subscribeHomeAccountChange(onChange);
    function replaceChangeSubscription(demanded: boolean) {
        stopChanges();
        stopChanges = subscribeHomeAccountChange(onChange, demanded ? { serverIds: [lifetime.scope.serverId] } : undefined);
    }
    sources.set(projectSourceId, owner);
    lifetime.onRetire(retire);
    return owner;
}

/** Account-wide and selected-Source consumers share the same lifetime/push owner. */
function useDeploymentOwner(lifetime: ServerAccountScopeLifetime | null, projectSourceId: string | undefined,
    enabled: boolean, demand: DeploymentReadDemandV1) {
    const scopeOwner = enabled && lifetime?.isCurrent() ? readServerAccountScopeOwnerLifetime(lifetime) : null;
    const owner = findProjectOwner(scopeOwner, projectSourceId);
    const [, publishOwner] = React.useState<ProjectOwner>();
    React.useEffect(() => {
        if (owner || !scopeOwner?.isCurrent()) return;
        publishOwner(readDeploymentProjectOwner(scopeOwner, projectSourceId));
    }, [owner, scopeOwner, projectSourceId]);
    const presented = isDeploymentReadDemandActiveV1(demand);
    React.useEffect(() => {
        if (presented) return owner?.acquireDemand();
    }, [owner, presented]);
    return { controller: owner?.controller ?? null, actions: owner?.actions ?? null };
}

/** One Source shares its demand owner only within the captured Account lifetime. */
export function useDeploymentProject(lifetime: ServerAccountScopeLifetime | null, projectSourceId: string | null,
    demand: DeploymentReadDemandV1) {
    return useDeploymentOwner(lifetime, projectSourceId ?? undefined, projectSourceId !== null, demand);
}

const UNBOUND_DEMAND: DeploymentReadDemandV1 = { mounted: false, visible: false, focused: false };

/** A remounted route can show the exact Account's admitted rows while its own credential binding settles. */
export function useDeploymentProjectRoute(serverId: string | null, projectSourceId: string | null, demand: DeploymentReadDemandV1) {
    const { binding, resolution } = useServerCredentialAccountScopeBinding(serverId);
    const lifetime = binding?.isCurrent() ? binding : null;
    const project = useDeploymentProject(lifetime, projectSourceId, demand);
    const displayLifetime = !lifetime && resolution.kind === 'resolving' && serverId && projectSourceId
        ? readCurrentServerCredentialAccountScopeLifetime(serverId) : null;
    return {
        lifetime, resolution,
        scope: lifetime?.scope ?? displayLifetime?.scope ?? null,
        controller: project.controller ?? findProjectOwner(displayLifetime, projectSourceId ?? undefined)?.controller ?? null,
        actions: project.actions,
        demand: lifetime ? demand : UNBOUND_DEMAND,
    };
}

/** The Account-wide owner alone, for a consumer that reads one known Environment (an API token's grant). */
export function useDeploymentAccountController(lifetime: ServerAccountScopeLifetime | null, enabled: boolean, demand: DeploymentReadDemandV1) {
    return useDeploymentOwner(lifetime, undefined, enabled, demand).controller;
}

/** Store Installed consumes one admitted page, with native coverage and explicit continuation. */
export function useDeploymentInventory(lifetime: ServerAccountScopeLifetime | null, demand: DeploymentReadDemandV1,
    query: DeploymentCollectionQueryV1 & Readonly<{ projectSourceId?: string }> = {}, visibleHealthOnly = false) {
    const { controller } = useDeploymentOwner(lifetime, query.projectSourceId, true, demand);
    const read = useDeploymentCollection(controller, demand, { machineId: query.machineId, cursor: query.cursor, environmentIds: query.environmentIds,
        previewRepositoryId: query.previewRepositoryId, previewPullRequestIds: query.previewPullRequestIds,
        previewTemplateEnvironmentId: query.previewTemplateEnvironmentId }, visibleHealthOnly);
    return { ...read, controller };
}

/** Exact children of P44's admitted template relation, never an Account inventory scan. */
export function useDeploymentEnvironmentPreviews(lifetime: ServerAccountScopeLifetime | null, demand: DeploymentReadDemandV1,
    query: Readonly<{ previewTemplateEnvironmentId: string; cursor?: string }>) {
    const read = useDeploymentInventory(lifetime, demand, query);
    return { ...read, result: projectDeploymentEnvironmentTabResult(read.snapshot, read.snapshot.value?.items ?? [], read.refresh),
        retry: read.refresh };
}
