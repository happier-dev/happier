import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { tryWriteServerEnabledBitInPlace, type SessionDiscussionOpenedSummaryV1 } from '@happier-dev/protocol';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { clearSessionDiscussionRepositoryRegistryForTests } from '@/sync/ops/sessionDiscussions/sessionDiscussionRepositoryRegistry';
import { t } from '@/text';

import type { SessionDiscussionActivityItem } from './sessionDiscussionActivityItems';
import { SessionConversationsBody } from './SessionConversationsBody';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';

const credentials = vi.hoisted(() => ({ serverId: '', accountId: 'conversations-account' }));
const discussionApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const { createCapturingFlatListMock } = await import('@/dev/testkit/mocks/virtualizedList');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
        ...createCapturingFlatListMock({ renderItems: true }).module,
    });
});

// HTTP is the replaced boundary. The repository, the canonical Agent activity
// owner, the pane workspace and the section projection stay real.
vi.mock('@/sync/api/session/sessionDiscussionActions', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/api/session/sessionDiscussionActions')>()),
    createSessionDiscussionClient: () => ({
        list: discussionApi.list,
        get: vi.fn(),
        read: vi.fn(),
        create: vi.fn(),
        post: vi.fn(),
        rename: vi.fn(),
        archive: vi.fn(),
        restore: vi.fn(),
        readState: vi.fn(),
    }),
}));

// Device credential storage is the boundary; scope resolution stays real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: async (_url, options) => options?.serverId === credentials.serverId ? {
                token: `header.${Buffer.from(JSON.stringify({ sub: credentials.accountId })).toString('base64')}.signature`,
                secret: 'test-secret',
            } : null,
        },
    });
});

afterEach(() => {
    standardCleanup();
    clearSessionDiscussionRepositoryRegistryForTests();
    storage.setState(storage.getInitialState(), true);
    resetServerFeaturesClientForTests();
    vi.clearAllMocks();
    vi.restoreAllMocks();
});

function PaneSelectionProbe(props: Readonly<{ serverId: string }>) {
    const pane = useAppPaneScope(createSessionPaneScopeId('conversation-session', props.serverId));
    return <React.Fragment>{React.createElement('PaneSelectionProbe', { activeTabKey: pane.scopeState?.details.activeTabKey })}</React.Fragment>;
}

async function renderConversations(options: Readonly<{
    activeDifferentHome?: boolean;
    conversationsEnabled?: boolean;
    credentialAvailable?: boolean;
    requestedAccountId?: string;
}> = {}) {
    const activeProfile = options.activeDifferentHome
        ? await upsertServerProfile({ name: 'Active Home', serverUrl: 'https://active.example.test' })
        : null;
    const profile = await upsertServerProfile({ name: 'Conversations Home', serverUrl: 'https://conversations.example.test' });
    const features = createRootLayoutFeaturesResponse();
    const enabledFeatures = options.conversationsEnabled === false
        ? ['sharing.session'] as const
        : ['sharing.session', 'sessions.conversations'] as const;
    for (const feature of enabledFeatures) {
        if (!tryWriteServerEnabledBitInPlace(features, feature, true)) throw new Error(`Unable to enable ${feature}`);
    }
    primeServerFeaturesSnapshot({ serverId: profile.id, snapshot: { status: 'ready', features } });
    credentials.serverId = options.credentialAvailable === false ? 'unbound-home' : profile.id;
    const activeServerId = activeProfile?.id ?? profile.id;
    await setActiveServerId(activeServerId, { scope: 'device' });
    storage.setState(() => ({ profileScope: { serverId: activeServerId, accountId: activeProfile ? 'active-account' : credentials.accountId } }));

    const screen = await renderScreen(
        <AppPaneProvider>
            <PaneSelectionProbe serverId={profile.id} />
            <SessionConversationsBody
                address={{ serverId: profile.id, sessionId: 'conversation-session' }}
                scope={{ serverId: profile.id, accountId: options.requestedAccountId ?? credentials.accountId }}
            />
        </AppPaneProvider>,
    );
    return { profile, screen };
}

