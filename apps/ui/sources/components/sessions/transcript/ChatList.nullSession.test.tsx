import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, it, expect, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async (importOriginal) => {
    const ReactMod = await import('react');
    const actual = await importOriginal<any>();
    return {
        ...actual,
        FlatList: (props: any) => {
            // Render ListHeaderComponent so ListFooter executes (this is where the null session crash happened).
            return ReactMod.createElement('FlatList', null, props.ListHeaderComponent ?? null);
        },
    };
});

vi.mock('@/sync/domains/state/storage', () => ({
    useSession: () => null,
    useSessionMessages: () => ({ messages: [], isLoaded: true }),
    useSessionPendingMessages: () => ({ messages: [] }),
    useSessionActionDrafts: () => ([]),
}));

vi.mock('@/components/sessions/chatListItems', () => ({
    buildChatListItems: () => [],
}));

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
    MessageView: () => React.createElement('MessageView'),
}));

vi.mock('@/components/sessions/pending/PendingUserTextMessageView', () => ({
    PendingUserTextMessageView: () => React.createElement('PendingUserTextMessageView'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
    SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
    getPermissionsInUiWhileLocal: () => ({}),
}));

describe('ChatList', () => {
    it('does not crash when useSession(sessionId) returns null in ListFooter', async () => {
        const { ChatList } = await import('./ChatList');

        const session = {
            id: 'session-1',
            metadata: null,
            accessLevel: null,
            canApprovePermissions: true,
        } as any;

        let tree: renderer.ReactTestRenderer | undefined;
        let thrown: unknown;
        try {
            await act(async () => {
                tree = renderer.create(<ChatList session={session} />);
            });
        } catch (error) {
            thrown = error;
        } finally {
            act(() => {
                tree?.unmount();
            });
        }

        expect(thrown).toBeUndefined();
    });
});
