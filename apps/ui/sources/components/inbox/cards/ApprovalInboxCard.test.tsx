import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionFixtures: Record<string, any> = {
    'session-1': {
        id: 'session-1',
        metadata: {
            name: 'Repo session',
            path: '/Users/leeroy/stale-repo',
            homeDir: '/Users/leeroy',
            machineId: 'machine-stale',
        },
    },
};

const machineFixtures: Record<string, any> = {
    'machine-target': {
        id: 'machine-target',
        metadata: { displayName: 'Rebound workstation', host: 'workstation.local' },
    },
};

const storageState = {
    sessions: {
        'session-1': {
            active: false,
            metadata: {
                machineId: 'machine-stale',
                path: '/Users/leeroy/stale-repo',
                homeDir: '/Users/leeroy',
            },
        },
    },
    machines: {
        'machine-target': {
            id: 'machine-target',
            active: true,
            activeAt: 10,
            metadata: { host: 'workstation.local' },
        },
    },
    getProjectForSession: (sessionId: string) =>
        sessionId === 'session-1'
            ? {
                key: {
                    machineId: 'machine-target',
                    path: '/Volumes/target/repo',
                },
            }
            : null,
};

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            View: 'View',
            Text: 'Text',
            Pressable: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) =>
                React.createElement('Pressable', props, children),
        },
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                status: { error: '#f00' },
                text: '#fff',
                textSecondary: '#999',
                divider: '#333',
                surfaceHighest: '#222',
                surfacePressedOverlay: '#333',
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSession: (sessionId: string) => sessionFixtures[sessionId] ?? null,
        useMachine: (machineId: string) => machineFixtures[machineId] ?? null,
        storage: {
            getState: () => storageState,
        },
    });
});

describe('ApprovalInboxCard', () => {
    it('shows the reachable machine label when the stored session machine id is stale', async () => {
        const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
        const screen = await renderScreen(
            <ApprovalInboxCard
                artifact={{
                    id: 'artifact-1',
                    title: 'Approval',
                    header: {
                        title: 'Approve answering the user',
                        actionId: 'session.user_action.answer',
                        sessionId: 'session-1',
                    },
                } as any}
                onPress={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('Rebound workstation');
        expect(screen.getTextContent()).toContain('/Volumes/target/repo');
    });
});
