import {
    resolveSessionMutationMaxAgeMs,
    resolveSessionMutationMaxAttempts,
} from './sessionMutationBackoff';
import { createSessionMutationDeadLetterEntry } from './sessionMutationPersistence';
import type { SessionRuntimeActivityProjection } from '@happier-dev/protocol';
import type { QueuedSessionMutation } from './sessionMutationTypes';
import type { SessionMutationDeadLetterEntry } from './sessionMutationPersistence';
import { isAuthoritativeSessionMutation } from './sessionMutationDurabilityPolicy';

export type SessionMutationDeliveredPath =
    | 'socket'
    | 'http'
    | 'legacy_socket_ack'
    | 'legacy_socket_proof';

export type SessionMutationDeliveryOutcome =
    | Readonly<{
        status: 'delivered';
        path: SessionMutationDeliveredPath;
        runtimeActivityEvidence?: Readonly<{
            disposition: 'applied' | 'unchanged';
            projection: SessionRuntimeActivityProjection;
        }>;
    }>
    | Readonly<{
        status: 'ignored_lossy';
        reason: string;
        httpStatus?: number;
    }>
    | Readonly<{
        status: 'retryable';
        reason: string;
        httpStatus?: number;
    }>
    | Readonly<{
        status: 'unsupported_capability';
        reason: string;
        diagnostic?: unknown;
    }>
    | Readonly<{
        status: 'permanent_invalid_payload';
        reason: string;
        diagnostic?: unknown;
    }>;

export function shouldDeadLetterFailedMutation(
    mutation: QueuedSessionMutation,
    now: number,
    outcome?: Exclude<SessionMutationDeliveryOutcome, { status: 'delivered' }>,
): boolean {
    if (outcome?.status === 'permanent_invalid_payload') return true;
    if (isAuthoritativeSessionMutation(mutation)) return false;
    if (outcome?.status === 'unsupported_capability' && mutation.kind === 'session_turn') return false;
    const maxAgeMs = resolveSessionMutationMaxAgeMs();
    return (
        mutation.attempts >= resolveSessionMutationMaxAttempts()
        || (maxAgeMs > 0 && now - mutation.createdAt >= maxAgeMs)
    );
}

export function createDeliveryDiagnostic(
    outcome: Exclude<SessionMutationDeliveryOutcome, { status: 'delivered' }>,
): Record<string, unknown> {
    return {
        deliveryStatus: outcome.status,
        reason: outcome.reason,
        ...('httpStatus' in outcome && outcome.httpStatus !== undefined ? { httpStatus: outcome.httpStatus } : {}),
        ...('diagnostic' in outcome && outcome.diagnostic ? { deliveryDiagnostic: outcome.diagnostic } : {}),
    };
}

function resolveTurnDependencyKey(mutation: QueuedSessionMutation): string | null {
    if (mutation.kind !== 'session_turn') return null;
    const turnId = mutation.payload.turnId;
    return typeof turnId === 'string' && turnId.length > 0 ? turnId : null;
}

export function deadLetterDependentMutations(params: Readonly<{
    batch: readonly QueuedSessionMutation[];
    startIndex: number;
    failedMutation: QueuedSessionMutation;
    deadLetters: SessionMutationDeadLetterEntry[];
}>): number {
    const failedDependencyKey = resolveTurnDependencyKey(params.failedMutation);
    if (!failedDependencyKey) return params.startIndex;
    let index = params.startIndex;
    while (index < params.batch.length) {
        const candidate = params.batch[index];
        if (resolveTurnDependencyKey(candidate) !== failedDependencyKey) break;
        params.deadLetters.push(createSessionMutationDeadLetterEntry({
            sessionId: params.failedMutation.payload.sessionId,
            mutation: candidate,
            reason: 'blocked_by_dead_lettered_dependency',
            dependencyMutationId: params.failedMutation.mutationId,
        }));
        index += 1;
    }
    return index;
}
