import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import {
    collectRenderedTestIds,
    createMachineFixture,
    createSessionFixture,
    renderScreen,
} from '@/dev/testkit';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const backSpy = vi.fn();
const pushSpy = vi.fn();
const executeSpy = vi.fn(async () => ({ ok: true as const, result: {} }));
const createDefaultActionExecutorSpy = vi.fn();
const fetchArtifactWithBodySpy = vi.fn(async (): Promise<unknown> => null);
const updateArtifactWithHeaderSpy = vi.fn(async (_artifactId: string, _header: unknown, _body: string) => {});
const resolvePreferredServerIdForSessionIdSpy = vi.fn((_: string) => 'server-cache');
let modalConfirmResult = true;
const defaultApprovalArtifactBody = {
    v: 1,
    status: 'open',
    createdAtMs: 1,
    updatedAtMs: 1,
    createdBy: {
        surface: 'agent',
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

function createTargetActionApprovalArtifact() {
    return {
        id: 'target-artifact-1',
        header: {
            v: 1,
            kind: 'target_action_approval.v1',
            title: 'Publish the release notes',
            approvalStatus: 'open',
            qualifiedActionId: 'acme.publisher/actions/releases/publish',
            subjectFingerprint: 'b'.repeat(64),
        },
        body: JSON.stringify({
            v: 1,
            kind: 'plugin_target_action',
            status: 'open',
            createdAtMs: 1,
            updatedAtMs: 1,
            createdBy: { surface: 'agent', agentId: 'codex', sessionId: 'session-1' },
            requestedSurface: 'agent',
            qualifiedActionId: 'acme.publisher/actions/releases/publish',
            input: { secretToken: 'must-not-render', body: 'private draft' },
            accountId: 'account-secret',
            resourceId: 'resource-secret',
            generation: 'generation-7',
            policyFingerprint: 'a'.repeat(64),
            subjectFingerprint: 'b'.repeat(64),
            summary: 'Publish the release notes',
            detail: 'This publishes the approved release notes to the configured remote.',
        }),
    };
}

function createExecutionRunHostActionApprovalArtifact() {
    return {
        id: 'host-action-artifact-1',
        header: {
            v: 1,
            kind: 'execution_run_host_action_approval.v1',
            title: 'Create 1 proposed review comment',
            approvalStatus: 'open',
            actionId: 'reviews.comments.create',
            sessionId: 'session-1',
            sessions: ['session-1'],
            runId: 'run-1',
            subjectFingerprint: 'c'.repeat(64),
            serverId: 'server-1',
        },
        body: JSON.stringify({
            v: 1, kind: 'execution_run_host_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'session-1' }, requestedSurface: 'agent',
            actionId: 'reviews.comments.create', sessionId: 'session-1', runId: 'run-1', callId: 'call-1',
            profileId: 'acme.review/review', pluginId: 'acme.review', agentId: 'claude', projectId: 'project-1',
            workspaceId: 'workspace-1', serverId: 'server-1',
            proposalCount: 1,
            proposalPreview: [{
                pathLabel: 'src/a.ts', pathSha256: 'a'.repeat(64), startLine: 7, endLine: 7,
                bodySha256: 'b'.repeat(64), bodyPreview: 'Use the canonical owner.',
            }],
            subjectFingerprint: 'c'.repeat(64), summary: 'Create 1 proposed review comment',
        }),
    };
}

function createSessionTitleApprovalArtifact(serverId?: string) {
    return {
        id: 'artifact-1',
        header: {
            kind: 'approval_request.v1',
            title: 'Set session title',
            approvalStatus: 'open',
            actionId: 'session.title.set',
            sessionId: 'session-1',
        },
        body: JSON.stringify({
            v: 1,
            status: 'open',
            createdAtMs: 1,
            updatedAtMs: 1,
            createdBy: {
                surface: 'mcp',
                sessionId: 'session-1',
            },
            requestedSurface: 'mcp',
            actionId: 'session.title.set',
            actionArgs: {
                sessionId: 'session-1',
                title: 'New title from MCP',
            },
            summary: 'Set session title',
            preview: {
                kind: 'session_title_set',
                summary: 'Set a new title for the session',
            },
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
                machineId: 'machine-target',
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
                    machineId: 'machine-target',
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
installApprovalCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            ScrollView: 'ScrollView',
            ActivityIndicator: 'ActivityIndicator',
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        });
    },
    unistyles: async () => {
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
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { back: backSpy, push: pushSpy },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                confirm: vi.fn(async () => modalConfirmResult),
                alert: vi.fn(),
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useArtifact: () => currentArtifact,
            useSession: (sessionId: string) => sessionFixtures[sessionId] ?? null,
            useMachine: (machineId: string) => machineFixtures[machineId] ?? null,
            storage: {
                getState: () => storageState,
            },
        });
    },
});

