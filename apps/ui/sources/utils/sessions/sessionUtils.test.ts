import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
    CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
} from '@happier-dev/plugins-claude/agent/permissions/requestSource';
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionAccessFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMessagesFixture, createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { getServerUrl, setServerUrl } from '@/sync/domains/server/serverConfig';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import type { ToolCall, ToolCallMessage } from "@happier-dev/session-core/messages";
import type { SessionMessages } from '@/sync/store/domains/messages';
import type { PendingMessage, Session } from '@/sync/domains/state/storageTypes';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                status: {
                    connected: '#11AA11',
                    connecting: '#2222AA',
                    actionRequired: '#AA7722',
                    disconnected: '#666666',
                    error: '#CC3333',
                    default: '#555555',
                },
            },
        },
    });
});

let previousState: ReturnType<typeof storage.getState>;
let previousServerUrl: string;

beforeAll(async () => {
    previousServerUrl = getServerUrl();
    await setServerUrl('https://session-utils.example.test');
});
afterAll(async () => { await setServerUrl(previousServerUrl || null); });
beforeEach(() => {
    previousState = storage.getState();
    storage.setState({
        sessions: {}, machines: {}, machineListByServerId: {}, sessionListRowsByServerId: {},
        sessionMessages: {}, sessionPending: {},
    });
    projectManager.clear();
});
afterEach(async () => {
    await standardCleanup();
    storage.setState(previousState, true);
    projectManager.clear();
});

function seedTranscriptFixtures(fixtures: Record<string, Partial<SessionMessages> & {
    messages?: Array<Omit<ToolCallMessage, 'tool'> & { tool: Partial<ToolCall> }>;
}>) {
    storage.setState({ sessionMessages: Object.fromEntries(Object.entries(fixtures).map(([id, fixture]) => {
        const { messages, ...state } = fixture;
        if (!messages) return [id, createSessionMessagesFixture(state)];
        const normalized = messages.map((message) => createToolCallMessageFixture({
            ...message,
            tool: { name: 'tool', state: 'running', input: {}, createdAt: message.createdAt,
                startedAt: null, completedAt: null, description: null, ...message.tool },
        }));
        return [id, createSessionMessagesFixture({
            ...state,
            messageIdsOldestFirst: normalized.map((message) => message.id),
            messagesById: Object.fromEntries(normalized.map((message) => [message.id, message])),
        })];
    })) });
}

function setWorkingTextAnimation(enabled: boolean) {
    storage.setState((state) => ({
        settings: { ...state.settings, sessionListWorkingStatusAnimatedTextEnabled: enabled },
    }));
}

describe('nullable static session presentation', () => {
    it('keeps an unbound presenter inert and uses canonical static work copy when it binds', async () => {
        const { useSessionStatus } = await import('./sessionUtils');
        setWorkingTextAnimation(true);
        const session = createSessionListRenderableSessionFixture({
            id: 'voice-work', encryptionMode: 'plain', active: true, activeAt: Date.now(),
            presence: 'online', thinking: true, thinkingAt: Date.now(),
        });
        const hook = await renderHook(({ bound }: { bound: boolean }) => useSessionStatus(bound ? session : null, {
            workingTextMode: 'static', subscribeToSession: false, subscribeToTranscript: false,
        }), { initialProps: { bound: false } });
        expect(hook.getCurrent()).toBeNull();
        await hook.rerender({ bound: true });
        expect(hook.getCurrent()).toMatchObject({ state: 'thinking', statusText: 'status.working' });
        await hook.unmount();
    });
});

function seedDisplayTargetSession(session: Session, path: string) {
    const serverId = getActiveServerSnapshot().serverId;
    storage.setState({
        sessions: { [session.id]: { ...session, serverId, metadata: {
            ...session.metadata!, machineId: 'machine-target', path,
        } } },
        machines: { 'machine-target': createMachineFixture({ id: 'machine-target' }) },
    });
}

function createBaseSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 's1',
        encryptionMode: 'plain',
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

function createPendingUserMessage(overrides: Partial<PendingMessage> = {}): PendingMessage {
    return {
        id: 'pending-first-turn',
        localId: 'pending-first-turn',
        createdAt: 999_000,
        updatedAt: 999_000,
        source: 'local_outbound',
        deliveryStatus: 'queued',
        text: 'Start here',
        displayText: 'Start here',
        rawRecord: {
            role: 'user',
            content: { type: 'text', text: 'Start here' },
            meta: {},
        },
        ...overrides,
    };
}

