import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';

type MockStorageState = {
    sessionMessages: Record<string, { messages: unknown[] }>;
    sessions?: Record<string, unknown>;
    machines?: Record<string, unknown>;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string; path?: string } } | null;
};

const mockStorageState: MockStorageState = {
    sessionMessages: {},
    sessions: {},
    machines: {},
    getProjectForSession: () => null,
};

vi.mock('@/text', () => {
    return {
        t: (key: string) => key,
    };
});

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => mockStorageState,
        setState: (updater: ((state: typeof mockStorageState) => typeof mockStorageState) | typeof mockStorageState) => {
            const next = typeof updater === 'function' ? updater(mockStorageState) : updater;
            mockStorageState.sessionMessages = next.sessionMessages;
        },
    },
}));

beforeEach(() => {
    vi.resetModules();
    mockStorageState.sessionMessages = {};
    mockStorageState.sessions = {};
    mockStorageState.machines = {};
    mockStorageState.getProjectForSession = () => null;
});

function createBaseSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 's1',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

describe('getSessionStatus', () => {
    it('returns disconnected when presence is not online', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({ presence: 123 });
        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('disconnected');
        expect(status.isConnected).toBe(false);
        expect(status.shouldShowStatus).toBe(true);
    });

    it('returns permission_required when the agent has pending requests', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: { tool: 'tool', arguments: {}, createdAt: null },
                },
                completedRequests: null,
            },
        });
        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('permission_required');
        expect(status.isConnected).toBe(true);
        expect(status.shouldShowStatus).toBe(true);
    });

    it('returns action_required when the agent has pending user-action requests', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: { tool: 'AskUserQuestion', kind: 'user_action', arguments: { q: 'x' }, createdAt: 1 },
                },
                completedRequests: null,
            },
        });
        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('action_required');
        expect(status.isConnected).toBe(true);
        expect(status.shouldShowStatus).toBe(true);
    });

    it('does not return permission_required when agentState.requests is stale relative to completedRequests', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: { tool: 'Bash', arguments: { command: 'ls' }, createdAt: 100 },
                },
                completedRequests: {
                    req1: {
                        tool: 'Bash',
                        arguments: { command: 'ls' },
                        createdAt: 100,
                        completedAt: 200,
                        status: 'canceled',
                        reason: null,
                        mode: null,
                        allowedTools: null,
                        decision: null,
                    },
                },
            },
        });
        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('waiting');
    });

    it('returns thinking when session.thinking is true', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({ thinking: true });
        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('thinking');
        expect(status.isConnected).toBe(true);
        expect(status.shouldShowStatus).toBe(true);
        expect(status.isPulsing).toBe(true);
    });

    it('returns thinking when optimisticThinkingAt is recent', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({ optimisticThinkingAt: now - 1_000 });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('thinking');
    });

    it('does not treat stale optimisticThinkingAt as thinking', async () => {
        const { getSessionStatus, OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({ optimisticThinkingAt: now - OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS - 1 });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('waiting');
    });

    it('does not treat optimisticThinkingAt exactly at timeout as thinking', async () => {
        const { getSessionStatus, OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({ optimisticThinkingAt: now - OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('waiting');
    });

    it('returns thinking when thinkingGraceUntil is in the future (debounced thinking)', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({ thinkingGraceUntil: now + 1_000 });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('thinking');
    });

    it('does not treat thinkingGraceUntil in the past as thinking', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({ thinkingGraceUntil: now - 1 });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('waiting');
    });

    it('prioritizes permission_required over thinking state', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({
            thinking: true,
            agentState: {
                controlledByUser: false,
                requests: {
                    req1: { tool: 'tool', arguments: {}, createdAt: null },
                },
                completedRequests: null,
            },
        });
        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('permission_required');
    });

    it('prioritizes action_required over thinking state', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({
            thinking: true,
            agentState: {
                controlledByUser: false,
                requests: {
                    req1: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 1 },
                },
                completedRequests: null,
            },
        });
        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('action_required');
    });
});

