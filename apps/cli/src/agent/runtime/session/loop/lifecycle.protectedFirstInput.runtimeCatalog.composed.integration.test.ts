import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventV1Schema } from '@happier-dev/protocol';

import { createProtectedFirstInputHomeHarness } from '@/testkit/backends/protectedFirstInputHome.composed.testkit';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/lifecycle/runnerTerminationHandlers';
import { bindSessionProviderInputOutcome, createSessionProviderInputOutcomeBinding } from '@/agent/runtime/session/input/providerInputOutcome';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import { createSessionProviderInputConsumerSessionAdapter } from '@/agent/runtime/waitForNextPermissionModeMessage';
import { registerPermissionModeMessageQueueBinding } from '@/agent/runtime/permissions/bindModeQueue';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { createLifecycleParams } from './lifecycle.testkit';
import { runSessionLoopLifecycle } from './lifecycle';

let home: Awaited<ReturnType<typeof createProtectedFirstInputHomeHarness>>;
beforeAll(async () => { home = await createProtectedFirstInputHomeHarness(); }, 120_000);
afterAll(async () => { await home?.close(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['refused-before-acceptance', 'accepted-turn-failed'] as const)(
    'commits the protected first input before %s and settles exact Pending custody', async failure => {
        const registry = await pluginReloadController.acquireRuntimeRegistry({
            resolveRuntimeRegistry: async () => resolveExecutablePluginRuntimeRegistry({ contributes: getResolvedContributionRegistry(), pluginIds: [] }),
        });
        const text = 'Keep this first request\nincluding SECOND LINE';
        const fixture = await home.createSession(text, { metadata: { flavor: 'qwen' } });
        const session = fixture.client;
        const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
            mode => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts });
        let beforePendingMaterialize: (() => boolean | Promise<boolean>) | null | undefined;
        const consumer = createSessionProviderInputConsumer({ messageQueue: queue,
            session: createSessionProviderInputConsumerSessionAdapter(session),
            beforePendingMaterialize: () => beforePendingMaterialize?.() ?? false,
            reconcileWhenEmpty: 'skip', refreshBeforeQueuedBatch: false });
        let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
        let sequence = 0;
        const emit = (event: Readonly<Record<string, unknown>>) => listener?.(AgentSessionRuntimeEventV1Schema.parse({
            sessionId: fixture.sessionId, sequence: ++sequence, emittedAtMs: Date.now(), ...event,
        }));
        let providerReached = false;
        let providerDisposeTrace: string | undefined;
        let transcriptBeforeProviderFailure: Awaited<ReturnType<typeof fixture.readTranscript>> | null = null;
        const diagnostic = { code: 'provider_authentication_failed', severity: 'error' as const,
            message: 'The provider refused this first request.' };
        // Only the external Agent is substituted. The real receiver admission,
        // native event adapter, prompt loop, failure presenter and Home writes run.
        const provider: AgentSessionRuntime = {
            async send(request) {
                transcriptBeforeProviderFailure = await fixture.readTranscript();
                providerReached = true;
                if (failure === 'refused-before-acceptance') {
                    emit({ kind: 'input-rejected', inputIds: request.inputIds, diagnostic, retryable: false });
                    return { status: 'rejected', diagnostic, retryable: false };
                }
                emit({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
                emit({ kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' });
                emit({ kind: 'turn-failed', turnId: request.delivery.turnId, diagnostic });
                return { status: 'admitted' };
            },
            watch(value) { listener = value; return { dispose() { listener = undefined; } }; },
            dispose(reason) { providerDisposeTrace ??= new Error(`External Agent disposed: ${reason}`).stack; },
        };
        const runtime = createNativeAgentSessionOperations(provider, fixture.sessionId, undefined, undefined, undefined, undefined, undefined, {
            // This external Agent fixture does not request optional host services.
            context: { signal: new AbortController().signal } as AgentSessionRuntimeContext, cwd: '/tmp/project', connectedAccounts: [],
            capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
            cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
        });
        const outcomes = createSessionProviderInputOutcomeBinding({ getTarget: () => session });
        registerPermissionModeMessageQueueBinding({ session, queue,
            getCurrentPermissionMode: () => 'default', setCurrentPermissionMode: () => {} });
        const unbindOutcomes = bindSessionProviderInputOutcome({ runtime,
            observe: outcomes.observeProviderInputOutcome, wakePendingMaterialization: () => session.wakePendingMaterialization() });
        let promptFailure: string | null = null;
        // Qwen's catalog does not require native startup-instruction reopening;
        // this fixture supplies an already-open external Agent session.
        const base = createLifecycleParams({ policyAgentId: 'qwen', runPermissionModePromptLoopFn: options => {
            beforePendingMaterialize = options.beforePendingMaterialize;
            return runPermissionModePromptLoop({ ...options, inputConsumer: consumer,
                onPromptFailure: async (error, detail) => {
                    promptFailure = error instanceof Error ? error.stack ?? error.message : String(error);
                    await options.onPromptFailure?.(error, detail);
                } });
        } });
        let termination: ReturnType<typeof registerRunnerTerminationHandlers> | undefined;
        const running = runSessionLoopLifecycle({ ...base, session, runtime, hookRuntime: runtime,
            machineId: fixture.machineId, runtimeMetadata: fixture.metadata,
            registerProviderAcceptedEffect: outcomes.registerProviderAcceptedEffect,
            opts: { ...base.opts, credentials: { token: fixture.token, encryption: null } },
            config: { ...base.config, startRuntimeBeforeFirstPrompt: true,
                lifecycleHooks: { createCheckpointLifecycle: () => ({}) } },
            permissionModeState: { ...base.permissionModeState, messageQueue: queue },
            deps: { ...base.deps, registerRunnerTerminationHandlersFn: options => {
                termination = registerRunnerTerminationHandlers({ ...options, processLifecycleOwnership: 'caller', sessionExitReport: null, exit: () => undefined });
                return termination;
            } },
        });
        let loopResult: unknown = 'running';
        void running.then(() => { loopResult = 'completed'; }, error => { loopResult = String(error); });
        try {
            await vi.waitFor(async () => {
                expect(providerReached, JSON.stringify({ loopResult, promptFailure, providerDisposeTrace, packets: fixture.packets.map(packet => ({
                    event: packet.event, responseKeys: Object.keys(packet.response as object),
                })), transcript: (await fixture.readTranscript()).map(row => ({ seq: row.seq, localId: row.localId, role: row.messageRole })),
                pending: (await fixture.readPending()).map(row => ({ localId: row.localId,
                    state: row.deliveryState, reason: row.deliveryBlockedReason })) })).toBe(true);
                expect(transcriptBeforeProviderFailure).toMatchObject([{ localId: fixture.localId, messageRole: 'user',
                    content: { t: 'plain', v: { content: { type: 'text', text } } } }]);
                const transcript = await fixture.readTranscript();
                expect(transcript[0]).toMatchObject({ localId: fixture.localId, messageRole: 'user',
                    content: { t: 'plain', v: { content: { type: 'text', text } } } });
                expect(transcript.slice(1)).toEqual(expect.arrayContaining([expect.objectContaining({
                    messageRole: 'agent', content: expect.objectContaining({ t: 'plain', v: expect.objectContaining({
                        meta: expect.objectContaining({ runtimeIssueCode: diagnostic.code }),
                    }) }),
                })]));
                const pending = await fixture.readPending();
                expect(pending.filter(row => row.deliveryState === 'delivering')).toEqual([]);
                expect(session.hasPendingProviderInput(fixture.localId)).toBe(false);
                if (failure === 'refused-before-acceptance') {
                    expect(pending).toMatchObject([{ localId: fixture.localId, deliveryState: 'blocked',
                        deliveryBlockedReason: 'provider_rejected_before_acceptance',
                        content: { t: 'plain', v: { content: { type: 'text', text } } } }]);
                } else {
                    expect(pending).toEqual([]);
                }
            }, { timeout: 10_000 });
            if (failure === 'refused-before-acceptance') {
                await fixture.retryFirstInput();
                expect(await fixture.readPending()).toMatchObject([{ localId: fixture.localId, status: 'queued',
                    deliveryState: null, deliveryBlockedReason: null,
                    content: { t: 'plain', v: { content: { type: 'text', text } } } }]);
                expect((await fixture.readTranscript()).filter(row => row.localId === fixture.localId)).toHaveLength(1);
            }
        } finally {
            queue.close();
            termination?.requestTermination({ kind: 'signal', signal: 'SIGTERM' });
            await runtime.resetOrDisposeRuntime();
            await running.catch(() => undefined);
            unbindOutcomes();
            await fixture.close();
            await registry.release();
        }
    },
);
