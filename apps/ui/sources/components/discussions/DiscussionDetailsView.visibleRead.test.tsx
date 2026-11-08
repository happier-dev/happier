import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscussionMessageContentV1 } from '@happier-dev/protocol/discussions/content';
import type {
    DiscussionOpenedMessageV1,
    DiscussionOpenedSummaryV1,
} from '@happier-dev/protocol/discussions/actions';
import type { SessionDiscussionDraftMutationAttempt, SessionDiscussionDraftMutationAttemptInput } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { DiscussionDraftSubmittedContentV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { buildDiscussionContentFromPendingText } from './discussionComposerDocument';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { SessionHumanPresenceVisibleReplaceV1Schema } from '@happier-dev/protocol/sessions';
import { attachSessionHumanPresenceSocket } from '@/sync/domains/session/humanPresence/sessionHumanPresenceRuntime';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { DiscussionRepositoryClient } from '@/sync/ops/discussions/discussionRepository';
import { clearDiscussionRepositoryRegistryForTests } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import {
    markSessionSurfaceHidden,
    markSessionSurfaceVisible,
    resetSessionSurfaceVisibilityForTests,
} from '@/sync/domains/session/sessionSurfaceVisibility';

/**
 * The visible-read admission of a mounted Discussion, through its real owners:
 * the shared exact-Home/Account repository, the one visible-read controller and the
 * shared Session surface visibility owner all stay real. Only true boundaries
 * are substituted — the Discussion HTTP client, device credentials, the
 * presence socket — plus presentation-only children unrelated to reading.
 */
import type { ComposerStructuredInputMention } from '@/components/sessions/agentInput/structuredInputMentions';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';

const alexToken = formatInlineReferenceTokenV1({ label: 'Alex', ref: 'account:account-alex' });
const alexMention = { kind: 'happier.account', ref: 'account:account-alex', tokenText: alexToken, start: 0, end: alexToken.length } as const;

const network = vi.hoisted(() => ({ client: null as null | Record<string, unknown> }));
const sourceSessionReads = vi.hoisted(() => vi.fn());
const transcriptProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
const composerProps = vi.hoisted(() => ({ current: null as null | Readonly<{ onSend: (content: DiscussionMessageContentV1) => void }> }));
const exactHomeBinding = { accountId: 'viewer', scope: { serverId: 'server-a', accountId: 'viewer' } };
const draftState = vi.hoisted(() => ({
    title: '', text: '', mentions: [] as readonly ComposerStructuredInputMention[], status: 'clean' as const, conflict: null,
    pendingMutationAttempt: null as SessionDiscussionDraftMutationAttempt | null,
    submitted: null as DiscussionDraftSubmittedContentV2 | null,
    setComposer: () => undefined, setTitle: () => undefined,
    recipients: [] as readonly import('@happier-dev/protocol/discussions/references').DiscussionParticipantRefV1[], setRecipients: () => undefined,
    replyTarget: null as import('@happier-dev/protocol/discussions/replyTargets').DiscussionReplyTargetV1 | null,
    setReplyTarget: vi.fn(),
    // The real draft binding with no recipients or passage: content goes out as written.
    prepareContent: (content: DiscussionMessageContentV1) => content,
    participants: [] as readonly never[], setParticipants: () => undefined,
    captureSubmittedCurrentness: (attempt?: SessionDiscussionDraftMutationAttemptInput) => {
        const address = attempt?.kind === 'post' ? { kind: 'discussion' as const, discussionId: attempt.discussionId } : { kind: 'newDiscussion' as const };
        return { scope: exactHomeBinding.scope, address, currentness: { address, mutationIds: {} } };
    },
    clearAfterObservedSuccess: async () => undefined, releaseSubmittedAttempt: () => undefined,
    purgePresentation: async () => undefined,
    purgeSourcePresentation: async () => undefined,
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/sync/api/discussions/discussionActions', () => ({
    createDiscussionClient: () => network.client,
}));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({ useAppPaneScope: () => ({ openDetailsTab: vi.fn(), closeDetails: vi.fn() }) }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/hooks/session/useSessionCollaborationAvailability', () => ({ useSessionCollaborationAvailabilityState: () => 'available' }));
vi.mock('@/hooks/session/useSessionAgentActivity', () => ({ useSessionAgentActivityRoster: () => ({ subagents: [], readExecutionRunEntry: () => null }) }));
vi.mock('@/hooks/session/useSessionExecutionRunLaunchability', async importOriginal => ({
    ...await importOriginal<typeof import('@/hooks/session/useSessionExecutionRunLaunchability')>(),
    useSessionExecutionRunLaunchability: () => ({
    canLaunchExecutionRuns: false, canShowExecutionRunLauncher: false, launchUnavailableReason: 'notEnabled', executionRunsBackends: {}, executionRunsSupported: false, sessionServerId: 'server-a',
}) }));
vi.mock('@/components/sessions/shell/sessionViewStableSession', () => ({ useSessionViewShellSession: (...args: unknown[]) => { sourceSessionReads(...args); return null; } }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
    });
});
// The real provider module (the Run… start modal reads its context snapshot); only handler registration is stubbed.
vi.mock('@/keyboard/KeyboardShortcutProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/keyboard/KeyboardShortcutProvider')>()),
  useKeyboardShortcutHandlers: () => true,
}));
vi.mock('@/sync/sync', () => ({ sync: { patchSessionMetadataWithRetry: vi.fn() } }));
vi.mock('@/components/discussions/useDiscussionDraft', () => ({ useDiscussionDraft: () => draftState }));
vi.mock('@/components/discussions/DiscussionComposer', () => ({ DiscussionComposer: (props: Readonly<{ onSend: (content: DiscussionMessageContentV1) => void }>) => { composerProps.current = props; return null; } }));
vi.mock('@/components/sessions/transcript/viewport/shell/TranscriptListShell', () => ({
    TranscriptListShell: (props: { data: readonly unknown[]; renderItem: (input: { item: unknown }) => React.ReactNode }) => {
        transcriptProps.current = props;
        return <>{props.data.map((item, index) => <React.Fragment key={index}>{props.renderItem({ item })}</React.Fragment>)}</>;
    },
}));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { DiscussionDetailsView } = await import('@/components/discussions/DiscussionDetailsView');

