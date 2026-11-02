import type { ProjectManagedServiceHandle } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';

/** Captured host-private reads, never serialized service or reboot operands. */
export type MachineServiceDisclosureRequest = Readonly<{
    requesterAccountId?: string | null;
    context?: Pick<ActionExecutorContext, 'externalActionExecutionAuthorization'>;
    canReadEnvironments?: (environmentIds: readonly string[]) => Promise<ReadonlySet<string>>;
}>;

/** The incumbent list's exact selection and requester disclosure policy. */
export async function selectVisibleMachineProjectServices(
    target: Readonly<{ serverId: string; machineId: string }>,
    services: readonly ProjectManagedServiceHandle[],
    request: MachineServiceDisclosureRequest,
    serviceId?: string,
): Promise<readonly ProjectManagedServiceHandle[]> {
    const custody = readRequesterAccountActionContext(request.context?.externalActionExecutionAuthorization);
    const binding = custody?.authorization.binding;
    const custodian = custody !== null && binding !== undefined && binding.accountId === request.requesterAccountId
        && binding.accountId === binding.custodianAccountId
        && binding.machineId === target.machineId && binding.serverIdentityId === target.serverId
        && await custody.isCustodyCurrent?.() === true;
    const projects: ProjectManagedServiceHandle[] = [];
    for (const handle of services) {
        const authority = handle.kind === 'workspace' ? handle.workspace : handle;
        if (serviceId && handle.serviceId !== serviceId || authority.machineId !== target.machineId
            || !handle.isCurrent() || handle.retirementSignal.aborted
            || !await isServerProfileHomeIdentity(target.serverId, authority.serverId)) continue;
        projects.push(handle);
    }
    const environmentIds = [...new Set(projects.flatMap(handle => handle.kind === 'environment' ? [handle.environmentId] : []))];
    // The Source owner admits the demanded set under one current Account read.
    const readable = environmentIds.length ? await request.canReadEnvironments?.(environmentIds) : undefined;
    return projects.filter(handle => handle.isCurrent() && !handle.retirementSignal.aborted
        && (handle.kind === 'workspace'
            ? custodian || !!request.requesterAccountId && handle.requester.accountId === request.requesterAccountId
            : readable?.has(handle.environmentId) === true));
}
