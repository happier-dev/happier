import { DiscussionOpenedMessageV1Schema, DiscussionOpenedSummaryV1Schema } from '@happier-dev/protocol/discussions/actions';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';

import type { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { DEMO_MACHINE_ID, DEMO_NOW_MS } from './constants';
import { createDemoListSession } from './sessions';

export const DEMO_DISCUSSION_ID = 'demo-discussion-northstar-launch';
export const DEMO_DISCUSSION_ACCOUNT_ID = 'demo-account';
export const DEMO_DISCUSSION_BOT_ID = 'demo-discussion-northstar-bot';
export const DEMO_DISCUSSION_SESSION_ID = 'demo-discussion-onboarding-review';
export const DEMO_DISCUSSION_APPROVAL_ID = '11111111-1111-4111-8111-111111112510';

export function buildDemoDiscussionApproval(serverId: string): DecryptedArtifact {
    const actionArgs = { discussionId: DEMO_DISCUSSION_ID, localId: 'demo-northstar-draft',
        content: { v: 1 as const, parts: [{ t: 'text' as const,
            text: 'Start with a sample project. Set up after your first result.' }] },
        replyTarget: { kind: 'message' as const, messageId: 'demo-discussion-message-2' } };
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open',
        createdAtMs: DEMO_NOW_MS - 10_000, updatedAtMs: DEMO_NOW_MS - 10_000,
        createdBy: { surface: 'agent', sessionId: DEMO_DISCUSSION_BOT_ID }, requestedSurface: 'agent',
        actionId: 'discussion.reply', actionArgs, discussionDraftReview: true,
        summary: 'Review the Northstar launch update',
        executionOriginV1: buildApprovalExecutionOriginV1({ actionId: 'discussion.reply', input: actionArgs,
            targetSessionId: null, context: { surface: 'agent', authority: 'account_automation',
                serverId, serverIdentityId: serverId, runtimeAccountId: DEMO_DISCUSSION_ACCOUNT_ID, actionCaller: { kind: 'host' },
                defaultSessionId: DEMO_DISCUSSION_BOT_ID, defaultSessionMachineId: DEMO_MACHINE_ID,
                actionRequestId: actionArgs.localId,
                discussionReplyReturn: { serverId, requestLocalId: 'demo-northstar-request', acceptedTurnId: 'demo-northstar-turn' } } }),
    });
    return { id: DEMO_DISCUSSION_APPROVAL_ID, sourceServerId: serverId,
        header: buildApprovalRequestArtifactHeaderV1(request), title: request.summary, body: JSON.stringify(request),
        storageMode: 'plain', isDecrypted: true, access: 'owner', headerVersion: 1, bodyVersion: 1,
        seq: 1, createdAt: request.createdAtMs, updatedAt: request.updatedAtMs };
}

export function buildDemoDiscussionSessions() {
    const bot = createDemoListSession({ id: DEMO_DISCUSSION_BOT_ID, machineId: DEMO_MACHINE_ID,
        title: 'Northstar Bot', active: false, thinking: false, activeAt: DEMO_NOW_MS, seq: 10 });
    return [
        { ...bot, metadata: { ...bot.metadata!, bot: { kind: 'bot' }, createdAsBot: true } },
        createDemoListSession({ id: DEMO_DISCUSSION_SESSION_ID, machineId: DEMO_MACHINE_ID,
            title: 'Onboarding review', active: false, thinking: false, activeAt: DEMO_NOW_MS, seq: 10 }),
    ];
}

