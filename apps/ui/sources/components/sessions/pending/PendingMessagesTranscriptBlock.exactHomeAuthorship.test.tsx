import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';
import { installPendingMessagesCommonModuleMocks } from './pendingMessagesTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HOME_A = 'home-a';
const HOME_B = 'home-b';
const SHARED_SESSION_ID = 'shared-session';

/**
 * Two Homes whose Sessions share one raw Session ID, with different viewer
 * Accounts and a different named-collaborator audience. Only the exact Home the
 * transcript was opened for may decide the pending/discarded bylines.
 */
const homes = vi.hoisted(() => ({
    activeServerId: 'home-a',
    accountIdByServerId: { 'home-a': 'alice', 'home-b': 'bob' } as Record<string, string>,
    /** `useSession` is single-keyed by raw Session ID, so it can only hold one Home's record. */
    rawSession: null as Record<string, unknown> | null,
    rowsByServerId: {} as Record<string, Record<string, unknown>>,
}));

vi.mock('./PendingMessagesDragReorderList', () => ({
    PendingMessagesDragReorderList: (props: any) => {
        const children = Array.isArray(props.messages)
            ? props.messages.map((m: any, index: number) =>
                props.renderItem({
                    message: m,
                    index,
                    isDragging: false,
                    renderDragHandle: ({ testID, accessibilityLabel }: { testID?: string; accessibilityLabel?: string }) => React.createElement('View', { testID, accessibilityLabel }),
                }),
            )
            : null;
        return React.createElement('PendingMessagesDragReorderList', props, children);
    },
}));

installPendingMessagesCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit');
        return createPartialStorageModuleMock(importOriginal, {
            useSession: () => homes.rawSession,
            useSessionListRenderableWithServerScope: (serverId: string | null | undefined, sessionId: string) =>
                (serverId ? homes.rowsByServerId[serverId]?.[sessionId] : undefined) ?? null,
            useActiveServerAccountScope: () => ({
                serverId: homes.activeServerId,
                accountId: homes.accountIdByServerId[homes.activeServerId]!,
            }),
            useSetting: () => undefined,
            storage: { getState: () => ({}) },
        });
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    },
});

// Device credential storage is the boundary; the exact-Home authorship selection stays real.
vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/scope/useServerCredentialAccountScopes')>();
    return {
        ...actual,
        useServerCredentialAccountScopeResolution: (serverId: string | null | undefined) => {
            const accountId = serverId ? homes.accountIdByServerId[serverId] : undefined;
            return accountId ? { kind: 'bound', scope: { serverId, accountId } } : { kind: 'resolving' };
        },
    };
});

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const { createPartialServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    return createPartialServerProfilesModuleMock(importOriginal as <T>() => Promise<T>, {
        profiles: [
            { id: 'home-a', serverUrl: 'https://home-a.example.test' },
            { id: 'home-b', serverUrl: 'https://home-b.example.test' },
        ],
    });
});

// Without an exact Home this resolver can only fall back to the active Home —
// which is precisely how a duplicate Session ID resolved the wrong viewer.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: (input: Readonly<{ serverId?: string | null }>) =>
        input.serverId?.trim() || homes.activeServerId,
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => homes.activeServerId,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendPendingMessageNow: vi.fn(),
        deletePendingMessage: vi.fn(),
        discardPendingMessage: vi.fn(),
        dismissPendingDelivery: vi.fn(),
        markPendingDeliveryHandled: vi.fn(),
        sendPendingDeliveryAsNew: vi.fn(),
        updatePendingMessage: vi.fn(),
        restoreDiscardedPendingMessage: vi.fn(),
        deleteDiscardedPendingMessage: vi.fn(),
        fetchPendingMessages: vi.fn(),
        reorderPendingMessages: vi.fn(),
        retryPendingMessageSend: vi.fn(),
    },
}));
vi.mock('@/sync/ops', () => ({ sessionAbort: vi.fn() }));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));
vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesSnapshotForServerId: () => ({ status: 'loading' }),
}));
vi.mock('@/components/markdown/MarkdownView', () => ({ MarkdownView: 'MarkdownView' }));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement(
        'DropdownMenu',
        null,
        typeof props.trigger === 'function'
            ? props.trigger({ open: false, openMenu: () => {}, closeMenu: () => {}, toggle: () => {}, selectedItem: null })
            : props.trigger ?? null,
    ),
}));
vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({ ScrollEdgeFades: () => null }));
vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({ ScrollEdgeIndicators: () => null }));
vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({
        canScrollX: false,
        canScrollY: false,
        visibility: { top: false, bottom: false, left: false, right: false },
        onViewportLayout: () => {},
        onContentSizeChange: () => {},
        onScroll: () => {},
    }),
}));
vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 800, headerMaxWidth: 800 },
    useLayoutMaxWidth: () => 800,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 800 }),
}));

