import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LOCAL_SERVICES_PREVIEW_ADMISSION_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonLocalServicePreviewAdmissionResponseV1Schema,
    type DaemonLocalServicePreviewAdmissionRequestV1, type LocalServicePreviewResourceV1 } from '@happier-dev/protocol/local/services/preview/v1';
import type { MachineAdmission } from '@happier-dev/protocol/machines/machineAccessV1';
import { eventRouter } from '@/app/events/connectionEventRouter';
import { resolveMachineAdmission } from '@/app/machines/machineAccess';
import type { RpcAckResponseEmitter } from '@/app/api/socket/rpc/_types';
import { log } from '@/utils/logging/log';

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
            // Retirement observes the Service's lifetime, not the Home's ordinary request
            // deadline. A timed-out observation would retire a still-current preview.
            ...(input.request.kind === 'wait_retirement' ? { timeoutMs: null } : {}),
            authorization: LOCAL_SERVICES_PREVIEW_ADMISSION_SERVER_ORIGIN, machineAdmission,
            ...(input.signal ? { cancellation: { targetRequestId, signal: input.signal,
                onTargetSelected: (target: RpcAckResponseEmitter) => { selectedTarget = target; } } } : {}),
            targetGuard: {
                filterTargets: async targets => targets.filter(matches),
                runOperation: async ({ target, readLatestTarget, operation }) => {
                    const latest = await readLatestTarget();
                    if (!matches(target) || !latest || !matches(latest)) {
                        return { status: 'unavailable' };
                    }
                    return { status: 'current', value: await operation() };
                },
            },
        });
        const parsed = response?.ok ? DaemonLocalServicePreviewAdmissionResponseV1Schema.safeParse(response.result) : null;
        log({ module: 'local-services-preview', level: 'info', machineId: input.admission.machineId,
            instanceId: input.request.target.managedServiceId, operation: input.request.kind,
            replyKind: parsed?.success ? parsed.data.kind : 'unavailable',
            ...(!response?.ok && response && 'errorCode' in response ? { errorCode: response.errorCode } : {}) },
            'Declared Service preview admission reply');
        if (!response?.ok || input.signal?.aborted) return null;
        return parsed?.success ? parsed.data : null;
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
    const decision = (stage: string, admitted: AdmittedMachine | null = null) => {
        log({ module: 'local-services-preview', level: 'info', previewId: input.resource.previewId,
            instanceId: target.managedServiceId, stage, admitted: admitted !== null }, 'Declared Service preview admission decision');
        return admitted;
    };
    const admission = await resolveMachineAdmission({ actorAccountId: input.accountId, machineId: input.resource.machineId,
        rpcMethod: method, requireOnline: true });
    if (admission.kind !== 'admitted') return decision(`machine_${admission.code}`);
    const result = await forwardAdmission({ admission, request: { v: 1, kind: 'read', target }, signal: input.signal });
    if (result?.kind !== 'admitted') return decision('daemon_admission_unavailable');
    if (result.instanceId !== target.managedServiceId || !isDeepStrictEqual(result.serviceTarget, target)) return decision('service_target_mismatch');
    if (!isDeepStrictEqual(result.endpoint, input.resource.target)) return decision('service_endpoint_mismatch');
    if (input.resource.owner.kind !== 'user' || input.resource.owner.id !== result.starterAccountId) return decision('service_starter_mismatch');
    const starter = await resolveMachineAdmission({ actorAccountId: result.starterAccountId, machineId: admission.machineId,
        rpcMethod: method, requireOnline: true });
    return sameInstallation(starter, admission) && !input.signal?.aborted
        ? decision('admitted', admission) : decision('starter_admission_unavailable');
}

/** Only the exact Service owner's retirement reply establishes an end.
 * Transport loss or an unavailable observation is not a Service lifecycle fact;
 * each subsequent access still passes the ordinary current-Service admission.
 */
export async function observeLocalServicePreviewRetirement(input: Readonly<{
    admission: AdmittedMachine;
    resource: LocalServicePreviewResourceV1;
    signal: AbortSignal;
}>): Promise<boolean> {
    const target = input.resource.serviceTarget;
    if (!target || input.signal.aborted) return false;
    const result = await forwardAdmission({ admission: input.admission, request: { v: 1, kind: 'wait_retirement', target,
        instanceId: target.managedServiceId }, signal: input.signal });
    return result?.kind === 'retired' && result.instanceId === target.managedServiceId;
}