/** Opened display records for the real Discussion reader; never persisted or sent to a Home. */
export function buildDemoDiscussion(serverId: string) {
    const account = (accountId: string, name: string) => ({ v: 1 as const, accountId,
        profile: { name, firstName: null, lastName: null, username: null, avatarUrl: null } });
    const maya = account(DEMO_DISCUSSION_ACCOUNT_ID, 'Maya Park');
    const leo = account('demo-account-leo', 'Leo Chen');
    const messages = [
        { actor: maya, text: 'Northstar: useful project before setup?', sessionId: null },
        { actor: leo, text: 'Yes. Please review the launch note.', sessionId: null },
        { actor: maya, text: 'Launch note ready for your approval.', sessionId: DEMO_DISCUSSION_BOT_ID },
        { actor: maya, text: 'Phone flow and keyboard checks passed.', sessionId: DEMO_DISCUSSION_SESSION_ID },
    ].map((entry, index) => {
        const row = {
            id: `demo-discussion-message-${index + 1}`, discussionId: DEMO_DISCUSSION_ID,
            localId: null, seq: index + 1, authorAccountId: entry.actor.accountId, accountActor: entry.actor,
            producerV1: entry.sessionId ? { v: 1 as const, kind: 'agent' as const, sessionId: entry.sessionId } : null,
            content: { v: 1 as const, parts: [{ t: 'text' as const, text: entry.text }] },
            mentionedAccountIds: [], createdAt: DEMO_NOW_MS - (6 - index) * 60_000,
        };
        return DiscussionOpenedMessageV1Schema.parse({ ...row,
            messageRef: createDiscussionMessageRefV1({ serverId, discussionId: DEMO_DISCUSSION_ID },
                { ...row, content: { t: 'plain', v: row.content } }) });
    });
    const latest = messages[messages.length - 1]!;
    const summary = DiscussionOpenedSummaryV1Schema.parse({
        id: DEMO_DISCUSSION_ID, ownerAccountId: DEMO_DISCUSSION_ACCOUNT_ID, encryptionMode: 'plain',
        anchor: null, access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId: null,
        title: 'Northstar · Launch room',
        latestMessage: { id: latest.id, localId: null, seq: latest.seq, authorAccountId: latest.authorAccountId,
            accountActor: latest.accountActor, producerV1: latest.producerV1, content: latest.content, createdAt: latest.createdAt },
        messageSeq: messages.length, lastReadSeq: messages.length, unreadCount: 0, unreadMentionCount: 0,
        recentAuthorAccountIds: [maya.accountId, leo.accountId], participantAccounts: [maya, leo],
        participantSessionIds: [DEMO_DISCUSSION_BOT_ID, DEMO_DISCUSSION_SESSION_ID], archivedAt: null,
        capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true,
            sendToSession: true, manageAccess: true, leave: false },
    });
    const roster = DiscussionParticipantsListResponseV1Schema.parse({
        discussionId: DEMO_DISCUSSION_ID, ownerAccountId: maya.accountId, access: 'owner',
        accountActors: [maya, leo], grants: [{ principal: { kind: 'account', accountId: leo.accountId },
            accessLevel: 'edit', createdByAccountId: maya.accountId, createdAt: DEMO_NOW_MS - 360_000,
            display: { name: 'Leo Chen', username: null } }],
        participants: [
            { participant: { kind: 'session', sessionId: DEMO_DISCUSSION_BOT_ID }, answerPolicy: 'drafts_for_approval', createdAt: DEMO_NOW_MS - 360_000 },
            { participant: { kind: 'session', sessionId: DEMO_DISCUSSION_SESSION_ID }, answerPolicy: 'when_addressed', createdAt: DEMO_NOW_MS - 360_000 },
        ],
    });
    const refuse = async () => ({ kind: 'failed' as const, errorCode: 'demo_read_only' });
    const client: ReturnType<typeof createDiscussionClient> = {
        attention: async () => ({ kind: 'succeeded', value: { v: 1, serverId, discussions: [], nextCursor: null, incomplete: false } }),
        list: async () => ({ kind: 'succeeded', value: { v: 1, serverId, discussions: [summary], nextCursor: null, incomplete: false } }),
        get: async () => ({ kind: 'succeeded', value: { v: 1, serverId, discussion: summary } }),
        read: async () => ({ kind: 'succeeded', value: { v: 1, serverId, discussionId: DEMO_DISCUSSION_ID,
            messages, hasMoreOlder: false, messageSeq: messages.length, incomplete: false } }),
        participants: async () => ({ kind: 'succeeded', value: roster }),
        listGrants: async () => ({ kind: 'succeeded', value: roster }),
        getSettings: async () => ({ kind: 'succeeded', value: { discussionId: DEMO_DISCUSSION_ID, settings: {} } }),
        readState: async (_id, lastReadSeq) => ({ kind: 'succeeded', value: { v: 1, serverId,
            cursor: { discussionId: DEMO_DISCUSSION_ID, lastReadSeq, didChange: false } } }),
        create: refuse, post: refuse, reply: refuse, rename: refuse, archive: refuse, restore: refuse,
        setSettings: refuse, setParticipantPolicy: refuse, invite: refuse, inviteExecutableParticipant: refuse,
        removeParticipant: refuse, leave: refuse, transferOwner: refuse, setGrant: refuse, removeGrant: refuse,
        readAttachment: refuse, secondOpinion: refuse, listCandidates: refuse,
    };
    return { summary, messages, roster, client };
}