function actor(serverId: string, accountId: string, firstName: string) {
    return { serverId, accountId, profile: { firstName, lastName: null, username: accountId, avatarUrl: null } };
}

function pending(id: string, authorServerId: string, authorAccountId: string, name: string) {
    return {
        id,
        localId: id,
        text: `text-${id}`,
        displayText: undefined,
        createdAt: 0,
        updatedAt: 0,
        rawRecord: {},
        accountActor: actor(authorServerId, authorAccountId, name),
    };
}

describe('pending queue authorship is decided by the exact Home', () => {
    beforeEach(() => {
        vi.resetModules();
        homes.activeServerId = HOME_A;
        // Home A's Session is solo; its record is the one `useSession` can hold.
        homes.rawSession = {
            id: SHARED_SESSION_ID,
            serverId: HOME_A,
            hasOtherNamedCollaborator: false,
        };
        homes.rowsByServerId = {
            [HOME_A]: { [SHARED_SESSION_ID]: { id: SHARED_SESSION_ID, serverId: HOME_A, hasOtherNamedCollaborator: false } },
            // Home B's Session shares the raw ID and has another named collaborator.
            [HOME_B]: { [SHARED_SESSION_ID]: { id: SHARED_SESSION_ID, serverId: HOME_B, hasOtherNamedCollaborator: true } },
        };
    });

    it('names the selected Home\'s viewer on pending and discarded bylines, not the active Home\'s', async () => {
        const { PendingMessagesTranscriptBlock } = await import('./PendingMessagesTranscriptBlock');
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: SHARED_SESSION_ID,
            serverId: HOME_B,
            pendingMessages: [pending('p1', HOME_B, 'bob', 'Bob')] as never,
            discardedMessages: [pending('d1', HOME_B, 'bob', 'Bob')] as never,
        }));

        // Bob is the viewer in Home B, so both rows read as "You"; the byline is
        // painted at all only because Home B's audience has another named human.
        expect(screen.findByTestId('transcript-account-attribution:p1')?.props.children)
            .toBe(t('message.accountActorYou'));
        expect(screen.findByTestId('transcript-account-attribution:d1')?.props.children)
            .toBe(t('message.accountActorYou'));
        const queue = screen.findByType('PendingMessagesDragReorderList');
        expect(queue.props.scope).toEqual({ serverId: HOME_B, accountId: 'bob' });
        expect(queue.props.sessionId).toBe(SHARED_SESSION_ID);
        expect(queue.props.recipient).toBeNull();
    });

    it('keeps the other Home\'s collaborator a named person rather than the viewer', async () => {
        const { PendingMessagesTranscriptBlock } = await import('./PendingMessagesTranscriptBlock');
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: SHARED_SESSION_ID,
            serverId: HOME_B,
            pendingMessages: [pending('p2', HOME_B, 'alice', 'Alice')] as never,
            discardedMessages: [],
        }));

        expect(screen.findByTestId('transcript-account-attribution:p2')?.props.children).toBe('Alice');
    });

    it('suppresses a self byline in a solo Session of the selected Home', async () => {
        const { PendingMessagesTranscriptBlock } = await import('./PendingMessagesTranscriptBlock');
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: SHARED_SESSION_ID,
            serverId: HOME_A,
            pendingMessages: [pending('p3', HOME_A, 'alice', 'Alice')] as never,
            discardedMessages: [],
        }));

        expect(screen.findByTestId('transcript-account-attribution:p3')).toBeNull();
    });
});
