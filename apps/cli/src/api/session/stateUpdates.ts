import { backoff } from '@/utils/time';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import { SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT, SessionRuntimeActivitySnapshotAckSchema, SessionRuntimeActivitySnapshotRequestSchema, type SessionRuntimeActivitySnapshotAck } from '@happier-dev/protocol/sessions/runtime/activity/transport';

type AckableSocket = {
    emitWithAck(event: string, ...args: unknown[]): Promise<unknown>;
    connected?: boolean;
    timeout?: (ms: number) => AckableSocket;
};

type SessionStateUpdateError = Error & {
    code: string;
    retryable: boolean;
};

export class SessionRuntimeActivitySnapshotRejectedError extends Error {
    readonly code = 'runtime_activity_update_failed';
    readonly retryable = false;

    constructor(readonly reason: Extract<SessionRuntimeActivitySnapshotAck, { status: 'rejected' }>['reason']) {
        super(`runtime activity update failed: ${reason}`);
        this.name = 'SessionRuntimeActivitySnapshotRejectedError';
    }
}

function createSessionStateUpdateError(message: string, code: string, retryable: boolean): SessionStateUpdateError {
    const error = new Error(message) as SessionStateUpdateError;
    error.code = code;
    error.retryable = retryable;
    return error;
}

export async function updateSessionRuntimeActivityProjectionWithAck(opts: {
    socket: AckableSocket;
    signal?: AbortSignal;
    sessionId: string;
    mutationId: string;
    state: 'active' | 'idle' | 'unknown';
    runtimeActivityActiveCount: number;
}): Promise<Readonly<{
    disposition: 'applied' | 'unchanged';
    projection: Readonly<{
    runtimeActivityState: 'active' | 'idle' | 'unknown';
    runtimeActivityActiveCount: number;
    runtimeActivityObservedAt: number | null;
    runtimeActivityRevision: number;
    }>;
}>> {
    return await backoff(async () => {
        const request = SessionRuntimeActivitySnapshotRequestSchema.parse({
            sessionId: opts.sessionId,
            mutationId: opts.mutationId,
            snapshot: {
                state: opts.state,
                activeCount: opts.runtimeActivityActiveCount,
            },
        });
        const rawAnswer = await emitSocketWithAck<unknown>({
            socket: opts.socket,
            event: SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT,
            timeoutMs: null,
            signal: opts.signal,
            payload: request,
        });
        const parsedAnswer =
            SessionRuntimeActivitySnapshotAckSchema.safeParse(rawAnswer);
        if (!parsedAnswer.success) {
            throw createSessionStateUpdateError(
                'runtime activity update failed: invalid acknowledgement',
                'runtime_activity_update_failed',
                true,
            );
        }
        const answer = parsedAnswer.data;

        if (answer.status === 'rejected' && (
            answer.reason === 'invalid_request'
            || (answer.sessionId === opts.sessionId && answer.mutationId === opts.mutationId)
        )) {
            throw new SessionRuntimeActivitySnapshotRejectedError(answer.reason);
        }

        if (
            (answer.status === 'applied' || answer.status === 'unchanged')
            && answer.sessionId === opts.sessionId
            && answer.mutationId === opts.mutationId
        ) {
            return {
                disposition: answer.status,
                projection: {
                    runtimeActivityState: answer.projection.state,
                    runtimeActivityActiveCount: answer.projection.activeCount,
                    runtimeActivityObservedAt: answer.projection.observedAt,
                    runtimeActivityRevision: answer.projection.revision,
                },
            };
        }

        throw createSessionStateUpdateError(
            `runtime activity update failed: ${
                'reason' in answer ? answer.reason : answer.status
            }`,
            'runtime_activity_update_failed',
            true,
        );
    });
}
