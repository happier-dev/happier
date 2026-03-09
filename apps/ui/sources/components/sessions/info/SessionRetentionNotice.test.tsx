import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useServerRetentionPolicy = vi.fn();
const resolveServerIdForSessionIdFromLocalCache = vi.fn();

vi.mock('@/hooks/server/useServerRetentionPolicy', () => ({
    useServerRetentionPolicy,
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: { count?: number }) => {
        if (key === 'server.retention.title') return 'Retention policy';
        if (key === 'server.retention.sessionNotice') return `This server deletes inactive sessions after ${params?.count ?? 0} days of inactivity.`;
        return key;
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
    resolveServerIdForSessionIdFromLocalCache,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: any) => React.createElement('ItemGroup', { title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

describe('SessionRetentionNotice', () => {
    it('renders nothing when the session server cannot be resolved', async () => {
        resolveServerIdForSessionIdFromLocalCache.mockReturnValue(null);
        useServerRetentionPolicy.mockReturnValue(null);

        const { SessionRetentionNotice } = await import('./SessionRetentionNotice');
        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionRetentionNotice, { sessionId: 'session-a' }));
        });

        expect(tree!.root.findAllByType('ItemGroup' as any)).toHaveLength(0);
    });

    it('renders a session retention notice when the server deletes inactive sessions', async () => {
        resolveServerIdForSessionIdFromLocalCache.mockReturnValue('server-a');
        useServerRetentionPolicy.mockReturnValue({
            enabled: true,
            sessions: {
                mode: 'delete_inactive',
                inactivityDays: 30,
                requires: ['updatedAt', 'lastActiveAt'],
            },
            accountChanges: { mode: 'keep_forever' },
            voiceSessionLeases: { mode: 'keep_forever' },
            userFeedItems: { mode: 'keep_forever' },
            sessionShareAccessLogs: { mode: 'keep_forever' },
            publicShareAccessLogs: { mode: 'keep_forever' },
            terminalAuthRequests: { mode: 'keep_forever' },
            accountAuthRequests: { mode: 'keep_forever' },
            authPairingSessions: { mode: 'keep_forever' },
            repeatKeys: { mode: 'keep_forever' },
            globalLocks: { mode: 'keep_forever' },
            automationRuns: { mode: 'keep_forever' },
            automationRunEvents: { mode: 'keep_forever' },
        });

        const { SessionRetentionNotice } = await import('./SessionRetentionNotice');
        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionRetentionNotice, { sessionId: 'session-a' }));
        });

        expect(tree!.root.findAllByType('ItemGroup' as any)).toHaveLength(1);
        expect(tree!.root.findAllByType('Item' as any)).toHaveLength(1);
        expect(tree!.root.findByType('Item' as any).props.testID).toBe('session-retention-notice');
    });
});
