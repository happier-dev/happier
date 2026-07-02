import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResumeSessionOptions, ResumeSessionResult } from '@/sync/ops/sessions';
import type { Session } from '@/sync/domains/state/storageTypes';
import { syncReliabilityTelemetry } from '@/sync/runtime/syncReliabilityTelemetry';

type TestWakeStorageState = {
    sessions: Record<string, unknown>;
    machines: Record<string, unknown>;
    getProjectForSession: (sessionId: string) => { key: { machineId: string; path: string } } | null;
};

const storageState = vi.hoisted((): { current: TestWakeStorageState } => ({
    current: {
        sessions: {},
        machines: {},
        getProjectForSession: (_sessionId: string) => null,
    },
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => storageState.current,
        } as any,
    });
});

vi.mock('@/agents/catalog/catalog', () => ({
    buildWakeResumeExtras: () => ({}),
    getAgentCore: () => ({ cli: { spawnAgent: 'claude' } }),
    isAgentId: (value: unknown) => typeof value === 'string' && value === 'claude',
    resolveAgentIdFromFlavor: (value: string | null | undefined) => value === 'claude' ? 'claude' : null,
}));

type LoadedSubject = typeof import('./submitSessionUserMessage');

async function expectSubject(): Promise<LoadedSubject> {
    return import('./submitSessionUserMessage');
}

function createSession(
    overrides: Partial<Omit<Session, 'metadata'>> & {
        metadata?: Partial<NonNullable<Session['metadata']>>;
    } = {},
): Session {
    const { metadata: metadataOverrides, ...sessionOverrides } = overrides;
    const metadata = {
        ...(metadataOverrides ?? {}),
        machineId: metadataOverrides?.machineId ?? 'm1',
        path: metadataOverrides?.path ?? '/tmp/project',
        host: metadataOverrides?.host ?? 'host.local',
        flavor: metadataOverrides?.flavor ?? 'claude',
        claudeSessionId: metadataOverrides?.claudeSessionId ?? 'claude-1',
        version: metadataOverrides?.version ?? '999.0.0',
    };

    return {
        id: 's1',
        serverId: 'server-cache',
        seq: 41,
        createdAt: 1,
        updatedAt: 2,
        active: false,
        activeAt: 1,
        pendingVersion: 2,
        pendingCount: 0,
        metadata,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        optimisticThinkingAt: null,
        ...sessionOverrides,
    };
}

type SubmitCall =
    | { type: 'refresh'; sessionId: string; serverId?: string | null }
    | { type: 'enqueue'; sessionId: string; text: string; displayText?: string; metaOverrides?: Record<string, unknown> }
    | {
        type: 'send';
        sessionId: string;
        text: string;
        displayText?: string;
        metaOverrides?: Record<string, unknown>;
        bypassPendingQueueReason?: string;
    }
    | { type: 'resume'; options: ResumeSessionOptions }
    | { type: 'abort'; sessionId: string }
    | { type: 'switchRemote'; sessionId: string };

function createPort(config: {
    enqueueResult?: { localId?: string } | void;
    enqueueReject?: Error;
    sendResult?: { localId?: string; seq?: number } | void;
    resumeResult?: ResumeSessionResult;
    resumeReject?: Error;
    sendReject?: Error;
    canWakeMachine?: boolean;
    refreshSessionResult?: Session | null;
    refreshSessionReject?: Error;
} = {}) {
    const calls: SubmitCall[] = [];
    const port = {
        enqueuePendingMessage: async (
            sessionId: string,
            text: string,
            displayText?: string,
            metaOverrides?: Record<string, unknown>,
        ) => {
            calls.push({ type: 'enqueue', sessionId, text, displayText, metaOverrides });
            if (config.enqueueReject) throw config.enqueueReject;
            return config.enqueueResult ?? { localId: 'pending-local-id' };
        },
        sendMessage: async (
            sessionId: string,
            text: string,
            displayText?: string,
            metaOverrides?: Record<string, unknown>,
            options?: Readonly<{
                profileId?: string | null;
                localId?: string | null;
                bypassPendingQueueReason?: string;
                onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void;
            }>,
        ) => {
            calls.push({ type: 'send', sessionId, text, displayText, metaOverrides, bypassPendingQueueReason: options?.bypassPendingQueueReason });
            if (config.sendReject) throw config.sendReject;
            options?.onLocalPendingProjectionCreated?.({
                localId: (config.sendResult && typeof config.sendResult === 'object' && config.sendResult.localId) || 'direct-local-id',
            });
            return config.sendResult ?? { localId: 'direct-local-id', seq: 42 };
        },
        resumeSession: async (options: ResumeSessionOptions) => {
            calls.push({ type: 'resume', options });
            if (config.resumeReject) throw config.resumeReject;
            return config.resumeResult ?? { type: 'success' as const };
        },
        abortSession: async (sessionId: string) => {
            calls.push({ type: 'abort', sessionId });
        },
        switchSessionControlToRemote: async (sessionId: string) => {
            calls.push({ type: 'switchRemote', sessionId });
        },
        canWakeMachineId: () => config.canWakeMachine ?? true,
        refreshSessionForSubmit: async (sessionId: string, options?: Readonly<{ serverId?: string | null }>) => {
            calls.push({ type: 'refresh', sessionId, serverId: options?.serverId });
            if (config.refreshSessionReject) throw config.refreshSessionReject;
            return config.refreshSessionResult ?? null;
        },
    };

    return { calls, port };
}

