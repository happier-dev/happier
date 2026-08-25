import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import type { DirectMessageSubmitResult, SessionSubmitPort } from './types';
import { submitSessionUserMessage } from './submitSessionUserMessage';

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 's1',
        serverId: 'server-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        pendingVersion: 2,
        pendingCount: 0,
        metadata: {
            machineId: 'm1', path: '/tmp/project', host: 'host', flavor: 'unknown-agent', version: '999.0.0',
            claudeSessionId: 'claude-1', claudeTranscriptPath: '/tmp/claude-1.jsonl',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
        ...overrides,
    };
}

function createPort() {
    const enqueuePendingMessage = vi.fn(async () => ({ localId: 'pending-1', accepted: true }));
    const updatePendingRequestedAction = vi.fn(async () => undefined);
    const ensureSessionRuntimeForPendingInput = vi.fn(async () => ({ type: 'success' as const }));
    const sendMessage = vi.fn<SessionSubmitPort['sendMessage']>(async () => ({ localId: 'direct-1', seq: 2 }));
    const port: SessionSubmitPort = {
        enqueuePendingMessage,
        updatePendingRequestedAction,
        ensureSessionRuntimeForPendingInput,
        sendMessage,
        isSessionTargetRemoteToActiveServer: () => false,
    };
    return { port, enqueuePendingMessage, updatePendingRequestedAction, ensureSessionRuntimeForPendingInput, sendMessage };
}

function submitOptions(session: Session) {
    return {
        sessionId: session.id,
        session,
        text: 'hello',
        configuredMode: 'agent_queue' as const,
        resumeCapabilityOptions: {},
        nowMs: 1_000,
    };
}

