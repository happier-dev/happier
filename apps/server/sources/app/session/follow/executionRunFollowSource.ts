import { ExecutionRunFollowFrontierResponseSchema, type ExecutionRunFollowFrontierResponse } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES, type RpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import type { SessionInputMachineTargetV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { Fastify } from '@/app/api/types';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { readCurrentCommittedSessionInputMachineTargetInTx } from '@/app/session/messages/sessionInputAdmission';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import { canReadFollowSourceInTx, readExecutionRunFollowMachineAdmissionInTx } from './followSourceAdmission';
import { resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import type { FollowSourceRefV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { resolveExecutionRunFollowOccurrenceV1, deriveSessionFollowOriginalOccurrenceKeyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { SessionFollowPendingObservationV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { composeExecutionRunWorkerUpdateV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';

export type ExecutionRunFollowFrontierWitness = Readonly<{
    source: Extract<FollowSourceRefV1, { kind: 'execution_run' }>;
    status: ExecutionRunFollowFrontierResponse['status'];
    terminalEventId: string | null;
    runtimeIssueV1?: ExecutionRunFollowFrontierResponse['runtimeIssueV1'];
    attention?: ExecutionRunFollowFrontierResponse['attention'];
    outputs?: ExecutionRunFollowFrontierResponse['outputs'];
    target: SessionInputMachineTargetV1 | Readonly<{ accountId: string; machineId: string; installationId: string }>;
    machineCustodianAccountId: string;
    publisherGeneration: string | null;
}>;

export type ExecutionRunFollowRpcUnavailableCode = RpcErrorCode | typeof MACHINE_RPC_TIMEOUT_ERROR_CODE
    | 'target_unavailable' | 'unknown' | 'exception';

function readRpcUnavailableCode(value: unknown): ExecutionRunFollowRpcUnavailableCode {
    // Forwarding errors may be arbitrary strings. Only canonical codes enter
    // the completion record, never error text or an untrusted returned value.
    const codes: readonly ExecutionRunFollowRpcUnavailableCode[] = [
        ...Object.values(RPC_ERROR_CODES), MACHINE_RPC_TIMEOUT_ERROR_CODE, 'target_unavailable',
    ];
    return codes.find(code => code === value) ?? 'unknown';
}

function sameTarget(left: SessionInputMachineTargetV1, right: SessionInputMachineTargetV1): boolean {
    return left.homeId === right.homeId && left.accountId === right.accountId && left.sessionId === right.sessionId
        && left.machineId === right.machineId && left.installationId === right.installationId;
}

/** Recheck the captured publisher and Machine target in the mutation/ACK transaction. */
export async function isExecutionRunFollowFrontierWitnessCurrentInTx(tx: Tx,
    witness: ExecutionRunFollowFrontierWitness): Promise<boolean> {
    if ('machineId' in witness.source) {
        if ('sessionId' in witness.target || witness.source.machineId !== witness.target.machineId
            || witness.publisherGeneration !== null) return false;
        const current = await resolveMachineAdmissionInTx(tx, { actorAccountId: witness.target.accountId,
            machineId: witness.source.machineId, rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER });
        return current.kind === 'admitted' && current.custodianAccountId === witness.target.accountId
            && current.custodianAccountId === witness.machineCustodianAccountId
            && current.installationId === witness.target.installationId;
    }
    if (!('sessionId' in witness.target) || witness.target.sessionId !== witness.source.sessionId) return false;
    const session = await tx.session.findUnique({ where: { id: witness.source.sessionId },
        select: { accountId: true, archivedAt: true, publisherGeneration: true } });
    if (!session || session.archivedAt !== null || session.accountId !== witness.target.accountId
        || session.publisherGeneration.toString() !== witness.publisherGeneration) return false;
    const current = await readCurrentCommittedSessionInputMachineTargetInTx(tx, witness.source.sessionId);
    if (current === undefined || !sameTarget(current, witness.target)) return false;
    const admission = await resolveMachineAdmissionInTx(tx, { actorAccountId: current.accountId,
        machineId: current.machineId });
    return admission.kind === 'admitted' && admission.installationId === current.installationId
        && admission.custodianAccountId === witness.machineCustodianAccountId;
}

/** One content-free retained Run read, shared by new-Follow seeding and original validation. */
export async function readCurrentExecutionRunFollowSource(input: Readonly<{
    app: Pick<Fastify, 'forwardRpcForUser'>;
    accountId: string;
    runId: string;
    outputRefs?: NonNullable<ExecutionRunFollowFrontierResponse['outputs']>[number]['outputRef'][];
    authentication: SessionAccessAuthentication;
}> & (Readonly<{ sessionId: string }> | Readonly<{ machineId: string }>)): Promise<Readonly<{ ok: true; value: ExecutionRunFollowFrontierWitness }>
    | Readonly<{ ok: false; error: 'session_follow_source_unavailable';
        code: 'target_unavailable' | 'rpc_unavailable' | 'rpc_invalid' | 'frontier_not_current';
        targetMachineId?: string; rpcCode?: ExecutionRunFollowRpcUnavailableCode }>> {
    const source: ExecutionRunFollowFrontierWitness['source'] = 'sessionId' in input
        ? { kind: 'execution_run', sessionId: input.sessionId, runId: input.runId }
        : { kind: 'execution_run', machineId: input.machineId, runId: input.runId };
    const captured = await inReadSnapshot(async tx => {
        if ('machineId' in source) {
            const admission = await readExecutionRunFollowMachineAdmissionInTx(tx, { ...input, machineId: source.machineId });
            return admission ? { target: { accountId: admission.custodianAccountId, machineId: admission.machineId,
                installationId: admission.installationId }, machineCustodianAccountId: admission.custodianAccountId,
                publisherGeneration: null } : null;
        }
        if (!await canReadFollowSourceInTx(tx, { accountId: input.accountId, source,
            authentication: input.authentication })) return null;
        const session = await tx.session.findUnique({ where: { id: source.sessionId },
            select: { accountId: true, archivedAt: true, publisherGeneration: true } });
        if (!session || session.archivedAt !== null) return null;
        const target = await readCurrentCommittedSessionInputMachineTargetInTx(tx, source.sessionId);
        if (!target || target.accountId !== session.accountId) return null;
        const admission = await resolveMachineAdmissionInTx(tx, { actorAccountId: session.accountId,
            machineId: target.machineId });
        return admission.kind === 'admitted' && admission.installationId === target.installationId
            ? { target, machineCustodianAccountId: admission.custodianAccountId,
                publisherGeneration: session.publisherGeneration.toString() } : null;
    });
    if (!captured) return { ok: false, error: 'session_follow_source_unavailable', code: 'target_unavailable' };
    let rpc: Awaited<ReturnType<Fastify['forwardRpcForUser']>>;
    try {
        rpc = await input.app.forwardRpcForUser({ userId: captured.machineCustodianAccountId,
            method: `${captured.target.machineId}:${SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER}`,
            params: { ...('sessionId' in source ? { sessionId: source.sessionId } : { machineId: source.machineId }),
                runId: input.runId, ...(input.outputRefs?.length ? { outputRefs: input.outputRefs } : {}) } });
    } catch {
        return { ok: false, error: 'session_follow_source_unavailable', code: 'rpc_unavailable',
            targetMachineId: captured.target.machineId, rpcCode: 'exception' };
    }
    if (!rpc.ok) return { ok: false, error: 'session_follow_source_unavailable', code: 'rpc_unavailable',
        targetMachineId: captured.target.machineId, rpcCode: readRpcUnavailableCode('errorCode' in rpc ? rpc.errorCode : undefined) };
    const parsed = ExecutionRunFollowFrontierResponseSchema.safeParse(rpc.result);
    if (!parsed.success || parsed.data.runId !== input.runId
        || ('sessionId' in source ? parsed.data.sessionId !== source.sessionId
            : !('machineId' in parsed.data) || parsed.data.machineId !== source.machineId || parsed.data.sessionId !== null))
        return { ok: false, error: 'session_follow_source_unavailable', code: 'rpc_invalid', targetMachineId: captured.target.machineId };
    const witness: ExecutionRunFollowFrontierWitness = { source, status: parsed.data.status,
        terminalEventId: parsed.data.terminalEventId,
        ...(parsed.data.runtimeIssueV1 ? { runtimeIssueV1: parsed.data.runtimeIssueV1 } : {}),
        ...(parsed.data.attention ? { attention: parsed.data.attention } : {}),
        ...(parsed.data.outputs ? { outputs: parsed.data.outputs } : {}),
        target: captured.target, machineCustodianAccountId: captured.machineCustodianAccountId,
        publisherGeneration: captured.publisherGeneration };
    if (!await inReadSnapshot(tx => isExecutionRunFollowFrontierWitnessCurrentInTx(tx, witness)))
        return { ok: false, error: 'session_follow_source_unavailable', code: 'frontier_not_current', targetMachineId: captured.target.machineId };
    return { ok: true, value: witness };
}

/** Hydrate exact Run outcomes and recheck mutable permissions without granting source-content reads. */
export async function retainCurrentExecutionRunFollowObservations(input: Readonly<{
    app: Pick<Fastify, 'forwardRpcForUser'>; accountId: string; authentication: SessionAccessAuthentication;
    observations: readonly SessionFollowPendingObservationV1[];
}>): Promise<SessionFollowPendingObservationV1[]> {
    const reads = new Map<string, ReturnType<typeof readCurrentExecutionRunFollowSource>>();
    const retained = await Promise.all(input.observations.map(async observation => {
        if (!('kind' in observation) || observation.kind !== 'admitted_run_input'
            || !('source' in observation.delivery.original)) return observation;
        const original = observation.delivery.original;
        const source = original.source;
        if (source.kind !== 'execution_run' || !('permissionRequests' in original)
            && !('terminalEventId' in original && 'sessionId' in source)) return observation;
        const key = JSON.stringify(source);
        let read = reads.get(key);
        if (!read) {
            read = readCurrentExecutionRunFollowSource({ ...input, ...source });
            reads.set(key, read);
        }
        const frontier = await read;
        if ('terminalEventId' in original) {
            // The frontier contains no result body or key material. Preserve the
            // actual failed/cancelled/timeout outcome and its exact source pointer;
            // native Run get remains scoped to its independently admitted caller.
            if (!frontier.ok || !('sessionId' in source) || frontier.value.status === 'running'
                || frontier.value.terminalEventId !== original.terminalEventId) return null;
            return { ...observation, workerUpdate: composeExecutionRunWorkerUpdateV1({
                runId: source.runId, sessionId: source.sessionId, status: frontier.value.status, canInspect: false,
                ...(frontier.value.runtimeIssueV1 ? { runtimeIssueV1: frontier.value.runtimeIssueV1 } : {}),
            }) };
        }
        if (!frontier.ok || frontier.value.status === 'running' && frontier.value.attention
            && !frontier.value.attention.requests) return null;
        const current = resolveExecutionRunFollowOccurrenceV1({ ...frontier.value, ...source });
        return current && deriveSessionFollowOriginalOccurrenceKeyV1(current.original)
            === deriveSessionFollowOriginalOccurrenceKeyV1(original) ? observation
            : { ...observation, disposition: 'withdrawn' as const, effectiveDelivery: null };
    }));
    return retained.filter((observation): observation is SessionFollowPendingObservationV1 => observation !== null);
}