const address = { serverId: 'server-a' };
const target = { kind: 'discussion' as const, address, discussionId: 'discussion-a' };

function summary(messageSeq: number, lastReadSeq = 0): DiscussionOpenedSummaryV1 {
    return {
        id: 'discussion-a', ownerAccountId: 'viewer', encryptionMode: 'plain', anchor: null,
        access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId: null, title: 'Design',
        latestMessage: { id: `message-${messageSeq}`, localId: null, seq: messageSeq, authorAccountId: 'alice', accountActor: { v: 1, accountId: 'alice', profile: null }, producerV1: null, createdAt: messageSeq },
        messageSeq, lastReadSeq, unreadCount: messageSeq - lastReadSeq, unreadMentionCount: 0, recentAuthorAccountIds: ['alice'], archivedAt: null,
        capabilities: { postMessages: true, rename: false, archive: false, restore: false, askAgent: false, sendToSession: false, manageAccess: true, leave: false },
    };
}

function message(seq: number, opened: boolean): DiscussionOpenedMessageV1 {
    const committed = {
        id: `message-${seq}`, discussionId: 'discussion-a', localId: null, seq, authorAccountId: 'alice',
        accountActor: { v: 1 as const, accountId: 'alice', profile: null }, producerV1: null,
        content: { t: 'plain' as const, v: { v: 1, parts: [{ t: 'text', text: `message ${seq}` }] } },
        mentionedAccountIds: [], createdAt: seq,
    };
    return {
        ...committed,
        content: opened ? { v: 1, parts: [{ t: 'text', text: `message ${seq}` }] } : null,
        messageRef: createDiscussionMessageRefV1({ ...address, discussionId: 'discussion-a' }, committed),
    };
}