describe('submitSessionUserMessage', () => {
    beforeEach(() => {
        syncReliabilityTelemetry.reset();
        storageState.current = {
            sessions: {
                s1: {
                    active: false,
                    updatedAt: 10,
                    metadata: { machineId: 'm1', path: '/tmp/project', homeDir: '/Users/test', host: 'host.local' },
                },
            },
            machines: {
                m1: {
                    id: 'm1',
                    active: true,
                    activeAt: 20,
                    metadata: { host: 'host.local' },
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 's1'
                    ? {
                        key: {
                            machineId: 'm1',
                            path: '/tmp/project',
                        },
                    }
                    : null,
        };
    });

    it('enqueues pending messages and wakes with the pre-enqueue transcript cursor', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort();
        const outboundHandoffs: unknown[] = [];

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession(),
            text: 'hello',
            configuredMode: 'agent_queue',
            resumeCapabilityOptions: { accountSettings: {} },
            serverId: 'server-cache',
            onOutboundHandoff: (event) => {
                outboundHandoffs.push({
                    event,
                    callTypes: calls.map((call) => call.type),
                });
            },
        });

        expect(result).toMatchObject({
            type: 'success',
            persistence: 'pending',
            wake: { attempted: true, state: 'started' },
            localId: 'pending-local-id',
        });
        expect(calls.map((call) => call.type)).toEqual(['enqueue', 'resume']);
        expect(outboundHandoffs).toEqual([{
            event: {
                persistence: 'pending',
                localId: 'pending-local-id',
            },
            callTypes: ['enqueue'],
        }]);
        expect(calls).toContainEqual(expect.objectContaining({
            type: 'resume',
            options: expect.objectContaining({
                sessionId: 's1',
                machineId: 'm1',
                directory: '/tmp/project',
                initialTranscriptAfterSeq: 41,
                serverId: 'server-cache',
            }),
        }));
    });

    it('keeps the pending row when no wake target is available', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort({ canWakeMachine: false });

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession(),
            text: 'queued',
            configuredMode: 'agent_queue',
            resumeCapabilityOptions: { accountSettings: {} },
        });

        expect(result).toMatchObject({
            type: 'wake_pending',
            persistence: 'pending',
            wake: { attempted: false, state: 'not_needed' },
        });
        expect(calls.map((call) => call.type)).toEqual(['enqueue']);
    });

    it('reports wake failure without falling through to direct send', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort({
            resumeResult: {
                type: 'error',
                errorCode: 'DAEMON_RPC_UNAVAILABLE',
                errorMessage: 'Daemon RPC is not available',
            },
        });

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession(),
            text: 'queued',
            configuredMode: 'agent_queue',
            resumeCapabilityOptions: { accountSettings: {} },
        });

        expect(result).toMatchObject({
            type: 'wake_failed',
            persistence: 'pending',
            wake: {
                attempted: true,
                state: 'failed',
                errorMessage: 'Daemon RPC is not available',
            },
        });
        expect(calls.map((call) => call.type)).toEqual(['enqueue', 'resume']);
    });

    it('rejects configured pending on old CLI without direct-sending', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort();

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({
                metadata: { version: '0.0.1' },
            }),
            text: 'legacy send',
            configuredMode: 'server_pending',
            resumeCapabilityOptions: { accountSettings: {} },
        });

        expect(result).toMatchObject({
            type: 'rejected',
            persistence: 'none',
            wake: { attempted: false, state: 'not_needed' },
            errorCode: 'PENDING_QUEUE_UNSUPPORTED',
        });
        expect(calls).toEqual([]);
    });

    it('refreshes unknown pending support once before enqueuing', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort({
            refreshSessionResult: createSession({
                active: false,
                pendingVersion: 2,
                metadata: { version: '999.0.0' },
            }),
        });

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({
                active: false,
                pendingVersion: undefined,
                metadata: { version: '999.0.0' },
            }),
            text: 'refresh then queue',
            configuredMode: 'server_pending',
            resumeCapabilityOptions: { accountSettings: {} },
            serverId: 'server-cache',
        });

        expect(result).toMatchObject({
            type: 'success',
            persistence: 'pending',
        });
        expect(calls.map((call) => call.type)).toEqual(['refresh', 'enqueue', 'resume']);
    });

    it('rejects unknown pending support after refresh without direct-sending or enqueuing', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort({
            refreshSessionResult: createSession({
                pendingVersion: undefined,
                metadata: { version: '999.0.0' },
            }),
        });

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({
                pendingVersion: undefined,
                metadata: { version: '999.0.0' },
            }),
            text: 'do not strand or direct send',
            configuredMode: 'server_pending',
            resumeCapabilityOptions: { accountSettings: {} },
            serverId: 'server-cache',
        });

        expect(result).toMatchObject({
            type: 'rejected',
            persistence: 'none',
            wake: { attempted: false, state: 'not_needed' },
            errorCode: 'PENDING_QUEUE_SUPPORT_UNKNOWN',
        });
        expect(calls.map((call) => call.type)).toEqual(['refresh']);
    });

    it('lets forceImmediate bypass configured pending when direct send is safe', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort();

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({ active: true, presence: 'online', agentStateVersion: 1 }),
            text: 'send now',
            configuredMode: 'server_pending',
            forceImmediate: true,
            callerSurface: 'session_composer',
            resumeCapabilityOptions: { accountSettings: {} },
            serverId: 'server-cache',
        });

        expect(result).toMatchObject({
            type: 'success',
            persistence: 'transcript_committed',
            wake: { attempted: false, state: 'not_needed' },
        });
        expect(calls.map((call) => call.type)).toEqual(['send']);
        expect(calls[0]).toMatchObject({
            type: 'send',
            bypassPendingQueueReason: 'force_immediate',
        });
        expect(syncReliabilityTelemetry.snapshot().events).toContainEqual(expect.objectContaining({
            name: 'ui.sessionMessage.delivery.decision',
            fields: expect.objectContaining({
                sessionId: 's1',
                mode: 'agent_queue',
                decisionReason: 'force_immediate_direct',
                configuredMode: 'server_pending',
                busySteerSendPolicy: 'steer_immediately',
                callerSurface: 'session_composer',
                forceImmediate: true,
                pendingRequested: true,
                pendingSupportState: 'supported',
            }),
        }));
    });

    it('aborts before sending interrupt messages', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort();

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({ active: true, presence: 'online' }),
            text: 'stop and do this',
            configuredMode: 'interrupt',
            resumeCapabilityOptions: { accountSettings: {} },
        });

        expect(result).toMatchObject({
            type: 'success',
            persistence: 'transcript_committed',
        });
        expect(calls.map((call) => call.type)).toEqual(['abort', 'send']);
    });

    it('returns send_failed when direct send fails', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort({ sendReject: new Error('send rejected') });
        const outboundHandoff = vi.fn();

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({ active: true, presence: 'online' }),
            text: 'hello',
            configuredMode: 'agent_queue',
            resumeCapabilityOptions: { accountSettings: {} },
            onOutboundHandoff: outboundHandoff,
        });

        expect(result).toMatchObject({
            type: 'send_failed',
            persistence: 'none',
            errorMessage: 'send rejected',
        });
        expect(calls.map((call) => call.type)).toEqual(['send']);
        expect(outboundHandoff).not.toHaveBeenCalled();
    });

    it('waits for the direct send port to create a local pending projection before marking outbound handoff', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort({ sendResult: { localId: 'projection-local-id', seq: 42 } });
        const handoffTrace: Array<Readonly<{ event: unknown; callTypes: readonly string[] }>> = [];

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({ active: true, presence: 'online' }),
            text: 'hello',
            configuredMode: 'agent_queue',
            resumeCapabilityOptions: { accountSettings: {} },
            onOutboundHandoff: (event) => {
                handoffTrace.push({
                    event,
                    callTypes: calls.map((call) => call.type),
                });
            },
        });

        expect(result).toMatchObject({
            type: 'success',
            persistence: 'transcript_committed',
            localId: 'projection-local-id',
        });
        expect(calls.map((call) => call.type)).toEqual(['send']);
        expect(handoffTrace).toEqual([{
            event: {
                persistence: 'transcript_committed',
                localId: 'projection-local-id',
            },
            callTypes: ['send'],
        }]);
    });

    it('enqueues provider config changes instead of steering them into a busy turn', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort();

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({
                active: true,
                thinking: true,
                thinkingAt: Date.now(),
                presence: 'online',
                agentStateVersion: 1,
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } } as any,
                metadata: {
                    flavor: 'claude',
                    sessionConfigOptionsV1: {
                        v: 1,
                        provider: 'claude',
                        updatedAt: 10,
                        configOptions: [
                            {
                                id: 'reasoning_effort',
                                name: 'Reasoning effort',
                                type: 'select',
                                currentValue: 'medium',
                            },
                        ],
                    },
                    sessionConfigOptionOverridesV1: {
                        v: 1,
                        updatedAt: 20,
                        overrides: {
                            reasoning_effort: { updatedAt: 20, value: 'high' },
                        },
                    },
                },
            }),
            text: 'use the new effort',
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            resumeCapabilityOptions: { accountSettings: {} },
        });

        expect(result).toMatchObject({
            persistence: 'pending',
            wake: { attempted: false, state: 'not_needed' },
        });
        expect(calls.map((call) => call.type)).toEqual(['enqueue']);
    });

    function createBusySteerableSession(overrides: Parameters<typeof createSession>[0] = {}) {
        return createSession({
            active: true,
            thinking: true,
            thinkingAt: Date.now(),
            presence: 'online',
            agentStateVersion: 1,
            agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } } as any,
            ...overrides,
        });
    }

    describe('G4 non-steerable payload threading (caller flags reach the delivery decision)', () => {
        it('demotes a FRESH mode-change payload to the pending queue while busy instead of silently steering', async () => {
            const subject = await expectSubject();
            if (!subject) return;
            const { calls, port } = createPort();

            const result = await subject.submitSessionUserMessage(port, {
                sessionId: 's1',
                session: createBusySteerableSession({
                    permissionMode: 'plan',
                    permissionModeUpdatedAt: Date.now() + 1_000,
                    metadata: { permissionMode: 'default' } as any,
                }),
                text: 'keep going but plan first',
                configuredMode: 'agent_queue',
                busySteerSendPolicy: 'steer_immediately',
                resumeCapabilityOptions: { accountSettings: {} },
            });

            expect(result).toMatchObject({ persistence: 'pending' });
            expect(calls.map((call) => call.type)).toEqual(['enqueue']);
        });

        it('demotes special commands to the pending queue while busy (mirrors the CLI steer gate)', async () => {
            const subject = await expectSubject();
            if (!subject) return;
            const { calls, port } = createPort();

            const result = await subject.submitSessionUserMessage(port, {
                sessionId: 's1',
                session: createBusySteerableSession(),
                text: '/clear',
                configuredMode: 'agent_queue',
                busySteerSendPolicy: 'steer_immediately',
                resumeCapabilityOptions: { accountSettings: {} },
            });

            expect(result).toMatchObject({ persistence: 'pending' });
            expect(calls.map((call) => call.type)).toEqual(['enqueue']);
        });

        it('steers a mode-change payload when the user chose apply-and-steer and the backend published the capability', async () => {
            const subject = await expectSubject();
            if (!subject) return;
            const { calls, port } = createPort();

            const result = await subject.submitSessionUserMessage(port, {
                sessionId: 's1',
                session: createBusySteerableSession({
                    permissionMode: 'plan',
                    permissionModeUpdatedAt: Date.now() + 1_000,
                    agentState: {
                        controlledByUser: false,
                        capabilities: { inFlightSteer: true, inFlightConfigApplySupported: true },
                    } as any,
                    metadata: { permissionMode: 'default' } as any,
                }),
                text: 'keep going but plan first',
                configuredMode: 'agent_queue',
                busySteerSendPolicy: 'steer_immediately',
                applyConfigAndSteer: true,
                resumeCapabilityOptions: { accountSettings: {} },
            });

            expect(result).toMatchObject({ type: 'success', persistence: 'transcript_committed' });
            expect(calls.map((call) => call.type)).toEqual(['send']);
        });

        it('keeps apply-and-steer fail-closed when the backend did not publish the capability', async () => {
            const subject = await expectSubject();
            if (!subject) return;
            const { calls, port } = createPort();

            const result = await subject.submitSessionUserMessage(port, {
                sessionId: 's1',
                session: createBusySteerableSession({
                    permissionMode: 'plan',
                    permissionModeUpdatedAt: Date.now() + 1_000,
                    metadata: { permissionMode: 'default' } as any,
                }),
                text: 'keep going but plan first',
                configuredMode: 'agent_queue',
                busySteerSendPolicy: 'steer_immediately',
                applyConfigAndSteer: true,
                resumeCapabilityOptions: { accountSettings: {} },
            });

            expect(result).toMatchObject({ persistence: 'pending' });
            expect(calls.map((call) => call.type)).toEqual(['enqueue']);
        });

        it('steers the text only when the user chose defer-and-steer', async () => {
            const subject = await expectSubject();
            if (!subject) return;
            const { calls, port } = createPort();

            const result = await subject.submitSessionUserMessage(port, {
                sessionId: 's1',
                session: createBusySteerableSession({
                    permissionMode: 'plan',
                    permissionModeUpdatedAt: Date.now() + 1_000,
                    metadata: { permissionMode: 'default' } as any,
                }),
                text: 'keep going but plan first',
                configuredMode: 'agent_queue',
                busySteerSendPolicy: 'steer_immediately',
                steerWithoutConfig: true,
                resumeCapabilityOptions: { accountSettings: {} },
            });

            expect(result).toMatchObject({ type: 'success', persistence: 'transcript_committed' });
            expect(calls.map((call) => call.type)).toEqual(['send']);
        });

        it('honors the kill-switch: nonSteerableSendPrompt=off restores legacy silent steering for mode changes', async () => {
            const subject = await expectSubject();
            if (!subject) return;
            const { calls, port } = createPort();

            const result = await subject.submitSessionUserMessage(port, {
                sessionId: 's1',
                session: createBusySteerableSession({
                    permissionMode: 'plan',
                    permissionModeUpdatedAt: Date.now() + 1_000,
                    metadata: { permissionMode: 'default' } as any,
                }),
                text: 'keep going but plan first',
                configuredMode: 'agent_queue',
                busySteerSendPolicy: 'steer_immediately',
                nonSteerableSendPrompt: 'off',
                resumeCapabilityOptions: { accountSettings: {} },
            });

            expect(result).toMatchObject({ type: 'success', persistence: 'transcript_committed' });
            expect(calls.map((call) => call.type)).toEqual(['send']);
        });

        it('skips the mode-change gate when permission mode applies on next prompt by setting', async () => {
            const subject = await expectSubject();
            if (!subject) return;
            const { calls, port } = createPort();

            const result = await subject.submitSessionUserMessage(port, {
                sessionId: 's1',
                session: createBusySteerableSession({
                    permissionMode: 'plan',
                    permissionModeUpdatedAt: Date.now() + 1_000,
                    metadata: { permissionMode: 'default' } as any,
                }),
                text: 'keep going but plan first',
                configuredMode: 'agent_queue',
                busySteerSendPolicy: 'steer_immediately',
                permissionModeApplyTiming: 'next_prompt',
                resumeCapabilityOptions: { accountSettings: {} },
            });

            expect(result).toMatchObject({ type: 'success', persistence: 'transcript_committed' });
            expect(calls.map((call) => call.type)).toEqual(['send']);
        });
    });

    it('does not mark outbound handoff when pending enqueue fails before a pending row exists', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort({ enqueueReject: new Error('enqueue rejected') });
        const outboundHandoff = vi.fn();

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession(),
            text: 'hello',
            configuredMode: 'agent_queue',
            resumeCapabilityOptions: { accountSettings: {} },
            onOutboundHandoff: outboundHandoff,
        });

        expect(result).toMatchObject({
            type: 'send_failed',
            persistence: 'none',
            errorMessage: 'enqueue rejected',
        });
        expect(calls.map((call) => call.type)).toEqual(['enqueue']);
        expect(outboundHandoff).not.toHaveBeenCalled();
    });
});