function summary(id: string, input: Readonly<{
    title: string;
    archivedAt?: number | null;
    messageSeq?: number;
    recentAuthorAccountIds?: readonly string[];
}>): SessionDiscussionOpenedSummaryV1 {
    const messageSeq = input.messageSeq ?? 1;
    return {
        id,
        sessionId: 'conversation-session',
        creationLocalId: null,
        title: input.title,
        latestMessage: {
            id: `${id}-message-${messageSeq}`,
            localId: null,
            seq: messageSeq,
            authorAccountId: credentials.accountId,
            accountActor: { v: 1, accountId: credentials.accountId, profile: { firstName: 'Alice', lastName: null, username: 'alice', avatarUrl: 'https://example.test/alice.png' } },
            producerV1: null,
            createdAt: messageSeq,
        },
        messageSeq,
        lastReadSeq: messageSeq,
        unreadCount: 0,
        unreadMentionCount: 0,
        recentAuthorAccountIds: [...(input.recentAuthorAccountIds ?? [credentials.accountId])],
        archivedAt: input.archivedAt ?? null,
        capabilities: {
            postMessages: true,
            rename: true,
            archive: input.archivedAt == null,
            restore: input.archivedAt != null,
            askAgent: true,
            sendToSession: true,
        },
    };
}

function succeededList(
    discussions: readonly SessionDiscussionOpenedSummaryV1[],
    nextCursor: string | null,
) {
    return Promise.resolve({
        kind: 'succeeded' as const,
        value: {
            v: 1 as const,
            serverId: credentials.serverId,
            sessionId: 'conversation-session',
            discussions: [...discussions],
            nextCursor,
            incomplete: false,
        },
    });
}

function useEmptyDiscussionApi(): void {
    discussionApi.list.mockImplementation(() => succeededList([], null));
}

/** The one scroller under the surface body, read back as the host stub renders it. */
function readListItems(screen: Awaited<ReturnType<typeof renderConversations>>['screen']): readonly (SessionDiscussionActivityItem | Readonly<{ kind: string }>)[] {
    const list = screen.root.findByType('FlatList' as never);
    return (list.props as Readonly<{ data: readonly SessionDiscussionActivityItem[] }>).data;
}

