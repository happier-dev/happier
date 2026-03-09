import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useServerRetentionPolicies = vi.fn();

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native')>('react-native');
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            OS: 'ios',
        },
    };
});

vi.mock('@/hooks/server/useServerRetentionPolicies', () => ({
    useServerRetentionPolicies,
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: { count?: number }) => {
        if (key === 'server.savedServersTitle') return 'Saved servers';
        if (key === 'server.serverCount') return `${params?.count ?? 0} servers`;
        if (key === 'server.switchToServer') return 'Switch';
        if (key === 'common.rename') return 'Rename';
        if (key === 'common.remove') return 'Remove';
        if (key === 'server.signedIn') return 'Signed in';
        if (key === 'server.signedOut') return 'Signed out';
        if (key === 'server.authStatusUnknown') return 'Unknown';
        if (key === 'server.active') return 'Active';
        if (key === 'server.default') return 'Default';
        if (key === 'server.retention.keepForever') return 'No automatic deletion';
        if (key === 'server.retention.deleteInactiveSessionsDays') return `Deletes inactive sessions after ${params?.count ?? 0} days.`;
        if (key === 'server.retention.sessionNotice') return `This server deletes inactive sessions after ${params?.count ?? 0} days of inactivity.`;
        return key;
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: any) => React.createElement('ItemGroup', { title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#999999',
            },
        },
    }),
}));

describe('SavedServersSection retention', () => {
    it('shows finite retention in inactive saved server rows only', async () => {
        useServerRetentionPolicies.mockReturnValue({
            'server-a': null,
            'server-b': {
                policyVersion: 1,
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
            },
        });

        const { SavedServersSection } = await import('./SavedServersSection');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(SavedServersSection, {
                    servers: [
                        { id: 'server-a', name: 'Active', serverUrl: 'https://active.example', source: 'manual' },
                        { id: 'server-b', name: 'Archive', serverUrl: 'https://archive.example', source: 'manual' },
                    ],
                    activeServerId: 'server-a',
                    authStatusByServerId: {
                        'server-a': 'signedIn',
                        'server-b': 'signedOut',
                    },
                    onSwitch: vi.fn(),
                    onRename: vi.fn(),
                    onRemove: vi.fn(),
                }),
            );
        });

        const items = tree.root.findAllByType('Item' as any);
        const activeItem = items.find((item) => item.props.title === 'Active');
        const inactiveItem = items.find((item) => item.props.title === 'Archive');

        expect(activeItem?.props.subtitle).not.toContain('Deletes inactive sessions after 30 days.');
        expect(inactiveItem?.props.subtitle).toContain('Deletes inactive sessions after 30 days.');
    });
});
