import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const backSpy = vi.fn();
const pushSpy = vi.fn();
const executeSpy = vi.fn(async () => ({ ok: true as const, result: {} }));
const createDefaultActionExecutorSpy = vi.fn();
const fetchArtifactWithBodySpy = vi.fn(async () => null);
const resolveServerIdForSessionIdFromLocalCacheSpy = vi.fn((_: string) => 'server-cache');
let currentArtifact: any = {
    id: 'artifact-1',
    header: {
        kind: 'approval_request.v1',
        title: 'Approve answering the user',
        approvalStatus: 'open',
        actionId: 'session.user_action.answer',
        sessionId: 'session-1',
    },
    body: JSON.stringify({
        v: 1,
        status: 'open',
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: {
            surface: 'session_agent',
            agentId: 'codex',
            sessionId: 'session-1',
        },
        actionId: 'session.user_action.answer',
        actionArgs: {
            sessionId: 'session-1',
            requestId: 'ask-1',
            answers: [{ question: 'Continue?', answer: 'Yes' }],
        },
        summary: 'Approve answering the user',
        preview: {
            kind: 'user_action',
            summary: 'Agent wants to answer the pending question',
        },
    }),
};

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        View: 'View',
        Text: 'Text',
        ScrollView: 'ScrollView',
        ActivityIndicator: 'ActivityIndicator',
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    };
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (value: unknown) => value },
    useUnistyles: () => ({
        theme: {
            colors: {
                groupped: { background: '#111' },
                text: '#fff',
                textSecondary: '#999',
                divider: '#333',
                surface: '#171717',
                surfaceHigh: '#1d1d1d',
                surfaceHighest: '#222',
                button: { primary: { background: '#444', tint: '#fff' } },
                deleteAction: '#b00',
                status: { error: '#f00' },
            },
        },
    }),
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ back: backSpy, push: pushSpy }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: any) => React.createElement('ItemGroup', { title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: ({ title, detail, subtitle }: any) => React.createElement('Item', { title, detail, subtitle }),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: ({ title, testID, onPress, disabled }: any) =>
        React.createElement('RoundButton', { title, testID, onPress, disabled }),
}));

vi.mock('@/modal', () => ({
    Modal: {
        confirm: vi.fn(async () => true),
        alert: vi.fn(),
    },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        getCredentials: () => ({ token: 'test' }),
        fetchArtifactWithBody: fetchArtifactWithBodySpy,
    },
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: (opts?: unknown) => {
        createDefaultActionExecutorSpy(opts);
        return { execute: executeSpy };
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
    resolveServerIdForSessionIdFromLocalCache: (sessionId: string) => resolveServerIdForSessionIdFromLocalCacheSpy(sessionId),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 960 },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useArtifact: () => currentArtifact,
    useSession: (sessionId: string) =>
        sessionId === 'session-1'
            ? {
                  id: 'session-1',
                  metadata: {
                      name: 'Repo session',
                      path: '/Users/leeroy/repo',
                      homeDir: '/Users/leeroy',
                      machineId: 'machine-1',
                  },
              }
            : null,
    useMachine: (machineId: string) =>
        machineId === 'machine-1'
            ? {
                  id: 'machine-1',
                  metadata: { displayName: 'Workstation', host: 'workstation.local' },
              }
            : null,
    storage: {
        getState: () => ({
            updateArtifact: vi.fn(),
        }),
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

describe('ApprovalDetailScreen', () => {
    beforeEach(() => {
        backSpy.mockReset();
        pushSpy.mockReset();
        executeSpy.mockClear();
        createDefaultActionExecutorSpy.mockReset();
        fetchArtifactWithBodySpy.mockClear();
        resolveServerIdForSessionIdFromLocalCacheSpy.mockReset();
        resolveServerIdForSessionIdFromLocalCacheSpy.mockReturnValue('server-cache');
        currentArtifact = {
            id: 'artifact-1',
            header: {
                kind: 'approval_request.v1',
                title: 'Approve answering the user',
                approvalStatus: 'open',
                actionId: 'session.user_action.answer',
                sessionId: 'session-1',
            },
            body: JSON.stringify({
                v: 1,
                status: 'open',
                createdAtMs: 1,
                updatedAtMs: 1,
                createdBy: {
                    surface: 'session_agent',
                    agentId: 'codex',
                    sessionId: 'session-1',
                },
                actionId: 'session.user_action.answer',
                actionArgs: {
                    sessionId: 'session-1',
                    requestId: 'ask-1',
                    answers: [{ question: 'Continue?', answer: 'Yes' }],
                },
                summary: 'Approve answering the user',
                preview: {
                    kind: 'user_action',
                    summary: 'Agent wants to answer the pending question',
                },
            }),
        };
    });

    it('renders requester, session context, and structured action details', async () => {
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ApprovalDetailScreen artifactId="artifact-1" />);
        });

        const text = collectText(tree!);
        expect(text).toContain('Approve answering the user');
        expect(text).toContain('Respond to user-action request');
        expect(text).toContain('Repo session');
        expect(text).toContain('Workstation');
        expect(text).toContain('~/repo');
        expect(text).toContain('codex');
        expect(text).toContain('Agent wants to answer the pending question');
        expect(text).toContain('Continue?');
        expect(text).toContain('Yes');
    });

    it('opens the linked session from the approval context card', async () => {
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ApprovalDetailScreen artifactId="artifact-1" />);
        });

        const openButton = tree!.root.findByProps({ testID: 'approvals.open-session' });
        await act(async () => {
            openButton.props.onPress();
        });

        expect(pushSpy).toHaveBeenCalledWith('/session/session-1');
    });

    it('fetches the artifact body when the route opens without a cached artifact', async () => {
        currentArtifact = null;
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ApprovalDetailScreen artifactId="artifact-1" />);
            await Promise.resolve();
        });

        expect(fetchArtifactWithBodySpy).toHaveBeenCalledWith('artifact-1');
        expect(tree).toBeTruthy();
    });

    it('shows an error state when loading a missing approval artifact fails', async () => {
        currentArtifact = null;
        fetchArtifactWithBodySpy.mockResolvedValueOnce(null);
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ApprovalDetailScreen artifactId="artifact-1" />);
            await Promise.resolve();
        });

        const text = collectText(tree!);
        expect(fetchArtifactWithBodySpy).toHaveBeenCalledWith('artifact-1');
        expect(text).toContain('approvals.loadError');
        expect(tree!.root.findAllByType('ActivityIndicator')).toHaveLength(0);
    });

    it('creates the action executor with the session-to-server resolver and routes approval decisions with a server hint', async () => {
        currentArtifact = {
            ...currentArtifact,
            body: JSON.stringify({
                ...JSON.parse(currentArtifact.body),
                serverId: 'server-approval',
            }),
        };
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ApprovalDetailScreen artifactId="artifact-1" />);
        });

        expect(createDefaultActionExecutorSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                resolveServerIdForSessionId: expect.any(Function),
            }),
        );

        const approveButton = tree!.root.findByProps({ testID: 'approvals.approve' });
        await act(async () => {
            await approveButton.props.onPress();
        });

        expect(executeSpy).toHaveBeenCalledWith(
            'approval.request.decide',
            { artifactId: 'artifact-1', decision: 'approve' },
            expect.objectContaining({
                surface: 'ui_button',
                serverId: 'server-approval',
            }),
        );
        expect(resolveServerIdForSessionIdFromLocalCacheSpy).not.toHaveBeenCalled();
    });
});