describe('submitSessionUserMessage Pending action ownership', () => {
    it('persists ordinary input with an explicit enqueue action', async () => {
        const session = createSession();
        const { port, enqueuePendingMessage } = createPort();

        await expect(submitSessionUserMessage(port, submitOptions(session))).resolves.toMatchObject({
            persistence: 'pending', localId: 'pending-1',
        });
        expect(enqueuePendingMessage).toHaveBeenCalledWith(
            's1', 'hello', undefined, expect.any(Object),
            expect.objectContaining({ requestedAction: { v: 1, kind: 'enqueue' } }),
        );
    });

    it('keeps Pending custody when the runtime version is opaque rather than proven legacy', async () => {
        const session = createSession({
            metadata: {
                machineId: 'm1', path: '/tmp/project', host: 'host', flavor: 'unknown-agent', version: 'custom-build',
                claudeSessionId: 'claude-1', claudeTranscriptPath: '/tmp/claude-1.jsonl',
            },
        });
        const { port, enqueuePendingMessage, sendMessage } = createPort();

        await expect(submitSessionUserMessage(port, submitOptions(session))).resolves.toMatchObject({
            persistence: 'pending', localId: 'pending-1',
        });
        expect(enqueuePendingMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('forwards host Voice admission to the durable Pending owner', async () => {
        const session = createSession();
        const { port, enqueuePendingMessage } = createPort();

        await submitSessionUserMessage(port, {
            ...submitOptions(session),
            forceImmediate: true,
            hostAdmissionOrigin: 'voice',
        });

        expect(enqueuePendingMessage).toHaveBeenCalledWith(
            's1',
            'hello',
            undefined,
            expect.any(Object),
            expect.objectContaining({
                hostAdmissionOrigin: 'voice',
                requestedAction: { v: 1, kind: 'send_now' },
            }),
        );
    });

    it('forwards host Voice admission to the direct owner when Pending is unavailable', async () => {
        const session = createSession({
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                host: 'host',
                flavor: 'unknown-agent',
                version: '0.0.1',
            },
        });
        const { port, sendMessage } = createPort();
        Object.assign(port, {
            isSessionTargetRemoteToActiveServer: () => false,
        });

        await submitSessionUserMessage(port, {
            ...submitOptions(session),
            forceImmediate: true,
            hostAdmissionOrigin: 'voice',
        });

        expect(sendMessage).toHaveBeenCalledWith(
            's1',
            'hello',
            undefined,
            undefined,
            expect.objectContaining({
                hostAdmissionOrigin: 'voice',
                bypassPendingQueueReason: 'force_immediate',
            }),
        );
    });

    it('rejects an unsupported remote Voice target before the active direct transport', async () => {
        const session = createSession({
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                host: 'host',
                flavor: 'unknown-agent',
                version: '0.0.1',
            },
        });
        const { port, enqueuePendingMessage, sendMessage } = createPort();
        Object.assign(port, {
            isSessionTargetRemoteToActiveServer: () => true,
        });

        await expect(submitSessionUserMessage(port, {
            ...submitOptions(session),
            explicitMode: 'server_pending',
            forceImmediate: true,
            hostAdmissionOrigin: 'voice',
        })).resolves.toEqual({
            type: 'rejected',
            persistence: 'none',
            wake: { attempted: false, state: 'not_needed' },
            errorCode: 'session_input_target_update_required',
            errorMessage: 'The selected remote session requires an updated agent runtime before Voice can send a message.',
        });
        expect(sendMessage).not.toHaveBeenCalled();
        expect(enqueuePendingMessage).not.toHaveBeenCalled();
    });

    it('keeps ambiguous enqueue custody pending after the local outbound handoff', async () => {
        const session = createSession();
        const { port, enqueuePendingMessage } = createPort();
        const onOutboundHandoff = vi.fn();
        enqueuePendingMessage.mockResolvedValueOnce({
            localId: 'pending-ambiguous',
            accepted: false,
        });

        await expect(submitSessionUserMessage(port, {
            ...submitOptions(session),
            onOutboundHandoff,
        })).resolves.toEqual({
            type: 'wake_pending',
            persistence: 'pending',
            wake: { attempted: false, state: 'not_needed' },
            localId: 'pending-ambiguous',
        });
        expect(onOutboundHandoff).toHaveBeenCalledWith({
            persistence: 'pending',
            localId: 'pending-ambiguous',
        });
    });

    it('does not hand off Composer custody until Pending persistence succeeds', async () => {
        const session = createSession();
        const { port, enqueuePendingMessage } = createPort();
        const onOutboundHandoff = vi.fn();
        let rejectPersistence!: (error: Error) => void;
        enqueuePendingMessage.mockImplementationOnce(async (...args: unknown[]) => {
            const options = args[4] as Readonly<{
                onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void;
            }>;
            options.onLocalPendingProjectionCreated?.({ localId: 'pending-before-persistence' });
            return await new Promise((_, reject) => {
                rejectPersistence = reject;
            });
        });

        const pending = submitSessionUserMessage(port, {
            ...submitOptions(session),
            onOutboundHandoff,
        });
        await vi.waitFor(() => expect(enqueuePendingMessage).toHaveBeenCalledTimes(1));
        expect(onOutboundHandoff).not.toHaveBeenCalled();

        rejectPersistence(new Error('outbox write failed'));
        await expect(pending).resolves.toMatchObject({
            type: 'send_failed',
            persistence: 'none',
            errorMessage: 'outbox write failed',
        });
        expect(onOutboundHandoff).not.toHaveBeenCalled();
    });

    it('hands off Composer custody when direct send creates the local pending projection', async () => {
        const session = createSession({
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                host: 'host',
                flavor: 'unknown-agent',
                version: '0.0.1',
            },
        });
        const { port, sendMessage } = createPort();
        const onOutboundHandoff = vi.fn();
        let rejectAdmission!: (error: Error) => void;
        sendMessage.mockImplementationOnce(async (...args: unknown[]) => {
            const options = args[4] as Readonly<{
                onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void;
            }>;
            options.onLocalPendingProjectionCreated?.({ localId: 'direct-before-admission' });
            return await new Promise((_, reject) => {
                rejectAdmission = reject;
            });
        });

        const pending = submitSessionUserMessage(port, {
            ...submitOptions(session),
            forceImmediate: true,
            onOutboundHandoff,
        });
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
        expect(onOutboundHandoff).toHaveBeenCalledOnce();
        expect(onOutboundHandoff).toHaveBeenCalledWith({
            persistence: 'pending',
            localId: 'direct-before-admission',
        });

        rejectAdmission(new Error('direct admission failed'));
        await expect(pending).resolves.toMatchObject({
            type: 'send_failed',
            persistence: 'none',
            localId: 'direct-before-admission',
            errorMessage: 'direct admission failed',
        });
        expect(onOutboundHandoff).toHaveBeenCalledOnce();
    });

    it('hands off Composer custody immediately after direct admission succeeds', async () => {
        const session = createSession({
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                host: 'host',
                flavor: 'unknown-agent',
                version: '0.0.1',
            },
        });
        const { port, sendMessage } = createPort();
        const onOutboundHandoff = vi.fn();
        let acceptAdmission!: (result: DirectMessageSubmitResult) => void;
        sendMessage.mockImplementationOnce(async (...args: unknown[]) => {
            const options = args[4] as Readonly<{
                onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void;
            }>;
            options.onLocalPendingProjectionCreated?.({ localId: 'direct-after-admission' });
            return await new Promise<DirectMessageSubmitResult>((resolve) => {
                acceptAdmission = resolve;
            });
        });

        const pending = submitSessionUserMessage(port, {
            ...submitOptions(session),
            forceImmediate: true,
            onOutboundHandoff,
        });
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
        expect(onOutboundHandoff).toHaveBeenCalledOnce();
        expect(onOutboundHandoff).toHaveBeenCalledWith({
            persistence: 'pending',
            localId: 'direct-after-admission',
        });

        acceptAdmission({
            localId: 'direct-after-admission',
            persistence: 'provider_direct',
            providerAcceptancePending: true,
        });
        await expect(pending).resolves.toMatchObject({
            type: 'success',
            persistence: 'provider_direct',
            providerAcceptancePending: true,
            localId: 'direct-after-admission',
        });
        expect(onOutboundHandoff).toHaveBeenCalledOnce();
    });

    it('persists steer_if_active only for a currently steerable turn', async () => {
        const session = createSession({
            thinking: true,
            thinkingAt: 1_000,
            agentState: { capabilities: { inFlightSteerSupported: true, inFlightSteerAvailable: true } },
        });
        const { port, enqueuePendingMessage } = createPort();

        await submitSessionUserMessage(port, submitOptions(session));

        expect(enqueuePendingMessage).toHaveBeenCalledWith(
            's1', 'hello', undefined, expect.any(Object),
            expect.objectContaining({ requestedAction: { v: 1, kind: 'steer_if_active' } }),
        );
    });

    it('queues busy input when fallback catalog state lacks exact transition authority', async () => {
        const session = createSession({
            thinking: true,
            thinkingAt: 1_000,
            agentState: { capabilities: { inFlightSteerSupported: true, inFlightSteerAvailable: true } },
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                host: 'host',
                flavor: 'claude',
                version: '999.0.0',
                modelSelectionIntentV1: {
                    v: 1,
                    updatedAt: 10,
                    selection: {
                        agentTargetKey: 'backend:claude',
                        providerConnectionId: null,
                        modelId: 'claude-opus-4-7',
                    },
                },
                sessionModelsV1: {
                    v: 1,
                    agentId: 'claude',
                    updatedAt: 20,
                    currentModelId: 'claude-opus-4-7',
                    availableModels: [
                        { id: 'claude-opus-4-7', name: 'Fallback Opus 4.7' },
                    ],
                },
            },
        });
        const { port, enqueuePendingMessage } = createPort();

        await submitSessionUserMessage(port, {
            ...submitOptions(session),
            currentRunnerProcessIdentity: null,
        });

        expect(enqueuePendingMessage).toHaveBeenCalledWith(
            's1', 'hello', undefined, expect.any(Object),
            expect.objectContaining({ requestedAction: { v: 1, kind: 'enqueue' } }),
        );
    });

    it('permits busy steer when exact active selection matches on the current process', async () => {
        const currentRunnerProcessIdentity = {
            pid: 123,
            processStartTimeMs: 1_000,
        };
        const session = createSession({
            thinking: true,
            thinkingAt: 1_000,
            agentState: { capabilities: { inFlightSteerSupported: true, inFlightSteerAvailable: true } },
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                host: 'host',
                flavor: 'claude',
                version: '999.0.0',
                modelSelectionIntentV1: {
                    v: 1,
                    updatedAt: 20,
                    selection: {
                        agentTargetKey: 'backend:claude',
                        providerConnectionId: null,
                        modelId: 'claude-opus-4-7',
                    },
                },
                sessionModelsV1: {
                    v: 1,
                    agentId: 'claude',
                    updatedAt: 10,
                    currentModelId: 'claude-opus-4-7',
                    activeSelectionV1: {
                        v: 1,
                        selection: {
                            agentTargetKey: 'backend:claude',
                            providerConnectionId: null,
                            modelId: 'claude-opus-4-7',
                        },
                        source: 'runtime_apply',
                        runner: currentRunnerProcessIdentity,
                    },
                    availableModels: [
                        { id: 'claude-opus-4-7', name: 'Opus 4.7' },
                    ],
                },
            },
        });
        const { port, enqueuePendingMessage } = createPort();

        await submitSessionUserMessage(port, {
            ...submitOptions(session),
            currentRunnerProcessIdentity,
        });

        expect(enqueuePendingMessage).toHaveBeenCalledWith(
            's1', 'hello', undefined, expect.any(Object),
            expect.objectContaining({ requestedAction: { v: 1, kind: 'steer_if_active' } }),
        );
    });

    it('permits busy steer when exact active selection matches a configured backend target', async () => {
        const agentTargetKey = 'backend:claude:configured:claude';
        const currentRunnerProcessIdentity = {
            pid: 123,
            processStartTimeMs: 1_000,
        };
        const session = createSession({
            thinking: true,
            thinkingAt: 1_000,
            agentState: { capabilities: { inFlightSteerSupported: true, inFlightSteerAvailable: true } },
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                host: 'host',
                flavor: 'claude',
                version: '999.0.0',
                modelSelectionIntentV1: {
                    v: 1,
                    updatedAt: 20,
                    selection: {
                        agentTargetKey,
                        providerConnectionId: null,
                        modelId: 'claude-opus-4-7',
                    },
                },
                sessionModelsV1: {
                    v: 1,
                    agentId: 'claude',
                    updatedAt: 10,
                    currentModelId: 'claude-opus-4-7',
                    activeSelectionV1: {
                        v: 1,
                        selection: {
                            agentTargetKey,
                            providerConnectionId: null,
                            modelId: 'claude-opus-4-7',
                        },
                        source: 'runtime_apply',
                        runner: currentRunnerProcessIdentity,
                    },
                    availableModels: [
                        { id: 'claude-opus-4-7', name: 'Opus 4.7' },
                    ],
                },
            },
        });
        const { port, enqueuePendingMessage } = createPort();

        await submitSessionUserMessage(port, {
            ...submitOptions(session),
            currentRunnerProcessIdentity,
        });

        expect(enqueuePendingMessage).toHaveBeenCalledWith(
            's1', 'hello', undefined, expect.any(Object),
            expect.objectContaining({ requestedAction: { v: 1, kind: 'steer_if_active' } }),
        );
    });

    it('queues a configured-target model transition when exact active selection differs', async () => {
        const agentTargetKey = 'backend:claude:configured:claude';
        const currentRunnerProcessIdentity = {
            pid: 123,
            processStartTimeMs: 1_000,
        };
        const session = createSession({
            thinking: true,
            thinkingAt: 1_000,
            agentState: { capabilities: { inFlightSteerSupported: true, inFlightSteerAvailable: true } },
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                host: 'host',
                flavor: 'claude',
                version: '999.0.0',
                modelSelectionIntentV1: {
                    v: 1,
                    updatedAt: 20,
                    selection: {
                        agentTargetKey,
                        providerConnectionId: null,
                        modelId: 'claude-opus-4-7',
                    },
                },
                sessionModelsV1: {
                    v: 1,
                    agentId: 'claude',
                    updatedAt: 10,
                    currentModelId: 'claude-sonnet-4-6',
                    activeSelectionV1: {
                        v: 1,
                        selection: {
                            agentTargetKey,
                            providerConnectionId: null,
                            modelId: 'claude-sonnet-4-6',
                        },
                        source: 'runtime_readback',
                        runner: currentRunnerProcessIdentity,
                    },
                    availableModels: [
                        { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' },
                        { id: 'claude-opus-4-7', name: 'Opus 4.7' },
                    ],
                },
            },
        });
        const { port, enqueuePendingMessage } = createPort();

        await submitSessionUserMessage(port, {
            ...submitOptions(session),
            currentRunnerProcessIdentity,
        });

        expect(enqueuePendingMessage).toHaveBeenCalledWith(
            's1', 'hello', undefined, expect.any(Object),
            expect.objectContaining({ requestedAction: { v: 1, kind: 'enqueue' } }),
        );
    });

    it('mutates an already durable row through the canonical action operation', async () => {
        const session = createSession();
        const { port, enqueuePendingMessage, updatePendingRequestedAction } = createPort();

        await expect(submitSessionUserMessage(port, {
            ...submitOptions(session),
            localId: 'durable-1',
            existingDurablePendingMessage: true,
            requestedAction: { v: 1, kind: 'send_now' },
        })).resolves.toMatchObject({ type: 'success', persistence: 'pending', localId: 'durable-1' });

        expect(updatePendingRequestedAction).toHaveBeenCalledWith('s1', 'durable-1', { v: 1, kind: 'send_now' });
        expect(enqueuePendingMessage).not.toHaveBeenCalled();
    });

    it('wakes an inactive durable row with request identity only', async () => {
        const session = createSession({
            active: false,
            presence: 0,
            metadata: {
                machineId: 'm1', path: '/tmp/project', host: 'host', flavor: 'claude', version: '999.0.0',
                claudeSessionId: 'claude-1', claudeTranscriptPath: '/tmp/claude-1.jsonl',
            },
        });
        const { port, updatePendingRequestedAction, ensureSessionRuntimeForPendingInput } = createPort();

        await submitSessionUserMessage(port, {
            ...submitOptions(session),
            localId: 'durable-wake-1',
            existingDurablePendingMessage: true,
            requestedAction: { v: 1, kind: 'send_now' },
            resumeTargetOverride: { machineId: 'm1', directory: '/tmp/project' },
        });

        expect(updatePendingRequestedAction).toHaveBeenCalledBefore(ensureSessionRuntimeForPendingInput);
        expect(ensureSessionRuntimeForPendingInput).toHaveBeenCalledWith(expect.objectContaining({
            executionAuthorization: { provenance: 'user_request', requestId: 'durable-wake-1' },
        }));
    });

    it('distinguishes action persistence failure from a later wake failure', async () => {
        const session = createSession({
            active: false,
            presence: 0,
            metadata: {
                machineId: 'm1', path: '/tmp/project', host: 'host', flavor: 'claude', version: '999.0.0',
                claudeSessionId: 'claude-1', claudeTranscriptPath: '/tmp/claude-1.jsonl',
            },
        });
        const actionFailure = createPort();
        actionFailure.updatePendingRequestedAction.mockRejectedValueOnce(Object.assign(
            new Error('action not persisted'),
            { code: 'action-conflict' },
        ));

        await expect(submitSessionUserMessage(actionFailure.port, {
            ...submitOptions(session),
            localId: 'durable-action-failed',
            existingDurablePendingMessage: true,
            requestedAction: { v: 1, kind: 'send_now' },
            resumeTargetOverride: { machineId: 'm1', directory: '/tmp/project' },
        })).resolves.toMatchObject({
            type: 'wake_failed',
            persistence: 'pending',
            localId: 'durable-action-failed',
            errorCode: 'action-conflict',
            errorMessage: 'action not persisted',
        });
        expect(actionFailure.ensureSessionRuntimeForPendingInput).not.toHaveBeenCalled();

        const wakeFailures: SessionSubmitPort['ensureSessionRuntimeForPendingInput'][] = [
            async () => ({
                type: 'error' as const,
                errorCode: 'DAEMON_RPC_UNAVAILABLE' as const,
                errorMessage: 'wake timed out',
            }),
            async () => { throw new Error('wake response lost'); },
        ];
        for (const ensureSessionRuntimeForPendingInput of wakeFailures) {
            const wakeFailure = createPort();
            wakeFailure.port.ensureSessionRuntimeForPendingInput = vi.fn(ensureSessionRuntimeForPendingInput);

            await expect(submitSessionUserMessage(wakeFailure.port, {
                ...submitOptions(session),
                localId: 'durable-wake-failed',
                existingDurablePendingMessage: true,
                requestedAction: { v: 1, kind: 'send_now' },
                resumeTargetOverride: { machineId: 'm1', directory: '/tmp/project' },
            })).resolves.toMatchObject({
                type: 'wake_pending',
                persistence: 'pending',
                localId: 'durable-wake-failed',
                wake: { attempted: true, state: 'failed' },
            });
            expect(wakeFailure.updatePendingRequestedAction).toHaveBeenCalledBefore(wakeFailure.port.ensureSessionRuntimeForPendingInput as ReturnType<typeof vi.fn>);
        }
    });
});