describe('getSessionStatus', () => {
    it.each([
        ['encrypted_access_pending', 'access_pending'],
        ['recipient_encryption_setup_required', 'setup_required'],
        ['encrypted_access_needs_repair', 'repair_needed'],
        ['encrypted_content_unavailable', 'content_unavailable'],
        [undefined, 'unknown'],
    ] as const)('keeps %s visible without working motion', async (encryptedContentAvailability, state) => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({ encryptionMode: 'e2ee', encryptedContentAvailability,
            metadata: null, latestTurnStatus: 'in_progress', activeAt: 1_000 });
        expect(getSessionStatus(session, 1_000)).toMatchObject({ state, isPulsing: false, shouldShowStatus: true });
    });
    it('stops working motion while the runtime observation is stale', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({ activeAt: 1, latestTurnStatus: 'in_progress' });
        expect(getSessionStatus(session, 200_000)).toMatchObject({ state: 'stale', isPulsing: false });
    });

    it('returns disconnected when presence is not online', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({ presence: 123 });
        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('disconnected');
        expect(status.isConnected).toBe(false);
        expect(status.shouldShowStatus).toBe(true);
    });

    it('surfaces recoverable session-control unserviceability without Runtime Activity state', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({
            active: false,
            presence: 123,
            metadata: {
                path: '/repo', host: 'local',
                terminal: {
                    mode: 'tmux', tmux: { target: 'happy:win-1' },
                    controlServiceabilityV1: { v: 1, state: 'recoverable_unservable', observedAt: 456 },
                },
            },
        });
        expect(getSessionStatus(session, 1_000, 0)).toMatchObject({
            state: 'recoverable_unservable', isConnected: false, shouldShowStatus: true,
        });
    });

    it('does not read private terminal control state from layout-v1 shared metadata', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                terminalControlServiceabilityV1: {
                    v: 1,
                    state: 'recoverable_unservable',
                    observedAt: 456,
                },
            } as unknown as Session['metadata'],
            ownerMetadataView: null,
        });

        expect(getSessionStatus(session, 1_000, 0).state).toBe('waiting');
    });

    it('formats last-seen without throwing when activeAt is missing or invalid', async () => {
        const { formatLastSeen } = await import('./sessionUtils');

        // Sessions can reach the disconnected status line without a usable
        // activeAt; the formatter must degrade instead of rendering garbage
        // (or crashing once the date formatting path throws on invalid dates).
        expect(() => formatLastSeen(undefined as unknown as number)).not.toThrow();
        expect(() => formatLastSeen(Number.NaN)).not.toThrow();
        expect(() => formatLastSeen(0)).not.toThrow();
        expect(typeof formatLastSeen(undefined as unknown as number)).toBe('string');
        expect(formatLastSeen(undefined as unknown as number).length).toBeGreaterThan(0);
        expect(formatLastSeen(undefined as unknown as number)).not.toContain('Invalid');
    });

    it('returns permission_required when the agent has pending requests', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: { tool: 'tool', arguments: {}, createdAt: 900 },
                },
                completedRequests: null,
            },
        });
        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('permission_required');
        expect(status.isConnected).toBe(true);
        expect(status.shouldShowStatus).toBe(true);
    });

    it('returns permission_required when pending transcript requests only exist in the registered storage state', async () => {
        const { getSessionStatus } = await import('./sessionUtils');

        seedTranscriptFixtures({
            s1: {
                messages: [
                    {
                        kind: 'tool-call',
                        id: 'm-tool-1',
                        localId: null,
                        createdAt: 10,
                        children: [],
                        tool: {
                            id: 'req1',
                            name: 'writeTextFile',
                            state: 'running',
                            input: { path: '/tmp/test.txt' },
                            createdAt: 10,
                            permission: {
                                id: 'req1',
                                status: 'pending',
                                kind: 'permission',
                            },
                        },
                    },
                ],
                messagesVersion: 1,
            },
        });
        const session = createBaseSession({
            agentState: {
                controlledByUser: null,
                requests: {},
                completedRequests: null,
            },
        });

        const status = getSessionStatus(session, 1_000, 0);

        expect(status.state).toBe('permission_required');
        expect(status.isConnected).toBe(true);
    });

    it('does not surface permission_required when a session is inactive (even if stale pending flags exist)', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const status = getSessionStatus({
            id: 's-renderable',
            encryptionMode: 'plain',
            seq: 1,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            archivedAt: null,
            pendingVersion: 0,
            pendingCount: 0,
            metadataVersion: 0,
            agentStateVersion: 0,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            accessLevel: undefined,
            canApprovePermissions: undefined,
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        } as any, 1_000, 0);

        expect(status.state).toBe('waiting');
    });

    it('uses the current theme status colors in the status hook', async () => {
        const { useSessionStatus } = await import('./sessionUtils');
        const hook = await renderHook(() => useSessionStatus(createBaseSession({
            thinking: true,
            thinkingAt: Date.now(),
        })));

        expect(hook.getCurrent()).toMatchObject({
            state: 'thinking',
            statusColor: '#2222AA',
            statusDotColor: '#2222AA',
            isPulsing: true,
        });
    });

    it('uses static working text in the status hook when animated working text is disabled', async () => {
        setWorkingTextAnimation(false);
        const { useSessionStatus } = await import('./sessionUtils');
        const hook = await renderHook(() => useSessionStatus(createBaseSession({
            thinking: true,
            thinkingAt: Date.now(),
        })));

        expect(hook.getCurrent()).toMatchObject({
            state: 'thinking',
            statusText: 'status.working',
        });
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

    it('does not surface action_required when a session is inactive (even if stale pending flags exist)', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const status = getSessionStatus({
            id: 's-renderable',
            encryptionMode: 'plain',
            seq: 1,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            archivedAt: null,
            pendingVersion: 0,
            pendingCount: 0,
            metadataVersion: 0,
            agentStateVersion: 0,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            accessLevel: undefined,
            canApprovePermissions: undefined,
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: true,
        } as any, 1_000, 0);

        expect(status.state).toBe('waiting');
    });

    it('does not return resuming for inactive sessions with only an optimistic prompt', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const status = getSessionStatus(createBaseSession({
            active: false,
            presence: 'online',
            optimisticThinkingAt: 1_000,
        }), 1_100, 0);

        expect(status.state).toBe('waiting');
        expect(status.shouldShowStatus).toBe(false);
        expect(status.isPulsing).toBeFalsy();
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

    it('does not return action_required when transcript marks the same request as canceled', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({
            id: 's-transcript-canceled',
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: { q: 'continue?' },
                        createdAt: 100,
                    },
                },
                completedRequests: null,
            },
        });

        seedTranscriptFixtures({
            's-transcript-canceled': {
                messages: [
                    {
                        kind: 'tool-call',
                        id: 'm-tool-1',
                        localId: null,
                        createdAt: 100,
                        children: [],
                        tool: {
                            id: 'req1',
                            name: 'AskUserQuestion',
                            state: 'error',
                            input: { q: 'continue?' },
                            createdAt: 100,
                            completedAt: 101,
                            permission: {
                                id: 'req1',
                                status: 'canceled',
                                kind: 'user_action',
                            },
                        },
                    },
                ],
                messagesVersion: 1,
            },
        });

        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('waiting');
    });

    it('does not return action_required when agentState user_action requests are stale relative to completedRequests', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: { q: 'continue?' },
                        createdAt: 100,
                    },
                },
                completedRequests: {
                    req1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: { q: 'continue?' },
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

    it('does not return action_required when a generated local-bridge request is covered by a recent canonical cancellation', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const question = { questions: [{ question: 'How should I proceed?', options: [{ label: 'Continue' }] }] };
        const session = createBaseSession({
            thinking: true,
            thinkingAt: 900,
            agentState: {
                controlledByUser: null,
                requests: {
                    perm_generated: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: question,
                        createdAt: 10_500,
                        source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
                    },
                },
                completedRequests: {
                    toolu_canonical: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: question,
                        createdAt: 1_000,
                        completedAt: 10_000,
                        status: 'canceled',
                        reason: CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
                        source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
                    },
                },
            },
        });

        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('thinking');
    });

    it('returns thinking when session.thinking is fresh', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({ thinking: true, thinkingAt: 900 });
        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('thinking');
        expect(status.isConnected).toBe(true);
        expect(status.shouldShowStatus).toBe(true);
        expect(status.isPulsing).toBe(true);
    });

    it('returns static translated working text when requested by list row callers', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({ thinking: true, thinkingAt: 900 });
        const status = getSessionStatus(session, 1_000, {
            vibingIndex: 0,
            workingTextMode: 'static',
        });

        expect(status.state).toBe('thinking');
        expect(status.statusText).toBe('status.working');
    });

    it('uses caller-provided status colors when resolving session status', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({ thinking: true, thinkingAt: 900 });
        const status = getSessionStatus(session, 1_000, {
            workingTextMode: 'static',
            statusColors: {
                connected: '#connected',
                connecting: '#connecting',
                actionRequired: '#action',
                disconnected: '#disconnected',
                error: '#error',
                default: '#default',
            },
        });

        expect(status.statusColor).toBe('#connecting');
        expect(status.statusDotColor).toBe('#connecting');
    });

    it('uses a neutral color token and distinct label for background activity', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: now - 10_000,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: now - 1_000,
            runtimeActivityRevision: now + 60_000,
        });

        const status = getSessionStatus(session, now, {
            workingTextMode: 'static',
            statusColors: {
                connected: '#connected',
                connecting: '#connecting',
                actionRequired: '#action',
                disconnected: '#disconnected',
                error: '#error',
                default: '#default',
            },
        });

        expect(status.state).toBe('background_active');
        expect(status.statusText).toBe('status.backgroundActive');
        expect(status.shouldShowStatus).toBe(true);
        expect(status.statusColor).toBe('#default');
        expect(status.statusDotColor).toBe('#default');
        expect(status.isPulsing).toBe(false);
    });

    it('does not return thinking when session.thinking is stale', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({
            thinking: true,
            thinkingAt: 1_000,
        });
        const status = getSessionStatus(session, 130_001, 0);
        expect(status.state).toBe('waiting');
    });

    it('returns thinking when the latest primary turn is fresh in progress', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 900,
            thinking: false,
        });
        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('thinking');
        expect(status.isPulsing).toBe(true);
    });

    it('retains canonical in-progress work until a terminal update when runtime freshness is unknown', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_000,
            thinking: false,
        });
        const status = getSessionStatus(session, 130_001, 0);
        expect(status.state).toBe('thinking');
    });

    it('clears stale thinking after a completed primary turn projection', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = {
            ...createBaseSession({
                latestTurnStatus: 'completed',
                meaningfulActivityAt: 500,
                thinking: true,
                optimisticThinkingAt: 999,
                thinkingGraceUntil: 2_000,
            }),
            latestTurnStatusObservedAt: 1_000,
        };
        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('ready');
        expect(status.shouldShowStatus).toBe(true);
        expect(status.isPulsing).toBe(false);
    });

    it('does not keep active sessions working when only meaningful activity is newer than the completed turn projection', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = {
            ...createBaseSession({
                active: true,
                presence: 'online',
                meaningfulActivityAt: 1_500,
                thinking: false,
                latestTurnStatus: 'completed',
            }),
            latestTurnStatusObservedAt: 1_000,
        };
        const status = getSessionStatus(session, 1_600, 0);
        expect(status.state).toBe('ready');
        expect(status.shouldShowStatus).toBe(true);
        expect(status.isPulsing).toBe(false);
    });

    it('does not let sourceClass turn provider runtime activity into foreground work', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({
            active: true,
            presence: 'online',
            thinking: false,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now - 10_000,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: now - 1_000,
            runtimeActivityRevision: now + 60_000,
        });

        const status = getSessionStatus(session, now, 0);

        expect(status.state).toBe('ready');
        expect(status.isPulsing).toBe(false);
        expect(status.awareness?.runtime).toBe('background_active');
    });

    it('keeps offline precedence over provider runtime activity', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;

        expect(getSessionStatus(createBaseSession({
            active: false,
            presence: now - 10_000,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
        }), now, { workingTextMode: 'static' })).toMatchObject({
            state: 'disconnected',
            isConnected: false,
        });
    });

    it('suppresses provider runtime activity status for archived sessions', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;

        expect(getSessionStatus(createBaseSession({
            archivedAt: now - 1,
            resumingAt: now - 2,
            pendingUserActionRequestCount: 1,
            pendingRequestObservedAt: now - 2,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
        }), now, { workingTextMode: 'static' })).toMatchObject({
            state: 'waiting',
            shouldShowStatus: false,
        });
    });

    it('ignores stale provider runtime activity after a completed foreground turn', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({
            active: true,
            presence: 'online',
            thinking: false,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now - 10_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: now - 300_000,
            runtimeActivityRevision: now - 1,
        });

        const status = getSessionStatus(session, now, 0);

        expect(status.state).toBe('ready');
        expect(status.shouldShowStatus).toBe(true);
        expect(status.isPulsing).toBe(false);
    });

    it('does not use legacy thinking after an older completed turn projection', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = {
            ...createBaseSession({
                active: true,
                presence: 'online',
                thinking: true,
                thinkingAt: 1_500,
                latestTurnStatus: 'completed',
            }),
            latestTurnStatusObservedAt: 1_000,
        };
        const status = getSessionStatus(session, 1_600, 0);
        expect(status.state).toBe('ready');
        expect(status.shouldShowStatus).toBe(true);
        expect(status.isPulsing).toBe(false);
    });

    it('does not return thinking when optimisticThinkingAt is recent', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({ optimisticThinkingAt: now - 1_000 });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('waiting');
    });

    it('returns thinking when a recent optimistic send still has a pending outbound user message', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({ optimisticThinkingAt: now - 1_000 });
        const status = getSessionStatus(session, now, {
            workingTextMode: 'static',
            hasPendingUserMessages: true,
        });
        expect(status.state).toBe('thinking');
        expect(status.statusText).toBe('status.working');
        expect(status.shouldShowStatus).toBe(true);
    });

    it('does not return resuming when an inactive session only has recent optimistic send activity', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({
            active: false,
            presence: now - 10_000,
            optimisticThinkingAt: now - 1_000,
        });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('disconnected');
        expect(status.shouldShowStatus).toBe(true);
        expect(status.isPulsing).toBeFalsy();
    });

    it('returns one shared resuming state while the explicit resume lifecycle marker is fresh', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const status = getSessionStatus(createBaseSession({
            active: true,
            presence: 'online',
            resumingAt: now - 5_000,
        }), now, 0);

        expect(status).toMatchObject({
            state: 'resuming',
            isConnected: true,
            isPulsing: true,
        });
    });

    it('keeps the explicit resuming lifecycle visible through the temporary offline attach gap', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const status = getSessionStatus(createBaseSession({
            active: false,
            presence: now - 10_000,
            resumingAt: now - 5_000,
        }), now, 0);

        expect(status).toMatchObject({
            state: 'resuming',
            isConnected: false,
            isPulsing: false,
        });
    });

    it('trusts the store-owned resuming marker instead of independently aging it out', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const status = getSessionStatus(createBaseSession({
            active: false,
            presence: now - 10_000,
            resumingAt: now - 30_001,
        }), now, 0);

        expect(status).toMatchObject({
            state: 'resuming',
            isConnected: false,
            isPulsing: false,
        });
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

    it('does not return thinking when only thinkingGraceUntil is in the future', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({ thinkingGraceUntil: now + 1_000 });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('waiting');
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
            thinkingAt: 900,
            agentState: {
                controlledByUser: false,
                requests: {
                    req1: { tool: 'tool', arguments: {}, createdAt: 900 },
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
            thinkingAt: 900,
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
    it('returns an empty list when the session is inactive', async () => {
        const { listPendingPermissionRequests } = await import('./sessionUtils');
        const session = createBaseSession({
            active: false,
            presence: 123,
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: { tool: 'Bash', arguments: { command: 'ls' }, createdAt: 5 },
                },
                completedRequests: null,
            },
        });

        expect(listPendingPermissionRequests(session)).toEqual([]);
    });

    it('returns an empty list when session.active is missing/unknown (conservative)', async () => {
        const { listPendingPermissionRequests } = await import('./sessionUtils');
        const session = createBaseSession({
            active: undefined as any,
            presence: 'online',
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: { tool: 'Bash', arguments: { command: 'ls' }, createdAt: 5 },
                },
                completedRequests: null,
            },
        });

        expect(listPendingPermissionRequests(session)).toEqual([]);
    });

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
            active: false,
            presence: 123,
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
        ] as any)).toEqual([]);
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

        seedTranscriptFixtures({
            ...storage.getState().sessionMessages,
            's-transcript-perm-normalized': {
                messageIdsOldestFirst: ['m-tool-1'],
                messagesById: {
                    'm-tool-1': transcriptMessage,
                },
                messagesMap: {
                    'm-tool-1': transcriptMessage,
                },
            } as any,
        });

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

    it('trusts zero projected pending request counts instead of scanning stored transcript tool calls', async () => {
        const { listPendingPermissionRequests } = await import('./sessionUtils');
        const session = createBaseSession({
            id: 's-zero-projected-pending-counts',
            agentState: null,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
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
                input: { command: 'printf stale > stale.txt' },
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

        seedTranscriptFixtures({
            ...storage.getState().sessionMessages,
            's-zero-projected-pending-counts': {
                messageIdsOldestFirst: ['m-tool-1'],
                messagesById: {
                    'm-tool-1': transcriptMessage,
                },
                messagesMap: {
                    'm-tool-1': transcriptMessage,
                },
            } as any,
        });

        expect(listPendingPermissionRequests(session)).toEqual([]);
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

describe('listPendingUserActionRequests', () => {
    it('does not return requests that are terminal in the transcript even if agentState.requests still contains them', async () => {
        const { listPendingUserActionRequests } = await import('./sessionUtils');
        const session = createBaseSession({
            id: 's-terminal-transcript',
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: { q: 'continue?' },
                        createdAt: 100,
                    },
                },
                completedRequests: null,
            },
        });

        expect(listPendingUserActionRequests(session, [
            {
                kind: 'tool-call',
                id: 'm-tool-1',
                localId: null,
                createdAt: 100,
                children: [],
                tool: {
                    id: 'req1',
                    name: 'AskUserQuestion',
                    state: 'error',
                    input: { q: 'continue?' },
                    createdAt: 100,
                    completedAt: 101,
                    permission: {
                        id: 'req1',
                        status: 'canceled',
                        kind: 'user_action',
                    },
                },
            } as any,
        ])).toEqual([]);
    });

    it('keeps requests pending when the transcript only shows a synthetic Request interrupted placeholder', async () => {
        const { listPendingUserActionRequests } = await import('./sessionUtils');
        const session = createBaseSession({
            id: 's-interrupted-transcript',
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: { q: 'continue?' },
                        createdAt: 100,
                    },
                },
                completedRequests: null,
            },
        });

        expect(listPendingUserActionRequests(session, [
            {
                kind: 'tool-call',
                id: 'm-tool-1',
                localId: null,
                createdAt: 100,
                children: [],
                tool: {
                    id: 'req1',
                    name: 'AskUserQuestion',
                    state: 'error',
                    input: { q: 'continue?' },
                    createdAt: 100,
                    completedAt: 101,
                    result: { error: 'Request interrupted' },
                    permission: {
                        id: 'req1',
                        status: 'canceled',
                        kind: 'user_action',
                        reason: 'Request interrupted',
                    },
                },
            } as any,
        ])).toEqual([
            expect.objectContaining({
                id: 'req1',
                tool: 'AskUserQuestion',
                kind: 'user_action',
                arguments: { q: 'continue?' },
                createdAt: 100,
            }),
        ]);
    });

    it('keeps requests pending when a local Request interrupted placeholder carries an abort decision', async () => {
        const { listPendingUserActionRequests } = await import('./sessionUtils');
        const session = createBaseSession({
            id: 's-aborted-transcript',
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: { q: 'continue?' },
                        createdAt: 100,
                    },
                },
                completedRequests: null,
            },
        });

        expect(listPendingUserActionRequests(session, [
            {
                kind: 'tool-call',
                id: 'm-tool-1',
                localId: null,
                createdAt: 100,
                children: [],
                tool: {
                    id: 'req1',
                    name: 'AskUserQuestion',
                    state: 'error',
                    input: { q: 'continue?' },
                    createdAt: 100,
                    completedAt: 101,
                    result: { error: 'Request interrupted' },
                    permission: {
                        id: 'req1',
                        status: 'canceled',
                        kind: 'user_action',
                        reason: 'Request interrupted',
                        decision: 'abort',
                    },
                },
            } as any,
        ])).toEqual([
            expect.objectContaining({
                id: 'req1',
                tool: 'AskUserQuestion',
                kind: 'user_action',
                arguments: { q: 'continue?' },
                createdAt: 100,
            }),
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

describe('useSessionStatus', () => {
    it('uses a fresh local pending message as the optimistic first-turn status after delayed session hydration', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        try {
            setWorkingTextAnimation(false);
            storage.setState({ sessions: {
                's-first-turn-late-hydration': createBaseSession({
                    id: 's-first-turn-late-hydration',
                    optimisticThinkingAt: null,
                }),
            } });
            storage.setState({ sessionPending: {
                's-first-turn-late-hydration': {
                    messages: [
                        createPendingUserMessage({
                            id: 'pending-first-turn',
                            localId: 'pending-first-turn',
                            createdAt: Date.now() - 1_000,
                            updatedAt: Date.now() - 1_000,
                            source: 'local_outbound',
                            deliveryStatus: 'queued',
                        }),
                    ],
                    discarded: [],
                    isLoaded: false,
                },
            } });

            const { useSessionStatus } = await import('./sessionUtils');
            const hook = await renderHook(() => useSessionStatus(createBaseSession({
                id: 's-first-turn-late-hydration',
                optimisticThinkingAt: null,
            })));

            expect(hook.getCurrent()).toMatchObject({
                state: 'thinking',
                statusText: 'status.working',
                shouldShowStatus: true,
                isPulsing: true,
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not use old server pending messages as optimistic working evidence', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        try {
            storage.setState({ sessions: {
                's-server-pending': createBaseSession({
                    id: 's-server-pending',
                    optimisticThinkingAt: null,
                }),
            } });
            storage.setState({ sessionPending: {
                's-server-pending': {
                    messages: [
                        createPendingUserMessage({
                            id: 'server-pending',
                            localId: 'server-pending',
                            createdAt: Date.now() - 1_000,
                            updatedAt: Date.now() - 1_000,
                            source: 'server_pending',
                            deliveryStatus: 'queued',
                        }),
                    ],
                    discarded: [],
                    isLoaded: true,
                },
            } });

            const { useSessionStatus } = await import('./sessionUtils');
            const hook = await renderHook(() => useSessionStatus(createBaseSession({
                id: 's-server-pending',
                optimisticThinkingAt: null,
            })));

            expect(hook.getCurrent().state).toBe('pending_input');
        } finally {
            vi.useRealTimers();
        }
    });

    it('exposes working status for a pending first turn from session pending storage', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        try {
            setWorkingTextAnimation(false);
            storage.setState({ sessions: {
                's-first-turn': createBaseSession({
                    id: 's-first-turn',
                    optimisticThinkingAt: Date.now() - 1_000,
                }),
            } });
            storage.setState({ sessionPending: {
                's-first-turn': {
                    messages: [
                        createPendingUserMessage({
                            id: 'pending-first-turn',
                            localId: 'pending-first-turn',
                            createdAt: Date.now() - 1_000,
                            updatedAt: Date.now() - 1_000,
                        }),
                    ],
                    discarded: [],
                    isLoaded: false,
                },
            } });

            const { useSessionStatus } = await import('./sessionUtils');
            const hook = await renderHook(() => useSessionStatus(createBaseSession({
                id: 's-first-turn',
                optimisticThinkingAt: Date.now() - 1_000,
            })));

            expect(hook.getCurrent()).toMatchObject({
                state: 'thinking',
                statusText: 'status.working',
                shouldShowStatus: true,
                isPulsing: true,
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('uses pending status-source counts when transcript subscriptions are skipped', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        try {
            setWorkingTextAnimation(false);
            const { useSessionStatus } = await import('./sessionUtils');
            const hook = await renderHook(() => useSessionStatus({
                ...createBaseSession({
                    id: 's-runtime-source-pending',
                    optimisticThinkingAt: Date.now() - 1_000,
                }),
                pendingCount: 1,
            } as any, {
                subscribeToSession: false,
                subscribeToTranscript: false,
            }));

            expect(hook.getCurrent()).toMatchObject({
                state: 'thinking',
                statusText: 'status.working',
                shouldShowStatus: true,
                isPulsing: true,
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('refreshes when fresh thinking expires without a storage update', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        try {
            const { useSessionStatus, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } = await import('./sessionUtils');
            const thinkingAt = Date.now() - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 5;
            const hook = await renderHook(() => useSessionStatus(createBaseSession({
                thinking: true,
                thinkingAt,
            })));

            expect(hook.getCurrent().state).toBe('thinking');

            await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 5 });

            expect(hook.getCurrent().state).toBe('waiting');
        } finally {
            vi.useRealTimers();
        }
    });

    it('arms every later expiration, not only the first, from unchanged session facts', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        try {
            const { useSessionStatus, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } = await import('./sessionUtils');
            // Immutable facts: the two deadlines below are the only things that change.
            const thinkingAt = Date.now() - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 5;
            const activeAt = Date.now() - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 1_005;
            const hook = await renderHook(() => useSessionStatus(createBaseSession({
                thinking: true,
                thinkingAt,
                activeAt,
            })));

            expect(hook.getCurrent().state).toBe('thinking');

            await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 5 });
            expect(hook.getCurrent().state).toBe('waiting');

            await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1_002 });
            expect(hook.getCurrent().state).toBe('stale');
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not expire a canonical in-progress projection without a terminal update', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        try {
            const { useSessionStatus, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } = await import('./sessionUtils');
            const latestTurnStatusObservedAt = Date.now() - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 5;
            const hook = await renderHook(() => useSessionStatus(createBaseSession({
                thinking: false,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt,
            })));

            expect(hook.getCurrent().state).toBe('thinking');

            await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 5 });

            expect(hook.getCurrent().state).toBe('thinking');
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps a canonical in-progress projection working regardless of presence heartbeat age', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        try {
            const { useSessionStatus, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } = await import('./sessionUtils');
            const activeAt = Date.now() - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 5;
            const hook = await renderHook(() => useSessionStatus(createBaseSession({
                activeAt,
                thinking: false,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: Date.now() - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            })));

            expect(hook.getCurrent().state).toBe('thinking');
        } finally {
            vi.useRealTimers();
        }
    });

    it('shows stale status without motion when runtime heartbeat has expired', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        try {
            const { useSessionStatus, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } = await import('./sessionUtils');
            const hook = await renderHook(() => useSessionStatus(createBaseSession({
                activeAt: Date.now() - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
                thinking: false,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: Date.now() - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
                meaningfulActivityAt: Date.now() - 5,
            })));

            expect(hook.getCurrent().state).toBe('stale');
            expect(hook.getCurrent().isPulsing).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('expires stale permission presentation without erasing the unresolved request', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        try {
            const { useSessionStatus, listPendingPermissionRequests, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } = await import('./sessionUtils');
            const createdAt = Date.now() - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 5;
            const session = createBaseSession({
                agentState: {
                    controlledByUser: null,
                    requests: {
                        req1: { tool: 'Bash', arguments: {}, createdAt },
                    },
                    completedRequests: null,
                },
            });
            const hook = await renderHook(() => useSessionStatus(session));

            expect(hook.getCurrent().state).toBe('permission_required');

            await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 5 });

            expect(hook.getCurrent().state).toBe('waiting');
            expect(listPendingPermissionRequests(session)).toEqual([
                expect.objectContaining({ id: 'req1', tool: 'Bash', createdAt }),
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('reschedules optimistic pending expiry when a newer local pending message replaces the previous one', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        try {
            const { useSessionStatus, OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS } = await import('./sessionUtils');
            const initialCreatedAt = Date.now() - OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS + 100;
            const refreshedCreatedAt = Date.now() - OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS + 500;
            storage.setState({ sessions: {
                's-replaced-local-pending': createBaseSession({
                    id: 's-replaced-local-pending',
                    optimisticThinkingAt: null,
                }),
            } });
            storage.setState({ sessionPending: {
                's-replaced-local-pending': {
                    messages: [
                        createPendingUserMessage({
                            id: 'pending-first-turn',
                            localId: 'pending-first-turn',
                            createdAt: initialCreatedAt,
                            updatedAt: initialCreatedAt,
                            source: 'local_outbound',
                        }),
                    ],
                    discarded: [],
                    isLoaded: false,
                },
            } });

            const hook = await renderHook(() => useSessionStatus(createBaseSession({
                id: 's-replaced-local-pending',
                optimisticThinkingAt: null,
            })));
            expect(hook.getCurrent().state).toBe('thinking');

            await act(async () => { storage.setState({ sessionPending: {
                's-replaced-local-pending': {
                    messages: [
                        createPendingUserMessage({
                            id: 'pending-replacement',
                            localId: 'pending-replacement',
                            createdAt: refreshedCreatedAt,
                            updatedAt: refreshedCreatedAt,
                            source: 'local_outbound',
                        }),
                    ],
                    discarded: [],
                    isLoaded: false,
                },
            } }); });
            await hook.rerender();

            await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 100 });
            expect(hook.getCurrent().state).toBe('thinking');

            await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 400 });
            expect(hook.getCurrent().state).toBe('pending_input');
        } finally {
            vi.useRealTimers();
        }
    });

    it('uses the raw session state when a renderable session still has stale pending flags', async () => {
        const { useSessionStatus } = await import('./sessionUtils');

        storage.setState({ sessions: {
            's-renderable-stale': createBaseSession({
                id: 's-renderable-stale',
                agentState: {
                    controlledByUser: null,
                    requests: {
                        req1: {
                            tool: 'AskUserQuestion',
                            kind: 'user_action',
                            arguments: { q: 'continue?' },
                            createdAt: 100,
                        },
                    },
                    completedRequests: null,
                },
            }),
        } });
        seedTranscriptFixtures({
            's-renderable-stale': {
                messages: [
                    {
                        kind: 'tool-call',
                        id: 'm-tool-1',
                        localId: null,
                        createdAt: 100,
                        children: [],
                        tool: {
                            id: 'req1',
                            name: 'AskUserQuestion',
                            state: 'error',
                            input: { q: 'continue?' },
                            createdAt: 100,
                            completedAt: 101,
                            permission: {
                                id: 'req1',
                                status: 'canceled',
                                kind: 'user_action',
                            },
                        },
                    },
                ],
                messagesVersion: 1,
            },
        });

        const hook = await renderHook(() => useSessionStatus({
            id: 's-renderable-stale',
            seq: 1,
            createdAt: 0,
            updatedAt: 0,
            active: true,
            activeAt: 0,
            archivedAt: null,
            pendingVersion: 0,
            pendingCount: 0,
            metadataVersion: 0,
            agentStateVersion: 0,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            accessLevel: undefined,
            canApprovePermissions: undefined,
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: true,
        } as any));

        expect(hook.getCurrent().state).toBe('waiting');
    });

    it('can skip transcript-version subscriptions for session-list rows', async () => {
        const { useSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({
            id: 's-list-row',
            active: true,
            thinking: true,
            thinkingAt: Date.now(),
            presence: 'online',
        });
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useSessionStatus(session, { subscribeToTranscript: false });
        });

        expect(hook.getCurrent().state).toBe('thinking');
        const initialRenders = renders;
        await act(async () => {
            seedTranscriptFixtures({ 's-list-row': { messagesVersion: 1 } });
        });
        expect(renders).toBe(initialRenders);
    });

    it('can skip full-session subscriptions for session-list rows', async () => {
        const { useSessionStatus } = await import('./sessionUtils');

        storage.setState({ sessions: {
            's-list-row': createBaseSession({
                id: 's-list-row',
                active: true,
                thinking: true,
                thinkingAt: 1_000,
                updatedAt: 1_000,
                presence: 'online',
            }),
        } });

        const session = createBaseSession({
            id: 's-list-row',
            active: true,
            thinking: false,
            thinkingAt: 0,
            updatedAt: 0,
            presence: 'online',
        });
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useSessionStatus(session, {
                subscribeToSession: false,
                subscribeToTranscript: false,
            });
        });

        expect(hook.getCurrent().state).toBe('waiting');
        const initialRenders = renders;
        await act(async () => {
            storage.setState({ sessions: { 's-list-row': { ...session, thinking: true, thinkingAt: Date.now() } } });
        });
        expect(hook.getCurrent().state).toBe('waiting');
        expect(renders).toBe(initialRenders);
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

    it('returns false for resuming sessions before the provider process is attached', async () => {
        const { shouldShowAbortButtonForSessionState } = await import('./sessionUtils');
        expect(shouldShowAbortButtonForSessionState('resuming')).toBe(false);
    });

    it('returns false for background-only activity', async () => {
        const { shouldShowAbortButtonForSessionState } = await import('./sessionUtils');
        expect(shouldShowAbortButtonForSessionState('background_active')).toBe(false);
    });
});

