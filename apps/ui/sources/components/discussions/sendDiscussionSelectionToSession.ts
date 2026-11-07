import { z } from 'zod/mini';
import {
    DiscussionSelectionSourceV1Schema,
    type DiscussionSelectionSourceV1,
} from '@happier-dev/protocol/discussions/content';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

import { applySendToSessionTemplate } from '@/components/sessions/transcript/messageSelection/applySendToSessionTemplate';
import type { SessionDraftTextAppend } from '@/components/sessions/composer/sessionDraftAppendAction';
import type { SessionAskTargetChipTarget } from '@/components/sessions/transcript/askRecord/SessionAskRecord';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

type SendSelectionSource = Omit<DiscussionSelectionSourceV1, 'draftCorrelationId'>;

/** The one format a Discussion selection takes in a Session, for the draft handoff and the deliberate Send alike. */
function formatDiscussionSelectionForSession(params: Readonly<{
    serverId: string;
    selectedText: string;
    source: SendSelectionSource;
    template: string;
    sourceSessionName: string | null;
}>): Readonly<{ text: string; source: SendSelectionSource }> | null {
    const sourceResult = z.omit(DiscussionSelectionSourceV1Schema, { draftCorrelationId: true })
        .safeParse(params.source);
    if (!sourceResult.success || sourceResult.data.serverId !== params.serverId) return null;
    const text = applySendToSessionTemplate({
        template: params.template,
        formattedMessages: params.selectedText,
        selectedCount: sourceResult.data.messageIds.length,
        sourceSessionName: params.sourceSessionName,
    });
    return text.trim() ? { text, source: sourceResult.data } : null;
}

/**
 * Formats a Home-qualified selection for the canonical Session draft append Action.
 * It never submits the draft as agent input.
 */
export async function sendDiscussionSelectionToSession(params: Readonly<{
    sessionId: string;
    serverId: string;
    selectedText: string;
    source: SendSelectionSource;
    template: string;
    sourceSessionName: string | null;
    appendToDraft: (input: SessionDraftTextAppend) => Promise<void>;
    revealPrimaryComposer: () => void | Promise<void>;
    focusPrimaryComposer: () => boolean | void | Promise<boolean | void>;
}>): Promise<boolean> {
    const formatted = formatDiscussionSelectionForSession(params);
    if (!formatted) return false;

    await params.appendToDraft({
        sessionId: params.sessionId,
        serverId: params.serverId,
        text: formatted.text,
        discussionSource: formatted.source,
    });
    await params.revealPrimaryComposer();
    await params.focusPrimaryComposer();
    return true;
}

/** What a reply-less Send became, in the ask record's target-chip terms. */
export type DiscussionSessionSendReceipt = Readonly<SessionAskTargetChipTarget & {
    status: 'queued' | 'held' | 'failed' | 'unknown';
    code?: string;
}>;

/**
 * Sends the same formatted selection to the Session as information (`session.message.send`, reply none), with
 * its Discussion source attached. The caller owns `localId`: sending again with it is the same operation, so
 * the Session never reads it twice. Nothing here reads or writes the Session's composer draft.
 */
export async function sendDiscussionSelectionToSessionNow(params: Readonly<{
    scope: ServerAccountScope;
    sessionId: string;
    selectedText: string;
    source: SendSelectionSource;
    template: string;
    sourceSessionName: string | null;
    localId: string;
    execute: FrontDoorActionExecute;
}>): Promise<DiscussionSessionSendReceipt> {
    const formatted = formatDiscussionSelectionForSession({ ...params, serverId: params.scope.serverId });
    if (!formatted) return { status: 'failed', requestBound: false, code: 'invalid_parameters' };
    const result = await params.execute('session.message.send', {
        sessionId: params.sessionId,
        message: formatted.text,
        localId: params.localId,
        reply: 'none',
        structuredInput: { v: 1, discussionSelectionSourceV1: formatted.source },
    }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId: params.scope.serverId, expectedAccountId: params.scope.accountId });
    if (!result.ok) return { status: 'failed', requestBound: false, code: result.errorCode };
    // An approval the person still owes holds the message exactly as a held input does.
    if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) return { status: 'held', requestBound: true };
    const sent = SessionMessageSendResultV1Schema.safeParse(result.result);
    if (!sent.success) return { status: 'unknown', requestBound: false };
    switch (sent.data.status) {
        case 'accepted':
        case 'alreadyAccepted':
        case 'replied':
            return { status: 'queued', requestBound: true };
        case 'held':
            return { status: 'held', requestBound: true };
        case 'outcomeUnknown':
            return { status: 'unknown', requestBound: false, code: sent.data.code };
        default:
            return { status: 'failed', requestBound: false, code: sent.data.code };
    }
}