function installNetwork(rows: () => readonly DiscussionOpenedMessageV1[], lastReadSeq = 0) {
    const messageSeq = () => rows().at(-1)?.seq ?? 0;
    const readState = vi.fn<DiscussionRepositoryClient['readState']>(async (_discussionId, lastReadSeq) => ({
        kind: 'succeeded',
        value: { cursor: { lastReadSeq } },
    }) as never);
    const create = vi.fn<DiscussionRepositoryClient['create']>(async () => ({ kind: 'failed', errorCode: 'discussion_invalid_mention' }));
    const post = vi.fn<DiscussionRepositoryClient['post']>(async () => ({ kind: 'failed', errorCode: 'discussion_invalid_mention' }));
    const client: DiscussionRepositoryClient = {
        attention: async () => ({ kind: 'failed', errorCode: 'unexpected-test-read' }),
        getSettings: async () => ({ kind: 'failed', errorCode: 'unexpected-test-read' }),
        setSettings: async () => ({ kind: 'failed', errorCode: 'unexpected-test-write' }),
        participants: vi.fn<DiscussionRepositoryClient['participants']>(async () => ({ kind: 'succeeded', value: DiscussionParticipantsListResponseV1Schema.parse({ discussionId: 'discussion-a', ownerAccountId: 'viewer', access: 'owner', grants: [], participants: [] }) })),
        invite: vi.fn<DiscussionRepositoryClient['invite']>(async () => ({ kind: 'failed', errorCode: 'unexpected-test-write' })),
        setParticipantPolicy: vi.fn<DiscussionRepositoryClient['setParticipantPolicy']>(async () => ({ kind: 'failed', errorCode: 'unexpected-test-write' })),
        inviteExecutableParticipant: vi.fn<DiscussionRepositoryClient['inviteExecutableParticipant']>(async () => ({ kind: 'failed', errorCode: 'unexpected-test-write' })),
        removeParticipant: vi.fn<DiscussionRepositoryClient['removeParticipant']>(async () => ({ kind: 'failed', errorCode: 'unexpected-test-write' })),
        leave: vi.fn<DiscussionRepositoryClient['leave']>(async () => ({ kind: 'failed', errorCode: 'unexpected-test-write' })),
        transferOwner: vi.fn<DiscussionRepositoryClient['transferOwner']>(async () => ({ kind: 'failed', errorCode: 'unexpected-test-write' })),
        listGrants: vi.fn<DiscussionRepositoryClient['listGrants']>(async () => ({ kind: 'failed', errorCode: 'unexpected-test-read' })),
        setGrant: vi.fn<DiscussionRepositoryClient['setGrant']>(async () => ({ kind: 'failed', errorCode: 'unexpected-test-write' })),
        removeGrant: vi.fn<DiscussionRepositoryClient['removeGrant']>(async () => ({ kind: 'failed', errorCode: 'unexpected-test-write' })),
        list: vi.fn(async () => ({ kind: 'succeeded', value: { v: 1, serverId: address.serverId, discussions: [summary(messageSeq(), lastReadSeq)], nextCursor: null, incomplete: false } })) as never,
        get: vi.fn(async () => ({ kind: 'succeeded', value: { v: 1, serverId: address.serverId, discussion: summary(messageSeq(), lastReadSeq) } })) as never,
        read: vi.fn(async (_discussionId: string, input?: { afterSeq?: number }) => {
            const all = rows();
            const page = input?.afterSeq === undefined ? all : all.filter((row) => row.seq > input.afterSeq!);
            return { kind: 'succeeded', value: { v: 1, serverId: address.serverId, discussionId: 'discussion-a', messages: [...page], hasMoreOlder: false, messageSeq: messageSeq(), incomplete: page.some((row) => row.content === null) } };
        }) as never,
        create,
        post,
        rename: vi.fn() as never,
        archive: vi.fn() as never,
        restore: vi.fn() as never,
        readState,
    };
    network.client = client as unknown as Record<string, unknown>;
    return { readState, create, post };
}

function viewableHumanMessages(): readonly { isViewable: true; item: unknown }[] {
    const data = (transcriptProps.current?.data ?? []) as readonly { kind: string }[];
    return data.filter((item) => item.kind === 'human_message').map((item) => ({ isViewable: true as const, item }));
}

async function reportAllRowsVisible(): Promise<void> {
    await act(async () => {
        (transcriptProps.current?.onViewableItemsChanged as (input: unknown) => void)({ viewableItems: viewableHumanMessages() });
    });
}

