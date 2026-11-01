import { describe, expect, it } from 'vitest';

import {
    createSessionFixture,
    createSessionMessagesFixture,
    createToolCallMessageFixture,
} from '@/dev/testkit';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { buildTranscriptRenderableAggregate } from '@/sync/domains/messages/transcriptRenderableAggregate';
import {
    deriveActivityAttentionFlags,
    hasActivityAttention,
    type ActivityAttentionSessionOptions,
} from './activityAttentionSessions';

const NOW_MS = 1_000_000;
const LIVE_SESSION_ID = 'session-live';

it('uses the maintained unread watermark without revisiting historical message attention', () => {
    let historicalVisits = 0;
    const message: Message = {
        id: 'historical',
        seq: 5,
        kind: 'agent-text',
        localId: null,
        createdAt: 100,
        text: 'done',
        get transcriptObservationProvenance() {
            historicalVisits += 1;
            return undefined;
        },
    };
    const renderableAggregate = buildTranscriptRenderableAggregate({ messages: [message], completedRequests: null });
    const sessionMessagesById = {
        [LIVE_SESSION_ID]: createSessionMessagesFixture({
            isLoaded: true,
            messageIdsOldestFirst: [message.id],
            messagesById: { [message.id]: message },
            renderableAggregate,
        }),
    };
    historicalVisits = 0;

    expect(deriveActivityAttentionFlags(createLiveCaughtUpSession(), attentionOptions(sessionMessagesById)).hasUnread).toBe(false);
    expect(historicalVisits).toBe(0);
});

/**
 * Attention is derived from the account's *stored* transcripts. Passing the
 * messages record explicitly keeps every case below hermetic: nothing here
 * depends on a registered global storage-state reader.
 */
function attentionOptions(
    sessionMessagesById: StorageState['sessionMessages'] = {},
): ActivityAttentionSessionOptions {
    return {
        showUnread: true,
        showPendingPermissionRequests: true,
        showPendingUserActionRequests: true,
        sessionMessagesById,
        nowMs: NOW_MS,
    };
}

function createRenderable(
    overrides: Partial<SessionListRenderableSession> & Pick<SessionListRenderableSession, 'id'>,
): SessionListRenderableSession {
    return {
        seq: 0,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        metadataVersion: 1,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        ...overrides,
    };
}

/**
 * A live session mid-turn whose transcript the user has already caught up on:
 * the only thing that can move it into the badge is a genuine attention reason.
 */
function createLiveCaughtUpSession(overrides: Partial<Session> = {}): Session {
    return createSessionFixture({
        id: LIVE_SESSION_ID,
        seq: 5,
        lastViewedSessionSeq: 5,
        active: true,
        activeAt: NOW_MS,
        presence: 'online',
        latestTurnStatus: 'in_progress',
        latestTurnStatusObservedAt: NOW_MS,
        pendingCount: 0,
        ...overrides,
    });
}

/**
 * A transcript holding exactly one `AskUserQuestion` request whose permission
 * reached `status`. The agent-state request below shares its id, so the only
 * difference between the two cases is what the transcript says happened to it.
 */
function createUserActionTranscript(
    status: 'pending' | 'canceled',
): StorageState['sessionMessages'] {
    const message = createToolCallMessageFixture({
        id: 'message-tool-1',
        createdAt: 100,
        tool: {
            name: 'AskUserQuestion',
            state: status === 'pending' ? 'running' : 'error',
            input: { question: 'continue?' },
            createdAt: 100,
            startedAt: 100,
            completedAt: status === 'pending' ? null : 101,
            description: null,
            permission: {
                id: 'request-1',
                status,
                kind: 'user_action',
            },
        },
    });

    return {
        [LIVE_SESSION_ID]: createSessionMessagesFixture({
            messageIdsOldestFirst: [message.id],
            messagesById: { [message.id]: message },
            isLoaded: true,
            messagesVersion: 1,
        }),
    };
}

function createSessionWithOpenUserActionRequest(): Session {
    return createLiveCaughtUpSession({
        agentState: {
            controlledByUser: null,
            requests: {
                'request-1': {
                    tool: 'AskUserQuestion',
                    kind: 'user_action',
                    arguments: { question: 'continue?' },
                    createdAt: 100,
                },
            },
            completedRequests: null,
        },
    });
}

describe('hasActivityAttention', () => {
    it('does not treat an undecryptable unread row as attention', () => {
        const undecryptable = createRenderable({
            id: 'session-1',
            seq: 4,
            hasUnreadMessages: true,
            metadataUnavailable: true,
        });
        // Control: the identical row is attention-worthy once its metadata
        // decrypts, so the assertion below cannot pass by ignoring unread.
        const decryptable = createRenderable({
            id: 'session-1',
            seq: 4,
            hasUnreadMessages: true,
        });

        expect(hasActivityAttention(undecryptable, attentionOptions())).toBe(false);
        expect(hasActivityAttention(decryptable, attentionOptions())).toBe(true);
    });

    it('treats queued user input as attention only when the badge option is enabled', () => {
        const session = createLiveCaughtUpSession({ pendingCount: 4 });

        const enabledOptions = { ...attentionOptions(), showQueuedUserInput: true };
        const disabledOptions = { ...attentionOptions(), showQueuedUserInput: false };
        const flags = deriveActivityAttentionFlags(session, enabledOptions);

        expect(flags.hasQueuedUserInput).toBe(true);
        expect(hasActivityAttention(session, enabledOptions)).toBe(true);
        expect(hasActivityAttention(session, disabledOptions)).toBe(false);
    });

    it('treats blocked pending delivery as attention even alongside ordinary queued input', () => {
        const session = createLiveCaughtUpSession({
            pendingCount: 4,
            pendingBlockedCount: 1,
        });

        const flags = deriveActivityAttentionFlags(session, attentionOptions());

        expect(flags.hasBlockedPendingDelivery).toBe(true);
        expect(hasActivityAttention(session, attentionOptions())).toBe(true);
    });

    it('does not treat pending permission/user-action requests on an inactive session as attention', () => {
        const inactive = createLiveCaughtUpSession({
            active: false,
            pendingPermissionRequestCount: 2,
            pendingUserActionRequestCount: 1,
            pendingRequestObservedAt: NOW_MS,
        });
        // Control: the same pending requests on the live session do demand
        // attention, so inactivity is what suppresses them here.
        const active = createLiveCaughtUpSession({
            pendingPermissionRequestCount: 2,
            pendingUserActionRequestCount: 1,
            pendingRequestObservedAt: NOW_MS,
        });

        expect(hasActivityAttention(inactive, attentionOptions())).toBe(false);
        expect(hasActivityAttention(active, attentionOptions())).toBe(true);
    });

    it('does not treat a pending request the transcript already canceled as attention', () => {
        const session = createSessionWithOpenUserActionRequest();

        // Control: the identical agent-state request with a still-pending
        // transcript entry is attention, so the assertion below cannot pass
        // merely because the request was never seen.
        expect(hasActivityAttention(session, attentionOptions(createUserActionTranscript('pending')))).toBe(true);
        expect(hasActivityAttention(session, attentionOptions(createUserActionTranscript('canceled')))).toBe(false);
    });
});
