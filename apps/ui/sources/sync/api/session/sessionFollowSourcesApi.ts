import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import type { FollowSourceRefV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { parseSessionFollowActionResponse } from '@happier-dev/protocol/sessions/follow/actionTransport';
import type { SessionFollowActionOutputV1 } from '@happier-dev/protocol/sessions/follow/actions';
import { SessionFollowSourceV1Schema, type SessionFollowSourceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { SESSION_FOLLOW_SOURCE_KEY_PREPARATION_WAITING_ACTION_ERROR_V1,
    SessionFollowSourceKeyPreparationResultV1Schema, type SessionFollowSourceKeyPreparationResultV1,
} from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';

import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import { executeSessionFollowAction, executeUiSessionFollowAction, type SessionFollowApiResult } from './sessionFollowApi';
import type { SessionFollowReadInputs } from './sessionFollowRulesApi';

export type SessionFollowSourcesResult<T> = SessionFollowApiResult<T>;
export type SessionFollowSourcesFailure = Extract<SessionFollowApiResult<never>, { kind: 'failed' }>;

/** Source-owned reverse read; personal rows are the caller's own, peopleCount is anonymous. */
export function listSessionFollowers(source: SessionAddress, signal?: AbortSignal, expectedAccountId?: string) {
    return executeSessionFollowAction('follow.list', {
        direction: 'followers', source: { kind: 'session', sessionId: source.sessionId },
    }, source.serverId, signal, expectedAccountId);
}

export async function listSessionFollowSources(destination: SessionAddress, signal?: AbortSignal, expectedAccountId?: string,
    readInputs?: SessionFollowReadInputs) {
    const result = await executeSessionFollowAction('follow.list', {
        direction: 'following',
        receiver: { kind: 'session', sessionId: destination.sessionId },
    }, destination.serverId, signal, expectedAccountId, undefined, readInputs);
    return result.kind === 'ok'
        ? { kind: 'ok' as const, value: { sources: result.value.sources, rules: result.value.rules,
            coverage: result.value.coverage,
            ...(result.value.continuation ? { continuation: result.value.continuation } : {}),
        } }
        : result;
}

/** A Session source by its id, or any other source kind (Discussion, Execution Run, Workflow Run) by its exact ref. */
type SessionFollowSourcePair = Readonly<{
    serverId: string;
    destinationSessionId: string;
}> & (Readonly<{ sourceSessionId: string }> | Readonly<{ source: FollowSourceRefV1 }>);

function readSourceRef(input: SessionFollowSourcePair): FollowSourceRefV1 {
    return 'source' in input ? input.source : { kind: 'session', sessionId: input.sourceSessionId };
}

type SessionFollowSourceSetResult = SessionFollowApiResult<SessionFollowActionOutputV1['follow.set']> & Readonly<{
    committedSource?: SessionFollowSourceV1;
    preparation?: Extract<SessionFollowSourceKeyPreparationResultV1, { kind: 'waiting' }>;
}>;

export async function setSessionFollowSource(input: SessionFollowSourcePair & Readonly<{ policy: FollowPolicyV1 }>): Promise<SessionFollowSourceSetResult> {
    const source = readSourceRef(input);
    const actionInput = {
        receiver: { kind: 'session', sessionId: input.destinationSessionId },
        source,
        policy: input.policy,
    };
    const result = await executeUiSessionFollowAction('follow.set', actionInput, input.serverId,
        value => parseSessionFollowActionResponse('follow.set', actionInput, value));
    if (result.kind !== 'failed' || result.actionFailure?.errorCode !== SESSION_FOLLOW_SOURCE_KEY_PREPARATION_WAITING_ACTION_ERROR_V1) return result;
    const details = result.actionFailure.details;
    if (!details || typeof details !== 'object' || !('edgeCommitted' in details) || details.edgeCommitted !== true
        || !('source' in details) || !('reason' in details) || source.kind !== 'session') return result;
    const committed = SessionFollowSourceV1Schema.safeParse(details.source);
    const preparation = SessionFollowSourceKeyPreparationResultV1Schema.safeParse({ kind: 'waiting', reason: details.reason,
        ...('cause' in details ? { cause: details.cause } : {}),
    });
    if (!committed.success || committed.data.sourceSessionId !== source.sessionId
        || committed.data.destinationSessionId !== input.destinationSessionId
        || !preparation.success || preparation.data.kind !== 'waiting') return result;
    return { ...result, committedSource: committed.data, preparation: preparation.data };
}

export function removeSessionFollowSource(input: SessionFollowSourcePair & Readonly<{ expectedVersion?: number }>) {
    const actionInput = {
        receiver: { kind: 'session', sessionId: input.destinationSessionId },
        source: readSourceRef(input),
        ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
    };
    return executeUiSessionFollowAction('follow.remove', actionInput, input.serverId,
        value => parseSessionFollowActionResponse('follow.remove', actionInput, value));
}