describe('DiscussionDetailsView visible read', () => {
    beforeEach(async () => {
        await homes.reset();
        address.serverId = await homes.addHome({ name: 'Discussion', serverUrl: 'https://discussion.test', serverIdentityId: 'server-a', accountId: 'viewer', currentAccount: true });
        exactHomeBinding.scope.serverId = address.serverId;
        const state = getStorage().getState();
        getStorage().setState({ sessions: {}, settings: { ...state.settings, transcriptBulkCopyFormat: 'markdown_labeled', transcriptMessageSendToSessionTemplate: '{{MESSAGES}}' } });
        sourceSessionReads.mockClear();
        resetSessionSurfaceVisibilityForTests();
        clearDiscussionRepositoryRegistryForTests();
        transcriptProps.current = null;
        composerProps.current = null;
        draftState.title = '';
        draftState.text = '';
        draftState.mentions = [];
        draftState.replyTarget = null;
        draftState.recipients = [];
        draftState.setReplyTarget.mockClear();
        draftState.pendingMutationAttempt = null;
        draftState.submitted = null;
    });

    afterEach(async () => {
        standardCleanup();
        await homes.reset();
        resetSessionSurfaceVisibilityForTests();
        clearDiscussionRepositoryRegistryForTests();
    });

    it('advances the private cursor from a focused standalone Discussion route without any primary Session surface', async () => {
        const { readState } = installNetwork(() => [message(1, true)]);

        // No SessionView is mounted: the standalone route is itself the visible surface.
        await renderScreen(<DiscussionDetailsView target={target} active standaloneSurface />);
        await vi.waitFor(() => expect(viewableHumanMessages()).toHaveLength(1));
        await reportAllRowsVisible();

        await vi.waitFor(() => expect(readState).toHaveBeenCalledWith('discussion-a', 1, undefined));
        expect(sourceSessionReads).not.toHaveBeenCalled();
    });

    it('shows an addressed participant hold beside its original question without hiding a later local ask', async () => {
        const participantSessionId = 'cmv3heldparticipant';
        const held = { ...message(1, true), participantDeliveryV1: [{
            participantSessionId, disposition: 'held' as const, code: 'session_input_target_unavailable' as const,
        }] };
        installNetwork(() => [held, message(2, true)]);
        const screen = await renderScreen(<DiscussionDetailsView target={target} active standaloneSurface />);
        await vi.waitFor(() => expect(viewableHumanMessages()).toHaveLength(2));

        const notice = screen.findHostByTestId(`session-discussion-participant-held-${held.id}-${participantSessionId}`);
        expect(notice).not.toBeNull();
        expect(notice?.props.accessibilityLiveRegion).toBe('polite');
        expect(notice?.children.join('').trim().length).toBeGreaterThan(0);
        expect(JSON.stringify(notice?.children)).not.toContain(participantSessionId);
        expect(screen.findHostByTestId('session-discussion-message-content-message-2')).not.toBeNull();
        expect(screen.findHostByTestId(`session-discussion-participant-held-message-2-${participantSessionId}`)).toBeNull();
        expect(sourceSessionReads).not.toHaveBeenCalled();
    });

    it('shows an unaccepted ask and retries its committed identity', async () => {
        const participantSessionId = 'cmv3pendingparticipant';
        const pending = { ...message(1, true), authorAccountId: 'viewer', localId: 'pending-original',
            participantDeliveryV1: [{ participantSessionId, disposition: 'pending' as const }] };
        const otherPending = { ...message(2, true), authorAccountId: 'another-person', localId: 'another-original',
            participantDeliveryV1: [{ participantSessionId, disposition: 'pending' as const }] };
        const { post } = installNetwork(() => [pending, otherPending]);
        const screen = await renderScreen(<DiscussionDetailsView target={target} active standaloneSurface />);
        await vi.waitFor(() => expect(viewableHumanMessages()).toHaveLength(2));
        expect(screen.findHostByTestId(`session-discussion-participant-pending-${pending.id}-${participantSessionId}`)).not.toBeNull();
        expect.soft(screen.findByTestId(`session-discussion-delivery-retry-${otherPending.id}`)).toBeNull();
        const { readRegisteredDiscussionRepository } = await import('@/sync/ops/discussions/discussionRepositoryRegistry');
        const repository = readRegisteredDiscussionRepository(exactHomeBinding.scope, address);
        if (!repository) throw new Error('Missing mounted Discussion repository');
        expect.soft(await repository.retryDelivery(otherPending.discussionId, otherPending.id))
            .toEqual({ kind: 'failed', errorCode: 'discussion_read_denied' });
        expect.soft(post).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync(`session-discussion-delivery-retry-${pending.id}`);
        expect(post).toHaveBeenCalledWith(expect.objectContaining({ discussionId: pending.discussionId,
            localId: pending.localId, content: pending.content }), undefined);
        expect(screen.findHostByTestId(`session-discussion-participant-pending-${pending.id}-${participantSessionId}`)).not.toBeNull();
        expect(screen.findByTestId(`session-discussion-delivery-retry-${pending.id}`)).not.toBeNull();
        post.mockResolvedValueOnce({ kind: 'succeeded', value: { v: 1, serverId: address.serverId,
            message: { ...pending, participantDeliveryV1: undefined }, messageSeq: pending.seq } });
        await screen.pressByTestIdAsync(`session-discussion-delivery-retry-${pending.id}`);
        await vi.waitFor(() => expect(screen.findHostByTestId(`session-discussion-participant-pending-${pending.id}-${participantSessionId}`)).toBeNull());
        expect(viewableHumanMessages()).toHaveLength(2);
    });

    it.each(['approval_rejected', 'approval_canceled'] as const)('presents a draft %s as a quiet decision beside its question', async (code) => {
        const participantSessionId = 'cmv3reviewedparticipant';
        const declined = { ...message(1, true), participantDeliveryV1: [{ participantSessionId, disposition: 'failed' as const,
            failure: { code, phase: 'action_admission' as const, retryable: false },
        }] };
        installNetwork(() => [declined, message(2, true)]);
        const screen = await renderScreen(<DiscussionDetailsView target={target} active standaloneSurface />);
        await vi.waitFor(() => expect(viewableHumanMessages()).toHaveLength(2));

        const outcome = screen.findByTestId(`session-discussion-participant-declined-${declined.id}-${participantSessionId}`);
        expect(outcome).not.toBeNull();
        expect(screen.findAllByTestId(`session-discussion-participant-declined-${declined.id}-${participantSessionId}`)
            .some(node => node.props.tone === 'quiet')).toBe(true);
        expect(screen.findAllByProps({ accessibilityLiveRegion: 'polite' }).some(node =>
            node.findAllByProps({ testID: `session-discussion-participant-declined-${declined.id}-${participantSessionId}` }).length > 0)).toBe(true);
        expect(screen.findHostByTestId(`session-discussion-participant-failed-${declined.id}-${participantSessionId}`)).toBeNull();
        expect(screen.findByTestId(`session-discussion-delivery-retry-${declined.id}`)).toBeNull();
        expect(screen.findHostByTestId('session-discussion-message-content-message-2')).not.toBeNull();
    });

    it.each(['action_disabled', 'discussion_post_denied'] as const)('shows a genuine %s return failure beside its question without presenting it as a delivery hold', async (code) => {
        const participantSessionId = 'cmv3failedparticipant';
        const failed = { ...message(1, true), participantDeliveryV1: [{ participantSessionId, disposition: 'failed' as const,
            failure: { code, phase: 'action_admission' as const, retryable: false },
        }] };
        installNetwork(() => [failed, message(2, true)]);
        const screen = await renderScreen(<DiscussionDetailsView target={target} active standaloneSurface />);
        await vi.waitFor(() => expect(viewableHumanMessages()).toHaveLength(2));

        const notice = screen.findHostByTestId(`session-discussion-participant-failed-${failed.id}-${participantSessionId}`);
        expect(notice).not.toBeNull();
        expect(notice?.props.accessibilityLiveRegion).toBe('polite');
        expect(notice?.children.join('').trim().length).toBeGreaterThan(0);
        expect(JSON.stringify(notice?.children)).not.toContain(participantSessionId);
        expect(JSON.stringify(notice?.children)).not.toContain(code);
        expect(screen.findHostByTestId(`session-discussion-participant-held-${failed.id}-${participantSessionId}`)).toBeNull();
        expect(screen.findHostByTestId('session-discussion-message-content-message-2')).not.toBeNull();
        expect(sourceSessionReads).not.toHaveBeenCalled();
    });

    it('declares and observes presence for its captured Discussion without a source Session', async () => {
        installNetwork(() => [message(1, true)]);
        const declarations: ReturnType<typeof SessionHumanPresenceVisibleReplaceV1Schema.parse>[] = [];
        let snapshot: ((payload: unknown) => void) | undefined;
        const detach = attachSessionHumanPresenceSocket({ serverId: address.serverId, accountId: exactHomeBinding.accountId, transport: {
            isConnected: () => true,
            subscribeStatus: () => () => undefined,
            subscribeSnapshot: (listener) => { snapshot = listener; return () => { snapshot = undefined; }; },
            send: () => undefined,
            sendWithAck: async (_event, payload) => {
                const request = SessionHumanPresenceVisibleReplaceV1Schema.parse(payload);
                declarations.push(request);
                return { v: 1, ok: true, admittedSessionIds: request.sessionIds, admittedLocations: request.locations ?? [] };
            },
        } });
        try {
            const screen = await renderScreen(<DiscussionDetailsView target={target} active standaloneSurface />);
            await vi.waitFor(() => expect(declarations.at(-1)?.locations).toEqual([{ discussionId: 'discussion-a' }]));
            await act(async () => { markSessionSurfaceVisible('source-session', address.serverId); });
            await vi.waitFor(() => expect(declarations.at(-1)?.sessionIds).toEqual(['source-session']));
            await act(async () => { snapshot?.({ v: 1, sessionId: 'source-session', observedAt: 1, viewers: [{ account: { kind: 'account', accountId: 'source-reader', name: 'Source reader', firstName: null, lastName: null, username: null, avatarUrl: null }, typing: true }] }); });
            expect(screen.findByTestId('session-discussion-presence')).toBeNull();
            expect(screen.getTextContent()).not.toContain('Source reader');
            await act(async () => { snapshot?.({ v: 1, discussionId: 'discussion-a', observedAt: 1, viewers: [{ account: { kind: 'account', accountId: 'ana', name: 'Ana', firstName: null, lastName: null, username: null, avatarUrl: null }, typing: false }] }); });
            expect(screen.getTextContent()).toContain('Ana');
            expect(screen.findByTestId('session-discussion-presence-faces')).not.toBeNull();
            expect(sourceSessionReads).not.toHaveBeenCalled();

            await screen.update(<DiscussionDetailsView target={target} active={false} standaloneSurface />);
            await vi.waitFor(() => expect(declarations.at(-1)?.locations ?? []).toEqual([]));
        } finally {
            await act(async () => { detach(); });
        }
    });

    it('opens route focus for navigation without turning a new post into a reply', async () => {
        const network = installNetwork(() => [message(1, true)]);
        await renderScreen(<DiscussionDetailsView target={{ ...target, messageId: 'message-1' }} active standaloneSurface />);
        await vi.waitFor(() => expect(composerProps.current).not.toBeNull());
        const content = buildDiscussionContentFromPendingText({ previousText: '', pendingText: 'Independent post', mentions: [] });
        await act(async () => { composerProps.current!.onSend(content); });
        await vi.waitFor(() => expect(network.post).toHaveBeenCalled());
        expect(network.post.mock.calls[0]![0].replyTarget).toBeUndefined();
        expect(network.post.mock.calls[0]![0].content).toEqual(content);
    });

    it('posts the explicit draft Reply target even when route focus points elsewhere and the parent is outside the loaded page', async () => {
        const network = installNetwork(() => [message(1, true)]);
        draftState.replyTarget = { kind: 'message', messageId: 'older-parent' };
        await renderScreen(<DiscussionDetailsView target={{ ...target, messageId: 'message-1' }} active standaloneSurface />);
        await vi.waitFor(() => expect(composerProps.current).not.toBeNull());
        const content = buildDiscussionContentFromPendingText({ previousText: '', pendingText: 'Deliberate reply', mentions: [] });
        await act(async () => { composerProps.current!.onSend(content); });
        await vi.waitFor(() => expect(network.post).toHaveBeenCalled());
        expect(network.post.mock.calls[0]![0].replyTarget).toEqual({ kind: 'message', messageId: 'older-parent' });
    });

    it('replies to a message only through its explicit Reply action, and the Replying-to line clears it', async () => {
        installNetwork(() => [message(1, true)]);
        const screen = await renderScreen(<DiscussionDetailsView target={{ ...target, messageId: 'message-1' }} active standaloneSurface />);
        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-reply-message-1')).not.toBeNull());
        // Route focus is navigation only: nothing reads as a reply until the person chooses Reply.
        expect(((composerProps.current as { contextItems?: readonly unknown[] } | null)?.contextItems ?? []).length).toBe(0);
        await screen.pressByTestIdAsync('session-discussion-reply-message-1');
        expect(draftState.setReplyTarget).toHaveBeenLastCalledWith({ kind: 'message', messageId: 'message-1' });
        draftState.replyTarget = { kind: 'message', messageId: 'message-1' };
        await screen.update(<DiscussionDetailsView target={target} active standaloneSurface />);
        // The reply target is a composer badge beside Session-style context items, not a block above the card.
        expect(screen.findByTestId('discussion-draft-reply')).toBeNull();
        const readReplyBadge = () => ((composerProps.current as { contextItems?: ReadonlyArray<{ testID?: string; label: string; accessibilityLabel?: string; onPress?: () => void; onRemove?: () => void }> } | null)
            ?.contextItems ?? []).find(item => item.testID === 'discussion-composer-reply');
        await vi.waitFor(() => expect(readReplyBadge()).toBeDefined());
        expect(readReplyBadge()!.accessibilityLabel).toContain('message 1');
        await act(async () => { readReplyBadge()!.onRemove?.(); });
        expect(draftState.setReplyTarget).toHaveBeenLastCalledWith(null);
    });

    it('says which Send to recipients were dropped because they left the Discussion', async () => {
        installNetwork(() => [message(1, true)]);
        draftState.recipients = [{ kind: 'session', sessionId: 'departed-session' }];
        const screen = await renderScreen(<DiscussionDetailsView target={target} active standaloneSurface />);
        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-recipients-removed')).not.toBeNull());
    });

    it.each(['create', 'post'] as const)('uses the exact pending submitted content for %s person attention', async (kind) => {
        const network = installNetwork(() => [message(1, true)]);
        draftState.title = 'Review';
        draftState.text = alexToken;
        draftState.mentions = [alexMention];
        const pending = buildDiscussionContentFromPendingText({ previousText: draftState.text, pendingText: '@Alex2', mentions: draftState.mentions });
        await renderScreen(<DiscussionDetailsView target={kind === 'create' ? { kind: 'new', address } : target} active standaloneSurface />);
        await vi.waitFor(() => expect(composerProps.current).not.toBeNull());
        await act(async () => { composerProps.current!.onSend(pending); });

        await vi.waitFor(() => expect(network[kind]).toHaveBeenCalled());
        const input = network[kind].mock.calls[0]![0];
        expect(input.content).toEqual({ v: 1, parts: [{ t: 'text', text: '@Alex2' }] });
        expect(input.mentionedAccountIds).toEqual([]);
    });

    it('derives an omitted create title from the exact pending submitted content', async () => {
        const { create } = installNetwork(() => [message(1, true)]);
        draftState.text = alexToken;
        draftState.mentions = [alexMention];
        const pending = buildDiscussionContentFromPendingText({ previousText: draftState.text, pendingText: '@Alex2', mentions: draftState.mentions });
        await renderScreen(<DiscussionDetailsView target={{ kind: 'new', address }} active standaloneSurface />);
        await act(async () => { composerProps.current!.onSend(pending); });

        await vi.waitFor(() => expect(create).toHaveBeenCalled());
        expect(create.mock.calls[0]![0].title).toBe('@Alex2');
    });

    it.each(['create', 'post'] as const)('admits meaningful flushed %s content while the synchronized draft still reads empty', async (kind) => {
        const network = installNetwork(() => [message(1, true)]);
        draftState.title = 'Review';
        await renderScreen(<DiscussionDetailsView target={kind === 'create' ? { kind: 'new', address } : target} active standaloneSurface />);
        await vi.waitFor(() => expect(composerProps.current).not.toBeNull());
        const content = buildDiscussionContentFromPendingText({ previousText: '', pendingText: 'Ready for review', mentions: [] });
        await act(async () => { composerProps.current!.onSend(content); });

        await vi.waitFor(() => expect(network[kind]).toHaveBeenCalled());
        expect(network[kind].mock.calls[0]![0].content).toEqual(content);
    });

    it.each(['create', 'post'] as const)('rejoins a restored %s with attention from rebuilt strict content and its original operands', async (kind) => {
        const network = installNetwork(() => [message(1, true)]);
        draftState.title = 'Review';
        draftState.text = '@Alex2';
        draftState.mentions = [alexMention];
        const draftAddress = kind === 'create' ? { kind: 'newDiscussion' as const } : { kind: 'discussion' as const, discussionId: target.discussionId };
        const currentness = { address: draftAddress, mutationIds: {} };
        draftState.pendingMutationAttempt = kind === 'create'
            ? { kind, creationLocalId: 'original-create', messageLocalId: 'original-first-post', anchor: { kind: 'session', sessionId: 'original-source' }, participants: [{ kind: 'account', accountId: 'original-invitee' }], currentness }
            : { kind, discussionId: target.discussionId, localId: 'original-post', replyTarget: { kind: 'message', messageId: 'message-1' }, currentness };
        draftState.submitted = { attemptLocalId: kind === 'create' ? 'original-create' : 'original-post',
            content: buildDiscussionContentFromPendingText({ previousText: draftState.text, pendingText: draftState.text, mentions: draftState.mentions }),
            ...(kind === 'create' ? { title: 'Review' } : {}) };
        draftState.text = 'A later synchronized edit';
        const screen = await renderScreen(<DiscussionDetailsView target={kind === 'create' ? { kind: 'new', address, anchor: { kind: 'session', sessionId: 'different-source' } } : target} active standaloneSurface />);
        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-mutation-retry')).not.toBeNull());
        await act(async () => { await screen.findByTestId('session-discussion-mutation-retry')!.props.onPress(); });

        await vi.waitFor(() => expect(network[kind]).toHaveBeenCalled());
        const input = network[kind].mock.calls[0]![0];
        expect(input.content).toEqual({ v: 1, parts: [{ t: 'text', text: '@Alex2' }] });
        expect(input.mentionedAccountIds).toEqual([]);
        expect(input).toMatchObject(kind === 'create'
            ? { creationLocalId: 'original-create', messageLocalId: 'original-first-post', anchor: { kind: 'session', sessionId: 'original-source' }, participants: [{ kind: 'account', accountId: 'original-invitee' }] }
            : { localId: 'original-post', replyTarget: { kind: 'message', messageId: 'message-1' } });
    });

    it('stops advancing once the standalone route is blurred, and a hidden pane host stays inactive', async () => {
        const rows = { current: [message(1, true)] };
        const { readState } = installNetwork(() => rows.current);
        const screen = await renderScreen(<DiscussionDetailsView target={target} active={false} standaloneSurface />);
        await flushHookEffects();
        expect(viewableHumanMessages()).toHaveLength(0);
        expect(readState).not.toHaveBeenCalled();

        // A Session-surface host (desktop Details pane) is not visible while its
        // Session surface is not registered, even if its tab is the active one.
        await screen.update(<DiscussionDetailsView target={target} active hostSessionAddress={{ serverId: address.serverId, sessionId: 'session-a' }} />);
        await vi.waitFor(() => expect(viewableHumanMessages()).toHaveLength(1));
        await reportAllRowsVisible();
        expect(readState).not.toHaveBeenCalled();

        markSessionSurfaceVisible('session-a', address.serverId);
        await screen.update(<DiscussionDetailsView target={target} active hostSessionAddress={{ serverId: address.serverId, sessionId: 'session-a' }} />);
        await reportAllRowsVisible();
        await vi.waitFor(() => expect(readState).toHaveBeenCalledWith('discussion-a', 1, undefined));
        markSessionSurfaceHidden('session-a', address.serverId);
    });

    it('never acknowledges a locked placeholder, and acknowledges the same still-visible row once it opens', async () => {
        const rows = { current: [message(1, false)] };
        const { readState } = installNetwork(() => rows.current);
        await renderScreen(<DiscussionDetailsView target={target} active standaloneSurface />);
        await vi.waitFor(() => expect(viewableHumanMessages()).toHaveLength(1));
        await reportAllRowsVisible();
        expect(readState).not.toHaveBeenCalled();

        // The Discussion key arrives; the repository reopens the retained row while it
        // is still on screen. No new viewability callback is required.
        rows.current = [message(1, true)];
        const { getDiscussionRepository } = await import('@/sync/ops/discussions/discussionRepositoryRegistry');
        const repository = getDiscussionRepository({ scope: exactHomeBinding.scope, address, client: network.client as unknown as DiscussionRepositoryClient });
        await act(async () => { await repository.refreshMessages('discussion-a'); });

        await vi.waitFor(() => expect(readState).toHaveBeenCalledWith('discussion-a', 1, undefined));
    });

    it('does not let a later readable row carry the cursor past an earlier locked row', async () => {
        const { readState } = installNetwork(() => [message(1, false), message(2, true)]);
        await renderScreen(<DiscussionDetailsView target={target} active standaloneSurface />);
        await vi.waitFor(() => expect(viewableHumanMessages()).toHaveLength(2));
        await reportAllRowsVisible();

        expect(readState).not.toHaveBeenCalled();
    });

    it('lets an unreadable row the cursor already covers stay behind, so newer readable rows still advance it', async () => {
        // Row 1 was read before its key became unavailable; it is not unread and
        // must not freeze the cursor below every later Discussion message.
        const { readState } = installNetwork(() => [message(1, false), message(2, true)], 1);
        await renderScreen(<DiscussionDetailsView target={target} active standaloneSurface />);
        await vi.waitFor(() => expect(viewableHumanMessages()).toHaveLength(2));
        await reportAllRowsVisible();

        await vi.waitFor(() => expect(readState).toHaveBeenCalledWith('discussion-a', 2, undefined));
    });
});