describe('SessionConversationsBody (Lane 05 canonical Conversations body)', () => {
    it('explains why conversations are unavailable instead of leaving an empty pane', async () => {
        for (const [name, options, expectedReason] of [
            ['feature off', { conversationsEnabled: false }, 'session.collaboration.discussion.featureUnavailable'],
            ['credential missing', { credentialAvailable: false }, 'session.collaboration.discussion.bindingUnavailable'],
            ['different account scope', { requestedAccountId: 'other-account' }, 'session.collaboration.discussion.scopeMismatch'],
        ] as const) {
            standardCleanup();
            resetServerFeaturesClientForTests();
            const { screen } = await renderConversations(options);
            await vi.waitFor(() => expect(screen.findByTestId('session-conversations-unavailable')).not.toBeNull(), { timeout: 1000 });
            expect(screen.getTextContent(), name).toContain(t('session.collaboration.discussion.unavailable'));
            expect(screen.getTextContent(), name).toContain(t(expectedReason));
            expect(screen.findByTestId('session-discussion-activity-list'), name).toBeNull();
        }
    });

    it('explains an encryption-mode mismatch as a pane state with a read retry, never an endless preparation', async () => {
        discussionApi.list.mockResolvedValue({ kind: 'failed', errorCode: 'session_discussion_encryption_mode_mismatch' });
        const { screen } = await renderConversations();
        await vi.waitFor(() => expect(screen.findByTestId('session-conversations-locked')).not.toBeNull());
        expect(screen.getTextContent()).not.toContain(t('session.access.preparing'));
        expect(screen.getTextContent()).toContain(t('session.collaboration.pane.lockedTitle'));
        expect(screen.findByTestId('session-conversations-locked-action')).not.toBeNull();
        // Nothing readable is retained, so the whole list is the one pane state.
        expect(screen.findByTestId('session-discussion-activity-list')).toBeNull();

        discussionApi.list.mockImplementation(() => succeededList([summary('recovered', { title: 'Recovered' })], null));
        await screen.pressByTestIdAsync('session-conversations-locked-action');
        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-row-recovered')).not.toBeNull());
        expect(screen.findByTestId('session-conversations-locked')).toBeNull();
    });

    it('keeps the section and says what failed in one line with Try again when the list cannot be read', async () => {
        discussionApi.list.mockResolvedValue({ kind: 'failed', errorCode: 'internal_error' });
        const { screen } = await renderConversations();
        await vi.waitFor(() => expect(screen.findByTestId('session-conversations-error')).not.toBeNull());
        expect(screen.findByTestId('session-human-conversations-section')).not.toBeNull();
        expect(screen.getTextContent()).toContain(t('session.collaboration.discussion.loadError'));
        expect(screen.findByTestId('session-conversations-error-action')).not.toBeNull();
    });

    it('explains removed access instead of silently emptying the list', async () => {
        discussionApi.list.mockResolvedValue({ kind: 'failed', errorCode: 'session_discussion_read_denied' });
        const { screen } = await renderConversations();
        await vi.waitFor(() => expect(screen.findByTestId('session-conversations-revoked')).not.toBeNull());
        expect(screen.getTextContent()).toContain(t('session.collaboration.pane.revokedTitle'));
    });

    it('does not call a locked archived list empty after an encryption-mode mismatch', async () => {
        discussionApi.list.mockImplementation((input?: Readonly<{ state?: 'active' | 'archived' }>) => (
            input?.state === 'archived'
                ? Promise.resolve({ kind: 'failed', errorCode: 'session_discussion_encryption_mode_mismatch' })
                : Promise.resolve(succeededList([], null))
        ));
        const { screen } = await renderConversations();
        await screen.pressByTestIdAsync('session-discussion-archived-disclosure');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('session.collaboration.discussion.modeMismatch')));
        expect(screen.getTextContent()).not.toContain(t('session.collaboration.discussion.emptyArchived'));
        expect(screen.getTextContent()).toContain(t('session.collaboration.discussion.retry'));
    });

    it('keeps the Conversations header and its one creation action in the one list, with no Agent conversations here (A3)', async () => {
        useEmptyDiscussionApi();
        const { screen } = await renderConversations();

        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-activity-list')).not.toBeNull());
        const kinds = readListItems(screen).map((item) => item.kind);
        expect(kinds).toContain('human_section');
        expect(kinds.some((kind) => kind.startsWith('agent_'))).toBe(false);
        expect(screen.root.findAllByType('FlatList' as never)).toHaveLength(1);
        expect(screen.findByTestId('session-human-conversations-section')
            ?.findAll((node) => node.props.accessibilityRole === 'header').length).toBeGreaterThan(0);
        expect(screen.findByTestId('session-discussion-new')?.props).toEqual(expect.objectContaining({
            role: 'button',
            accessibilityLabel: expect.any(String),
        }));
        // The launch "+" in the Agents tab is the one entry to a new Agent conversation.
        expect(screen.findByTestId('session-agent-conversations-section')).toBeNull();
        expect(screen.findByTestId('session-agent-conversation-new')).toBeNull();
        expect(screen.getTextContent()).not.toContain(t('session.subagents.panel.newAgentConversation'));
    });

    it('reserves the rows while the first read is pending, never a blank body', async () => {
        discussionApi.list.mockImplementation(() => new Promise(() => undefined));
        const { screen } = await renderConversations();

        await vi.waitFor(() => expect(screen.findByTestId('session-conversations-loading')).not.toBeNull());
        expect(screen.findByTestId('session-human-conversations-section')).not.toBeNull();
    });

    it('uses the viewed Session Home credential lifetime when another Home is active', async () => {
        useEmptyDiscussionApi();
        const { screen } = await renderConversations({ activeDifferentHome: true });

        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-activity-list')).not.toBeNull());
        expect(discussionApi.list).toHaveBeenCalledWith({ state: 'active' }, undefined);
    });

    it('invites the first conversation once the list settled empty', async () => {
        useEmptyDiscussionApi();
        const { screen } = await renderConversations();

        await vi.waitFor(() => expect(readListItems(screen).map((item) => item.kind)).toContain('human_empty'));
        expect(screen.root.findByType('FlatList' as never).props).toEqual(expect.objectContaining({
            accessibilityRole: 'list',
            accessibilityLabel: 'Conversations',
        }));
        await vi.waitFor(() => expect(screen.findByTestId('session-conversations-empty')).not.toBeNull());
        expect(screen.getTextContent()).toContain(t('session.collaboration.pane.inviteTitle'));
        expect(screen.findByTestId('session-conversations-empty-action')).not.toBeNull();
    });

    it('keeps the new-conversation action usable while write capability is unknown and says who can post on a known refusal', async () => {
        useEmptyDiscussionApi();
        const { profile, screen } = await renderConversations();

        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-new')).not.toBeNull());
        // No exact-Session access projection yet: the server stays the authority
        // and the affordance must not be taken away from a writer.
        expect(screen.findByTestId('session-discussion-new')?.props.disabled).not.toBe(true);

        await act(async () => {
            storage.setState((state) => ({
                sessions: {
                    ...state.sessions,
                    'conversation-session': {
                        ...createSessionFixture({ id: 'conversation-session', accessLevel: 'view' }),
                        serverId: profile.id,
                    },
                },
            }));
        });

        // Read only: the "+" becomes one line that says who can post.
        await vi.waitFor(() => expect(screen.findByTestId('session-conversations-read-only')).not.toBeNull());
        expect(screen.findByTestId('session-discussion-new')).toBeNull();
        expect(screen.findByTestId('session-conversations-empty-action')).toBeNull();
        expect(screen.getTextContent()).toContain(t('session.collaboration.pane.readOnly'));
    });

    it('paginates active summaries through the shared repository and selects the opened Details resource', async () => {
        const first = summary('discussion-active-1', { title: 'Release readiness', messageSeq: 2 });
        const second = summary('discussion-active-2', { title: 'Design review', messageSeq: 1 });
        discussionApi.list.mockImplementation((input?: Readonly<{ state?: 'active' | 'archived'; cursor?: string }>) => {
            if (input?.state === 'active' && input.cursor === 'active-page-2') return succeededList([second], null);
            return succeededList([first], 'active-page-2');
        });
        const { screen } = await renderConversations();

        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-row-discussion-active-1')).not.toBeNull());
        expect(readListItems(screen).filter((item) => item.kind === 'human_discussion')).toHaveLength(1);

        await act(async () => {
            const list = screen.root.findByType('FlatList' as never);
            await (list.props as Readonly<{ onEndReached?: () => void }>).onEndReached?.();
        });
        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-row-discussion-active-2')).not.toBeNull());
        expect(discussionApi.list).toHaveBeenCalledWith({ state: 'active', cursor: 'active-page-2' }, undefined);

        await screen.pressByTestIdAsync('session-discussion-row-discussion-active-2');
        await vi.waitFor(() => expect(
            screen.root.findAll((node) => node.props.discussion?.id === 'discussion-active-2' && typeof node.props.selected === 'boolean').map((row) => row.props.selected),
        ).toEqual([true]));
        expect(screen.root.findByType('PaneSelectionProbe').props.activeTabKey).toBe(`discussion:${sessionAddressKey({ serverId: credentials.serverId, sessionId: 'conversation-session' })}:discussion-active-2`);
    });

    it('renders the bounded recent-author projection as a compact accessible avatar stack', async () => {
        const discussion = summary('discussion-authors', {
            title: 'Review authors',
            recentAuthorAccountIds: [credentials.accountId, 'account-b', 'account-c'],
        });
        discussionApi.list.mockImplementation(() => succeededList([discussion], null));
        const { screen } = await renderConversations();

        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-row-discussion-authors')).not.toBeNull());
        // The row's one accessible name carries the facts; the avatars are decoration.
        expect(screen.findByTestId('session-discussion-row-discussion-authors')?.props.accessibilityLabel).toContain('Review authors');
        expect(screen.findByTestId(`session-discussion-row-recent-author-discussion-authors-${credentials.accountId}`)).not.toBeNull();
        expect(screen.findByTestId('session-discussion-row-recent-author-discussion-authors-account-b')).not.toBeNull();
        expect(screen.findByTestId('session-discussion-row-recent-author-discussion-authors-account-c')).not.toBeNull();
    });


    it('loads and paginates archived summaries only after the disclosure opens', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const archivedFirst = summary('discussion-archived-1', { title: 'Finished migration', archivedAt: 10, messageSeq: 3 });
        const archivedSecond = summary('discussion-archived-2', { title: 'Resolved incident', archivedAt: 11, messageSeq: 2 });
        discussionApi.list.mockImplementation((input?: Readonly<{ state?: 'active' | 'archived'; cursor?: string }>) => {
            if (input?.state === 'archived' && input.cursor === 'archived-page-2') return succeededList([archivedSecond], null);
            if (input?.state === 'archived') return succeededList([archivedFirst], 'archived-page-2');
            return succeededList([], null);
        });
        const { screen } = await renderConversations();

        await vi.waitFor(() => expect(readListItems(screen).map((item) => item.kind)).toContain('human_empty'));
        // Before the disclosure opens the archived route is reached only by the
        // bounded existence probe; no page and no cursor is preloaded.
        expect(discussionApi.list.mock.calls
            .filter(([input]) => input?.state === 'archived')
            .every(([input]) => (input as Readonly<{ limit?: number; cursor?: string }>).limit === 1
                && (input as Readonly<{ cursor?: string }>).cursor === undefined)).toBe(true);

        await screen.pressByTestIdAsync('session-discussion-archived-disclosure');
        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-row-discussion-archived-1')).not.toBeNull());
        expect(readListItems(screen).map((item) => item.kind)).toContain('archived_discussion');
        expect(screen.root.findAllByType('FlatList' as never)).toHaveLength(1);
        expect(screen.findByTestId('session-discussion-archived-load-more')).not.toBeNull();

        await screen.pressByTestIdAsync('session-discussion-archived-load-more');
        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-row-discussion-archived-2')).not.toBeNull());
        expect(discussionApi.list).toHaveBeenCalledWith({ state: 'archived', cursor: 'archived-page-2' }, undefined);

        await screen.pressByTestIdAsync('session-discussion-row-discussion-archived-2');
        await vi.waitFor(() => expect(
            screen.root.findAll((node) => node.props.discussion?.id === 'discussion-archived-2' && typeof node.props.selected === 'boolean').map((row) => row.props.selected),
        ).toEqual([true]));
        expect(screen.root.findByType('PaneSelectionProbe').props.activeTabKey).toBe(`discussion:${sessionAddressKey({ serverId: credentials.serverId, sessionId: 'conversation-session' })}:discussion-archived-2`);
        expect(consoleError.mock.calls.some((args) => args.some((value) => (
            typeof value === 'string' && value.includes('Cannot update a component')
        )))).toBe(false);
    });

    /**
     * The archived disclosure is a claim about archived Discussions. Leading with
     * it before archived existence is known lets the reader open it only to be
     * told the list is empty, so the collapsed row waits for a proven answer.
     */
    it('offers the archived disclosure only until the bounded probe proves there is nothing archived', async () => {
        useEmptyDiscussionApi();
        const { screen } = await renderConversations();

        await vi.waitFor(() => expect(readListItems(screen).map((item) => item.kind)).toContain('human_empty'));
        await vi.waitFor(() => expect(
            discussionApi.list.mock.calls.some(([input]) => input?.state === 'archived'),
        ).toBe(true));
        await vi.waitFor(() => expect(
            readListItems(screen).map((item) => item.kind),
        ).not.toContain('archived_disclosure'));
    });

    it('keeps the archived disclosure when the probe could not answer', async () => {
        discussionApi.list.mockImplementation((input?: Readonly<{ state?: 'active' | 'archived' }>) => (
            input?.state === 'archived'
                ? Promise.resolve({ kind: 'failed' as const, errorCode: 'offline' })
                : succeededList([], null)
        ));
        const { screen } = await renderConversations();

        await vi.waitFor(() => expect(readListItems(screen).map((item) => item.kind)).toContain('human_empty'));
        await vi.waitFor(() => expect(
            discussionApi.list.mock.calls.some(([input]) => input?.state === 'archived'),
        ).toBe(true));
        // An unanswered probe must never read as "nothing archived".
        expect(readListItems(screen).map((item) => item.kind)).toContain('archived_disclosure');
    });

    it('does not own a second repository decision apart from the shared Lane 05 registry', async () => {
        useEmptyDiscussionApi();
        const { screen } = await renderConversations();

        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-activity-list')).not.toBeNull());
        // The canonical body renders through the shared repository snapshot owner;
        // paging stays repository-owned (refreshList/loadMoreList) rather than
        // host-owned. This assertion guards the Lane04/Lane05 boundary: the
        // Lane 04 responsive host must not reconstruct list paging beside this body.
        expect(screen.root.findAllByType('FlatList' as never)).toHaveLength(1);
    });
});
