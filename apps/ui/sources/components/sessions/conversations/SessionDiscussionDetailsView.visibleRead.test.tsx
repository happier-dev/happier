import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    SessionDiscussionOpenedMessageV1,
    SessionDiscussionOpenedSummaryV1,
} from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';
import type { SessionDiscussionRepositoryClient } from '@/sync/ops/sessionDiscussions/sessionDiscussionRepository';
import { clearSessionDiscussionRepositoryRegistryForTests } from '@/sync/ops/sessionDiscussions/sessionDiscussionRepositoryRegistry';
import {
    markSessionSurfaceHidden,
    markSessionSurfaceVisible,
    resetSessionSurfaceVisibilityForTests,
} from '@/sync/domains/session/sessionSurfaceVisibility';

/**
 * The visible-read admission of a mounted Discussion, through its real owners:
 * the shared exact-Session repository, the one visible-read controller and the
 * shared Session surface visibility owner all stay real. Only true boundaries
 * are substituted — the Discussion HTTP client, device credentials, the
 * presence socket — plus presentation-only children unrelated to reading.
 */
const network = vi.hoisted(() => ({ client: null as null | Record<string, unknown> }));
const transcriptProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
const exactHomeBinding = vi.hoisted(() => ({
    serverId: 'server-a',
    accountId: 'viewer',
    scope: { serverId: 'server-a', accountId: 'viewer' },
    revision: 1,
    isCurrent: () => true,
    onRetire: () => ({ dispose: () => undefined }),
}));
const draftState = vi.hoisted(() => ({
    title: '', text: '', mentions: [] as readonly unknown[], status: 'clean' as const, conflict: null,
    setComposer: () => undefined, setTitle: () => undefined, captureSubmittedCurrentness: () => null,
    clearAfterObservedSuccess: async () => undefined, releaseSubmittedAttempt: () => undefined,
    purgePresentation: async () => undefined,
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/sync/api/session/sessionDiscussionActions', () => ({
    createSessionDiscussionClient: () => network.client,
}));
vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', () => ({
    useServerCredentialAccountScopeBindings: () => new Map([[exactHomeBinding.serverId, exactHomeBinding]]),
}));
vi.mock('@/sync/domains/session/humanPresence/sessionHumanPresenceRuntime', () => ({
    registerSessionDiscussionHumanPresence: () => () => undefined,
}));
vi.mock('@/sync/domains/session/humanPresence/useSessionHumanPresence', () => ({
    useSessionHumanPresence: () => ({ status: 'live', viewers: [] }),
}));
vi.mock('@/utils/runtime/useHostActivelyViewed', () => ({ useHostActivelyViewed: () => true }));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({ useAppPaneScope: () => ({ openDetailsTab: vi.fn(), closeDetails: vi.fn() }) }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/hooks/session/useSessionCollaborationAvailability', () => ({ useSessionCollaborationAvailability: () => 'available' }));
vi.mock('@/hooks/session/useSessionAgentActivity', () => ({ useSessionAgentActivityRoster: () => ({ subagents: [], readExecutionRunEntry: () => null }) }));
vi.mock('@/hooks/session/useSessionExecutionRunLaunchability', () => ({ useSessionExecutionRunLaunchability: () => ({
    canLaunchExecutionRuns: false, canShowExecutionRunLauncher: false, executionRunsBackends: {}, executionRunsSupported: false, sessionServerId: 'server-a',
}) }));
vi.mock('@/components/sessions/shell/sessionViewStableSession', () => ({ useSessionViewShellSession: () => null }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
    });
});
vi.mock('@/sync/domains/state/storage', () => ({ useSetting: (key: string) => key === 'transcriptBulkCopyFormat' ? 'markdown_labeled' : '{{MESSAGES}}' }));
vi.mock('@/keyboard/KeyboardShortcutProvider', () => ({ useKeyboardShortcutHandlers: () => true }));
vi.mock('@/sync/sync', () => ({ sync: { patchSessionMetadataWithRetry: vi.fn() } }));
vi.mock('./useSessionDiscussionDraft', () => ({ useSessionDiscussionDraft: () => draftState }));
vi.mock('./SessionDiscussionComposer', () => ({ SessionDiscussionComposer: () => null }));
vi.mock('@/components/sessions/transcript/viewport/shell/TranscriptListShell', () => ({
    TranscriptListShell: (props: { data: readonly unknown[]; renderItem: (input: { item: unknown }) => React.ReactNode }) => {
        transcriptProps.current = props;
        return <>{props.data.map((item, index) => <React.Fragment key={index}>{props.renderItem({ item })}</React.Fragment>)}</>;
    },
}));