vi.mock('@/components/ui/text/Text', async () => {
    const { createPassThroughModule } = await import('@/dev/testkit/mocks/components');
    return createPassThroughModule(['Text']);
});

vi.mock('@/components/ui/lists/ItemGroup', async () => {
    const { createPassThroughModule } = await import('@/dev/testkit/mocks/components');
    return createPassThroughModule(['ItemGroup']);
});

vi.mock('@/components/ui/lists/Item', async () => {
    const { createPassThroughModule } = await import('@/dev/testkit/mocks/components');
    return createPassThroughModule(['Item']);
});

vi.mock('@/components/ui/buttons/RoundButton', async () => {
    const { createPassThroughModule } = await import('@/dev/testkit/mocks/components');
    return createPassThroughModule(['RoundButton']);
});

vi.mock('@/sync/sync', () => ({
    sync: {
        getCredentials: () => ({ token: 'test' }),
        fetchArtifactWithBody: fetchArtifactWithBodySpy,
        updateArtifactWithHeader: updateArtifactWithHeaderSpy,
    },
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: (opts?: unknown) => {
        createDefaultActionExecutorSpy(opts);
        return { execute: executeSpy };
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdSpy(sessionId),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 960 },
    useLayoutMaxWidth: () => 960,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 960 }),
}));

