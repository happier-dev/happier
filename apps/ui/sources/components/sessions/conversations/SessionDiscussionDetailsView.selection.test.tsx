import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessageAccountActorV1 } from '@happier-dev/protocol';
import type { SessionDiscussionRepositoryMutationOutcome } from '@/sync/ops/sessionDiscussions/sessionDiscussionRepository';

import { renderScreen } from '@/dev/testkit';

const pane = vi.hoisted(() => ({ openDetailsTab: vi.fn(), closeDetails: vi.fn(), closeDetailsTab: vi.fn() }));
const clipboard = vi.hoisted(() => vi.fn<(value: string) => Promise<boolean>>(async () => true));
const focusComposer = vi.hoisted(() => vi.fn(() => true));
const routerPush = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
const deviceType = vi.hoisted(() => ({ current: 'tablet' as 'tablet' | 'phone' }));
const repositoryRetry = vi.hoisted(() => vi.fn());
const repositoryRefreshDiscussion = vi.hoisted(() => vi.fn());
const repositoryCreate = vi.hoisted(() => vi.fn(async () => ({ kind: 'failed', errorCode: 'test-stop' })));
const repositoryPost = vi.hoisted(() => vi.fn(async () => ({ kind: 'failed', errorCode: 'test-stop' })));
const repositoryDismiss = vi.hoisted(() => vi.fn(() => true));
const launchability = vi.hoisted(() => ({ current: true }));
const shellSession = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
const repositoryRename = vi.hoisted(() => vi.fn<() => Promise<SessionDiscussionRepositoryMutationOutcome<unknown>>>(async () => ({ kind: 'succeeded', value: {} })));
const repositoryArchive = vi.hoisted(() => vi.fn(async () => ({ kind: 'succeeded', value: {} })));
const repositoryRestore = vi.hoisted(() => vi.fn(async () => ({ kind: 'succeeded', value: {} })));
const dropdownProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
const composerProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
const repositoryOptions = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
const transcriptProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
const observeVisibleMessageSeqs = vi.hoisted(() => vi.fn());
const updateVisibleReadEligibility = vi.hoisted(() => vi.fn());
const exactHomeBinding = vi.hoisted(() => ({
    current: {
        serverId: 'server-a',
        accountId: 'viewer',
        scope: { serverId: 'server-a', accountId: 'viewer' },
        revision: 1,
        isCurrent: () => true,
        onRetire: () => ({ dispose: () => undefined }),
    },
}));
const exactHomeBindings = vi.hoisted(() => ({ current: new Map<string, typeof exactHomeBinding.current>() }));
const draftState = vi.hoisted(() => ({
    title: '', text: '', mentions: [] as readonly unknown[],
    status: 'clean' as 'clean' | 'pending' | 'offline' | 'conflict' | 'error' | 'unsupported',
    conflict: null as null | { fields: readonly unknown[] },
    setComposer: vi.fn(), setTitle: vi.fn(), captureSubmittedCurrentness: vi.fn(() => ({
        scope: { serverId: 'server-a', accountId: 'viewer' },
        address: { kind: 'newDiscussion', sessionId: 'session-a' },
        currentness: { address: { kind: 'newDiscussion', sessionId: 'session-a' }, mutationIds: {} },
    })),
    clearAfterObservedSuccess: vi.fn(), releaseSubmittedAttempt: vi.fn(), purgePresentation: vi.fn(async () => undefined),
}));
const activity = vi.hoisted(() => ({ subagents: [] as unknown[], readExecutionRunEntry: vi.fn((_runId: string) => null as unknown) }));
const metadataWrites = vi.hoisted(() => vi.fn(async (_sessionId: string, update: (metadata: unknown) => unknown, options: unknown) => ({
    metadata: update({}),
    options,
})));
const snapshot = vi.hoisted(() => ({
    mutations: {},
    lists: { active: { items: [] }, archived: { items: [] } },
    threads: {
        'discussion-a': {
            status: 'ready' as 'idle' | 'loading' | 'ready' | 'offline' | 'locked' | 'error' | 'revoked',
            errorCode: null as string | null,
            hasMoreOlder: false,
            summary: {
                id: 'discussion-a', sessionId: 'session-a', creationLocalId: null, title: 'Design', messageSeq: 1,
                latestMessage: { id: 'message-a', seq: 1, authorAccountId: 'account-private-123', accountActor: { v: 1, accountId: 'account-private-123', profile: { firstName: 'Alice', lastName: null, username: null, avatarUrl: null } }, producerV1: null, createdAt: 1 },
                lastReadSeq: null as number | null, unreadCount: 1, unreadMentionCount: 0, recentAuthorAccountIds: ['alice'], archivedAt: null as number | null,
                capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true },
            },
            messages: [{
                id: 'message-a', discussionId: 'discussion-a', localId: null, seq: 1, authorAccountId: 'account-private-123', producerV1: null,
                accountActor: { v: 1, accountId: 'account-private-123', profile: { firstName: 'Alice', lastName: null, username: null, avatarUrl: null } },
                content: { v: 1, parts: [{ t: 'text', text: 'Check this' }, { t: 'mention', accountId: 'mention-private-456' }] }, mentionedAccountIds: ['mention-private-456'], createdAt: 1,
            }, {
                id: 'message-agent', discussionId: 'discussion-a', localId: null, seq: 2, authorAccountId: 'account-private-123',
                accountActor: { v: 1, accountId: 'account-private-123', profile: { firstName: 'Alice', lastName: null, username: null, avatarUrl: null } },
                producerV1: { v: 1, kind: 'agent', sessionId: 'session-a', runId: 'run-a' },
                content: { v: 1, parts: [{ t: 'text', text: 'Agent result' }] }, mentionedAccountIds: [], createdAt: 2,
            }],
        },
    },
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: routerPush, replace: routerReplace }) }));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({ useAppPaneScope: () => pane }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/hooks/session/useSessionCollaborationAvailability', () => ({ useSessionCollaborationAvailability: () => 'available' }));
vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', () => ({
    useServerCredentialAccountScopeBindings: () => exactHomeBindings.current,
}));
vi.mock('@/hooks/session/useSessionAgentActivity', () => ({ useSessionAgentActivityRoster: () => activity }));
const DEFAULT_PRESENCE_VIEW = { status: 'live', viewers: [
    { account: { kind: 'account', accountId: 'account-private-123', firstName: 'Presence Alice', lastName: null, username: null, avatarUrl: null }, typing: false },
    { account: { kind: 'account', accountId: 'mention-private-456', firstName: 'Bob', lastName: null, username: null, avatarUrl: null }, typing: false },
] };
const presenceView = vi.hoisted(() => ({ current: null as null | { status: string; viewers: readonly unknown[] } }));
vi.mock('@/sync/domains/session/humanPresence/useSessionHumanPresence', () => ({
    useSessionHumanPresence: () => presenceView.current ?? DEFAULT_PRESENCE_VIEW,
}));
vi.mock('@/sync/ops/sessionDiscussions/useSessionDiscussionRepositorySnapshot', () => ({ useSessionDiscussionRepositorySnapshot: () => snapshot }));
vi.mock('@/sync/ops/sessionDiscussions/sessionDiscussionRepositoryRegistry', () => ({ getSessionDiscussionRepository: (options: Record<string, unknown>) => {
    repositoryOptions.current = options;
    return { mount: () => () => undefined, getSnapshot: () => snapshot, refreshDiscussion: repositoryRefreshDiscussion, setReadState: vi.fn(async () => ({ kind: 'succeeded', value: { cursor: { lastReadSeq: 1 } } })), create: repositoryCreate, post: repositoryPost, dismissFailure: repositoryDismiss, rename: repositoryRename, archive: repositoryArchive, restore: repositoryRestore, retry: repositoryRetry, acknowledgeObservedSuccess: vi.fn(), loadOlderMessages: vi.fn() };
} }));
vi.mock('@/sync/domains/session/discussions/sessionDiscussionVisibleReadController', () => ({ createSessionDiscussionVisibleReadController: () => ({ updateEligibility: updateVisibleReadEligibility, observeVisibleMessageSeqs }) }));
vi.mock('@/utils/runtime/useHostActivelyViewed', () => ({ useHostActivelyViewed: () => true }));
vi.mock('@/sync/domains/session/sessionSurfaceVisibility', () => ({ useSessionSurfaceVisibilitySnapshot: () => 1, isSessionSurfaceVisible: () => true }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: deviceType.current === 'phone' ? 390 : 1440, height: 900, scale: 1, fontScale: 1 }),
    });
});
vi.mock('@/sync/domains/state/storage', () => ({ useSetting: (key: string) => key === 'transcriptBulkCopyFormat' ? 'markdown_labeled' : '{{MESSAGES}}' }));
vi.mock('@/utils/ui/clipboard', () => ({ setClipboardStringSafe: clipboard }));
vi.mock('@/components/sessions/presentation/sessionComposerPresentationTargets', () => ({ requestRegisteredSessionComposerFocus: focusComposer }));
vi.mock('@/sync/sync', () => ({ sync: { patchSessionMetadataWithRetry: metadataWrites } }));
vi.mock('@/keyboard/KeyboardShortcutProvider', () => ({ useKeyboardShortcutHandlers: () => true }));
vi.mock('@/components/sessions/transcript/viewport/shell/TranscriptListShell', () => ({ TranscriptListShell: (props: { data: readonly unknown[]; renderItem: (input: { item: unknown }) => React.ReactNode }) => { transcriptProps.current = props; return <>{props.data.map((item, index) => <React.Fragment key={index}>{props.renderItem({ item })}</React.Fragment>)}</>; } }));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown> & { trigger: (input: Record<string, unknown>) => React.ReactNode }) => {
        dropdownProps.current = props;
        return <>{props.trigger({ open: false, toggle: vi.fn(), openMenu: vi.fn(), closeMenu: vi.fn(), selectedItem: null })}</>;
    },
}));
vi.mock('./SessionDiscussionComposer', () => ({ SessionDiscussionComposer: (props: Record<string, unknown>) => { composerProps.current = props; return null; } }));
vi.mock('./useSessionDiscussionDraft', () => ({ useSessionDiscussionDraft: () => draftState }));
vi.mock('@/components/sessions/shell/sessionViewStableSession', () => ({ useSessionViewShellSession: () => shellSession.current }));
vi.mock('@/hooks/session/useSessionExecutionRunLaunchability', () => ({ useSessionExecutionRunLaunchability: () => ({
    canLaunchExecutionRuns: launchability.current, canShowExecutionRunLauncher: launchability.current, executionRunsBackends: {}, executionRunsSupported: launchability.current, sessionServerId: 'server-a',
}) }));

