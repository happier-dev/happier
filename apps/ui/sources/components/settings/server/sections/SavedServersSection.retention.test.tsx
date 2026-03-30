import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useServerRetentionPolicies = vi.fn();

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, params) => {
                if (key === 'server.retention.deleteInactiveSessionsDays' && typeof params?.count === 'number') {
                    return `Deletes inactive sessions after ${params.count} days.`;
                }
                return key;
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    textSecondary: '#999999',
                },
            },
        });
    },
});

vi.mock('@/hooks/server/useServerRetentionPolicies', () => ({
    useServerRetentionPolicies,
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

        const screen = await renderScreen(React.createElement(SavedServersSection, {
            servers: [
                {
                    id: 'server-a',
                    name: 'Active',
                    serverUrl: 'https://active.example',
                    source: 'manual',
                    createdAt: 1,
                    updatedAt: 1,
                    lastUsedAt: 1,
                },
                {
                    id: 'server-b',
                    name: 'Archive',
                    serverUrl: 'https://archive.example',
                    source: 'manual',
                    createdAt: 1,
                    updatedAt: 1,
                    lastUsedAt: 1,
                },
            ],
            activeServerId: 'server-a',
            authStatusByServerId: {
                'server-a': 'signedIn',
                'server-b': 'signedOut',
            },
            onSwitch: vi.fn(),
            onRename: vi.fn(),
            onRemove: vi.fn(),
        }));

        expect(screen.findByTestId('saved-server-row-server-a')?.props.subtitle)
            .not.toContain('Deletes inactive sessions after 30 days.');
        expect(screen.findByTestId('saved-server-row-server-b')?.props.subtitle)
            .toContain('Deletes inactive sessions after 30 days.');
    });
});