describe('ApprovalDetailScreen', () => {
    beforeEach(() => {
        backSpy.mockReset();
        pushSpy.mockReset();
        executeSpy.mockClear();
        createDefaultActionExecutorSpy.mockReset();
        fetchArtifactWithBodySpy.mockClear();
        updateArtifactWithHeaderSpy.mockClear();
        resolvePreferredServerIdForSessionIdSpy.mockReset();
        resolvePreferredServerIdForSessionIdSpy.mockReturnValue('server-cache');
        modalConfirmResult = true;
        sessionFixtures = createSessionFixtures();
        machineFixtures = createMachineFixtures();
        storageState = createStorageState();
        currentArtifact = createApprovalArtifact();
    });

    it('renders a redacted plugin target action and updates only that artifact', async () => {
        currentArtifact = createTargetActionApprovalArtifact();
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="target-artifact-1" />);

        const text = screen.getTextContent();
        expect(text).toContain('Publish the release notes');
        expect(text).toContain('This publishes the approved release notes to the configured remote.');
        expect(text).toContain('acme.publisher');
        expect(text).toContain('releases/publish');
        expect(text).toContain('approvals.generation');
        expect(text).not.toContain('must-not-render');
        expect(text).not.toContain('account-secret');
        expect(text).not.toContain('resource-secret');
        expect(text).not.toContain('a'.repeat(64));

        await screen.pressByTestIdAsync('approvals.approve');
        expect(executeSpy).not.toHaveBeenCalled();
        expect(updateArtifactWithHeaderSpy).toHaveBeenCalledTimes(1);
        const [artifactId, header, body] = updateArtifactWithHeaderSpy.mock.calls[0]!;
        expect(artifactId).toBe('target-artifact-1');
        expect(header).toMatchObject({ kind: 'target_action_approval.v1', approvalStatus: 'approved' });
        expect(JSON.parse(body)).toMatchObject({
            kind: 'plugin_target_action',
            status: 'approved',
            qualifiedActionId: 'acme.publisher/actions/releases/publish',
            subjectFingerprint: 'b'.repeat(64),
            decision: { kind: 'approve' },
        });
    });

    it('renders and updates only the execution-run host-action approval artifact', async () => {
        currentArtifact = createExecutionRunHostActionApprovalArtifact();
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="host-action-artifact-1" />);

        const text = screen.getTextContent();
        expect(text).toContain('Create 1 proposed review comment');
        expect(text).toContain('acme.review');
        expect(text).toContain('reviews.comments.create');
        expect(text).toContain('approvals.proposedComments');
        expect(text).toContain('Use the canonical owner.');
        expect(text).not.toContain('project-1');
        expect(text).not.toContain('c'.repeat(64));

        await screen.pressByTestIdAsync('approvals.approve');
        expect(executeSpy).not.toHaveBeenCalled();
        expect(updateArtifactWithHeaderSpy).toHaveBeenCalledTimes(1);
        const [artifactId, header, body] = updateArtifactWithHeaderSpy.mock.calls[0]!;
        expect(artifactId).toBe('host-action-artifact-1');
        expect(header).toMatchObject({
            kind: 'execution_run_host_action_approval.v1', approvalStatus: 'approved',
            actionId: 'reviews.comments.create', runId: 'run-1',
        });
        expect(JSON.parse(body)).toMatchObject({
            kind: 'execution_run_host_action', status: 'approved',
            decision: { kind: 'approve' }, subjectFingerprint: 'c'.repeat(64),
        });
    });

    it('fails closed when a target header is paired with a built-in body', async () => {
        currentArtifact = {
            ...createApprovalArtifact(),
            id: 'target-artifact-1',
            header: createTargetActionApprovalArtifact().header,
        };
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="target-artifact-1" />);

        expect(screen.getTextContent()).toContain('approvals.loadError');
        expect(screen.findByTestId('approvals.approve')).toBeNull();
        expect(executeSpy).not.toHaveBeenCalled();
        expect(updateArtifactWithHeaderSpy).not.toHaveBeenCalled();
    });

    it('reloads the authoritative artifact after a decision version conflict', async () => {
        currentArtifact = createTargetActionApprovalArtifact();
        const authoritative = {
            ...createTargetActionApprovalArtifact(),
            header: { ...createTargetActionApprovalArtifact().header, approvalStatus: 'approved' },
            body: JSON.stringify({
                ...JSON.parse(createTargetActionApprovalArtifact().body),
                status: 'approved',
                updatedAtMs: 2,
                decision: { kind: 'approve', decidedAtMs: 2 },
            }),
        };
        updateArtifactWithHeaderSpy.mockRejectedValueOnce(new Error('Artifact was modified by another client. Please refresh and try again.'));
        fetchArtifactWithBodySpy.mockResolvedValueOnce(authoritative);
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="target-artifact-1" />);

        await screen.pressByTestIdAsync('approvals.approve');

        expect(fetchArtifactWithBodySpy).toHaveBeenCalledWith('target-artifact-1');
        expect(storageState.updateArtifact).toHaveBeenCalledWith(authoritative);
        expect(executeSpy).not.toHaveBeenCalled();
    });

    it('writes exact reject and cancel transitions without executing client-side', async () => {
        currentArtifact = createTargetActionApprovalArtifact();
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const rejectScreen = await renderScreen(<ApprovalDetailScreen artifactId="target-artifact-1" />);
        await rejectScreen.pressByTestIdAsync('approvals.reject');
        expect(JSON.parse(updateArtifactWithHeaderSpy.mock.calls[0]![2])).toMatchObject({
            status: 'rejected', decision: { kind: 'reject' },
        });

        updateArtifactWithHeaderSpy.mockClear();
        const cancelScreen = await renderScreen(<ApprovalDetailScreen artifactId="target-artifact-1" />);
        await cancelScreen.pressByTestIdAsync('approvals.cancel');
        const canceled = JSON.parse(updateArtifactWithHeaderSpy.mock.calls[0]![2]);
        expect(canceled).toMatchObject({ status: 'canceled' });
        expect(canceled).not.toHaveProperty('decision');
        expect(executeSpy).not.toHaveBeenCalled();
    });

    it('guards same-frame duplicate decisions and removes controls for terminal artifacts', async () => {
        currentArtifact = createTargetActionApprovalArtifact();
        let release!: () => void;
        updateArtifactWithHeaderSpy.mockImplementationOnce(async () => await new Promise<void>((resolve) => { release = resolve; }));
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="target-artifact-1" />);
        const approve = screen.findByTestId('approvals.approve');
        expect(approve).not.toBeNull();
        await act(async () => {
            approve!.props.onPress();
            approve!.props.onPress();
            await Promise.resolve();
        });
        expect(updateArtifactWithHeaderSpy).toHaveBeenCalledTimes(1);
        await act(async () => release());

        currentArtifact = {
            ...createTargetActionApprovalArtifact(),
            header: { ...createTargetActionApprovalArtifact().header, approvalStatus: 'approved' },
            body: JSON.stringify({
                ...JSON.parse(createTargetActionApprovalArtifact().body),
                status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 },
            }),
        };
        const terminal = await renderScreen(<ApprovalDetailScreen artifactId="target-artifact-1" />);
        expect(terminal.findByTestId('approvals.approve')).toBeNull();
        expect(terminal.findByTestId('approvals.reject')).toBeNull();
        expect(terminal.findByTestId('approvals.cancel')).toBeNull();
    });

    it('provides explicit accessible labels for all target decision controls', async () => {
        currentArtifact = createTargetActionApprovalArtifact();
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="target-artifact-1" />);

        expect(screen.findByTestId('approvals.approve')?.props.accessibilityLabel).toBe('approvals.approve');
        expect(screen.findByTestId('approvals.reject')?.props.accessibilityLabel).toBe('approvals.reject');
        expect(screen.findByTestId('approvals.cancel')?.props.accessibilityLabel).toBe('common.cancel');
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

    it('places the primary approve action before the reject action', async () => {
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

        const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);

        const testIdOrder = collectRenderedTestIds(screen.tree.toJSON());

        expect(testIdOrder.indexOf('approvals.approve')).toBeGreaterThanOrEqual(0);
        expect(testIdOrder.indexOf('approvals.reject')).toBeGreaterThanOrEqual(0);
        expect(testIdOrder.indexOf('approvals.approve')).toBeLessThan(testIdOrder.indexOf('approvals.reject'));
    });

    it('fetches the artifact body when the route opens without a cached artifact', async () => {
        currentArtifact = null;
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

        const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);

        expect(fetchArtifactWithBodySpy).toHaveBeenCalledWith('artifact-1');
        expect(screen).toBeTruthy();
    });

    it('fetches the artifact body when only a header-only artifact with a null body is cached', async () => {
        currentArtifact = {
            ...createApprovalArtifact(),
            body: null,
        };
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

    it('shows retained encrypted approvals as locked without refetching them as missing bodies', async () => {
        currentArtifact = {
            id: 'artifact-1',
            title: null,
            header: null,
            body: undefined,
            headerVersion: 3,
            bodyVersion: 4,
            seq: 5,
            createdAt: 1,
            updatedAt: 2,
            isDecrypted: false,
            storageMode: 'e2ee',
            availability: {
                kind: 'locked',
                reason: 'encryption_material_unavailable',
            },
        };
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

        const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);

        expect(fetchArtifactWithBodySpy).not.toHaveBeenCalled();
        expect(screen.getTextContent()).toContain('settingsAccount.secretKeyMissing');
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
                surface: 'ui',
                serverId: 'server-approval',
            }),
        );
        expect(resolvePreferredServerIdForSessionIdSpy).not.toHaveBeenCalled();
    });

    it('executes approval decisions even when the web confirm modal resolves false (ModalProvider unavailable)', async () => {
        modalConfirmResult = false;
        currentArtifact = createApprovalArtifact('server-approval');
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

        const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);

        await act(async () => {
            await screen.pressByTestIdAsync('approvals.approve');
        });

        expect(executeSpy).toHaveBeenCalledWith(
            'approval.request.decide',
            { artifactId: 'artifact-1', decision: 'approve' },
            expect.objectContaining({
                surface: 'ui',
                serverId: 'server-approval',
            }),
        );
    });

    it('renders and approves external session.title.set requests', async () => {
        currentArtifact = createSessionTitleApprovalArtifact('server-approval');
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

        const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);

        const text = screen.getTextContent();
        expect(text).toContain('Set session title');
        expect(text).toContain('New title from MCP');
        expect(text).toContain('Session id');
        expect(text).toContain('Title');

        await act(async () => {
            await screen.pressByTestIdAsync('approvals.approve');
        });

        expect(executeSpy).toHaveBeenCalledWith(
            'approval.request.decide',
            { artifactId: 'artifact-1', decision: 'approve' },
            expect.objectContaining({
                surface: 'ui',
                serverId: 'server-approval',
            }),
        );
    });
});