import { SessionDiscussionDetailsView } from './SessionDiscussionDetailsView';

const address = { serverId: 'server-a', sessionId: 'session-a' } as const;
const target = { kind: 'discussion' as const, address, discussionId: 'discussion-a' };

function summary(messageSeq: number, lastReadSeq = 0): SessionDiscussionOpenedSummaryV1 {
    return {
        id: 'discussion-a', sessionId: address.sessionId, creationLocalId: null, title: 'Design',
        latestMessage: { id: `message-${messageSeq}`, localId: null, seq: messageSeq, authorAccountId: 'alice', accountActor: { v: 1, accountId: 'alice', profile: null }, producerV1: null, createdAt: messageSeq },
        messageSeq, lastReadSeq, unreadCount: messageSeq - lastReadSeq, unreadMentionCount: 0, recentAuthorAccountIds: ['alice'], archivedAt: null,
        capabilities: { postMessages: true, rename: false, archive: false, restore: false, askAgent: false, sendToSession: false },
    };
}

function message(seq: number, opened: boolean): SessionDiscussionOpenedMessageV1 {
    return {
        id: `message-${seq}`, discussionId: 'discussion-a', localId: null, seq, authorAccountId: 'alice',
        accountActor: { v: 1, accountId: 'alice', profile: null }, producerV1: null,
        content: opened ? { v: 1, parts: [{ t: 'text', text: `message ${seq}` }] } : null,
        mentionedAccountIds: [], createdAt: seq,
    };
}

