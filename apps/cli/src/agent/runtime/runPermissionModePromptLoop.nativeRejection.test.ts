import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageQueue2 } from './modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt } from './permissions/queuedPrompt';
import { runPermissionModePromptLoop } from './runPermissionModePromptLoop';
import { createNativeAgentSessionOperations } from './registry/engineRegistry/nativeAgentSession';
import { createNativeAgentSessionEffectBoundaryError } from './registry/engineRegistry/nativeAgentSessionBoundaryError';
import type { PermissionMode } from '@/api/types';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { once } from 'node:events';
import { createNativeAgentRuntimeSessionPlanFixture, createExternalContributionFixtures, createLease,
    createSessionHostServiceOwners } from './registry/engineRegistry/nativeAgentSession.testkit';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { SessionTurnPublicationRejectedError } from '@/api/session/client/transport/mutations/deliverSessionTurnMutation';
import { spawnSupervisedPluginProcess } from '@/plugins/runtime/exec/processSupervisor';

describe('native prompt loop non-admission recovery', () => {
    it.each(['rejected', 'unavailable', 'cancelled', 'slow_cleanup'] as const)(
        'processes the next prompt after the first is %s before a turn starts',
        async (failure) => {
            const queue = new MessageQueue2<{ permissionMode: PermissionMode }, PermissionModeQueuedPrompt>(
                (mode) => mode.permissionMode,
                { batcher: combinePermissionModeQueuedPrompts },
            );
            queue.push({ text: 'first', localId: 'first' }, { permissionMode: 'default' });
            const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
            const delivered: string[] = [];
            let admissionCount = 0;
            let sequence = 0;
            const nativeSession: AgentSessionRuntime = {
                async send(request) {
                    if (request.inputIds[0] === 'first' && failure !== 'slow_cleanup') {
                        return { status: 'rejected', diagnostic: { code: 'not_ready', severity: 'error' }, retryable: true };
                    }
                    delivered.push(request.input.text);
                    for (const listener of listeners) {
                        listener({ sequence: ++sequence, sessionId: 'session-1', emittedAtMs: sequence,
                            kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
                        listener({ sequence: ++sequence, sessionId: 'session-1', emittedAtMs: sequence,
                            kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' });
                        listener({ sequence: ++sequence, sessionId: 'session-1', emittedAtMs: sequence,
                            kind: 'turn-complete', turnId: request.delivery.turnId });
                    }
                    return { status: 'admitted' };
                },
                watch(listener) {
                    listeners.add(listener);
                    return { dispose: () => { listeners.delete(listener); } };
                },
                dispose: async () => undefined,
            };
            const runtime = createNativeAgentSessionOperations(
                nativeSession, 'session-1', undefined, undefined, undefined, undefined,
                undefined, {
                    // No direct control is declared or exercised by this provider-boundary fixture.
                    context: {} as AgentSessionRuntimeContext,
                    cwd: '/repo', connectedAccounts: [],
                    capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
                    cancellation: { declared: false }, configuration: { declared: false },
                    compaction: { capability: null },
                }, undefined, [], undefined, undefined,
                async (_witness, { signal }) => {
                    if (++admissionCount === 1 && failure === 'slow_cleanup') {
                        let finishCleanup!: () => void;
                        const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
                        const prior = spawnSupervisedPluginProcess({ command: process.execPath,
                            args: ['-e', 'setInterval(() => {}, 1000)'], env: {},
                            // OS cleanup is delayed at its real boundary, not at the queue owner.
                            terminateProcessTree: async child => {
                                await cleanup;
                                const exited = once(child, 'exit');
                                child.kill('SIGKILL');
                                await exited;
                            },
                        });
                        try {
                            vi.useFakeTimers();
                            const disposal = prior.dispose();
                            void disposal.catch(() => undefined);
                            await vi.advanceTimersByTimeAsync(5_001);
                            vi.useRealTimers();
                            finishCleanup();
                            await disposal;
                        } finally {
                            vi.useRealTimers();
                            finishCleanup();
                            await prior.handle.wait();
                        }
                    } else if (admissionCount === 1 && failure !== 'rejected') {
                        if (failure === 'unavailable') {
                            throw createNativeAgentSessionEffectBoundaryError('authority_unavailable_before_effect');
                        }
                        queueMicrotask(() => { void runtime.cancelTurn(); });
                        await new Promise<void>((_resolve, reject) => {
                            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                        });
                    }
                    return { status: 'admitted' };
                },
            );
            const abort = new AbortController();
            let readyCount = 0;
            // Server transport boundary; the prompt loop and native lifecycle owner stay real.
            const session = createMutableApiSessionClientFixture({
                sessionId: 'session-1',
                metadata: createTestMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 0 }),
                overrides: {
                    enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: false }),
                    enqueueAgentMessageCommitted: async () => ({ persisted: true, delivered: false }),
                    getLastObservedMessageSeq: () => 0,
                    ensureMetadataSnapshot: async () => createTestMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 0 }),
                },
            });
            const loop = runPermissionModePromptLoop({
                providerName: 'Test Agent', agentMessageType: 'codex', explicitPermissionMode: undefined,
                session,
                messageQueue: queue,
                permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() },
                runtime,
                createOverrideSynchronizer: () => ({ syncFromMetadata: () => undefined, flushPendingAfterStart: async () => undefined }),
                messageBuffer: new MessageBuffer(),
                shouldExit: () => abort.signal.aborted,
                getAbortSignal: () => abort.signal,
                keepAlive: vi.fn(), setThinking: vi.fn(),
                sendReady: async () => {
                    if (++readyCount === 1) queue.push({ text: 'second', localId: 'second' }, { permissionMode: 'default' });
                    else abort.abort();
                },
                currentPermissionModeUpdatedAt: 0,
                setCurrentPermissionMode: vi.fn(), setCurrentPermissionModeUpdatedAt: vi.fn(),
                formatPromptErrorMessage: String,
                resolveFreshSessionSystemPrompt: async () => 'SESSION_PLAN',
                registerProviderAcceptedEffect: () => undefined,
            });
            try {
                await loop;
                expect(delivered).toEqual(failure === 'slow_cleanup'
                    ? ['SESSION_PLAN\n\nfirst', 'SESSION_PLAN\n\nsecond']
                    : ['SESSION_PLAN\n\nsecond']);
            } finally {
                abort.abort();
                await runtime.resetOrDisposeRuntime();
                await loop.catch(() => undefined);
            }
        },
    );
});

