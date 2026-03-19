import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

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

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        View: 'View',
        Text: 'Text',
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    };
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (value: unknown) => value },
    useUnistyles: () => ({
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
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSession: (sessionId: string) => sessionFixtures[sessionId] ?? null,
    useMachine: (machineId: string) => machineFixtures[machineId] ?? null,
    storage: {
        getState: () => storageState,
    },
}));

function collectText(node: renderer.ReactTestRenderer): string[] {
    return node.root
        .findAll((entry) => String(entry.type) === 'Text')
        .flatMap((entry) => {
            const children = Array.isArray(entry.props.children) ? entry.props.children : [entry.props.children];
            return children.map((child) => String(child ?? '')).filter((value) => value.length > 0);
        });
}

describe('ApprovalInboxCard', () => {
    it('shows the reachable machine label when the stored session machine id is stale', async () => {
        const { ApprovalInboxCard } = await import('./ApprovalInboxCard');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
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
        });

        expect(collectText(tree!)).toContain('Rebound workstation');
        expect(collectText(tree!)).toContain('/Volumes/target/repo');
    });
});