function installNetwork(rows: () => readonly SessionDiscussionOpenedMessageV1[], lastReadSeq = 0) {
    const messageSeq = () => rows().at(-1)?.seq ?? 0;
    const readState = vi.fn<SessionDiscussionRepositoryClient['readState']>(async (_discussionId, lastReadSeq) => ({
        kind: 'succeeded',
        value: { cursor: { lastReadSeq } },
    }) as never);
    const client: SessionDiscussionRepositoryClient = {
        list: vi.fn(async () => ({ kind: 'succeeded', value: { v: 1, serverId: address.serverId, sessionId: address.sessionId, discussions: [summary(messageSeq(), lastReadSeq)], nextCursor: null, incomplete: false } })) as never,
        get: vi.fn(async () => ({ kind: 'succeeded', value: { v: 1, serverId: address.serverId, sessionId: address.sessionId, discussion: summary(messageSeq(), lastReadSeq) } })) as never,
        read: vi.fn(async (_discussionId: string, input?: { afterSeq?: number }) => {
            const all = rows();
            const page = input?.afterSeq === undefined ? all : all.filter((row) => row.seq > input.afterSeq!);
            return { kind: 'succeeded', value: { v: 1, serverId: address.serverId, sessionId: address.sessionId, discussionId: 'discussion-a', messages: [...page], hasMoreOlder: false, messageSeq: messageSeq(), incomplete: page.some((row) => row.content === null) } };
        }) as never,
        create: vi.fn() as never,
        post: vi.fn() as never,
        rename: vi.fn() as never,
        archive: vi.fn() as never,
        restore: vi.fn() as never,
        readState,
    };
    network.client = client as unknown as Record<string, unknown>;
    return { readState };
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

describe('SessionDiscussionDetailsView visible read', () => {
    beforeEach(() => {
        resetSessionSurfaceVisibilityForTests();
        clearSessionDiscussionRepositoryRegistryForTests();
        transcriptProps.current = null;
    });

    afterEach(() => {
        resetSessionSurfaceVisibilityForTests();
        clearSessionDiscussionRepositoryRegistryForTests();
    });

    it('advances the private cursor from a focused standalone Discussion route without any primary Session surface', async () => {
        const { readState } = installNetwork(() => [message(1, true)]);

        // No SessionView is mounted: the standalone route is itself the visible surface.
        await renderScreen(<SessionDiscussionDetailsView target={target} active standaloneSurface />);
        await vi.waitFor(() => expect(viewableHumanMessages()).toHaveLength(1));
        await reportAllRowsVisible();

        await vi.waitFor(() => expect(readState).toHaveBeenCalledWith('discussion-a', 1, undefined));
    });

    it('stops advancing once the standalone route is blurred, and a hidden pane host stays inactive', async () => {
        const rows = { current: [message(1, true)] };
        const { readState } = installNetwork(() => rows.current);
        const screen = await renderScreen(<SessionDiscussionDetailsView target={target} active={false} standaloneSurface />);
        await vi.waitFor(() => expect(viewableHumanMessages()).toHaveLength(1));
        await reportAllRowsVisible();
        expect(readState).not.toHaveBeenCalled();

        // A Session-surface host (desktop Details pane) is not visible while its
        // Session surface is not registered, even if its tab is the active one.
        await screen.update(<SessionDiscussionDetailsView target={target} active />);
        await reportAllRowsVisible();
        expect(readState).not.toHaveBeenCalled();

        markSessionSurfaceVisible(address.sessionId, address.serverId);
        await screen.update(<SessionDiscussionDetailsView target={target} active />);
        await reportAllRowsVisible();
        await vi.waitFor(() => expect(readState).toHaveBeenCalledWith('discussion-a', 1, undefined));
        markSessionSurfaceHidden(address.sessionId, address.serverId);
    });

    it('never acknowledges a locked placeholder, and acknowledges the same still-visible row once it opens', async () => {
        const rows = { current: [message(1, false)] };
        const { readState } = installNetwork(() => rows.current);
        await renderScreen(<SessionDiscussionDetailsView target={target} active standaloneSurface />);
        await vi.waitFor(() => expect(viewableHumanMessages()).toHaveLength(1));
        await reportAllRowsVisible();
        expect(readState).not.toHaveBeenCalled();

        // The Session key arrives; the repository reopens the retained row while it
        // is still on screen. No new viewability callback is required.
        rows.current = [message(1, true)];
        const { getSessionDiscussionRepository } = await import('@/sync/ops/sessionDiscussions/sessionDiscussionRepositoryRegistry');
        const repository = getSessionDiscussionRepository({ scope: exactHomeBinding.scope, address, client: network.client as unknown as SessionDiscussionRepositoryClient });
        await act(async () => { await repository.refreshMessages('discussion-a'); });

        await vi.waitFor(() => expect(readState).toHaveBeenCalledWith('discussion-a', 1, undefined));
    });

    it('does not let a later readable row carry the cursor past an earlier locked row', async () => {
        const { readState } = installNetwork(() => [message(1, false), message(2, true)]);
        await renderScreen(<SessionDiscussionDetailsView target={target} active standaloneSurface />);
        await vi.waitFor(() => expect(viewableHumanMessages()).toHaveLength(2));
        await reportAllRowsVisible();

        expect(readState).not.toHaveBeenCalled();
    });

    it('lets an unreadable row the cursor already covers stay behind, so newer readable rows still advance it', async () => {
        // Row 1 was read before its key became unavailable; it is not unread and
        // must not freeze the cursor below every later Discussion message.
        const { readState } = installNetwork(() => [message(1, false), message(2, true)], 1);
        await renderScreen(<SessionDiscussionDetailsView target={target} active standaloneSurface />);
        await vi.waitFor(() => expect(viewableHumanMessages()).toHaveLength(2));
        await reportAllRowsVisible();

        await vi.waitFor(() => expect(readState).toHaveBeenCalledWith('discussion-a', 2, undefined));
    });
});