describe('listPendingPermissionRequests', () => {
    it('filters out requests that are user-action prompts (kind=user_action) and custom-tool fallbacks', async () => {
        const { listPendingPermissionRequests } = await import('./sessionUtils');
        const session = createBaseSession({
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: { tool: 'AskUserQuestion', kind: 'user_action', arguments: { q: 'x' }, createdAt: 1 },
                    req2: { tool: 'ExitPlanMode', arguments: {}, createdAt: 2 },
                    req3: { tool: 'exit_plan_mode', arguments: {}, createdAt: 3 },
                    req4: { tool: 'AcpHistoryImport', arguments: {}, createdAt: 4 },
                    req4b: { tool: 'SomeNewInteractiveTool', kind: 'user_action', arguments: {}, createdAt: 4 },
                    req5: { tool: 'Bash', arguments: { command: 'ls' }, createdAt: 5 },
                },
                completedRequests: null,
            },
        });

        expect(listPendingPermissionRequests(session)).toEqual([
            { id: 'req5', tool: 'Bash', kind: 'permission', arguments: { command: 'ls' }, createdAt: 5 },
        ]);
    });

    it('includes permissionSuggestions when present on agentState requests', async () => {
        const { listPendingPermissionRequests } = await import('./sessionUtils');
        const suggestions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
        const session = createBaseSession({
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: { tool: 'Bash', arguments: { command: 'ls' }, createdAt: 5, permissionSuggestions: suggestions },
                },
                completedRequests: null,
            },
        });

        expect(listPendingPermissionRequests(session)).toEqual([
            {
                id: 'req1',
                tool: 'Bash',
                kind: 'permission',
                arguments: { command: 'ls' },
                createdAt: 5,
                permissionSuggestions: suggestions,
            },
        ]);
    });

    it('falls back to pending transcript tool-call permissions when agentState is missing', async () => {
        const { listPendingPermissionRequests } = await import('./sessionUtils');
        const session = createBaseSession({
            id: 's-transcript-perm',
            agentState: null,
        });

        expect(listPendingPermissionRequests(session, [
            {
                kind: 'tool-call',
                id: 'm-tool-1',
                localId: null,
                createdAt: 2,
                children: [],
                tool: {
                    id: 'perm_tool_1',
                    name: 'Bash',
                    state: 'completed',
                    input: { command: 'printf hello > hello.txt' },
                    createdAt: 2,
                    startedAt: 2,
                    completedAt: 3,
                    description: 'Write file',
                    result: {},
                    permission: {
                        id: 'perm_tool_1',
                        status: 'pending',
                    },
                },
            },
        ] as any)).toEqual([
            {
                id: 'perm_tool_1',
                tool: 'Bash',
                kind: 'permission',
                arguments: { command: 'printf hello > hello.txt' },
                createdAt: 2,
            },
        ]);
    });

    it('reads pending transcript tool-call permissions from normalized stored session messages when no messages are passed', async () => {
        const { listPendingPermissionRequests } = await import('./sessionUtils');
        const session = createBaseSession({
            id: 's-transcript-perm-normalized',
            agentState: null,
        });
        const transcriptMessage = {
            kind: 'tool-call',
            id: 'm-tool-1',
            localId: null,
            createdAt: 2,
            children: [],
            tool: {
                id: 'perm_tool_1',
                name: 'Bash',
                state: 'completed',
                input: { command: 'printf hello > hello.txt' },
                createdAt: 2,
                startedAt: 2,
                completedAt: 3,
                description: 'Write file',
                result: {},
                permission: {
                    id: 'perm_tool_1',
                    status: 'pending',
                },
            },
        } as any;

        mockStorageState.sessionMessages = {
            ...mockStorageState.sessionMessages,
            's-transcript-perm-normalized': {
                messageIdsOldestFirst: ['m-tool-1'],
                messagesById: {
                    'm-tool-1': transcriptMessage,
                },
                messagesMap: {
                    'm-tool-1': transcriptMessage,
                },
            } as any,
        };

        expect(listPendingPermissionRequests(session)).toEqual([
            {
                id: 'perm_tool_1',
                tool: 'Bash',
                kind: 'permission',
                arguments: { command: 'printf hello > hello.txt' },
                createdAt: 2,
            },
        ]);
    });

    it('prefers the transcript permission id when agentState and transcript describe the same pending request', async () => {
        const { listPendingPermissionRequests } = await import('./sessionUtils');
        const suggestions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
        const session = createBaseSession({
            id: 's-permission-alias',
            agentState: {
                controlledByUser: null,
                requests: {
                    call_MRGAh1tIH4dBEwSc0mCt3MtU: {
                        tool: 'writeTextFile',
                        kind: 'permission',
                        arguments: {
                            path: '/Users/leeroy/Documents/Development/happier/dev/voice-permission-request.txt',
                            bytes: 25,
                        },
                        createdAt: 10,
                        permissionSuggestions: suggestions,
                    },
                },
                completedRequests: null,
            },
        });

        expect(listPendingPermissionRequests(session, [
            {
                kind: 'tool-call',
                id: 'm-tool-1',
                localId: null,
                createdAt: 10,
                children: [],
                tool: {
                    id: 'tool:acp-fs-write:64154962-012d-4d95-8211-b65855cc7476',
                    name: 'writeTextFile',
                    state: 'running',
                    input: {
                        path: '/Users/leeroy/Documents/Development/happier/dev/voice-permission-request.txt',
                        bytes: 25,
                    },
                    createdAt: 10,
                    startedAt: null,
                    completedAt: null,
                    description: 'Write file',
                    permission: {
                        id: 'acp-fs-write:64154962-012d-4d95-8211-b65855cc7476',
                        status: 'pending',
                        kind: 'permission',
                        suggestions,
                    },
                },
            },
        ] as any)).toEqual([
            {
                id: 'acp-fs-write:64154962-012d-4d95-8211-b65855cc7476',
                tool: 'writeTextFile',
                kind: 'permission',
                arguments: {
                    path: '/Users/leeroy/Documents/Development/happier/dev/voice-permission-request.txt',
                    bytes: 25,
                },
                createdAt: 10,
                permissionSuggestions: suggestions,
            },
        ]);
    });
});

