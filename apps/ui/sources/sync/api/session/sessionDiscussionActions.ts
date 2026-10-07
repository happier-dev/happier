import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { buildSessionDiscussionMutationRequestBodyV1, SessionDiscussionCreateResponseV1Schema, SessionDiscussionDetailsResponseV1Schema, SessionDiscussionErrorResponseV1Schema, SessionDiscussionListResponseV1Schema, SessionDiscussionMessagesResponseV1Schema, SessionDiscussionPostResponseV1Schema, SessionDiscussionReadResponseV1Schema } from '@happier-dev/protocol/sessions/discussions/api';
import { bindSessionDiscussionActionHttpRequestV1 } from '@happier-dev/protocol/actions/sessionDiscussionActionFamily';
import { SessionDiscussionCreateInputV1Schema, SessionDiscussionCreateResultV1Schema, SessionDiscussionDetailsResultV1Schema, SessionDiscussionListInputV1Schema, SessionDiscussionListResultV1Schema, SessionDiscussionOpenedMessageV1Schema, SessionDiscussionOpenedSummaryV1Schema, SessionDiscussionPostInputV1Schema, SessionDiscussionPostResultV1Schema, SessionDiscussionReadInputV1Schema, SessionDiscussionReadResultV1Schema, SessionDiscussionReadStateResultV1Schema, SessionDiscussionRenameInputV1Schema, type SessionDiscussionCreateResultV1, type SessionDiscussionDetailsResultV1, type SessionDiscussionListInputV1, type SessionDiscussionListResultV1, type SessionDiscussionOpenedMessageV1, type SessionDiscussionOpenedSummaryV1, type SessionDiscussionPostResultV1, type SessionDiscussionReadResultV1, type SessionDiscussionReadStateResultV1 } from '@happier-dev/protocol/sessions/discussions/actions';
import { SessionDiscussionMessageContentV1Schema, SessionDiscussionTitleV1Schema, type SessionDiscussionMessageContentV1 } from '@happier-dev/protocol/sessions/discussions/content';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { serializeSessionDiscussionMutationEqualityIntentV1 } from '@happier-dev/protocol/sessions/discussions/equality';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { SessionDiscussionActionIdV1 } from '@happier-dev/protocol/sessions/discussions/actionIds';
import type { SessionDiscussionMessageV1, SessionDiscussionSummaryV1 } from '@happier-dev/protocol/sessions/discussions/models';
import type { SessionMutationEqualityEvidenceV1 } from '@happier-dev/protocol/sessions/mutations/sessionMutationEqualityV1';
import type { SessionResponsibilityCandidatesResponse } from '@happier-dev/protocol/sessions/access/sessionResponsibilityV1';
import type { SessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { randomUUID } from '@/platform/randomUUID';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import {
    openSessionStoredContent,
    sealSessionStoredContent,
    type SessionStoredContentContext,
} from '@happier-dev/sync-client';
import { listSessionResponsibilityMentionCandidates } from './apiSessionResponsibility';

export async function listSessionDiscussionMentionCandidates(params: Readonly<{
    scope: ServerAccountScope;
    session: SessionAddress;
    availability: SessionCollaborationAvailability;
    query?: string;
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
}>): Promise<SessionResponsibilityCandidatesResponse> {
    if (!areServerProfileIdentifiersEquivalent(params.scope.serverId, params.session.serverId)) {
        throw new Error('Discussion mention candidates require the exact Session Home');
    }
    return await listSessionResponsibilityMentionCandidates(params.scope, {
        sessionId: params.session.sessionId,
        ...(params.query !== undefined ? { query: params.query } : {}),
        ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
    }, {
        availability: params.availability,
        ...(params.signal ? { signal: params.signal } : {}),
    });
}

function failure(errorCode: string) {
    return { ok: false as const, errorCode, error: errorCode };
}

async function openSummary(context: SessionStoredContentContext | null, row: SessionDiscussionSummaryV1): Promise<SessionDiscussionOpenedSummaryV1> {
    const opened = await openSessionStoredContent(context, row.titleContent);
    const title = opened.status === 'ready' ? SessionDiscussionTitleV1Schema.safeParse(opened.value) : null;
    const { titleContent: _titleContent, ...projection } = row;
    return SessionDiscussionOpenedSummaryV1Schema.parse({ ...projection, title: title?.success === true ? title.data.title : null });
}

async function openMessage(context: SessionStoredContentContext | null, row: SessionDiscussionMessageV1): Promise<SessionDiscussionOpenedMessageV1> {
    const opened = await openSessionStoredContent(context, row.content);
    const content = opened.status === 'ready' ? SessionDiscussionMessageContentV1Schema.safeParse(opened.value) : null;
    const { content: _content, ...projection } = row;
    return SessionDiscussionOpenedMessageV1Schema.parse({ ...projection, content: content?.success === true ? content.data : null });
}

function discussionEqualityEvidence(context: SessionStoredContentContext | null, canonicalIntent: string):
    | Readonly<{ status: 'ready'; evidence?: SessionMutationEqualityEvidenceV1 }>
    | Readonly<{ status: 'locked' }> {
    if (context?.mode !== 'e2ee') return { status: 'ready' };
    const derive = context.encryption?.deriveDiscussionMutationEqualityTagV1;
    if (!derive) return { status: 'locked' };
    return { status: 'ready', evidence: { kind: 'e2eeTag', tag: derive(canonicalIntent) } };
}

/** One UI host adapter: Action transport + existing Session cipher + Protocol final-body/response owners. */
export function createSessionDiscussionActionAdapter(options: Readonly<{
    request: (path: string, init?: RequestInit) => Promise<Response>;
    contentContext: SessionStoredContentContext | null;
    session: SessionAddress;
    availability: SessionCollaborationAvailability;
}>): NonNullable<ActionExecutorDeps['sessionDiscussionAction']> {
    return async ({ actionId, input, context, signal }) => {
        if (options.availability === 'unavailable') return failure('unsupported_action');
        const sessionId = typeof input === 'object' && input !== null && 'sessionId' in input && typeof input.sessionId === 'string'
            ? input.sessionId : context.defaultSessionId;
        // A replay carries the origin's device-local profile id while the
        // captured scope addresses the Session by the Home's scope id; the
        // profile owner decides whether they name the same Home.
        if (!sessionId || sessionId !== options.session.sessionId
            || (context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, options.session.serverId))) {
            return failure('session_discussion_not_found');
        }
        let bound;
        try { bound = bindSessionDiscussionActionHttpRequestV1(actionId, input); }
        catch { return failure('session_discussion_invalid_content'); }
        let body = bound.body;

        if (actionId === 'session.discussion.create') {
            const args = SessionDiscussionCreateInputV1Schema.parse(input);
            const title = SessionDiscussionTitleV1Schema.parse({ v: 1, title: args.title });
            const content = SessionDiscussionMessageContentV1Schema.parse(args.firstMessage.content);
            const mentionedAccountIds = args.firstMessage.mentionedAccountIds ?? [];
            const creationLocalId = args.creationLocalId ?? randomUUID();
            const messageLocalId = args.firstMessage.localId ?? randomUUID();
            const creationEvidence = discussionEqualityEvidence(options.contentContext, serializeSessionDiscussionMutationEqualityIntentV1({
                kind: 'create', title, firstMessage: { localId: messageLocalId, content, mentionedAccountIds },
            }));
            const messageEvidence = discussionEqualityEvidence(options.contentContext, serializeSessionDiscussionMutationEqualityIntentV1({
                kind: 'post', content, mentionedAccountIds,
            }));
            if (creationEvidence.status !== 'ready' || messageEvidence.status !== 'ready') return failure('session_discussion_encryption_mode_mismatch');
            const [sealedTitle, sealedMessage] = await Promise.all([
                sealSessionStoredContent(options.contentContext, StrictJsonValueSchema.parse(title)),
                sealSessionStoredContent(options.contentContext, StrictJsonValueSchema.parse(content)),
            ]);
            if (sealedTitle.status !== 'ready' || sealedMessage.status !== 'ready') return failure('session_discussion_encryption_mode_mismatch');
            body = buildSessionDiscussionMutationRequestBodyV1({
                kind: 'create', creationLocalId,
                ...(creationEvidence.evidence?.kind === 'e2eeTag' ? { creationEqualityEvidenceV1: creationEvidence.evidence } : {}),
                titleContent: sealedTitle.content,
                firstMessage: {
                    localId: messageLocalId,
                    ...(messageEvidence.evidence?.kind === 'e2eeTag' ? { requestEqualityEvidenceV1: messageEvidence.evidence } : {}),
                    content: sealedMessage.content,
                    mentionedAccountIds,
                },
            });
        } else if (actionId === 'session.discussion.post') {
            const args = SessionDiscussionPostInputV1Schema.parse(input);
            const content = SessionDiscussionMessageContentV1Schema.parse(args.content);
            const mentionedAccountIds = args.mentionedAccountIds ?? [];
            const evidence = discussionEqualityEvidence(options.contentContext, serializeSessionDiscussionMutationEqualityIntentV1({ kind: 'post', content, mentionedAccountIds }));
            if (evidence.status !== 'ready') return failure('session_discussion_encryption_mode_mismatch');
            const sealed = await sealSessionStoredContent(options.contentContext, StrictJsonValueSchema.parse(content));
            if (sealed.status !== 'ready') return failure('session_discussion_encryption_mode_mismatch');
            body = buildSessionDiscussionMutationRequestBodyV1({
                kind: 'post', localId: args.localId ?? randomUUID(),
                ...(evidence.evidence?.kind === 'e2eeTag' ? { requestEqualityEvidenceV1: evidence.evidence } : {}),
                content: sealed.content, mentionedAccountIds,
            });
        } else if (actionId === 'session.discussion.rename') {
            const args = SessionDiscussionRenameInputV1Schema.parse(input);
            const title = SessionDiscussionTitleV1Schema.parse({ v: 1, title: args.title });
            const sealed = await sealSessionStoredContent(options.contentContext, StrictJsonValueSchema.parse(title));
            if (sealed.status !== 'ready') return failure('session_discussion_encryption_mode_mismatch');
            body = buildSessionDiscussionMutationRequestBodyV1({ kind: 'rename', titleContent: sealed.content });
        }

        signal?.throwIfAborted();
        let response: Response;
        try {
            response = await options.request(bound.path, { method: bound.method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal });
        } catch {
            return failure(signal?.aborted ? 'canceled' : 'outcome_unknown');
        }
        let payload: unknown;
        try { payload = await response.json(); }
        catch { return failure('outcome_unknown'); }
        if (!response.ok) {
            const error = SessionDiscussionErrorResponseV1Schema.safeParse(payload);
            return error.success ? failure(error.data.error) : failure('outcome_unknown');
        }

        if (actionId === 'session.discussion.list') {
            const value = SessionDiscussionListResponseV1Schema.safeParse(payload);
            if (!value.success) return failure('outcome_unknown');
            const discussions = await Promise.all(value.data.discussions.map((row) => openSummary(options.contentContext, row)));
            return SessionDiscussionListResultV1Schema.parse({ v: 1, serverId: options.session.serverId, sessionId, discussions, nextCursor: value.data.nextCursor, incomplete: discussions.some((row) => row.title === null) });
        }
        if (actionId === 'session.discussion.get' || actionId === 'session.discussion.rename' || actionId === 'session.discussion.archive' || actionId === 'session.discussion.restore') {
            const value = SessionDiscussionDetailsResponseV1Schema.safeParse(payload);
            if (!value.success) return failure('outcome_unknown');
            return SessionDiscussionDetailsResultV1Schema.parse({ v: 1, serverId: options.session.serverId, sessionId, discussion: await openSummary(options.contentContext, value.data.discussion) });
        }
        if (actionId === 'session.discussion.read') {
            const args = SessionDiscussionReadInputV1Schema.parse(input);
            const value = SessionDiscussionMessagesResponseV1Schema.safeParse(payload);
            if (!value.success) return failure('outcome_unknown');
            const messages = await Promise.all(value.data.messages.map((row) => openMessage(options.contentContext, row)));
            return SessionDiscussionReadResultV1Schema.parse({ v: 1, serverId: options.session.serverId, sessionId, discussionId: args.discussionId, messages, hasMoreOlder: value.data.hasMoreOlder, messageSeq: value.data.messageSeq, incomplete: messages.some((row) => row.content === null) });
        }
        if (actionId === 'session.discussion.create') {
            const value = SessionDiscussionCreateResponseV1Schema.safeParse(payload);
            if (!value.success) return failure('outcome_unknown');
            return SessionDiscussionCreateResultV1Schema.parse({ v: 1, serverId: options.session.serverId, sessionId, discussion: await openSummary(options.contentContext, value.data.discussion), firstMessage: await openMessage(options.contentContext, value.data.firstMessage) });
        }
        if (actionId === 'session.discussion.post') {
            const value = SessionDiscussionPostResponseV1Schema.safeParse(payload);
            if (!value.success) return failure('outcome_unknown');
            return SessionDiscussionPostResultV1Schema.parse({ v: 1, serverId: options.session.serverId, sessionId, message: await openMessage(options.contentContext, value.data.message), messageSeq: value.data.messageSeq });
        }
        const value = SessionDiscussionReadResponseV1Schema.safeParse(payload);
        return value.success ? SessionDiscussionReadStateResultV1Schema.parse({ v: 1, serverId: options.session.serverId, sessionId, cursor: value.data }) : failure('outcome_unknown');
    };
}

