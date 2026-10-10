import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LOCAL_SERVICES_PREVIEW_ADMISSION_SERVER_ORIGIN, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonLocalServicePreviewAdmissionResponseV1Schema,
    type DaemonLocalServicePreviewAdmissionRequestV1, type LocalServicePreviewResourceV1 } from '@happier-dev/protocol/local/services/preview/v1';
import type { MachineAdmission } from '@happier-dev/protocol/machines/machineAccessV1';
import { eventRouter } from '@/app/events/connectionEventRouter';
import { resolveMachineAdmission } from '@/app/machines/machineAccess';
import type { RpcAckResponseEmitter } from '@/app/api/socket/rpc/_types';

type AdmittedMachine = Extract<MachineAdmission, { kind: 'admitted' }>;
const method = RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION;

function sameInstallation(current: MachineAdmission, admitted: AdmittedMachine): boolean {
    return current.kind === 'admitted' && current.machineId === admitted.machineId
        && current.custodianAccountId === admitted.custodianAccountId && current.installationId === admitted.installationId;
}

async function forwardAdmission(input: Readonly<{
    admission: AdmittedMachine;
    request: DaemonLocalServicePreviewAdmissionRequestV1;
    signal?: AbortSignal;
}>) {
    const { kind: _kind, ...machineAdmission } = input.admission;
    const readCurrent = () => resolveMachineAdmission({ actorAccountId: input.admission.actorAccountId,
        machineId: input.admission.machineId, rpcMethod: method, requireOnline: true });
    const matches = (target: RpcAckResponseEmitter) => target.data?.clientType === 'machine-scoped'
        && target.data.userId === input.admission.custodianAccountId && target.data.machineId === input.admission.machineId
        && target.data.verifiedMachineInstallationId === input.admission.installationId;
    const targetRequestId = `preview_admission_${randomUUID()}`;
    let selectedTarget: RpcAckResponseEmitter | null = null;
    const cancel = () => {
        if (selectedTarget) eventRouter.cancelServerOwnedRpc({ targetSocketId: selectedTarget.id, targetRequestId });
    };
    input.signal?.addEventListener('abort', cancel, { once: true });
    try {
        const response = await eventRouter.forwardServerOwnedRpc({ targetUserId: input.admission.custodianAccountId,
            method: `${input.admission.machineId}:${method}`, callParams: input.request,
            authorization: LOCAL_SERVICES_PREVIEW_ADMISSION_SERVER_ORIGIN, machineAdmission,
            ...(input.signal ? { cancellation: { targetRequestId, signal: input.signal,
                onTargetSelected: (target: RpcAckResponseEmitter) => { selectedTarget = target; } } } : {}),
            targetGuard: {
                filterTargets: async targets => targets.filter(matches),
                runOperation: async ({ target, readLatestTarget, operation }) => {
                    const latest = await readLatestTarget();
                    if (!matches(target) || !latest || !matches(latest) || !sameInstallation(await readCurrent(), input.admission)) {
                        return { status: 'unavailable' };
                    }
                    return { status: 'current', value: await operation() };
                },
            },
        });
        if (!response?.ok || input.signal?.aborted || !sameInstallation(await readCurrent(), input.admission)) return null;
        const parsed = DaemonLocalServicePreviewAdmissionResponseV1Schema.safeParse(response.result);
        return parsed.success ? parsed.data : null;
    } finally { input.signal?.removeEventListener('abort', cancel); }
}

/** The current Machine owner and actual managed occurrence, never caller-supplied service facts. */
export async function readLocalServicePreviewAdmission(input: Readonly<{
    accountId: string;
    resource: LocalServicePreviewResourceV1;
    signal?: AbortSignal;
}>): Promise<AdmittedMachine | null> {
    const target = input.resource.serviceTarget;
    if (!target) return null;
    const admission = await resolveMachineAdmission({ actorAccountId: input.accountId, machineId: input.resource.machineId,
        rpcMethod: method, requireOnline: true });
    if (admission.kind !== 'admitted') return null;
    const result = await forwardAdmission({ admission, request: { v: 1, kind: 'read', target }, signal: input.signal });
    if (result?.kind !== 'admitted' || result.instanceId !== target.managedServiceId
        || !isDeepStrictEqual(result.serviceTarget, target) || !isDeepStrictEqual(result.endpoint, input.resource.target)
        || input.resource.owner.kind !== 'user' || input.resource.owner.id !== result.starterAccountId) return null;
    const starter = await resolveMachineAdmission({ actorAccountId: result.starterAccountId, machineId: admission.machineId,
        rpcMethod: method, requireOnline: true });
    return sameInstallation(starter, admission) && !input.signal?.aborted ? admission : null;
}

/** Disclosure follows the owner signal; native process termination is a different outcome. */
export async function observeLocalServicePreviewRetirement(input: Readonly<{
    admission: AdmittedMachine;
    resource: LocalServicePreviewResourceV1;
    signal: AbortSignal;
}>): Promise<void> {
    const target = input.resource.serviceTarget;
    if (!target || input.signal.aborted) return;
    await forwardAdmission({ admission: input.admission, request: { v: 1, kind: 'wait_retirement', target,
        instanceId: target.managedServiceId }, signal: input.signal });
}
