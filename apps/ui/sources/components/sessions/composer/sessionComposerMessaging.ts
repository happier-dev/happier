import { MENTION_KIND_V1, parseMentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { SessionIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import type { SessionDraftSessionMessagingValueV1 } from '@happier-dev/protocol/drafts/sessionDrafts';
import { ActionSessionFanoutResultV1Schema } from '@happier-dev/protocol/actions/sessionTargetV1';
import { SessionMessageSendResultV1Schema, SessionMessageSendActionResultV1Schema, type SessionMessageSendResultV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import type { ComposerAttachmentDraftV1 } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import type { ComposerContentHandleV1 } from '@happier-dev/protocol/runtime/input/composerContentV1';
import type { RawIngressStructuredInputV1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { captureComposerContentSubmission, releaseComposerContent } from '@/sync/domains/transfers/runtime/transferRuntime/families/composerMediaStageTransfers';
import type { ComposerSubmissionSnapshot } from './composerSubmissionCoordinator';
import { projectSessionMessageInvocationV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageInvocationV1';
import { persistSessionMessageInvocation } from '@/sync/api/session/sessionMessageInvocationApi';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readSessionMessagingDraftMutationAttempt, retainSessionMessagingDraftCustody, flushSessionDraftLocally,
    type SessionDraftRepository, type SessionMessagingDraftCustody } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

export type SessionComposerMessageIntent = SessionDraftSessionMessagingValueV1;

export async function recordSessionComposerMessageResult(input: Readonly<{
    scope: ServerAccountScope;
    sessionId: string;
    localId: string;
    text: string;
    intent: Exclude<SessionComposerMessageIntent, { kind: 'post_update' }>;
    result: ActionExecuteResult;
    isCurrent: () => boolean;
}>): Promise<void> {
    if (!input.isCurrent()) throw new Error('Composer submission retired');
    if (input.result.ok && ActionApprovalRequestCreatedResultSchema.safeParse(input.result.result).success) return;
    const invocation = projectSessionMessageInvocationV1({ serverId: input.scope.serverId, localId: input.localId,
        requestLocalId: input.localId, target: input.intent.target,
        reply: input.intent.kind === 'ask' ? input.intent.reply ?? 'return' : 'none', result: input.result });
    await persistSessionMessageInvocation({ ...input, invocation });
}

/** The composer admits the real Action and retains its result before relinquishing the captured draft. */
export async function submitSessionComposerMessagingAction(input: Omit<Parameters<typeof recordSessionComposerMessageResult>[0], 'result'>
    & Readonly<{ execute: FrontDoorActionExecute; actionInput: unknown; context: Parameters<FrontDoorActionExecute>[2];
        /** Captured Home/Account authority survives presentation retirement, never Account retirement. */
        isAccountCurrent: () => boolean;
        draftRepository?: Pick<SessionDraftRepository, 'readSessionMessagingDraftMutationAttempt' | 'retainSessionMessagingDraftCustody' | 'flushSessionDraftLocally'>;
    }>): Promise<ActionExecuteResult> {
    if (!input.isCurrent()) throw new Error('Composer submission retired');
    const repository = input.draftRepository ?? { readSessionMessagingDraftMutationAttempt, retainSessionMessagingDraftCustody, flushSessionDraftLocally };
    const attempt = repository.readSessionMessagingDraftMutationAttempt(input);
    if (!attempt || attempt.localId !== input.localId) throw new Error('Composer draft attempt unavailable');
    let custody = attempt.custody;
    const addressKey = (target: SessionMessagingDraftCustody['targets']['targets'][number]) => JSON.stringify([target.serverId, target.sessionId]);
    const previous = new Map(custody?.results.map(row => [addressKey(row.target), row]));
    const remaining = custody?.targets.targets.filter(target => {
        const row = previous.get(addressKey(target));
        return !row?.result.ok || !hasAdmittedInput(row.result.result);
    });
    let resolved = custody && remaining?.length ? { ...custody.targets, targets: remaining } : input.context?.sessionTargetsV1;
    const retain = () => {
        if (!custody || !input.isCurrent() || !repository.retainSessionMessagingDraftCustody({ ...input, custody })) {
            throw new Error('Composer draft attempt retired');
        }
    };
    // A settled private receipt is real admission evidence, not a transcript
    // inference. Only unresolved leaves enter the existing Action executor.
    const result: ActionExecuteResult = custody && remaining?.length === 0
        ? custody.targets.selector ? { ok: true, result: { kind: 'fanout', results: custody.results } } : custody.results[0].result
        : await input.execute('session.message.send', input.actionInput, {
        ...input.context,
        ...(resolved ? { sessionTargetsV1: resolved } : {}),
        onSessionTargetsResolved: notice => {
            resolved = notice.targets;
            custody ??= { targets: notice.targets, results: [] };
            // The repository persists this local supplement synchronously, before
            // fanout effects, and never seals it into the Account draft payload.
            retain();
            input.context?.onSessionTargetsResolved?.(notice);
        },
    });
    if (result.ok && ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) {
        await repository.flushSessionDraftLocally(input);
        return result;
    }
    const fanout = result.ok ? ActionSessionFanoutResultV1Schema.safeParse(result.result) : null;
    // A root refusal/unknown after target preparation still names the concrete
    // attempted leaves. Resolution itself failing has no invented recipients.
    const results = fanout?.success ? fanout.data.results : resolved?.targets.map(target => ({ target, result }));
    let combined = result;
    if (custody && results?.length) {
        const current = SessionMessageSendActionResultV1Schema.parse({ kind: 'fanout', results });
        if (!('kind' in current)) throw new Error('Expected exact message results');
        const settled = new Map(current.results.map(row => [addressKey(row.target), row]));
        custody = { targets: custody.targets, results: custody.targets.targets.map(target => {
            const known = previous.get(addressKey(target));
            const row = known?.result.ok && hasAdmittedInput(known.result.result) ? known : settled.get(addressKey(target)) ?? known;
            if (!row) throw new Error('Missing exact message result');
            return row;
        }) };
        // Even if editing retired this draft while the send was in flight, the
        // real Action result still belongs in its source presentation entry.
        if (input.isAccountCurrent()) repository.retainSessionMessagingDraftCustody({ ...input, custody });
        await repository.flushSessionDraftLocally(input);
        combined = custody.targets.selector ? { ok: true, result: { kind: 'fanout', results: custody.results } } : custody.results[0].result;
    }
    await recordSessionComposerMessageResult({ ...input, result: combined, isCurrent: input.isAccountCurrent });
    return combined;
}

/** Freeze source bytes once before target fanout; the caller releases its captures after all leaves settle. */
export async function captureSessionComposerMessageAttachments(input: Readonly<{
    structuredInput: RawIngressStructuredInputV1 | undefined;
    sourceComposerRef: ComposerRefV1;
    messageLocalId: string;
    signal?: AbortSignal;
    isCurrent: () => boolean;
}>): Promise<Readonly<{
    structuredInput: RawIngressStructuredInputV1 | undefined;
    releaseSnapshots: () => Promise<void>;
}> | null> {
    const isCurrent = () => !input.signal?.aborted && input.isCurrent();
    if (!isCurrent()) return null;
    const acquired: Array<Readonly<{ handle: ComposerContentHandleV1; attachmentInstanceId: string }>> = [];
    const releaseSnapshots = async () => {
        let failure: Error | null = null;
        for (const stage of [...acquired]) {
            try {
                // Cleanup must still run after cancellation, and never owns the mutable draft claim.
                const released = await releaseComposerContent(stage.handle, { claimant: {
                    composer: input.sourceComposerRef, attachmentInstanceId: stage.attachmentInstanceId,
                }, observerSignal: input.signal });
                if (!released.success) throw new Error(released.error);
                acquired.splice(acquired.indexOf(stage), 1);
            } catch (error) {
                failure ??= error instanceof Error ? error : new Error('Composer submission snapshot cleanup unavailable');
            }
        }
        if (failure) throw failure;
    };
    if (!input.structuredInput?.composerAttachments?.some(attachment => attachment.content)) {
        return { structuredInput: input.structuredInput, releaseSnapshots };
    }
    const attachments: ComposerAttachmentDraftV1[] = [];
    try {
        for (const attachment of input.structuredInput.composerAttachments) {
            if (!isCurrent()) throw new Error('Composer submission is no longer current');
            if (!attachment.content) {
                attachments.push(attachment);
                continue;
            }
            const captured = await captureComposerContentSubmission(attachment.content.handle, {
                sourceComposerRef: input.sourceComposerRef, destinationComposerRef: input.sourceComposerRef,
                attachmentInstanceId: attachment.instanceId, messageLocalId: input.messageLocalId,
            }, { signal: input.signal });
            if (captured.status !== 'claimed') throw new Error('Composer submission capture unavailable');
            // A rejoined capture may still belong to an earlier in-flight invocation.
            if (captured.newlyAcquired) acquired.push({ handle: captured.handle, attachmentInstanceId: attachment.instanceId });
            if (!isCurrent()) throw new Error('Composer submission is no longer current');
            attachments.push({ ...attachment, content: { kind: 'stagedMedia', handle: captured.handle } });
        }
        return { structuredInput: { ...input.structuredInput, composerAttachments: attachments }, releaseSnapshots };
    } catch {
        try { await releaseSnapshots(); } catch (error) {
            if (!input.signal?.aborted) throw error;
        }
        return null;
    }
}

/** Only a selected leading Session mention addresses a message; quoted/context mentions stay references. */
export function readSessionComposerMessageIntent(
    snapshot: ComposerSubmissionSnapshot,
    explicit?: SessionComposerMessageIntent,
): SessionComposerMessageIntent | null {
    if (explicit) return explicit;
    const reference = snapshot.references[0];
    if (!reference || reference.kind !== MENTION_KIND_V1.session
        || snapshot.text.slice(0, reference.start).trim().length !== 0
        || snapshot.text.slice(reference.start, reference.end) !== reference.token) return null;
    const parsed = parseMentionRefV1(reference.ref);
    if (parsed?.scheme !== 'session') return null;
    const sessionId = SessionIdSchema.safeParse(parsed.opaque);
    return sessionId.success ? { kind: 'ask', target: sessionId.data } : null;
}

export type AdmittedSessionComposerMessageResult = Exclude<SessionMessageSendResultV1, { status: 'rejected' | 'outcomeUnknown' }>;

/** One admission interpretation for mounted messaging and detached draft submission. */
export function readSessionComposerMessageAdmission(value: unknown):
    | Readonly<{ kind: 'accepted'; receipt: AdmittedSessionComposerMessageResult }>
    | Readonly<{ kind: 'unaccepted'; code: string }> {
    const parsed = SessionMessageSendResultV1Schema.safeParse(value);
    if (!parsed.success) return { kind: 'unaccepted', code: 'session_input_target_unavailable' };
    return parsed.data.status === 'rejected' || parsed.data.status === 'outcomeUnknown'
        ? { kind: 'unaccepted', code: parsed.data.code }
        : { kind: 'accepted', receipt: parsed.data };
}

function hasAdmittedInput(value: unknown): boolean {
    return readSessionComposerMessageAdmission(value).kind === 'accepted';
}

export type SessionComposerMessagingOutcome =
    | Readonly<{ kind: 'accepted' }>
    | Readonly<{ kind: 'partial'; accepted: number; total: number }>
    | Readonly<{ kind: 'approval_pending' }>
    | Readonly<{ kind: 'unaccepted'; error: string | null }>;

/** What the person is told after Send/Ask: the frozen fanout's own counts, never inferred from wake intent. */
export function readSessionComposerMessagingOutcome(result: ActionExecuteResult): SessionComposerMessagingOutcome {
    if (!result.ok) return { kind: 'unaccepted', error: result.error };
    if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) return { kind: 'approval_pending' };
    const fanout = ActionSessionFanoutResultV1Schema.safeParse(result.result);
    if (!fanout.success) return hasAdmittedInput(result.result) ? { kind: 'accepted' } : { kind: 'unaccepted', error: null };
    const total = fanout.data.results.length;
    const accepted = fanout.data.results.filter(entry => entry.result.ok && hasAdmittedInput(entry.result.result)).length;
    return accepted === 0 ? { kind: 'unaccepted', error: null } : accepted === total ? { kind: 'accepted' } : { kind: 'partial', accepted, total };
}

/** Partial fanout keeps the draft and its retry identity rather than discarding an unaccepted target. */
export function readSessionComposerMessagingHandoff(result: ActionExecuteResult): 'accepted' | 'partial' | 'unaccepted' | 'approval_pending' {
    return readSessionComposerMessagingOutcome(result).kind;
}