export type SessionDiscussionClientOutcome<T> =
    | Readonly<{ kind: 'succeeded'; value: T }>
    | Readonly<{ kind: 'approval_request_created'; artifactId: string; actionId: string }>
    | Readonly<{ kind: 'failed'; errorCode: string }>;

type OutputSchema<T> = Readonly<{ safeParse(value: unknown): { success: true; data: T } | { success: false } }>;

function parseClientOutcome<T>(value: unknown, schema: OutputSchema<T>): SessionDiscussionClientOutcome<T> {
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(value);
    if (approval.success) return {
        kind: 'approval_request_created',
        artifactId: approval.data.artifactId,
        actionId: approval.data.actionId,
    };
    const parsed = schema.safeParse(value);
    return parsed.success ? { kind: 'succeeded', value: parsed.data } : { kind: 'failed', errorCode: 'outcome_unknown' };
}

export function createSessionDiscussionClient(options: Readonly<{ session: SessionAddress; availability: SessionCollaborationAvailability }>) {
    const execute = async (actionId: SessionDiscussionActionIdV1, input: unknown, signal?: AbortSignal): Promise<SessionDiscussionClientOutcome<unknown>> => {
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor({
            sessionDiscussionAction: async (args) => {
                const result = await import('@/sync/sync').then(({ sync }) => sync.withSessionSystemRecordRuntime(options.session, async (runtime) => await createSessionDiscussionActionAdapter({ request: runtime.request, contentContext: runtime.contentContext, session: options.session, availability: options.availability })(args)));
                return result.status === 'ok' ? result.value : failure(result.status);
            },
        });
        const result = await executor.execute(actionId, input, { surface: 'ui', serverId: options.session.serverId, defaultSessionId: options.session.sessionId, ...(signal ? { signal } : {}) });
        return result.ok ? { kind: 'succeeded', value: result.result } : { kind: 'failed', errorCode: result.errorCode };
    };
    const run = async <T>(actionId: SessionDiscussionActionIdV1, input: unknown, schema: OutputSchema<T>, signal?: AbortSignal): Promise<SessionDiscussionClientOutcome<T>> => {
        const outcome = await execute(actionId, input, signal);
        return outcome.kind === 'succeeded' ? parseClientOutcome(outcome.value, schema) : outcome;
    };
    return {
        list: (input: Omit<SessionDiscussionListInputV1, 'sessionId'> = {}, signal?: AbortSignal) => run<SessionDiscussionListResultV1>('session.discussion.list', { sessionId: options.session.sessionId, ...input }, SessionDiscussionListResultV1Schema, signal),
        get: (discussionId: string, signal?: AbortSignal) => run<SessionDiscussionDetailsResultV1>('session.discussion.get', { sessionId: options.session.sessionId, discussionId }, SessionDiscussionDetailsResultV1Schema, signal),
        read: (discussionId: string, input: Readonly<{ beforeSeq?: number; afterSeq?: number; limit?: number }> = {}, signal?: AbortSignal) => run<SessionDiscussionReadResultV1>('session.discussion.read', { sessionId: options.session.sessionId, discussionId, ...input }, SessionDiscussionReadResultV1Schema, signal),
        create: (input: Readonly<{ creationLocalId: string; messageLocalId: string; title: string; content: SessionDiscussionMessageContentV1; mentionedAccountIds?: readonly string[] }>, signal?: AbortSignal) => run<SessionDiscussionCreateResultV1>('session.discussion.create', { sessionId: options.session.sessionId, creationLocalId: input.creationLocalId, title: input.title, firstMessage: { localId: input.messageLocalId, content: input.content, mentionedAccountIds: input.mentionedAccountIds ?? [] } }, SessionDiscussionCreateResultV1Schema, signal),
        post: (input: Readonly<{ discussionId: string; localId: string; content: SessionDiscussionMessageContentV1; mentionedAccountIds?: readonly string[] }>, signal?: AbortSignal) => run<SessionDiscussionPostResultV1>('session.discussion.post', { sessionId: options.session.sessionId, discussionId: input.discussionId, localId: input.localId, content: input.content, mentionedAccountIds: input.mentionedAccountIds ?? [] }, SessionDiscussionPostResultV1Schema, signal),
        rename: (discussionId: string, title: string, signal?: AbortSignal) => run<SessionDiscussionDetailsResultV1>('session.discussion.rename', { sessionId: options.session.sessionId, discussionId, title }, SessionDiscussionDetailsResultV1Schema, signal),
        archive: (discussionId: string, signal?: AbortSignal) => run<SessionDiscussionDetailsResultV1>('session.discussion.archive', { sessionId: options.session.sessionId, discussionId }, SessionDiscussionDetailsResultV1Schema, signal),
        restore: (discussionId: string, signal?: AbortSignal) => run<SessionDiscussionDetailsResultV1>('session.discussion.restore', { sessionId: options.session.sessionId, discussionId }, SessionDiscussionDetailsResultV1Schema, signal),
        readState: (discussionId: string, lastReadSeq: number, signal?: AbortSignal) => run<SessionDiscussionReadStateResultV1>('session.discussion.read_state.set', { sessionId: options.session.sessionId, discussionId, lastReadSeq }, SessionDiscussionReadStateResultV1Schema, signal),
    };
}