describe('listPendingTranscriptRequests', () => {
    it('returns pending transcript-backed user-action requests', async () => {
        const { listPendingTranscriptRequests } = await import('./sessionUtils');
        const session = createBaseSession({
            id: 's-transcript-action',
            agentState: null,
        });

        expect(listPendingTranscriptRequests(session, [
            {
                kind: 'tool-call',
                id: 'm-tool-action-1',
                localId: null,
                createdAt: 7,
                children: [],
                tool: {
                    id: 'ask_user_question_1',
                    name: 'AskUserQuestion',
                    state: 'completed',
                    input: {
                        questions: [
                            {
                                question: 'Should I continue with local voice QA?',
                                options: [{ label: 'Yes' }, { label: 'No' }],
                            },
                        ],
                    },
                    createdAt: 7,
                    startedAt: 7,
                    completedAt: 8,
                    description: 'Ask the user a question',
                    result: {},
                    permission: {
                        id: 'ask_user_question_1',
                        status: 'pending',
                        kind: 'user_action',
                    },
                },
            },
        ] as any)).toEqual([
            {
                id: 'ask_user_question_1',
                tool: 'AskUserQuestion',
                kind: 'user_action',
                arguments: {
                    questions: [
                        {
                            question: 'Should I continue with local voice QA?',
                            options: [{ label: 'Yes' }, { label: 'No' }],
                        },
                    ],
                },
                createdAt: 7,
            },
        ]);
    });
});

describe('getSessionStatus', () => {
    it('treats transcript-backed pending permissions as permission_required when agentState is missing', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState((state: any) => ({
            ...state,
            sessionMessages: {
                ...(state.sessionMessages ?? {}),
                's-transcript-status': {
                    messages: [
                        {
                            kind: 'tool-call',
                            id: 'm-tool-2',
                            localId: null,
                            createdAt: 5,
                            children: [],
                            tool: {
                                id: 'perm_tool_2',
                                name: 'Bash',
                                state: 'completed',
                                input: { command: 'printf hi > hi.txt' },
                                createdAt: 5,
                                startedAt: 5,
                                completedAt: 6,
                                description: 'Write file',
                                result: {},
                                permission: {
                                    id: 'perm_tool_2',
                                    status: 'pending',
                                },
                            },
                        },
                    ],
                },
            },
        }));
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({
            id: 's-transcript-status',
            agentState: null,
        });

        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('permission_required');
    });
});

describe('shouldShowAbortButtonForSessionState', () => {
    it('returns false for waiting (idle online) sessions', async () => {
        const { shouldShowAbortButtonForSessionState } = await import('./sessionUtils');
        expect(shouldShowAbortButtonForSessionState('waiting')).toBe(false);
    });

    it('returns true for thinking sessions', async () => {
        const { shouldShowAbortButtonForSessionState } = await import('./sessionUtils');
        expect(shouldShowAbortButtonForSessionState('thinking')).toBe(true);
    });

    it('returns true for permission_required sessions', async () => {
        const { shouldShowAbortButtonForSessionState } = await import('./sessionUtils');
        expect(shouldShowAbortButtonForSessionState('permission_required')).toBe(true);
    });

    it('returns true for action_required sessions', async () => {
        const { shouldShowAbortButtonForSessionState } = await import('./sessionUtils');
        expect(shouldShowAbortButtonForSessionState('action_required')).toBe(true);
    });

    it('returns false for disconnected sessions', async () => {
        const { shouldShowAbortButtonForSessionState } = await import('./sessionUtils');
        expect(shouldShowAbortButtonForSessionState('disconnected')).toBe(false);
    });
});

