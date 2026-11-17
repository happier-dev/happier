import * as React from 'react';
import type { Message } from '@happier-dev/session-core/messages';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionMessageInvocationV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageInvocationV1';
import type { SessionInputReturnedAnswerV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { SessionMessageReplyReadResultV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { CoordinationMessageRefV1 } from '@happier-dev/protocol/discussions/references';
import { readSessionMessageReplies, sessionMessageReplyKey } from '@/sync/api/session/sessionMessageReplyApi';
import { subscribeSessionMessageReplyInvalidation } from '@/sync/runtime/sessionMessageReplyInvalidation';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readSessionMessageInvocation, type SessionMessageInvocationEntry } from './readSessionMessageInvocation';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';

export type SessionMessageInvocationTarget = Readonly<{
    target: SessionMessageInvocationV1['targets'][number]['target'];
    localId: string | null;
    /** A supplied operation key is not proof that this question was admitted. */
    requestBound: boolean;
    status: 'queued' | 'held' | 'failed' | 'unknown' | 'answered' | 'passed' | 'cancelled' | 'terminal_no_result';
    code?: string;
    resultRef: CoordinationMessageRefV1 | null;
    replyStatus: SessionMessageReplyReadResultV1['status'] | 'not_requested' | 'loading';
}>;

export type InvocationReadState =
    | Readonly<{ status: 'inactive' | 'unavailable' }>
    | Readonly<{ status: 'ready'; invocation: SessionMessageInvocationV1; refreshing: boolean;
        text: string; origin: 'composer' | 'agent_tool'; sourceRowId: string;
        targets: readonly SessionMessageInvocationTarget[]; refresh: () => void }>;
const EMPTY_RETURNS: readonly SessionInputReturnedAnswerV1[] = Object.freeze([]);
function hasAdmittedRequest(row: SessionMessageInvocationV1['targets'][number]): boolean {
    return Boolean(row.localId) && row.immediate.status !== 'rejected' && row.immediate.status !== 'outcomeUnknown';
}

function outcomeStatus(outcome: string): SessionMessageInvocationTarget['status'] {
    if (outcome === 'answer') return 'answered';
    if (outcome === 'pass') return 'passed';
    if (outcome === 'cancelled' || outcome === 'terminal_no_result') return outcome;
    return 'failed';
}

/** One invocation's real frozen targets. Same-commit row demand shares the API batch owner. No polls or history scans. */
export function useSessionMessageInvocation(input: Readonly<{
    scope: ServerAccountScope | null; sessionId: string; message: Message; active: boolean;
    /** Already admitted returns from this source transcript/Home, associated by its owner. */
    returnedAnswers?: readonly SessionInputReturnedAnswerV1[];
}>): InvocationReadState {
    const entry = React.useMemo(() => input.active && input.scope ? readSessionMessageInvocation(input.message,
        { serverId: input.scope.serverId, sessionId: input.sessionId }) : null,
    [input.active, input.message, input.scope?.serverId, input.sessionId]);
    const invocation = entry?.invocation ?? null;
    const requests = React.useMemo(() => input.active && invocation && input.scope && invocation.reply !== 'none'
        ? invocation.targets.filter(row => hasAdmittedRequest(row) && !row.immediate.outcome
            && areServerProfileIdentifiersEquivalent(row.target.serverId, input.scope!.serverId))
            .map(row => ({ sessionId: row.target.sessionId, localId: row.localId! })) : [],
    [input.active, invocation, input.scope?.serverId]);
    const [revision, refresh] = React.useReducer((value: number) => value + 1, 0);
    const [snapshot, setSnapshot] = React.useState<Readonly<{ invocation: SessionMessageInvocationV1;
        scopeKey: string; replies: ReadonlyMap<string, SessionMessageReplyReadResultV1> }> | null>(null);
    const [reading, setReading] = React.useState(false);
    const scopeKey = JSON.stringify([input.scope?.serverId, input.scope?.accountId]);

    React.useEffect(() => {
        if (!input.scope || !input.active || !requests.length) return;
        const scope = input.scope;
        const unsubscribe = subscribeSessionMessageReplyInvalidation(scope, requests, refresh);
        const disconnected = apiSocket.onReconnected(() => {
            const active = getActiveServerAccountScope();
            if (active?.accountId === scope.accountId && areServerProfileIdentifiersEquivalent(active.serverId, scope.serverId)) refresh();
        });
        return () => { unsubscribe(); disconnected(); };
    }, [input.scope?.serverId, input.scope?.accountId, input.active, requests]);
    React.useEffect(() => {
        if (!input.scope || !input.active || !invocation || !requests.length) return;
        let current = true;
        setReading(true);
        void readSessionMessageReplies({ scope: input.scope, requests, isCurrent: () => current }).then(replies => {
            if (!current) return;
            setSnapshot({ invocation, scopeKey, replies }); setReading(false);
        });
        return () => { current = false; };
    }, [input.scope?.serverId, input.scope?.accountId, input.active, invocation, requests, revision]);

    const returns = input.returnedAnswers ?? EMPTY_RETURNS;
    return React.useMemo((): InvocationReadState => {
        if (!input.active) return { status: 'inactive' };
        return projectSessionMessageInvocationRead({
            entry, homeServerId: input.scope?.serverId ?? null, sourceRowId: input.message.id,
            replies: snapshot?.invocation === invocation && snapshot.scopeKey === scopeKey ? snapshot.replies : null,
            returnedAnswers: returns, refreshing: reading && requests.length > 0, refresh,
        });
    }, [input.active, invocation, input.scope?.serverId, scopeKey, snapshot, returns, reading, requests, entry, input.message.id]);
}

/**
 * One invocation's targets from its frozen source entry, the Home's reply reads and the returns already in the
 * transcript. Pure: the hook supplies live reads; a specimen supplies settled ones.
 */
export function projectSessionMessageInvocationRead(input: Readonly<{
    entry: SessionMessageInvocationEntry | null;
    /** The asker's Home; null means no account scope, so the record is unavailable. */
    homeServerId: string | null;
    sourceRowId: string;
    replies: ReadonlyMap<string, SessionMessageReplyReadResultV1> | null;
    returnedAnswers: readonly SessionInputReturnedAnswerV1[];
    refreshing: boolean;
    refresh: () => void;
}>): Exclude<InvocationReadState, Readonly<{ status: 'inactive' }>> {
    const invocation = input.entry?.invocation ?? null;
    const homeServerId = input.homeServerId;
    if (!invocation || !homeServerId) return { status: 'unavailable' };
    const returned = new Map<string, SessionInputReturnedAnswerV1>();
    for (const answer of input.returnedAnswers) returned.set(sessionMessageReplyKey({ sessionId: answer.requestSessionId, localId: answer.requestLocalId }), answer);
    const replies = input.replies;
    const targets = invocation.targets.map((row): SessionMessageInvocationTarget => {
        const sameHome = areServerProfileIdentifiersEquivalent(row.target.serverId, homeServerId);
        const requestBound = hasAdmittedRequest(row);
        const key = requestBound && row.localId ? sessionMessageReplyKey({ sessionId: row.target.sessionId, localId: row.localId }) : null;
        const reply = sameHome && key ? replies?.get(key) : undefined;
        const answer = sameHome && key ? returned.get(key) : undefined;
        const outcome = reply?.status === 'available' ? reply.progress.outcome : undefined;
        const status = outcome ? outcomeStatus(outcome.kind) : answer ? outcomeStatus(answer.outcome)
            : row.immediate.outcome ? outcomeStatus(row.immediate.outcome)
            : row.immediate.status === 'held' && !(reply?.status === 'available' && reply.progress.acceptedTurnId) ? 'held' : row.immediate.status === 'outcomeUnknown' ? 'unknown'
            : row.immediate.status === 'rejected' || row.immediate.status === 'failed' ? 'failed'
            : row.immediate.status === 'cancelled' ? 'cancelled' : 'queued';
        const resultRef: CoordinationMessageRefV1 | null = outcome
            ? 'result' in outcome
                ? { kind: 'session', session: { serverId: row.target.serverId, sessionId: outcome.result.sessionId }, messageId: outcome.result.messageId }
                : 'publicationRef' in outcome ? outcome.publicationRef : null
            : answer?.sourceMessageRef ?? row.immediate.resultRef ?? null;
        return { target: row.target, localId: row.localId ?? null, requestBound, status,
            ...(row.immediate.code && !outcome && !answer && !row.immediate.outcome ? { code: row.immediate.code } : {}), resultRef,
            replyStatus: row.immediate.status === 'outcomeUnknown' ? 'unavailable'
                : invocation.reply === 'none' || row.immediate.outcome || row.immediate.status === 'rejected' ? 'not_requested'
                : reply?.status ?? (sameHome && row.localId ? 'loading' : 'unavailable') };
    });
    return { status: 'ready', invocation, targets, refreshing: input.refreshing, refresh: input.refresh,
        text: input.entry?.text ?? '', origin: input.entry?.origin ?? 'composer', sourceRowId: input.sourceRowId };
}
