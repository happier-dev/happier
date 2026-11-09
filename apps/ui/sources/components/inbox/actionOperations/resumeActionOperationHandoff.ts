import {
    SessionHandoffStatusSchema,
    type SessionHandoffPrepareTargetResumeResponse,
} from '@happier-dev/protocol/sessions/control/handoff/handoffSchemas';

import { randomUUID } from '@/platform/randomUUID';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';

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
    serverId: string | null;
    handoffId: string;
    sessionId: string;
    targetMachineId: string;
    createAttemptId?: () => string;
    signal?: AbortSignal;
}>): Promise<ResumeActionOperationHandoffResult> {
    if (!params.serverId?.trim() || !params.targetMachineId.trim()) return { kind: 'not_available' };
    const executor = createDefaultActionExecutor();
    // These are private lifecycle continuations, intentionally absent from external UI discovery.
    const context = { surface: 'rpc' as const, authority: 'present_user' as const,
        serverId: params.serverId, defaultSessionId: params.sessionId,
        externalActionTarget: { kind: 'machine' as const, machineId: params.targetMachineId },
        ...(params.signal ? { signal: params.signal } : {}) };
    let statusEnvelope: Readonly<Record<string, unknown>> | null;
    try {
        const result = await executor.execute('session.handoff.status.get', { handoffId: params.handoffId }, context);
        if (!result.ok) return { kind: 'failed', message: failureMessage(result.error) };
        statusEnvelope = readRecord(result.result);
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

    let resumeResult: SessionHandoffPrepareTargetResumeResponse;
    try {
        params.signal?.throwIfAborted();
        const result = await executor.execute('session.handoff.prepare_target.resume', {
            handoffId: params.handoffId,
            jobId: status.data.jobId,
            expectedRevision: transitionRevision,
            attemptId: (params.createAttemptId ?? randomUUID)(),
        }, context);
        if (!result.ok) return { kind: 'failed', message: result.errorCode === 'invalid_action_output'
            ? 'session_handoff_resume_invalid_response' : failureMessage(result.error) };
        // The Action executor validates this private Action's canonical output schema.
        resumeResult = result.result as SessionHandoffPrepareTargetResumeResponse;
    } catch (error) {
        return { kind: 'failed', message: failureMessage(error instanceof Error ? error.message : error) };
    }

    if (!resumeResult.ok) return { kind: 'failed', message: resumeResult.error.message };
    return { kind: 'requested' };
}