it.each(['admission', 'runtime_event', 'clear'] as const)('reopens the retained Team broker job after two turns, withdrawal and restoration (%s)', async (recoveryPath) => {
    const refusalDelivery = recoveryPath === 'runtime_event' ? 'runtime_event' : 'admission';
    const abort = new AbortController();
    const agentId = 'acme-team-recovery';
    const contributions = createExternalContributionFixtures(agentId);
    const queue = new MessageQueue2<{ permissionMode: PermissionMode }, PermissionModeQueuedPrompt>(mode => mode.permissionMode,
        { batcher: combinePermissionModeQueuedPrompts });
    const session = createMutableApiSessionClientFixture({ sessionId: 'session-1',
        metadata: createTestMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 0 }), overrides: {
            enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: false }),
            enqueueAgentMessageCommitted: async () => ({ persisted: true, delivered: false }),
        } });
    const permissionHandler = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[TeamRecovery]' });
    let revision = 4;
    let available = true;
    let index = 0;

    const admittedRevisions: number[] = [];
    const completed: string[] = [];
    const opens: string[] = [];
    const failures: unknown[] = [];
    const plan = await createNativeAgentRuntimeSessionPlanFixture({
        backend: contributions.backend, agent: contributions.agent, lease: createLease(agentId),
        createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
        // Daemon new-turn admission is an RPC boundary; the host path beneath it is real.
        authorizeNewTurn: async () => {
            if (!available && refusalDelivery === 'admission') throw new SessionTurnPublicationRejectedError({
                code: 'session_team_credential_binding_rejected', reason: 'access_removed' });
            return { status: 'admitted' };
        },
        // Daemon RPC is the process boundary. A fresh open uses its current catalog,
        // while each external Agent below retains the signed job it received.
        prepareTeamCredentialProviderBinding: async () => {
            if (!available) throw new Error('resource_forbidden');
            admittedRevisions.push(revision);
            return { providerBinding: { source: { kind: 'team_resource', resourceId: 'resource', resourceRevision: revision },
                model: { id: 'model', name: 'Model' }, materialization: { v: 1, kind: 'spawnEnv' },
                upstream: { protocol: 'openai-responses', normalizedUrl: 'http://127.0.0.1:8741/v1', credential: 'apiKey' } },
                environmentOverlay: [], additionalRedactionValues: [], cleanup: () => undefined };
        },
        runtime: { sessions: { open: async (request) => {
            opens.push(request.kind);
            const admittedRevision = request.providerBinding?.source?.kind === 'team_resource'
                ? request.providerBinding.source.resourceRevision : -1;
            let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
            let sequence = 0;
            const emit = (event: Record<string, unknown>) => listener?.({ sessionId: 'session-1',
                emittedAtMs: ++sequence, sequence, ...event } as AgentSessionRuntimeEvent);
            return {
                send: async input => {
                    emit({ kind: 'provider-session-id', providerSessionId: 'provider-conversation' });
                    emit({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
                    emit({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
                    if (!available) {
                        const refusal = new SessionTurnPublicationRejectedError({ code: 'session_team_credential_binding_rejected', reason: 'access_removed' });
                        emit({ kind: 'turn-failed', turnId: input.delivery.turnId, diagnostic: {
                            code: refusal.failureCause.code, severity: 'error', details: { v: 1, failureCause: refusal.failureCause } } });
                    } else if (admittedRevision !== revision) {
                        emit({ kind: 'turn-failed', turnId: input.delivery.turnId,
                            diagnostic: { code: 'operation_not_current', severity: 'error' } });
                    } else {
                        completed.push(input.inputIds[0]!);
                        emit({ kind: 'turn-complete', turnId: input.delivery.turnId });
                    }
                    return { status: 'admitted' as const };
                },
                watch(value) { listener = value; return { dispose() { listener = undefined; } }; },
                dispose: async () => undefined,
            };
        } } },
        sessionInput: buildPluginSessionBindingInput({
            credentials: { token: 'synthetic', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) } },
            directory: '/tmp/team-recovery', backendTarget: { kind: 'backend', backendId: agentId },
            modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'backend:' + agentId, providerConnectionId: null, modelId: 'model' } },
            teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource', teamId: 'team',
                expectedResourceRevision: 4, deliveryMode: 'brokered' }],
        }),
    });
    if (!plan.config.createSessionRuntime) throw new Error('Missing factory');
    const created = await plan.config.createSessionRuntime({ directory: '/tmp/team-recovery', metadata: {}, machineId: 'machine',
        session, transcriptSession: {}, messageBuffer: {}, mcpServers: {}, permissionHandler, getPermissionMode: () => 'default',
        setThinking: () => undefined, memoryRecallGuidanceEnabled: false } as never);
    queue.push({ text: 'first', localId: 'first' }, { permissionMode: 'default' });
    try {
        await runPermissionModePromptLoop({ providerName: 'Test', agentMessageType: 'codex', explicitPermissionMode: undefined, session, messageQueue: queue,
            permissionHandler, runtime: created.operations,
            createOverrideSynchronizer: () => ({ syncFromMetadata() {}, async flushPendingAfterStart() {} }),
            messageBuffer: new MessageBuffer(), shouldExit: () => abort.signal.aborted, getAbortSignal: () => abort.signal,
            keepAlive() {}, setThinking() {}, sendReady() {
                index++;
                if (index === 2) { revision = 5; available = false; }
                if (index === 3) { revision = 6; available = true; }
                const prompts = recoveryPath === 'clear'
                    ? ['first', 'second', 'withdrawn', '/clear', 'restored']
                    : ['first', 'second', 'withdrawn', 'restored'];
                if (index === prompts.length) { abort.abort(); return; }
                const text = prompts[index]!;
                queue.push({ text, localId: text === '/clear' ? 'clear' : text }, { permissionMode: 'default' });
            }, currentPermissionModeUpdatedAt: 0, setCurrentPermissionMode() {}, setCurrentPermissionModeUpdatedAt() {},
            formatPromptErrorMessage: String, registerProviderAcceptedEffect: () => undefined,
            onPromptFailure: async error => { failures.push(error); },
        });
        expect(completed).toEqual(['first', 'second', 'restored']);
        expect(admittedRevisions).toEqual([4, 6]);
        // A runtime diagnostic is already surfaced; an admission throw is published by the loop.
        expect(failures).toHaveLength(refusalDelivery === 'admission' ? 1 : 0);
        expect(opens).toEqual(['create', recoveryPath === 'clear' ? 'create' : 'resume']);
    } finally { abort.abort(); await created.operations.resetOrDisposeRuntime(); }
});