import { SessionDiscussionDetailsView } from './SessionDiscussionDetailsView';
import { createSessionDiscussionDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import {
    consumeInteractiveExecutionRunDraftNavigationIntent,
    resetInteractiveExecutionRunDraftNavigationIntentsForTests,
} from '@/components/sessions/runs/launcher/interactiveExecutionRunDraftNavigationIntent';

async function press(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    const node = screen.find((item) => item.props?.testID === testID && typeof item.props.onPress === 'function');
    await act(async () => { await node.props.onPress(); });
}

describe('SessionDiscussionDetailsView selection', () => {
    beforeEach(() => {
        pane.openDetailsTab.mockClear();
        pane.closeDetails.mockClear();
        pane.closeDetailsTab.mockClear();
        clipboard.mockClear();
        focusComposer.mockClear();
        routerPush.mockClear();
        routerReplace.mockClear();
        deviceType.current = 'tablet';
        resetInteractiveExecutionRunDraftNavigationIntentsForTests();
        metadataWrites.mockClear();
        repositoryRetry.mockClear();
        repositoryCreate.mockClear();
        repositoryPost.mockClear();
        repositoryDismiss.mockClear();
        launchability.current = true;
        shellSession.current = null;
        repositoryRename.mockClear();
        repositoryArchive.mockClear();
        repositoryRestore.mockClear();
        dropdownProps.current = null;
        composerProps.current = null;
        repositoryOptions.current = null;
        exactHomeBinding.current = {
            serverId: 'server-a',
            accountId: 'viewer',
            scope: { serverId: 'server-a', accountId: 'viewer' },
            revision: 1,
            isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }),
        };
        exactHomeBindings.current = new Map([[exactHomeBinding.current.serverId, exactHomeBinding.current]]);
        draftState.title = '';
        draftState.text = '';
        draftState.mentions = [];
        draftState.status = 'clean';
        draftState.conflict = null;
        draftState.purgePresentation.mockClear();
        draftState.releaseSubmittedAttempt.mockClear();
        transcriptProps.current = null;
        observeVisibleMessageSeqs.mockClear();
        updateVisibleReadEligibility.mockClear();
        activity.subagents = [];
        activity.readExecutionRunEntry.mockReset().mockReturnValue(null);
        delete (snapshot.mutations as Record<string, unknown>)['post-local-unknown'];
        delete (snapshot.mutations as Record<string, unknown>)['post-local-failed'];
        delete (snapshot.mutations as Record<string, unknown>)['create-local-failed'];
        snapshot.threads['discussion-a'].status = 'ready';
        snapshot.threads['discussion-a'].errorCode = null;
        snapshot.threads['discussion-a'].summary.lastReadSeq = null;
        snapshot.threads['discussion-a'].summary.archivedAt = null;
        snapshot.threads['discussion-a'].summary.capabilities = {
            postMessages: true,
            rename: true,
            archive: true,
            restore: false,
            askAgent: true,
            sendToSession: true,
        };
    });

    it.each([
        ['a new conversation', { kind: 'new' as const, address: { serverId: 'server-a', sessionId: 'session-a' } }],
        ['an existing conversation', { kind: 'discussion' as const, address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }],
    ])('keeps the empty editor available while Send alone remains unavailable for %s', async (_label, target) => {
        await renderScreen(<SessionDiscussionDetailsView target={target} active />);

        expect(composerProps.current?.disabled).toBe(false);
        expect((composerProps.current?.value as { text: string }).text).toBe('');
    });

    it('annotates a known write refusal on the new-conversation flow without purging the private draft', async () => {
        draftState.text = 'Private draft I am still writing';
        const target = { kind: 'new' as const, address: { serverId: 'server-a', sessionId: 'session-a' } };
        const screen = await renderScreen(<SessionDiscussionDetailsView target={target} active />);
        expect(composerProps.current?.disabled).toBe(false);

        // Known refusal from the exact Session's own access projection.
        shellSession.current = { id: 'session-a', access: { role: 'recipient', level: 'view', capabilities: { readTranscript: true, submitAgentInput: false } } };
        await screen.update(<SessionDiscussionDetailsView target={target} active />);

        expect(composerProps.current?.disabled).toBe(true);
        expect(screen.getTextContent()).toContain('You can no longer post in this Session.');
        // A write downgrade is not access loss: the private draft survives.
        expect(draftState.purgePresentation).not.toHaveBeenCalled();
        expect((composerProps.current?.value as { text: string }).text).toBe('Private draft I am still writing');

        shellSession.current = { id: 'session-a', access: { role: 'recipient', level: 'edit', capabilities: { readTranscript: true, submitAgentInput: true } } };
        await screen.update(<SessionDiscussionDetailsView target={target} active />);
        expect(composerProps.current?.disabled).toBe(false);
        expect((composerProps.current?.value as { text: string }).text).toBe('Private draft I am still writing');
    });

    it('keeps the new-conversation flow usable while the exact Session write capability is unknown', async () => {
        shellSession.current = null;
        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'new', address: { serverId: 'server-a', sessionId: 'session-a' } }} active />);

        expect(composerProps.current?.disabled).toBe(false);
        expect(screen.getTextContent()).not.toContain('You can no longer post in this Session.');
    });

    // A disconnected client keeps its last observation as `stale` with the
    // viewers' typing flags intact; the header must not keep claiming live typing.
    it('names a live typist, then keeps a stale observation\'s names without a typing claim', async () => {
        const viewer = {
            account: { kind: 'account', accountId: 'account-private-123', firstName: 'Presence Alice', lastName: null, username: null, avatarUrl: null },
            typing: true,
        };
        const discussionTarget = { kind: 'discussion' as const, address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' };
        try {
            presenceView.current = { status: 'live', viewers: [viewer] };
            const screen = await renderScreen(<SessionDiscussionDetailsView target={discussionTarget} active />);
            expect(screen.findByTestId('session-discussion-presence')?.props.children).toBe('Presence Alice is typing…');

            presenceView.current = { status: 'stale', viewers: [viewer] };
            await screen.update(<SessionDiscussionDetailsView target={discussionTarget} active />);
            expect(screen.findByTestId('session-discussion-presence')?.props.children).toBe('Presence Alice is here · May be out of date');
        } finally {
            presenceView.current = null;
        }
    });

    it('says who is here and who is typing in this conversation, beside their faces', async () => {
        const discussionTarget = { kind: 'discussion' as const, address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' };
        try {
            presenceView.current = { status: 'live', viewers: [
                { account: { kind: 'account', accountId: 'account-private-123', firstName: 'Ana', lastName: null, username: null, avatarUrl: null }, typing: false },
                { account: { kind: 'account', accountId: 'mention-private-456', firstName: 'Ben', lastName: null, username: null, avatarUrl: null }, typing: true },
            ] };
            const screen = await renderScreen(<SessionDiscussionDetailsView target={discussionTarget} active />);

            expect(screen.findByTestId('session-discussion-presence')?.props.children).toBe('Ana and Ben are here · Ben is typing…');
            expect(screen.findByTestId('session-discussion-presence-faces')?.props.accessibilityLabel).toContain('Ana');
            // The header names the people in this conversation now, not a history of past authors.
            expect(screen.findByTestId('session-discussion-recent-authors')).toBeNull();
        } finally {
            presenceView.current = null;
        }
    });

    it('exposes the conversation title as the details heading', async () => {
        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        expect(screen.findByTestId('session-discussion-header.title')?.props.accessibilityRole).toBe('header');
    });

    it('presents recent authors, quiet lifecycle actions, producer-aware groups, and accessible timestamps', async () => {
        const messages = snapshot.threads['discussion-a'].messages as unknown as Array<typeof snapshot.threads['discussion-a']['messages'][number]>;
        messages.push({
            ...messages[1]!,
            id: 'message-agent-followup',
            seq: 3,
            content: { v: 1, parts: [{ t: 'text', text: 'Agent follow-up' }] },
            createdAt: 3,
        });
        try {
            const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

            expect(screen.findByTestId('session-discussion-message-group-start-message-a')).not.toBeNull();
            expect(screen.findByTestId('session-discussion-message-group-start-message-agent')).not.toBeNull();
            expect(screen.findByTestId('session-discussion-message-group-continuation-message-agent-followup')).not.toBeNull();
            // One header per author group: a continuation carries no second name or time.
            expect(screen.findByTestId('session-discussion-message-actor-message-agent-followup')).toBeNull();
            expect(screen.findByTestId('session-discussion-message-timestamp-message-agent-followup')).toBeNull();

            const timestamp = screen.findByTestId('session-discussion-message-timestamp-message-a');
            expect(timestamp?.props.accessibilityRole).toBe('text');
            expect(timestamp?.props.accessibilityLabel).toBe(new Date(1).toLocaleString());

            expect(screen.findByTestId('session-discussion-actions-menu')).not.toBeNull();
            expect(dropdownProps.current?.items).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'rename', title: 'Rename conversation' }),
                expect.objectContaining({ id: 'archive', title: 'Archive conversation' }),
            ]));
            expect(screen.tree.findAll((item) => item.props?.accessibilityLabel === 'Rename conversation')).toHaveLength(0);
            expect(screen.tree.findAll((item) => item.props?.accessibilityLabel === 'Archive conversation')).toHaveLength(0);
            await act(async () => {
                (dropdownProps.current?.onSelect as (itemId: string) => void)('archive');
            });
            expect(repositoryArchive).toHaveBeenCalledWith('discussion-a');
        } finally {
            messages.pop();
        }
    });

    it('keeps rename text and presents typed unknown/refusal outcomes until the next lifecycle success', async () => {
        repositoryRename
            .mockResolvedValueOnce({ kind: 'failed', errorCode: 'outcome_unknown' })
            .mockResolvedValueOnce({ kind: 'failed', errorCode: 'session_discussion_manage_denied' })
            .mockResolvedValueOnce({ kind: 'succeeded', value: {} });
        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        act(() => {
            (dropdownProps.current?.onSelect as (itemId: string) => void)('rename');
        });
        const input = screen.findByTestId('session-discussion-rename-input');
        act(() => input?.props.onChangeText('Still editing'));
        const save = screen.find((item) => item.props?.accessibilityLabel === 'Save' && typeof item.props.onPress === 'function');
        await act(async () => { await save.props.onPress(); });

        expect(screen.findByTestId('session-discussion-rename-input')?.props.value).toBe('Still editing');
        expect(screen.getTextContent()).toContain('Delivery unknown');
        expect(screen.getTextContent()).not.toContain('Conversations could not be loaded.');

        await act(async () => { await save.props.onPress(); });
        expect(screen.findByTestId('session-discussion-rename-input')?.props.value).toBe('Still editing');
        expect(screen.getTextContent()).toContain('Permission denied');
        expect(screen.getTextContent()).not.toContain('Conversations could not be loaded.');

        await act(async () => { await save.props.onPress(); });
        expect(screen.getTextContent()).not.toContain('Permission denied');
        expect(screen.findByTestId('session-discussion-rename-input')).toBeNull();
    });

    it('binds details repository lifetime to the exact Session Home rather than the active Home', async () => {
        exactHomeBinding.current = {
            serverId: 'server-b',
            accountId: 'viewer-b',
            scope: { serverId: 'server-b', accountId: 'viewer-b' },
            revision: 4,
            isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }),
        };
        exactHomeBindings.current = new Map([[exactHomeBinding.current.serverId, exactHomeBinding.current]]);

        await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-b', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        expect(repositoryOptions.current).toEqual(expect.objectContaining({
            scope: { serverId: 'server-b', accountId: 'viewer-b' },
            address: { serverId: 'server-b', sessionId: 'session-a' },
            accountLifetime: exactHomeBinding.current,
        }));
    });

    it('creates with an optional title derived from the first nonempty message line', async () => {
        draftState.text = '\n  Release status  \nPlease review';
        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'new', address: { serverId: 'server-a', sessionId: 'session-a' } }} active />);

        expect(composerProps.current?.disabled).toBe(false);
        await act(async () => {
            await (composerProps.current?.onSend as (content: unknown) => Promise<void>)({ v: 1, parts: [{ t: 'text', text: draftState.text }] });
        });
        expect(repositoryCreate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Release status' }));
        expect(screen.findByTestId('session-discussion-title')).not.toBeNull();
    });

    it('keeps a mention-only first message as a draft until the user supplies a title', async () => {
        draftState.text = '@Alex';
        draftState.mentions = [{ start: 0, end: 5, accountId: 'account-a' }];
        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'new', address: { serverId: 'server-a', sessionId: 'session-a' } }} active />);

        await act(async () => {
            await (composerProps.current?.onSend as (content: unknown) => Promise<void>)({ v: 1, parts: [{ t: 'mention', accountId: 'account-a' }] });
        });

        expect(repositoryCreate).not.toHaveBeenCalled();
        expect(screen.findByTestId('session-discussion-title-required')?.props.children).toBe('Add a title to start this conversation.');
        expect((composerProps.current?.value as { text: string }).text).toBe('@Alex');
    });

    it('opens a linked execution Run through the canonical Run Details command', async () => {
        activity.subagents = [{
            id: 'execution_run:run-linked', kind: 'execution_run', status: 'running', display: { title: 'Linked run' }, transcript: {},
            runRef: { runId: 'run-linked', launchOrigin: { kind: 'session_discussion', sessionId: 'session-a', discussionId: 'discussion-a', messageIds: ['message-a'] } },
            recipient: null,
            capabilities: { canOpen: true, canSend: false, canStop: false, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: true }, timestamps: {},
        }];
        activity.readExecutionRunEntry.mockReturnValue({
            id: 'execution_run:run-linked', kind: 'execution_run', status: 'running', title: 'Linked run', metaDetail: null,
            startedAtMs: 1, endedAtMs: null, provenance: 'local', detailState: 'loaded', parentId: null,
            runId: 'run-linked', sidechainId: null, subagentId: 'execution_run:run-linked', attentionKinds: [],
        });
        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        await press(screen, 'session-discussion-agent-activity:run-linked');
        expect(pane.openDetailsTab).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'executionRun',
            resource: { kind: 'executionRun', runId: 'run-linked' },
        }), { intent: 'preview' });
    });

    it('selects a trusted Agent-posted row with its Account label and Via Agent attribution, and keeps Run cards ineligible', async () => {
        activity.subagents = [{
            id: 'execution_run:run-linked', kind: 'execution_run', status: 'running', display: { title: 'Linked run' }, transcript: {},
            runRef: { runId: 'run-linked', launchOrigin: { kind: 'session_discussion', sessionId: 'session-a', discussionId: 'discussion-a', messageIds: ['message-a'] } },
            recipient: null,
            capabilities: { canOpen: true, canSend: false, canStop: false, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: true }, timestamps: {},
        }];
        activity.readExecutionRunEntry.mockReturnValue({
            id: 'execution_run:run-linked', kind: 'execution_run', status: 'running', title: 'Linked run', metaDetail: null,
            startedAtMs: 1, endedAtMs: null, provenance: 'local', detailState: 'loaded', parentId: null,
            runId: 'run-linked', sidechainId: null, subagentId: 'execution_run:run-linked', attentionKinds: [],
        });
        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        // A Run activity card is a resource reference, never a selectable message.
        expect(screen.tree.findAll((item) => typeof item.props?.testID === 'string'
            && item.props.testID.startsWith('session-discussion-select-run'))).toHaveLength(0);

        await press(screen, 'session-discussion-select-message-agent');
        await press(screen, 'transcript-selection-copy');
        expect(clipboard).toHaveBeenCalledWith('**Alice · Via Agent:**\n\nAgent result');
        expect(clipboard.mock.calls[0]?.[0]).not.toContain('Assistant');
        expect(clipboard.mock.calls[0]?.[0]).not.toContain('account-private-123');

        await press(screen, 'session-discussion-selection-ask-agent');
        expect(pane.openDetailsTab).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'executionRunLauncher',
            resource: expect.objectContaining({
                initialInstructions: '**Alice · Via Agent:**\n\nAgent result',
                source: expect.objectContaining({ kind: 'session_discussion', sessionId: 'session-a', discussionId: 'discussion-a', messageIds: ['message-agent'] }),
            }),
        }), { intent: 'preview' });
    });

    it('mounts row selection, copies canonical labeled text, and opens the interactive Agent draft', async () => {
        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        expect(screen.findByTestId('session-discussion-message-content-message-a')?.props.children[0]).toBe('Check this');
        expect(screen.findByTestId('session-discussion-mention-message-a-1')?.props.children).toBe('@Bob');
        expect(screen.findByTestId('session-discussion-message-actor-message-a')?.props.children).toBe('Alice');
        expect(screen.findByTestId('session-discussion-message-actor-message-agent')?.props.children).toBe('Alice');
        expect(screen.findByTestId('session-discussion-message-producer-message-agent')?.props.children).toBe('Via Agent');

        await press(screen, 'session-discussion-select-message-a');
        await press(screen, 'transcript-selection-copy');
        expect(clipboard).toHaveBeenCalledWith('**Alice:**\n\nCheck this@Bob');
        expect(clipboard.mock.calls[0]?.[0]).not.toContain('account-private-123');

        await press(screen, 'session-discussion-selection-ask-agent');
        expect(pane.openDetailsTab).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'executionRunLauncher',
            resource: expect.objectContaining({
                kind: 'executionRunLauncher', mode: 'conversation', initialInstructions: '**Alice:**\n\nCheck this@Bob',
                source: expect.objectContaining({ kind: 'session_discussion', sessionId: 'session-a', discussionId: 'discussion-a', messageIds: ['message-a'], draftCorrelationId: expect.any(String) }),
            }),
        }), { intent: 'preview' });
    });

    it('preserves selection and composer handoff state when Send to Session fails, then retries once', async () => {
        metadataWrites
            .mockRejectedValueOnce(new Error('temporary metadata write failure'))
            .mockImplementationOnce(async (_sessionId, update, options) => ({ metadata: update({}), options }));
        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        await press(screen, 'session-discussion-select-message-a');
        await press(screen, 'transcript-selection-send');

        expect(metadataWrites).toHaveBeenCalledTimes(1);
        expect(pane.closeDetails).not.toHaveBeenCalled();
        expect(routerReplace).not.toHaveBeenCalled();
        expect(focusComposer).not.toHaveBeenCalled();
        expect(screen.findByTestId('transcript-selection-toolbar-count')?.props.children).toBe('1 message selected');
        const announcements = screen.root.findAll((node) => (
            typeof node.type === 'string'
            && node.props.role === 'status'
            && node.findAll((child) => child.props.testID === 'session-discussion-selection-handoff-error').length > 0
        ));
        expect(announcements).toHaveLength(1);
        expect(announcements[0]?.props.accessibilityLiveRegion).toBe('polite');
        expect(announcements[0]?.props['aria-live']).toBe('polite');
        expect(screen.getTextContent()).toContain('The selected messages could not be added to the Session composer.');

        await press(screen, 'session-discussion-selection-handoff-retry');

        expect(metadataWrites).toHaveBeenCalledTimes(2);
        expect(metadataWrites).toHaveBeenLastCalledWith('session-a', expect.any(Function), { serverId: 'server-a' });
        expect(pane.closeDetails).toHaveBeenCalledTimes(1);
        expect(focusComposer).toHaveBeenCalledTimes(1);
        expect(routerReplace).not.toHaveBeenCalled();
        expect(screen.findByTestId('session-discussion-selection-handoff-error')).toBeNull();
    });

    it('uses the safe historical fallback without exposing a deleted Account id', async () => {
        type MutableActorMessage = Omit<typeof snapshot.threads['discussion-a']['messages'][number], 'accountActor'> & { accountActor: SessionMessageAccountActorV1 };
        const message = snapshot.threads['discussion-a'].messages[0]! as MutableActorMessage;
        const agentMessage = snapshot.threads['discussion-a'].messages[1]! as MutableActorMessage;
        const originalActor = message.accountActor;
        const originalAgentActor = agentMessage.accountActor;
        message.accountActor = { v: 1, accountId: 'account-private-123', profile: null };
        agentMessage.accountActor = { v: 1, accountId: 'account-private-123', profile: null };
        try {
            const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);
            const label = screen.findByTestId('session-discussion-message-actor-message-a')?.props.children;
            expect(label).toBe('Former member');
            expect(JSON.stringify(screen.tree.toJSON())).not.toContain('account-private-123');
        } finally {
            message.accountActor = originalActor;
            agentMessage.accountActor = originalAgentActor;
        }
    });

    it('never substitutes current Presence for missing historical actor evidence', async () => {
        type MutableActorMessage = Omit<typeof snapshot.threads['discussion-a']['messages'][number], 'accountActor'> & { accountActor: SessionMessageAccountActorV1 | null };
        const message = snapshot.threads['discussion-a'].messages[0]! as MutableActorMessage;
        const agentMessage = snapshot.threads['discussion-a'].messages[1]! as MutableActorMessage;
        const originalActor = message.accountActor;
        const originalAgentActor = agentMessage.accountActor;
        message.accountActor = null;
        agentMessage.accountActor = null;
        try {
            const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);
            expect(screen.findByTestId('session-discussion-message-actor-message-a')?.props.children).toBe('Collaborator');
            expect(screen.findByTestId('session-discussion-message-actor-message-a')?.props.children).not.toBe('Presence Alice');
        } finally {
            message.accountActor = originalActor;
            agentMessage.accountActor = originalAgentActor;
        }
    });

    it('fails closed instead of attaching a mismatched safe profile to another author id', async () => {
        type MutableActorMessage = Omit<typeof snapshot.threads['discussion-a']['messages'][number], 'accountActor'> & { accountActor: SessionMessageAccountActorV1 };
        const message = snapshot.threads['discussion-a'].messages[0]! as MutableActorMessage;
        const originalActor = message.accountActor;
        message.accountActor = {
            v: 1,
            accountId: 'different-private-account',
            profile: { firstName: 'Mallory', lastName: null, username: null, avatarUrl: null },
        };
        try {
            const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);
            expect(screen.findByTestId('session-discussion-message-actor-message-a')?.props.children).toBe('Collaborator');
            expect(JSON.stringify(screen.tree.toJSON())).not.toContain('Mallory');
            expect(JSON.stringify(screen.tree.toJSON())).not.toContain('different-private-account');
        } finally {
            message.accountActor = originalActor;
        }
    });

    it('appends through the exact Home metadata owner, then reveals and focuses the primary composer', async () => {
        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        await press(screen, 'session-discussion-select-message-a');
        await press(screen, 'transcript-selection-send');

        expect(metadataWrites).toHaveBeenCalledTimes(1);
        expect(metadataWrites.mock.calls[0]?.[0]).toBe('session-a');
        expect(metadataWrites.mock.calls[0]?.[2]).toEqual({ serverId: 'server-a' });
        expect(metadataWrites.mock.results[0]?.value).toBeInstanceOf(Promise);
        const written = await metadataWrites.mock.results[0]!.value;
        expect(written.metadata).toEqual(expect.objectContaining({
            sessionInitialPromptV1: expect.objectContaining({
                mode: 'append',
                source: {
                    kind: 'session_discussion',
                    sessionId: 'session-a',
                    discussionId: 'discussion-a',
                    messageIds: ['message-a'],
                },
            }),
        }));
        expect(pane.closeDetails).toHaveBeenCalledTimes(1);
        expect(focusComposer).toHaveBeenCalledWith({ serverId: 'server-a', sessionId: 'session-a' });
        expect(routerReplace).not.toHaveBeenCalled();
    });

    it('returns from the phone discussion route to the exact Session and focuses after its composer registers', async () => {
        deviceType.current = 'phone';
        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'https://home.example.test:8443', sessionId: 'session/a' }, discussionId: 'discussion-a' }} active />);

        await press(screen, 'session-discussion-select-message-a');
        await press(screen, 'transcript-selection-send');

        expect(metadataWrites.mock.calls[0]?.[0]).toBe('session/a');
        expect(metadataWrites.mock.calls[0]?.[2]).toEqual({ serverId: 'https://home.example.test:8443' });
        expect(routerReplace).toHaveBeenCalledWith('/session/session%2Fa?serverId=https%3A%2F%2Fhome.example.test%3A8443');
        expect(pane.closeDetails).not.toHaveBeenCalled();
        expect(focusComposer).toHaveBeenCalledWith({ serverId: 'https://home.example.test:8443', sessionId: 'session/a' });
    });

    it('presents a settled unknown outcome distinctly and retries the retained identity only on request', async () => {
        (snapshot.mutations as Record<string, unknown>)['post-local-unknown'] = {
            kind: 'post',
            localId: 'post-local-unknown',
            discussionId: 'discussion-a',
            status: 'outcome_unknown',
            errorCode: 'outcome_unknown',
            content: { v: 1, parts: [{ t: 'text', text: 'Uncertain message' }] },
            mentionedAccountIds: [],
            draftSubmission: {
                scope: { serverId: 'server-a', accountId: 'viewer' },
                address: { kind: 'discussion', sessionId: 'session-a', discussionId: 'discussion-a' },
                currentness: { v: 1, fields: {} },
            },
        };
        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        expect(screen.findByTestId('session-discussion-message-status-post-local-unknown')?.props.accessibilityLiveRegion).toBe('polite');
        expect(screen.findByTestId('session-discussion-message-content-post-local-unknown')?.props.children).toBe('Uncertain message');
        expect(screen.findByTestId('session-discussion-mutation-retry')?.props).toEqual(expect.objectContaining({
            accessibilityRole: 'button',
            accessibilityLabel: 'Try again',
        }));
        expect(repositoryRetry).not.toHaveBeenCalled();
        await press(screen, 'session-discussion-mutation-retry');
        expect(repositoryRetry).toHaveBeenCalledWith('post-local-unknown');
    });

    it('keeps retained messages and draft visible offline while disabling mutation controls', async () => {
        snapshot.threads['discussion-a'].status = 'offline';
        snapshot.threads['discussion-a'].errorCode = 'offline';

        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        expect(screen.findByTestId('session-discussion-message-content-message-a')).not.toBeNull();
        expect(screen.getTextContent()).toContain('You’re offline. Reconnect to continue.');
        expect(composerProps.current?.disabled).toBe(true);
        expect(dropdownProps.current?.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'rename', disabled: true }),
            expect.objectContaining({ id: 'archive', disabled: true }),
        ]));
    });

    it('tints a mention inside the message and names the person it points at', async () => {
        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        const mention = screen.findByTestId('session-discussion-mention-message-a-1');
        expect(mention?.props.children).toBe('@Bob');
        expect(screen.findByTestId('session-discussion-message-content-message-a')?.props.children).not.toBe('Check this@Bob');
    });

    it('keeps retained messages under one freshness line whose Retry re-reads the conversation', async () => {
        snapshot.threads['discussion-a'].status = 'offline';
        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        expect(screen.findByTestId('session-discussion-freshness')).not.toBeNull();
        expect(screen.findByTestId('session-discussion-message-content-message-a')).not.toBeNull();
        repositoryRefreshDiscussion.mockClear();
        await press(screen, 'session-discussion-freshness-action');
        expect(repositoryRefreshDiscussion).toHaveBeenCalledWith('discussion-a');
    });

    it('offers Close tab when access to the conversation is removed', async () => {
        const thread = snapshot.threads['discussion-a'];
        const previousStatus = thread.status;
        thread.status = 'revoked';
        try {
            const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

            expect(screen.getTextContent()).toContain('You no longer have access to this conversation');
            await press(screen, 'session-discussion-details-state-action');
            expect(pane.closeDetailsTab).toHaveBeenCalledWith(createSessionDiscussionDetailsTab({ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }).key);
        } finally {
            thread.status = previousStatus;
        }
    });

    it.each([
        ['offline', 'This conversation isn’t available offline', true],
        ['locked', 'Can’t open this conversation on this device yet', true],
        ['error', 'Couldn’t open this conversation', true],
        ['revoked', 'You no longer have access to this conversation', false],
    ] as const)('renders the distinct empty %s recovery state before any content is available', async (status, expected, retryable) => {
        const thread = snapshot.threads['discussion-a'];
        const previousStatus = thread.status;
        const previousSummary = thread.summary;
        const previousMessages = thread.messages;
        thread.status = status;
        thread.summary = null as never;
        thread.messages = [] as never;
        try {
            const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

            expect(screen.getTextContent()).toContain(expected);
            expect(screen.findByTestId('session-discussion-details-state-action') !== null).toBe(true);
            // Recoverable states offer Try again; a removed access offers Close tab instead.
            expect(screen.getTextContent().includes('Try again')).toBe(retryable);
        } finally {
            thread.status = previousStatus;
            thread.summary = previousSummary;
            thread.messages = previousMessages;
        }
    });

    it('presents an archived conversation as readable and restorable without a composer', async () => {
        snapshot.threads['discussion-a'].summary.archivedAt = 10;
        snapshot.threads['discussion-a'].summary.capabilities = {
            postMessages: false,
            rename: false,
            archive: false,
            restore: true,
            askAgent: false,
            sendToSession: false,
        };

        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        expect(screen.findByTestId('session-discussion-message-content-message-a')).not.toBeNull();
        expect(screen.getTextContent()).toContain('This conversation is archived.');
        expect(dropdownProps.current?.items).toEqual([
            expect.objectContaining({ id: 'restore', title: 'Restore conversation' }),
        ]);
        expect(composerProps.current).toBeNull();
    });

    it('names the Home that cannot sync this draft and keeps the conversation usable', async () => {
        draftState.status = 'unsupported';

        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        // Not the generic load error, and not a dead composer: the draft is kept
        // on this device and the conversation still accepts messages.
        expect(screen.getTextContent()).toContain('Not synced — this Home can’t sync this draft');
        expect(screen.getTextContent()).not.toContain('Conversations could not be loaded.');
        expect(composerProps.current?.disabled).toBe(false);
    });

    it('renders the canonical V2 draft conflict resolution for a Discussion field', async () => {
        draftState.status = 'conflict';
        draftState.conflict = {
            fields: [{
                fieldId: 'composer.text',
                path: { kind: 'composer', field: 'text' },
                mine: 'My local reply',
                synced: 'Reply from another device',
            }],
        };

        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        expect(screen.findByTestId('session-draft-conflict:composer.text')).not.toBeNull();
        expect(composerProps.current?.disabled).toBe(true);
    });

    it('never advances the private cursor from a locally optimistic message frontier', async () => {
        (snapshot.mutations as Record<string, unknown>)['post-local-optimistic'] = {
            kind: 'post',
            localId: 'post-local-optimistic',
            discussionId: 'discussion-a',
            status: 'sending',
            content: { v: 1, parts: [{ t: 'text', text: 'Optimistic' }] },
            mentionedAccountIds: [],
            draftSubmission: {
                scope: { serverId: 'server-a', accountId: 'viewer' },
                address: { kind: 'discussion', sessionId: 'session-a', discussionId: 'discussion-a' },
                currentness: { address: { kind: 'discussion', sessionId: 'session-a', discussionId: 'discussion-a' }, mutationIds: {} },
            },
        };
        await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);
        const optimistic = (transcriptProps.current?.data as readonly { kind: string; message?: { id: string; seq: number } }[])
            .find((item) => item.kind === 'human_message' && item.message?.id === 'post-local-optimistic');

        await act(async () => {
            (transcriptProps.current?.onViewableItemsChanged as (input: unknown) => void)({
                viewableItems: [{ isViewable: true, item: optimistic }],
            });
        });

        expect(observeVisibleMessageSeqs).toHaveBeenLastCalledWith([]);
        delete (snapshot.mutations as Record<string, unknown>)['post-local-optimistic'];
    });

    it('retries a pending visible-read frontier when the canonical repository refreshes after reconnect', async () => {
        snapshot.threads['discussion-a'].summary.lastReadSeq = 0;
        const target = { kind: 'discussion' as const, address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' };
        const screen = await renderScreen(<SessionDiscussionDetailsView target={target} active />);
        const callsBeforeRefresh = updateVisibleReadEligibility.mock.calls.length;

        snapshot.threads['discussion-a'].status = 'loading';
        await screen.update(<SessionDiscussionDetailsView target={target} active />);

        expect(updateVisibleReadEligibility.mock.calls.length).toBeGreaterThan(callsBeforeRefresh);
        expect(updateVisibleReadEligibility).toHaveBeenLastCalledWith({
            activeAndVisible: true,
            lastReadSeq: 0,
        });
    });

    it('purges draft presentation and decrypted rows when access is explicitly revoked', async () => {
        const activeList = snapshot.lists.active as typeof snapshot.lists.active & { status?: string };
        activeList.status = 'revoked';
        try {
            const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);
            await vi.waitFor(() => expect(draftState.purgePresentation).toHaveBeenCalled());
            expect(screen.findByTestId('session-discussion-message-content-message-a')).toBeNull();
        } finally {
            delete activeList.status;
        }
    });

    it('offers Ask Agent only while the Session can launch an interactive run', async () => {
        launchability.current = false;
        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        await press(screen, 'session-discussion-select-message-a');
        expect(screen.findByTestId('session-discussion-selection-ask-agent')).toBeNull();
        expect(screen.findByTestId('transcript-selection-send')).not.toBeNull();
    });

    function failedPost(errorCode: string, recovery: 'retry' | 'dismiss') {
        (snapshot.mutations as Record<string, unknown>)['post-local-failed'] = {
            kind: 'post',
            localId: 'post-local-failed',
            discussionId: 'discussion-a',
            status: 'failed',
            errorCode,
            recovery,
            content: { v: 1, parts: [{ t: 'text', text: 'Refused message' }] },
            mentionedAccountIds: [],
            draftSubmission: {
                scope: { serverId: 'server-a', accountId: 'viewer' },
                address: { kind: 'discussion', sessionId: 'session-a', discussionId: 'discussion-a' },
                currentness: { address: { kind: 'discussion', sessionId: 'session-a', discussionId: 'discussion-a' }, mutationIds: {} },
            },
        };
    }

    it('re-enables the composer after a definitive refusal, names the reason, and dismisses it with the draft intact', async () => {
        failedPost('session_discussion_invalid_mention', 'dismiss');
        draftState.text = 'Refused message';
        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        expect(composerProps.current?.disabled).toBe(false);
        expect(screen.findByTestId('session-discussion-message-status-post-local-failed')?.props.children)
            .toBe('Someone you mentioned can no longer read this Session.');
        expect(screen.findByTestId('session-discussion-mutation-retry')).toBeNull();

        await press(screen, 'session-discussion-mutation-dismiss');
        expect(draftState.releaseSubmittedAttempt).toHaveBeenCalledTimes(1);
        expect(repositoryDismiss).toHaveBeenCalledWith('post-local-failed');
        expect((composerProps.current?.value as { text: string }).text).toBe('Refused message');
    });

    it('keeps a transient failure retryable under its own reason', async () => {
        failedPost('offline', 'retry');
        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        expect(composerProps.current?.disabled).toBe(true);
        expect(screen.findByTestId('session-discussion-message-status-post-local-failed')?.props.children)
            .toBe('You’re offline. Reconnect to continue.');
        expect(screen.findByTestId('session-discussion-mutation-dismiss')).toBeNull();
        await press(screen, 'session-discussion-mutation-retry');
        expect(repositoryRetry).toHaveBeenCalledWith('post-local-failed');
    });

    it('replaces a dismissable refusal with a fresh attempt on the next send', async () => {
        failedPost('session_discussion_archived', 'dismiss');
        draftState.text = 'Second try';
        await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        await act(async () => {
            await (composerProps.current?.onSend as (content: unknown) => Promise<void>)({ v: 1, parts: [{ t: 'text', text: 'Second try' }] });
        });

        expect(repositoryDismiss).toHaveBeenCalledWith('post-local-failed');
        expect(repositoryPost).toHaveBeenCalledTimes(1);
        expect((repositoryPost.mock.calls[0] as unknown as [{ localId: string }])[0].localId).not.toBe('post-local-failed');
    });

    it('lets a refused conversation creation be dismissed and drafted again', async () => {
        (snapshot.mutations as Record<string, unknown>)['create-local-failed'] = {
            kind: 'create',
            localId: 'create-local-failed',
            messageLocalId: 'create-message-failed',
            status: 'failed',
            errorCode: 'session_discussion_post_denied',
            recovery: 'dismiss',
            content: { v: 1, parts: [{ t: 'text', text: 'Refused opener' }] },
            mentionedAccountIds: [],
            draftSubmission: {
                scope: { serverId: 'server-a', accountId: 'viewer' },
                address: { kind: 'newDiscussion', sessionId: 'session-a' },
                currentness: { address: { kind: 'newDiscussion', sessionId: 'session-a' }, mutationIds: {} },
            },
        };
        draftState.text = 'Refused opener';
        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'new', address: { serverId: 'server-a', sessionId: 'session-a' } }} active />);

        expect(composerProps.current?.disabled).toBe(false);
        expect(screen.findByTestId('session-discussion-message-status-create-message-failed')?.props.children)
            .toBe('You can no longer post in this Session.');
        expect(screen.findByTestId('session-discussion-mutation-retry')).toBeNull();

        await press(screen, 'session-discussion-mutation-dismiss');
        expect(draftState.releaseSubmittedAttempt).toHaveBeenCalledTimes(1);
        expect(repositoryDismiss).toHaveBeenCalledWith('create-local-failed');
    });

    it('hands mobile Ask Agent to the qualified Run route without exposing selected text in history', async () => {
        deviceType.current = 'phone';
        const screen = await renderScreen(<SessionDiscussionDetailsView target={{ kind: 'discussion', address: { serverId: 'server-a', sessionId: 'session-a' }, discussionId: 'discussion-a' }} active />);

        await press(screen, 'session-discussion-select-message-a');
        await press(screen, 'session-discussion-selection-ask-agent');

        expect(pane.openDetailsTab).not.toHaveBeenCalled();
        const href = routerPush.mock.calls[0]?.[0] as string;
        expect(href).toMatch(/^\/session\/session-a\/runs\/new\?serverId=server-a&draftCorrelationId=/);
        expect(href).not.toContain('Check');
        const correlationId = new URL(`https://example.test${href}`).searchParams.get('draftCorrelationId');
        expect(consumeInteractiveExecutionRunDraftNavigationIntent({
            address: { serverId: 'server-a', sessionId: 'session-a' },
            correlationId: correlationId ?? '',
        })).toEqual({
            initialText: '**Alice:**\n\nCheck this@Bob',
            source: {
                kind: 'session_discussion',
                sessionId: 'session-a',
                discussionId: 'discussion-a',
                messageIds: ['message-a'],
                draftCorrelationId: correlationId,
            },
        });
    });
});
