import {
    SessionHandoffPrepareTargetResumeResponseSchema,
    SessionHandoffStatusSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { randomUUID } from '@/platform/randomUUID';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export type ResumeActionOperationHandoffResult =
    | Readonly<{ kind: 'requested' }>
    | Readonly<{ kind: 'not_available' }>
    | Readonly<{ kind: 'failed'; message: string }>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function failureMessage(value: unknown): string {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : 'session_handoff_resume_failed';
}

export async function resumeActionOperationHandoff(params: Readonly<{
    handoffId: string;
    sessionId: string;
    targetMachineId: string;
    createAttemptId?: () => string;
}>): Promise<ResumeActionOperationHandoffResult> {
    if (!params.targetMachineId.trim()) return { kind: 'not_available' };
    let statusEnvelope: Readonly<Record<string, unknown>> | null;
    try {
        statusEnvelope = readRecord(await machineRpcWithServerScope<unknown, { handoffId: string }>({
            machineId: params.targetMachineId,
            method: RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET,
            payload: { handoffId: params.handoffId },
        }));
    } catch (error) {
        return { kind: 'failed', message: failureMessage(error instanceof Error ? error.message : error) };
    }
    const status = SessionHandoffStatusSchema.safeParse(statusEnvelope?.status);
    const transitionRevision = statusEnvelope?.transitionRevision;
    if (
        !status.success
        || status.data.handoffId !== params.handoffId
        || status.data.status !== 'awaiting_user_resume'
        || typeof status.data.jobId !== 'string'
        || status.data.jobId.length === 0
        || typeof transitionRevision !== 'number'
        || !Number.isSafeInteger(transitionRevision)
        || transitionRevision < 0
    ) {
        return { kind: 'not_available' };
    }

    let resumeResult: unknown;
    try {
        resumeResult = await machineRpcWithServerScope<unknown, {
            handoffId: string;
            jobId: string;
            expectedRevision: number;
            attemptId: string;
        }>({
            machineId: params.targetMachineId,
            method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESUME,
            payload: {
            handoffId: params.handoffId,
            jobId: status.data.jobId,
            expectedRevision: transitionRevision,
            attemptId: (params.createAttemptId ?? randomUUID)(),
            },
        });
    } catch (error) {
        return { kind: 'failed', message: failureMessage(error instanceof Error ? error.message : error) };
    }

    const parsed = SessionHandoffPrepareTargetResumeResponseSchema.safeParse(resumeResult);
    if (!parsed.success) return { kind: 'failed', message: 'session_handoff_resume_invalid_response' };
    if (!parsed.data.ok) return { kind: 'failed', message: parsed.data.error.message };
    return { kind: 'requested' };
}
