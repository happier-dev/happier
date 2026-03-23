import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import {
    createMachineFixture,
    createSessionFixture,
    renderScreen,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const backSpy = vi.fn();
const pushSpy = vi.fn();
const executeSpy = vi.fn(async () => ({ ok: true as const, result: {} }));
const createDefaultActionExecutorSpy = vi.fn();
const fetchArtifactWithBodySpy = vi.fn(async () => null);
const resolveServerIdForSessionIdFromLocalCacheSpy = vi.fn((_: string) => 'server-cache');
const defaultApprovalArtifactBody = {
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
};

function createApprovalArtifact(serverId?: string) {
    return {
        id: 'artifact-1',
        header: {
            kind: 'approval_request.v1',
            title: 'Approve answering the user',
            approvalStatus: 'open',
            actionId: 'session.user_action.answer',
            sessionId: 'session-1',
        },
        body: JSON.stringify({
            ...defaultApprovalArtifactBody,
            ...(serverId ? { serverId } : {}),
        }),
    };
}

function createSessionFixtures() {
    return {
        'session-1': createSessionFixture({
            id: 'session-1',
            metadata: {
                name: 'Repo session',
                host: 'tester.local',
                path: '/Users/leeroy/repo',
                homeDir: '/Users/leeroy',
                machineId: 'machine-stale',
            },
        }),
    } satisfies Record<string, Session>;
}

function createMachineFixtures() {
    return {
        'machine-target': createMachineFixture({
            id: 'machine-target',
            metadata: {
                displayName: 'Rebound workstation',
                host: 'workstation.local',
                platform: 'darwin',
                happyCliVersion: '0.0.0-test',
                happyHomeDir: '/Users/tester/.happy-dev',
                homeDir: '/Users/tester',
            },
        }),
    } satisfies Record<string, Machine>;
}

function createStorageState() {
    return {
        sessions: {
            'session-1': createSessionFixture({
                id: 'session-1',
                active: false,
                metadata: {
                    host: 'tester.local',
                    machineId: 'machine-stale',
                    path: '/Users/leeroy/repo',
                    homeDir: '/Users/leeroy',
                } as Session['metadata'],
            }),
        },
        machines: {
            'machine-target': createMachineFixture({
                id: 'machine-target',
                active: true,
                activeAt: 10,
                metadata: {
                    displayName: 'Rebound workstation',
                    host: 'workstation.local',
                    platform: 'darwin',
                    happyCliVersion: '0.0.0-test',
                    happyHomeDir: '/Users/tester/.happy-dev',
                    homeDir: '/Users/tester',
                },
            }),
        },
        getProjectForSession: (sessionId: string) =>
            sessionId === 'session-1'
                ? {
                    key: {
                        machineId: 'machine-target',
                        path: '/Users/leeroy/repo',
                    },
                }
                : null,
        updateArtifact: vi.fn(),
    };
}

let currentArtifact: any = createApprovalArtifact();
let sessionFixtures: Record<string, Session> = createSessionFixtures();
let machineFixtures: Record<string, Machine> = createMachineFixtures();
let storageState = createStorageState();

async function createReactNativeWebMockForApprovalDetailScreen() {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Text: 'Text',
        ScrollView: 'ScrollView',
        ActivityIndicator: 'ActivityIndicator',
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    });
}

async function createUnistylesMockForApprovalDetailScreen() {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
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
    });
}

async function createExpoRouterMockForApprovalDetailScreen() {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { back: backSpy, push: pushSpy },
    });
    return expoRouterMock.module;
}

async function createTextModuleMockForApprovalDetailScreen() {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
}

async function createModalModuleMockForApprovalDetailScreen() {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            confirm: vi.fn(async () => true),
            alert: vi.fn(),
        },
    }).module;
}

async function createStorageModuleStubForApprovalDetailScreen() {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useArtifact: () => currentArtifact,
        useSession: (sessionId: string) => sessionFixtures[sessionId] ?? null,
        useMachine: (machineId: string) => machineFixtures[machineId] ?? null,
        storage: {
            getState: () => storageState,
        },
    });
}

vi.mock('react-native', async () => createReactNativeWebMockForApprovalDetailScreen());

vi.mock('react-native-unistyles', async () => createUnistylesMockForApprovalDetailScreen());

vi.mock('expo-router', async () => createExpoRouterMockForApprovalDetailScreen());

vi.mock('@/text', async () => createTextModuleMockForApprovalDetailScreen());

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

vi.mock('@/modal', async () => createModalModuleMockForApprovalDetailScreen());

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

vi.mock('@/sync/domains/state/storage', async () => createStorageModuleStubForApprovalDetailScreen());

describe('ApprovalDetailScreen', () => {
    beforeEach(() => {
        backSpy.mockReset();
        pushSpy.mockReset();
        executeSpy.mockClear();
        createDefaultActionExecutorSpy.mockReset();
        fetchArtifactWithBodySpy.mockClear();
        resolveServerIdForSessionIdFromLocalCacheSpy.mockReset();
        resolveServerIdForSessionIdFromLocalCacheSpy.mockReturnValue('server-cache');
        sessionFixtures = createSessionFixtures();
        machineFixtures = createMachineFixtures();
        storageState = createStorageState();
        currentArtifact = createApprovalArtifact();
    });

    it('renders requester, session context, and structured action details', async () => {
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

        const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);

        const text = screen.getTextContent();
        expect(text).toContain('Approve answering the user');
        expect(text).toContain('Respond to user-action request');
        expect(text).toContain('Repo session');
        expect(text).toContain('Rebound workstation');
        expect(text).toContain('~/repo');
        expect(text).toContain('codex');
        expect(text).toContain('Agent wants to answer the pending question');
        expect(text).toContain('Continue?');
        expect(text).toContain('Yes');
    });

    it('opens the linked session from the approval context card', async () => {
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

        const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);

        await act(async () => {
            await screen.pressByTestIdAsync('approvals.open-session');
        });

        expect(pushSpy).toHaveBeenCalledWith('/session/session-1');
    });

    it('fetches the artifact body when the route opens without a cached artifact', async () => {
        currentArtifact = null;
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

        const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);

        expect(fetchArtifactWithBodySpy).toHaveBeenCalledWith('artifact-1');
        expect(screen).toBeTruthy();
    });

    it('shows an error state when loading a missing approval artifact fails', async () => {
        currentArtifact = null;
        fetchArtifactWithBodySpy.mockResolvedValueOnce(null);
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

        const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);

        const text = screen.getTextContent();
        expect(fetchArtifactWithBodySpy).toHaveBeenCalledWith('artifact-1');
        expect(text).toContain('approvals.loadError');
        expect(screen.findAllByType('ActivityIndicator')).toHaveLength(0);
    });

    it('creates the action executor with the session-to-server resolver and routes approval decisions with a server hint', async () => {
        currentArtifact = createApprovalArtifact('server-approval');
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

        const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);

        expect(createDefaultActionExecutorSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                resolveServerIdForSessionId: expect.any(Function),
            }),
        );

        await act(async () => {
            await screen.pressByTestIdAsync('approvals.approve');
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