describe('getSessionCarriedLine', () => {
    it('says a carried Session\'s state, then where it works, on one line (DnD lab C2 carried card)', async () => {
        const { getSessionCarriedLine, getSessionStatus } = await import('./sessionUtils');
        const row = createSessionListRenderableSessionFixture({ metadata: {
            path: '/Users/alice/projects/payments', homeDir: '/Users/alice', machineId: 'work-mac', host: 'MacBook Pro',
        } });
        const status = getSessionStatus(row);
        const line = getSessionCarriedLine(row);
        expect(line).toContain('MacBook Pro');
        expect(line).not.toContain('/projects/');
        // An idle, reachable Session's state is not news; any other state leads the line.
        if (status.quiet) expect(line).not.toContain(status.statusText);
        else expect(line?.startsWith(`${status.statusText} · `)).toBe(true);
    });
});

describe('getSessionName', () => {
    it('presents work identity from the named machine, then the workspace owner, without an unknown placeholder', async () => {
        const { getSessionWorkContext } = await import('./sessionUtils');
        const row = createSessionListRenderableSessionFixture({ metadata: {
            path: '/Users/alice/projects/payments', homeDir: '/Users/alice', machineId: 'work-mac', host: 'MacBook Pro',
        } });
        expect(getSessionWorkContext(row)).toContain('MacBook Pro');
        expect(getSessionWorkContext(row)).not.toContain('/projects/');
        expect(getSessionWorkContext(createSessionListRenderableSessionFixture({ metadata: {
            path: 'C:\\Users\\alice\\projects\\payments', homeDir: 'C:\\Users\\alice',
        } }))).toBe('payments');
        expect(getSessionWorkContext(createSessionListRenderableSessionFixture({ metadata: null }))).toBeNull();
    });
    it('reads the owner name from a narrow layout-1 display projection', async () => {
        const { getSessionName } = await import('./sessionUtils');
        expect(getSessionName({
            id: 'source-session', metadata: null, metadataLayoutVersion: 1,
            ownerMetadataView: { name: 'Lead A', path: '/tmp/worktree', host: 'mac' },
        })).toBe('Lead A');
    });

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

    // An imported or not-yet-summarized session with no name and no project path has no title. It
    // reads as untitled, not as "unknown" (which claimed Happier did not know something it had never
    // been told), and the untitled marker is recognised where a missing title matters.
    it('names a session with no title, name or path as untitled', async () => {
        const { getSessionName, isUntitledSessionName, resolveLockedSessionTitle } = await import('./sessionUtils');
        const session = createBaseSession({ metadata: { host: 'mac' } as never });
        const name = getSessionName(session);
        expect(name).toBe('session.untitled');
        expect(isUntitledSessionName(name)).toBe(true);
        expect(isUntitledSessionName('Linked Direct Session')).toBe(false);
        expect(resolveLockedSessionTitle(name)).toBe('session.access.lockedTitleFallback');
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
            } as never,
        });

        seedDisplayTargetSession(session, '/Users/test/workspace/live-name');

        expect(getSessionName(session)).toBe('live-name');
    });
});