describe('getSessionName', () => {
    it('prefers metadata summary text over other fallbacks', async () => {
        const { getSessionName } = await import('./sessionUtils');
        const session = createBaseSession({
            metadata: {
                path: '/tmp/worktree',
                host: 'mac',
                name: 'Stored Name',
                summary: {
                    text: 'Summary Title',
                    updatedAt: 1,
                },
            },
        });
        expect(getSessionName(session)).toBe('Summary Title');
    });

    it('falls back to metadata name before path segments', async () => {
        const { getSessionName } = await import('./sessionUtils');
        const session = createBaseSession({
            metadata: {
                path: '/tmp/worktree',
                host: 'mac',
                name: 'Linked Direct Session',
            },
        });
        expect(getSessionName(session)).toBe('Linked Direct Session');
    });

    it('uses the reachable target base path when path-derived names are stale after handoff', async () => {
        const { getSessionName } = await import('./sessionUtils');
        const session = createBaseSession({
            id: 'session-1',
            metadata: {
                machineId: 'machine-stale',
                path: '/Users/test/workspace/stale-name',
                homeDir: '/Users/test',
                host: 'stale.local',
            } as Session['metadata'],
        });

        mockStorageState.sessions = {
            'session-1': {
                active: true,
                updatedAt: 10,
                metadata: session.metadata,
            },
        };
        mockStorageState.machines = {
            'machine-target': {
                id: 'machine-target',
                active: true,
                activeAt: 20,
                metadata: { host: 'target.local' },
            },
        };
        mockStorageState.getProjectForSession = (sessionId: string) =>
            sessionId === 'session-1'
                ? {
                    key: {
                        machineId: 'machine-target',
                        path: '/Users/test/workspace/live-name',
                    },
                }
                : null;

        expect(getSessionName(session)).toBe('live-name');
    });
});

describe('reachable target session display helpers', () => {
    it('uses the reachable target base path for session subtitles when metadata is stale after handoff', async () => {
        const { getSessionSubtitle } = await import('./sessionUtils');

        const session = createBaseSession({
            id: 'session-1',
            metadata: {
                machineId: 'machine-stale',
                path: '/Users/test/workspace/stale',
                homeDir: '/Users/test',
                host: 'stale.local',
            } as Session['metadata'],
        });

        mockStorageState.sessions = {
            'session-1': {
                active: true,
                updatedAt: 10,
                metadata: session.metadata,
            },
        };
        mockStorageState.machines = {
            'machine-target': {
                id: 'machine-target',
                active: true,
                activeAt: 20,
                metadata: { host: 'target.local' },
            },
        };
        mockStorageState.getProjectForSession = (sessionId: string) =>
            sessionId === 'session-1'
                ? {
                    key: {
                        machineId: 'machine-target',
                        path: '/Users/test/workspace/live',
                    },
                }
                : null;

        expect(getSessionSubtitle(session)).toBe('~/workspace/live');
    });

    it('uses the reachable target machine and base path for session avatar ids when metadata is stale after handoff', async () => {
        const { getSessionAvatarId } = await import('./sessionUtils');

        const session = createBaseSession({
            id: 'session-1',
            metadata: {
                machineId: 'machine-stale',
                path: '/Users/test/workspace/stale',
                homeDir: '/Users/test',
                host: 'stale.local',
            } as Session['metadata'],
        });

        mockStorageState.sessions = {
            'session-1': {
                active: true,
                updatedAt: 10,
                metadata: session.metadata,
            },
        };
        mockStorageState.machines = {
            'machine-target': {
                id: 'machine-target',
                active: true,
                activeAt: 20,
                metadata: { host: 'target.local' },
            },
        };
        mockStorageState.getProjectForSession = (sessionId: string) =>
            sessionId === 'session-1'
                ? {
                    key: {
                        machineId: 'machine-target',
                        path: '/Users/test/workspace/live',
                    },
                }
                : null;

        expect(getSessionAvatarId(session)).toBe('machine-target:/Users/test/workspace/live');
    });
});
