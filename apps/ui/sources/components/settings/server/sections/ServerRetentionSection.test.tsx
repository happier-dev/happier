import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useServerRetentionPolicy = vi.fn();

vi.mock('@/hooks/server/useServerRetentionPolicy', () => ({
    useServerRetentionPolicy,
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: { count?: number }) => {
        if (key === 'server.retention.title') return 'Retention policy';
        if (key === 'server.retention.summary') return 'Summary';
        if (key === 'server.retention.keepForever') return 'No automatic deletion';
        if (key === 'server.retention.deleteInactiveSessionsDays') return `Deletes inactive sessions after ${params?.count ?? 0} days.`;
        if (key === 'server.retention.deleteOlderThanDays') return `Deletes data after ${params?.count ?? 0} days.`;
        if (key === 'server.retention.sessionNotice') return `This server deletes inactive sessions after ${params?.count ?? 0} days of inactivity.`;
        if (key === 'server.retention.sessions') return 'Sessions';
        if (key === 'server.retention.accountChanges') return 'Account changes';
        if (key === 'server.retention.voiceSessionLeases') return 'Voice session leases';
        if (key === 'server.retention.feedItems') return 'Feed items';
        if (key === 'server.retention.sessionShareAccessLogs') return 'Session share access logs';
        if (key === 'server.retention.publicShareAccessLogs') return 'Public share access logs';
        if (key === 'server.retention.terminalAuthRequests') return 'Terminal auth requests';
        if (key === 'server.retention.accountAuthRequests') return 'Account auth requests';
        if (key === 'server.retention.authPairingSessions') return 'Auth pairing sessions';
        if (key === 'server.retention.repeatKeys') return 'Repeat keys';
        if (key === 'server.retention.globalLocks') return 'Global locks';
        if (key === 'server.retention.automationRuns') return 'Automation runs';
        if (key === 'server.retention.automationRunEvents') return 'Automation run events';
        return key;
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: any) => React.createElement('ItemGroup', { title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

describe('ServerRetentionSection', () => {
    it('renders nothing when no retention policy is available', async () => {
        useServerRetentionPolicy.mockReturnValue(null);
        const { ServerRetentionSection } = await import('./ServerRetentionSection');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ServerRetentionSection, { serverId: 'server-a' }));
        });

        expect(tree!.root.findAllByType('ItemGroup' as any)).toHaveLength(0);
    });

    it('renders retention rows when finite retention is configured', async () => {
        useServerRetentionPolicy.mockReturnValue({
            enabled: true,
            sessions: {
                mode: 'delete_inactive',
                inactivityDays: 30,
                requires: ['updatedAt', 'lastActiveAt'],
            },
            accountChanges: { mode: 'delete_older_than', days: 30 },
            voiceSessionLeases: { mode: 'delete_older_than', days: 31 },
            userFeedItems: { mode: 'delete_older_than', days: 32 },
            sessionShareAccessLogs: { mode: 'delete_older_than', days: 33 },
            publicShareAccessLogs: { mode: 'delete_older_than', days: 34 },
            terminalAuthRequests: { mode: 'delete_older_than', days: 35 },
            accountAuthRequests: { mode: 'delete_older_than', days: 36 },
            authPairingSessions: { mode: 'delete_older_than', days: 37 },
            repeatKeys: { mode: 'delete_older_than', days: 38 },
            globalLocks: { mode: 'delete_older_than', days: 39 },
            automationRuns: { mode: 'delete_older_than', days: 40 },
            automationRunEvents: { mode: 'delete_older_than', days: 41 },
        });
        const { ServerRetentionSection } = await import('./ServerRetentionSection');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ServerRetentionSection, { serverId: 'server-a' }));
        });

        const items = tree!.root.findAllByType('Item' as any);
        expect(items.length).toBeGreaterThan(0);
        expect(items[0]?.props.testID).toBe('server-retention-summary');
        expect(items.some((item) => item.props.testID === 'server-retention-row-accountChanges')).toBe(true);
        expect(items.some((item) => item.props.testID === 'server-retention-row-publicShareAccessLogs')).toBe(true);
        expect(items.some((item) => item.props.testID === 'server-retention-row-terminalAuthRequests')).toBe(true);
        expect(items.some((item) => item.props.testID === 'server-retention-row-accountAuthRequests')).toBe(true);
        expect(items.some((item) => item.props.testID === 'server-retention-row-authPairingSessions')).toBe(true);
        expect(items.some((item) => item.props.testID === 'server-retention-row-repeatKeys')).toBe(true);
        expect(items.some((item) => item.props.testID === 'server-retention-row-globalLocks')).toBe(true);
        expect(items.some((item) => item.props.testID === 'server-retention-row-automationRunEvents')).toBe(true);
    });
});