describe('a no-folder session', () => {
    const privatePath = '/Users/test/.happier/servers/s/session-directories/3f9a0c21';
    const managedMetadata = {
        machineId: 'machine-a',
        path: privatePath,
        homeDir: '/Users/test',
        host: 'mbp.local',
        sessionDirectoryV1: { v: 1, kind: 'managed' },
    } satisfies NonNullable<Session['metadata']>;

    it('is named “New chat” until it has a summary, never after its private folder', async () => {
        const { getSessionName } = await import('./sessionUtils');
        expect(getSessionName(createBaseSession({ metadata: managedMetadata }))).toBe('session.folderless.untitledChat');
        expect(getSessionName(createBaseSession({
            metadata: { ...managedMetadata, name: '   ' },
        }))).toBe('session.folderless.untitledChat');
        expect(getSessionName(createBaseSession({
            metadata: { path: '/Users/test/project', host: 'mbp.local', name: '   ' },
        }))).toBe('project');
        expect(getSessionName(createBaseSession({
            metadata: { ...(managedMetadata as object), summary: { text: 'Haiku in notes.md', updatedAt: 1 } } as never,
        }))).toBe('Haiku in notes.md');
    });

    it('takes its avatar from the machine and the session, and its subtitle from the machine', async () => {
        const { getSessionAvatarId, getSessionSubtitle } = await import('./sessionUtils');
        storage.setState({
            machines: { 'machine-a': createMachineFixture({ id: 'machine-a', metadata: { displayName: 'MacBook Pro' } as never }) },
        });
        const first = createBaseSession({ id: 'chat-1', metadata: managedMetadata });
        const second = createBaseSession({ id: 'chat-2', metadata: managedMetadata });
        expect(getSessionAvatarId(first)).not.toBe(getSessionAvatarId(second));
        expect(getSessionAvatarId(first)).not.toContain('session-directories');
        expect(getSessionSubtitle(first)).toBe('MacBook Pro');
    });
});

