import type { ProjectManagedServiceHandle, WorkspaceProjectManagedServiceHandle, EnvironmentProjectManagedServiceHandle } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { selectServerProfileHomeIdentityMatches } from '@/server/serverProfiles';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';

/** Captured host-private reads, never serialized service or reboot operands. */
export type MachineServiceDisclosureRequest = Readonly<{
    requesterAccountId?: string | null;
    context?: Pick<ActionExecutorContext, 'externalActionExecutionAuthorization'>;
    canReadEnvironments?: (environmentIds: readonly string[]) => Promise<ReadonlySet<string>>;
    observeEnvironmentAccessChanges?: (listener: Parameters<import('@/deployments/createCliDeploymentActionDeps').CliDeploymentEnvironmentAccessObserve>[2]) => ReturnType<import('@/deployments/createCliDeploymentActionDeps').CliDeploymentEnvironmentAccessObserve>;
}>;

/** The incumbent list's exact selection and requester disclosure policy. */
type DisclosableProjectService = Pick<ProjectManagedServiceHandle, 'serviceId' | 'isCurrent' | 'retirementSignal'> & (
    Pick<WorkspaceProjectManagedServiceHandle, 'kind' | 'workspace' | 'requester'>
    | Pick<EnvironmentProjectManagedServiceHandle, 'kind' | 'serverId' | 'machineId' | 'environmentId'>
);

export async function selectVisibleMachineProjectServices<T extends DisclosableProjectService>(
    target: Readonly<{ serverId: string; machineId: string }>,
    services: readonly T[],
    request: MachineServiceDisclosureRequest,
    serviceId?: string,
): Promise<readonly T[]> {
    const custody = readRequesterAccountActionContext(request.context?.externalActionExecutionAuthorization);
    const binding = custody?.authorization.binding;
    const custodian = custody !== null && binding !== undefined && binding.accountId === request.requesterAccountId
        && binding.accountId === binding.custodianAccountId
        && binding.machineId === target.machineId && binding.serverIdentityId === target.serverId
        && await custody.isCustodyCurrent?.() === true;
    const candidates = services.flatMap(handle => {
        // Narrow through the constraint: a generic `T` does not narrow on its `kind`.
        const disclosable: DisclosableProjectService = handle;
        const authority = disclosable.kind === 'workspace' ? disclosable.workspace : disclosable;
        if (serviceId && handle.serviceId !== serviceId || authority.machineId !== target.machineId
            || !handle.isCurrent() || handle.retirementSignal.aborted) return [];
        return [{ handle, serverId: authority.serverId }];
    });
    const matches = await selectServerProfileHomeIdentityMatches(candidates.map(candidate => candidate.serverId), target.serverId);
    const projects = candidates.filter(candidate => matches.has(candidate.serverId)).map(candidate => candidate.handle);
    const environmentIds = [...new Set(projects.flatMap(handle => handle.kind === 'environment' ? [handle.environmentId] : []))];
    // The Source owner admits the demanded set under one current Account read.
    const readable = environmentIds.length ? await request.canReadEnvironments?.(environmentIds) : undefined;
    return projects.filter(handle => handle.isCurrent() && !handle.retirementSignal.aborted
        && (handle.kind === 'workspace'
            ? custodian || !!request.requesterAccountId && handle.requester.accountId === request.requesterAccountId
            : readable?.has(handle.environmentId) === true));
}
