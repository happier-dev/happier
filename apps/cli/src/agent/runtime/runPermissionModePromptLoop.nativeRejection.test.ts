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
import { once } from 'node:events';
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