describe('getSessionName for a list row', () => {
    // A list row has no separate owner view: its composed `metadata` is this viewer's projection.
    // The row and the detail header must call an owner's untitled Session the same thing.
    it('names a layout-1 owner row exactly as its Session is named', async () => {
        const { getSessionName, getSessionSubtitle } = await import('./sessionUtils');
        const { buildSessionFromListRenderable } = await import('@/sync/domains/session/listing/sessionListRenderableSessionProjection');
        const row = createSessionListRenderableSessionFixture({
            id: 'owner-row',
            encryptionMode: 'e2ee',
            metadataLayoutVersion: 1,
            metadata: { path: '/Users/u/workspace/project', homeDir: '/Users/u', summaryText: null },
        });

        expect(getSessionName(row)).toBe('project');
        expect(getSessionName(row)).toBe(getSessionName(buildSessionFromListRenderable(row)));
        expect(getSessionSubtitle(row)).toBe(getSessionSubtitle(buildSessionFromListRenderable(row)));
    });

    it('never reads private workspace facts from a layout-1 recipient row', async () => {
        const { getSessionName } = await import('./sessionUtils');
        const row = createSessionListRenderableSessionFixture({
            id: 'recipient-row',
            encryptionMode: 'e2ee',
            access: createSessionAccessFixture('view'),
            metadataLayoutVersion: 1,
            metadata: { path: '/injected/private/path', summaryText: null },
        });

        expect(getSessionName(row)).toBe('session.untitled');
    });
});

