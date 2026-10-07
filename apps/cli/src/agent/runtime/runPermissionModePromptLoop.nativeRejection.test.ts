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

describe('native prompt loop non-admission recovery', () => {
    it.each(['rejected', 'unavailable', 'cancelled'] as const)(
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
                    if (request.inputIds[0] === 'first') {
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
                    manualCompaction: { declared: false },
                }, undefined, [], undefined, undefined,
                async (_witness, { signal }) => {
                    if (++admissionCount === 1 && failure !== 'rejected') {
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
                await vi.waitFor(() => expect(delivered).toEqual(['SESSION_PLAN\n\nsecond']), { timeout: 1000 });
                await loop;
            } finally {
                abort.abort();
                await runtime.resetOrDisposeRuntime();
                await loop.catch(() => undefined);
            }
        },
    );
});