describe('reachable target session display helpers', () => {
    it('keeps the ordinary avatar seed through registered Bot promotion, demotion and reload', async () => {
        const { getSessionAvatarId } = await import('./sessionUtils');
        const { MetadataSchema } = await import('@happier-dev/session-core/state');
        const { writeSessionStateFieldToMetadata } = await import('@happier-dev/agents/session/state/metadataWriters');
        const inputs = [
            { path: '/project', host: 'host', machineId: 'machine' },
            { path: '/private/session-directory', host: 'host', machineId: 'machine',
                sessionDirectoryV1: { v: 1, kind: 'managed' } },
            {},
        ];
        for (const input of inputs) {
            const metadata = MetadataSchema.parse(input);
            const session = createBaseSession({ id: 'same-session', metadata });
            const seed = getSessionAvatarId(session);
            const promoted = MetadataSchema.parse(writeSessionStateFieldToMetadata(metadata, 'display.bot', { kind: 'bot' }));
            const demoted = MetadataSchema.parse(writeSessionStateFieldToMetadata(promoted, 'display.bot', null));
            for (const next of [promoted, demoted, MetadataSchema.parse(JSON.parse(JSON.stringify(promoted)))]) {
                expect(getSessionAvatarId({ ...session, metadata: next })).toBe(seed);
            }
        }
        expect(getSessionAvatarId(createBaseSession({ id: 'same-session', metadata: null }))).toBe('same-session');
    });
    it('uses the owner compatibility view for layout-v1 private workspace fallbacks', async () => {
        const { getSessionAvatarId, getSessionName, getSessionSubtitle } = await import('./sessionUtils');
        const session = createBaseSession({
            id: 'layout-v1-session',
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                summary: {
                    text: 'Shared title',
                    updatedAt: 1,
                },
            } as unknown as Session['metadata'],
            ownerMetadataView: {
                name: 'Private name',
                machineId: 'private-machine',
                path: '/Users/private/workspace',
                host: 'private-host',
                homeDir: '/Users/private',
            } as Session['metadata'],
        });

        expect(getSessionName(session)).toBe('Shared title');
        expect(getSessionSubtitle(session)).toBe('~/workspace');
        expect(getSessionAvatarId(session)).toBe('private-machine:/Users/private/workspace');
    });

    it('does not fall back to layout-v1 shared metadata for private workspace display facts', async () => {
        const { getSessionAvatarId, getSessionName, getSessionSubtitle } = await import('./sessionUtils');
        const session = createBaseSession({
            id: 'layout-v1-owner-view-missing',
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                summary: {
                    text: 'Shared title',
                    updatedAt: 1,
                },
                machineId: 'injected-shared-machine',
                path: '/injected/shared/private-path',
                host: 'injected.shared',
                homeDir: '/injected',
            } as unknown as Session['metadata'],
            ownerMetadataView: null,
        });

        expect(getSessionName(session)).toBe('Shared title');
        expect(getSessionSubtitle(session)).toBe('status.unknown');
        expect(getSessionAvatarId(session)).toBe('layout-v1-owner-view-missing');
    });

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

        seedDisplayTargetSession(session, '/Users/test/workspace/live');

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

        seedDisplayTargetSession(session, '/Users/test/workspace/live');

        expect(getSessionAvatarId(session)).toBe('machine-target:/Users/test/workspace/live');
    });
});
