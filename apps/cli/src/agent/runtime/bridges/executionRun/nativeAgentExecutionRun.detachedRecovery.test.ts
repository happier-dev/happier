import { describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
    AgentRuntime, AgentExecutionRunOpenRequest, AgentSessionSendRequest,
    AgentExecutionRunConversationEventV1,
    AgentExecutionRunConversationRuntimeV1,
    AgentExecutionRunRuntimeContextV1,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { createExecutionRunHostBackendFromConversationRuntime } from '../../../../../../../packages/plugin-sdk/src/agentRuntime/executionRun';
import { createNativeAgentExecutionRunContextLeaseFactory, createNativeAgentExecutionRunHostRuntime, type NativeAgentSessionContextLeaseFactory } from './nativeAgentExecutionRun';
import { resolveExecutionRunInputAuthority } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import { materializeActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

it.each([
    { interaction: 'approval', permissionMode: 'default', intent: 'delegate' },
    { interaction: 'question', permissionMode: 'default', intent: 'delegate' },
    { interaction: 'question', permissionMode: 'read_only', intent: 'delegate' },
    { interaction: 'question', permissionMode: 'default', intent: 'review' },
] as const)('fails a finite $intent $permissionMode run whose native $interaction cannot be presented', async ({ interaction, permissionMode, intent }) => {
    const runId = `unsupported-${interaction}-${permissionMode}`;
    const lease = { pluginId: 'acme.detached', pluginVersion: '1.0.0', agentId: 'acme.detached/default',
        localAgentId: 'default', occurrenceId: runId, isCurrent: () => true };
    const factory = {
        async open(request: AgentExecutionRunOpenRequest, context: AgentExecutionRunRuntimeContextV1) {
            if (request.kind === 'fork') throw new Error('No fork');
            // Only the provider-native conversation is a boundary fake. It can
            // finish normally after an unavailable prompt was denied by its SDK.
            return await createExecutionRunHostBackendFromConversationRuntime({ request, openConversation: async () => {
                let listener: ((event: AgentExecutionRunConversationEventV1) => void) | undefined;
                return {
                    watch(next) { listener = next; return { dispose() { listener = undefined; } }; },
                    async send(input) {
                        listener?.({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
                        if (interaction === 'approval') await context.services.interactions.requestApproval({
                            kind: 'approval', title: 'Write file',
                            subject: { kind: 'tool', name: 'Write', input: { path: '/repo/a', content: 'changed' } },
                        });
                        else await context.services.interactions.askQuestions({ kind: 'questions', title: 'Choose scope',
                            questions: [{ id: 'scope', prompt: 'Which scope?', type: 'text', required: true }],
                        });
                        listener?.({ kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant', text: 'Partial answer' });
                        listener?.({ kind: 'turn-complete', turnId: input.delivery.turnId });
                        return { status: 'admitted' as const };
                    },
                    async dispose() {},
                };
            } });
        },
    };
    const start = { intent, runClass: 'bounded', retentionPolicy: 'ephemeral', ioMode: 'request_response' } as const;
    const host = createNativeAgentExecutionRunHostRuntime({
        runtime: { sessions: { async open() { throw new Error('No Session identity'); }, executionRunContextV1: factory } },
        executionRunContextV1: factory, lease, supportsResume: false,
        options: { cwd: '/repo', runId, scope: 'detached', backendId: lease.agentId, permissionMode, start },
        createExecutionRunContext: createNativeAgentExecutionRunContextLeaseFactory({ lease, runId, start, permissionMode,
            controllerOccurrenceId: `${runId}-controller`, callId: `${runId}-call`, sidechainId: `${runId}-sidechain`,
            runtimeRegistry: null, directory: '/repo', machineId: 'machine', accountSettings: null,
        }),
    });
    try {
        await host.provisionRuntime({ initialPrompt: 'Complete the helper task' });
        await expect(host.waitForTurnCompletion?.()).rejects.toMatchObject({ executionRunErrorCode: 'execution_run_interaction_unavailable' });
    } finally { await host.dispose(); }
});

it.each(['public', 'narrowed', 'no_tools'] as const)('keeps detached %s native approvals on the active input authority', async source => {
    const runId = `authority-${source}`;
    const permissionMode = source === 'public' ? 'read_only' : source === 'no_tools' ? 'no_tools' : 'yolo';
    const admitted = resolveExecutionRunInputAuthority({ permissionMode,
        ...(source === 'narrowed' ? {
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
            effectiveCallerPermissionMode: 'read-only',
        } : source === 'no_tools' ? {
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
        } : {}),
    });
    if (!admitted.ok) throw new Error(admitted.error);
    const lease = { pluginId: 'acme.detached', pluginVersion: '1.0.0', agentId: 'acme.detached/default',
        localAgentId: 'default', occurrenceId: 'authority-fixture', isCurrent: () => true };
    let context!: AgentExecutionRunRuntimeContextV1;
    let listener: ((event: AgentExecutionRunConversationEventV1) => void) | undefined;
    let readWitness: (() => AgentInvocationTurnAdmissionWitness | null) | undefined;
    let expectedAttribution: ReturnType<typeof materializeActionRequestAttributionV1>;
    let suppliedAttribution: typeof expectedAttribution;
    const approve = (name: string, input: { readonly [key: string]: JsonValue } = { path: '/repo/a' }) => context.services.interactions.requestApproval({ kind: 'approval', title: 'Native tool',
        subject: { kind: 'tool', name, input } });
    const factory = {
        async open(): Promise<never> { throw new Error('Retained input must use the conversation'); },
        async openConversation(_request: AgentExecutionRunOpenRequest, current: AgentExecutionRunRuntimeContextV1): Promise<AgentExecutionRunConversationRuntimeV1> {
            context = current;
            return {
                watch(next) { listener = next; return { dispose() { listener = undefined; } }; },
                async send(input, options) {
                    Object.assign(suppliedAttribution.requester ?? {}, { accountId: 'later-caller' });
                    expect(readWitness?.()?.actionRequestAttributionV1).toEqual(expectedAttribution);
                    expect(Object.isFrozen(readWitness?.()?.actionRequestAttributionV1)).toBe(true);
                    expect(input).not.toHaveProperty('actionRequestAttributionV1');
                    expect(options).not.toHaveProperty('actionRequestAttributionV1');
                    expect(options).not.toHaveProperty('effectiveCallerPermissionMode');
                    expect(options).toMatchObject({ permissionIntent: 'read-only' });
                    expect(input.causalPermissionAuthority).toEqual(admitted.causalPermissionAuthority);
                    listener?.({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
                    await expect(approve('Read')).resolves.toMatchObject({ status: source === 'no_tools' ? 'declined' : 'approved' });
                    await expect(approve('Write')).resolves.toMatchObject({ status: 'declined' });
                    await expect(approve('mcp__happier__settings_get', { anchor: 'voiceConversations.minSpeechMs' }))
                        .resolves.toMatchObject({ status: 'approved' });
                    await expect(approve('mcp__happier__session_stop', { sessionId: 'other-session' }))
                        .resolves.toMatchObject({ status: 'declined' });
                    await expect(approve('mcp__happier__settings_invoke', { anchor: 'voicePrivacy.forgetVoiceAgentMemory' }))
                        .resolves.toMatchObject({ status: 'declined' });
                    await expect(approve('mcp__happier__action_execute', {
                        actionId: 'settings.set', input: { anchor: 'voiceConversations.minSpeechMs', value: 1100 },
                    })).resolves.toMatchObject({ status: 'declined' });
                    listener?.({ kind: 'turn-complete', turnId: input.delivery.turnId });
                    return { status: 'admitted' };
                },
                async dispose() {},
            };
        },
    };
    const host = createNativeAgentExecutionRunHostRuntime({
        runtime: { sessions: { async open() { throw new Error('No Session identity'); }, executionRunContextV1: factory } },
        executionRunContextV1: factory, retainedConversation: true, lease,
        options: { cwd: '/repo', runId, scope: 'detached', backendId: lease.agentId, permissionMode,
            start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable', ioMode: 'streaming' } },
        supportsResume: false,
        createExecutionRunContext: createNativeAgentExecutionRunContextLeaseFactory({ lease, runId,
            controllerOccurrenceId: 'authority-controller', callId: 'authority-call', sidechainId: 'authority-sidechain',
            runtimeRegistry: null, directory: '/repo', machineId: 'authority-machine', accountSettings: null,
            permissionMode, start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable', ioMode: 'streaming' },
            createInvocationServices: async ({ readActiveTurnAdmissionWitness }) => {
                readWitness = readActiveTurnAdmissionWitness;
                return createUnavailablePluginServices();
            },
        }),
    });
    try {
        await host.provisionRuntime();
        for (const localId of ['first', 'second']) {
            expectedAttribution = materializeActionRequestAttributionV1({ requestRef: localId,
                requester: localId === 'first' ? { serverId: 'home', accountId: 'bob' } : null,
                persona: { serverId: 'home', sessionId: 'bot-session' }, origin: null });
            suppliedAttribution = structuredClone(expectedAttribution);
            await host.deliverInput(runId, { text: localId }, { localId, causalPermissionAuthority: admitted.causalPermissionAuthority,
                effectiveCallerPermissionMode: admitted.effectiveCallerPermissionMode, actionRequestAttributionV1: suppliedAttribution });
            await host.waitForTurnCompletion?.();
            await expect(approve('Read')).resolves.toMatchObject({ status: 'declined' });
        }
    } finally { await host.dispose(); }
});

describe.each([
    { custody: 'accepted', diagnosticCode: 'provider_capacity', lifetimes: ['finite', 'retained'] },
    { custody: 'custody-unknown', diagnosticCode: 'acp_input_custody_unknown', lifetimes: ['finite', 'retained'] },
    { custody: 'rejected', diagnosticCode: 'acp_input_rejected_before_effect', lifetimes: ['finite', 'retained'] },
    { custody: 'custody-unknown', diagnosticCode: 'codex_send_outcome_unknown', lifetimes: ['retained'] },
    { custody: 'rejected', diagnosticCode: 'provider_capacity', lifetimes: ['retained'] },
] as const)('detached $custody native input ($diagnosticCode)', ({ custody, diagnosticCode, lifetimes }) => {
it.each(lifetimes)('recovers only accepted failure, never an unknown-custody input (%s)', async lifetime => {
    const requests: AgentExecutionRunOpenRequest[] = [];
    const sends: AgentSessionSendRequest[] = [];
    // This provider-native conversation is the sole external fake. The SDK's
    // truthful detached conversation adapter and host lifecycle remain real.
    const openConversation = async (request: AgentExecutionRunOpenRequest): Promise<AgentExecutionRunConversationRuntimeV1> => {
        requests.push(request);
                let listener: ((event: AgentExecutionRunConversationEventV1) => void) | undefined;
                return {
                    watch(next) { listener = next; next({ kind: 'provider-session-id', providerSessionId: 'detached-native-original' }); return { dispose() { listener = undefined; } }; },
                    async send(input) {
                        sends.push(input);
                        if (sends.length === 1 && custody !== 'accepted') {
                            if (custody === 'custody-unknown') listener?.({ kind: 'input-custody-unknown', inputIds: input.inputIds,
                                issue: { code: diagnosticCode, severity: 'error', details: { requestErrorCode: 429 } } });
                            else listener?.({ kind: 'input-rejected', inputIds: input.inputIds, retryable: true,
                                diagnostic: { code: diagnosticCode, severity: 'error', details: { requestErrorCode: 429 } } });
                            return { status: 'admitted' as const };
                        }
                        listener?.({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
                        listener?.({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
                        if (sends.length === 1) {
                            listener?.({ kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant', text: 'Partial detached work. ' });
                            listener?.({ kind: 'turn-failed', turnId: input.delivery.turnId,
                                diagnostic: { code: 'provider_capacity', severity: 'error' } });
                            // Native process exit can repeat terminal noise after
                            // the correlated turn failure starts host recovery.
                            listener?.({ kind: 'runtime-ended', cause: 'processExited', retryable: true,
                                diagnostic: { code: 'native_process_exited', severity: 'error' } });
                        } else {
                            listener?.({ kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant', text: 'Detached continuation.' });
                            listener?.({ kind: 'turn-complete', turnId: input.delivery.turnId });
                        }
                        return { status: 'admitted' as const };
                    },
                    async dispose() {},
                };
    };
    const factory = {
        openConversation,
        async open(request: AgentExecutionRunOpenRequest) {
            if (request.kind === 'fork') throw new Error('Fixture does not offer fork');
            return await createExecutionRunHostBackendFromConversationRuntime({ request,
                readCheckpointId: event => event.kind === 'provider-session-id' ? event.providerSessionId : null,
                openConversation: () => openConversation(request),
            });
        },
    };
    const runtime: AgentRuntime = { sessions: { async open() { throw new Error('Unexpected Session'); }, executionRunContextV1: factory } };
    const recovery = vi.fn<NonNullable<CreateCliExecutionRunBackendParams['prepareRuntimeFailureRecovery']>>(async () => ({
        status: 'continue', input: 'Continue where you left off', async prepareResume() { return undefined; },
    }));
    const host = createNativeAgentExecutionRunHostRuntime({ runtime, executionRunContextV1: factory,
        ...(lifetime === 'retained' ? { retainedConversation: true } : {}),
        lease: { pluginId: 'acme.detached', pluginVersion: '1.0.0', agentId: 'acme.detached/default', localAgentId: 'default', occurrenceId: 'detached-fixture', isCurrent: () => true },
        options: { cwd: '/repo', runId: 'detached-recovery', scope: 'detached', backendId: 'acme.detached/default', permissionMode: 'read_only',
            start: { intent: 'review', runClass: 'bounded', retentionPolicy: 'resumable' }, prepareRuntimeFailureRecovery: recovery },
        supportsResume: true,
    });
    const messages: AgentMessage[] = [];
    host.subscribeMessages(message => messages.push(message));
    try {
        await host.provisionRuntime({ initialPrompt: 'Perform effect once' });
        if (custody !== 'accepted') {
            await expect(host.waitForTurnCompletion?.()).rejects.toThrow(diagnosticCode);
            expect(recovery).not.toHaveBeenCalled();
            expect(requests).toHaveLength(1);
            expect(sends).toHaveLength(1);
            return;
        }
        await host.waitForTurnCompletion?.();
        expect(recovery).toHaveBeenCalledOnce();
        expect(requests).toMatchObject([{ kind: 'create' }, { kind: 'resume', checkpointId: 'detached-native-original' }]);
        expect(sends.map(send => send.input.text)).toEqual(['Perform effect once', 'Continue where you left off']);
        expect(sends[1]?.inputIds).not.toEqual(sends[0]?.inputIds);
        expect(messages.some(message => message.type === 'status' && message.status === 'error')).toBe(false);
        expect(JSON.stringify(messages)).toContain('Partial detached work. ');
        expect(JSON.stringify(messages)).toContain('Detached continuation.');
    } finally { await host.dispose(); }
});
});

it.each(['retained', 'finite'] as const)('keeps detached %s conversation lifetime distinct from turn completion', async kind => {
    const sends: AgentSessionSendRequest[] = [];
    const opens: AgentExecutionRunOpenRequest[] = [];
    let listener: ((event: AgentExecutionRunConversationEventV1) => void) | undefined;
    let readWitness: Parameters<NonNullable<NativeAgentSessionContextLeaseFactory['bindInvocationServices']>>[0]['readActiveTurnAdmissionWitness'];
    const dispose = vi.fn(async () => {});
    const conversation: AgentExecutionRunConversationRuntimeV1 = {
        watch(next) { listener = next; return { dispose() { listener = undefined; } }; },
        async send(input, options) {
            sends.push(input);
            expect(options).not.toHaveProperty('effectiveCallerPermissionMode');
            if (kind === 'finite') expect(options).not.toHaveProperty('permissionIntent');
            else expect(options).toMatchObject({ permissionIntent: 'read-only' });
            if (kind === 'retained') expect(readWitness?.()).toMatchObject({
                inputId: input.inputIds[0], turnId: input.delivery.turnId,
                causalPermissionAuthority: input.causalPermissionAuthority,
                callerPermissionMode: 'read-only',
            });
            // A delayed duplicate from the previous turn must not settle this one.
            if (sends.length > 1) listener?.({ kind: 'turn-complete', turnId: sends[0]!.delivery.turnId });
            listener?.({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
            listener?.({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
            listener?.({ kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant', text: `reply-${sends.length}` });
            listener?.({ kind: 'turn-complete', turnId: input.delivery.turnId });
            return { status: 'admitted' };
        },
        dispose,
    };
    const factory = {
        async open(request: AgentExecutionRunOpenRequest) {
            opens.push(request);
            if (request.kind === 'fork') throw new Error('No fork');
            return await createExecutionRunHostBackendFromConversationRuntime({ request, openConversation: () => conversation });
        },
        async openConversation(request: AgentExecutionRunOpenRequest, context: AgentExecutionRunRuntimeContextV1) {
            expect(context.scope).toEqual({ kind: 'execution_run', executionRunId: 'detached-lifetime' });
            expect('session' in context).toBe(false);
            opens.push(request); return conversation;
        },
    };
    const host = createNativeAgentExecutionRunHostRuntime({
        async bindInvocationServices(input) { readWitness = input.readActiveTurnAdmissionWitness; return input.services; },
        runtime: { sessions: { async open() { throw new Error('Detached Run must not open a Happier Session'); }, executionRunContextV1: factory } },
        executionRunContextV1: factory,
        ...(kind === 'retained' ? { retainedConversation: true as const } : {}),
        lease: { pluginId: 'acme.detached', pluginVersion: '1.0.0', agentId: 'acme.detached/default', localAgentId: 'default', occurrenceId: 'retained-fixture', isCurrent: () => true },
        options: { cwd: '/repo', runId: 'detached-lifetime', scope: 'detached', backendId: 'acme.detached/default', permissionMode: 'read_only',
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
            start: { intent: 'delegate', runClass: kind === 'retained' ? 'long_lived' : 'bounded', retentionPolicy: 'resumable' } },
        supportsResume: false,
    });
    const messages: AgentMessage[] = [];
    host.subscribeMessages(message => messages.push(message));
    try {
        await host.provisionRuntime({ initialPrompt: 'first' });
        await host.waitForTurnCompletion?.();
        if (kind === 'finite') {
            await expect(host.deliverInput('detached-lifetime', { text: 'second' }, { localId: 'second' })).rejects.toThrow('already terminated');
            expect(sends.map(send => send.input.text)).toEqual(['first']);
        } else {
            for (const text of ['second', 'third']) {
                await host.deliverInput('detached-lifetime', { text }, { localId: text,
                    effectiveCallerPermissionMode: 'read-only',
                    causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: text === 'second' ? 'read-only' : 'yolo' } });
                await host.waitForTurnCompletion?.();
            }
            expect(sends.map(send => send.input.text)).toEqual(['first', 'second', 'third']);
            expect(new Set(sends.map(send => send.delivery.turnId)).size).toBe(3);
            expect(dispose).not.toHaveBeenCalled();
            expect(readWitness?.()).toBeNull();
            expect(messages.filter(message => message.type === 'model-output').map(message => message.textDelta)).toEqual(['reply-1', 'reply-2', 'reply-3']);
        }
        expect(opens).toHaveLength(1);
    } finally { await host.dispose(); }
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
});

it.each(['unsupported', 'supported', 'pending-custody'] as const)('preserves an idle retained native failure without replaying a completed input (resume=%s)', async resume => {
    let listener: ((event: AgentExecutionRunConversationEventV1) => void) | undefined;
    const send = vi.fn<AgentExecutionRunConversationRuntimeV1['send']>(async input => {
        listener?.({ kind: 'turn-complete', turnId: input.delivery.turnId });
        return { status: 'admitted' };
    });
    const dispose = vi.fn(async () => {});
    const openConversation = vi.fn(async (): Promise<AgentExecutionRunConversationRuntimeV1> => ({
        watch(next) { listener = next; next({ kind: 'provider-session-id', providerSessionId: 'idle-native-original' });
            return { dispose() { listener = undefined; } }; }, send, dispose,
    }));
    const recovery = vi.fn<NonNullable<CreateCliExecutionRunBackendParams['prepareRuntimeFailureRecovery']>>(async () => ({
        status: 'continue', input: 'must not replay completed work', async prepareResume() { return undefined; },
    }));
    const factory = { async open(): Promise<never> { throw new Error('Finite open is not retained'); }, openConversation };
    const lease = { pluginId: 'acme.detached', pluginVersion: '1.0.0', agentId: 'acme.detached/default',
        localAgentId: 'default', occurrenceId: 'idle-fixture', isCurrent: () => true };
    let acknowledgeCustody!: () => void;
    // Durable host persistence is an external boundary; hold its acknowledgement.
    const custody = new Promise<void>(resolve => { acknowledgeCustody = resolve; });
    const contextFactory = Object.assign(createNativeAgentExecutionRunContextLeaseFactory({ lease, runId: 'detached-idle',
        controllerOccurrenceId: 'idle-controller', callId: 'idle-call', sidechainId: 'idle-sidechain',
        runtimeRegistry: null, directory: '/repo', machineId: 'idle-machine', accountSettings: null,
        permissionMode: 'read_only', start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable' },
    }), { onTurnTerminal: () => custody });
    const host = createNativeAgentExecutionRunHostRuntime({
        runtime: { sessions: { async open() { throw new Error('No Session identity'); }, executionRunContextV1: factory } },
        executionRunContextV1: factory, retainedConversation: true,
        lease,
        ...(resume === 'pending-custody' ? { createExecutionRunContext: contextFactory } : {}),
        options: { cwd: '/repo', runId: 'detached-idle', scope: 'detached', backendId: 'acme.detached/default', permissionMode: 'read_only',
            start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable' }, prepareRuntimeFailureRecovery: recovery },
        supportsResume: resume !== 'unsupported',
    });
    try {
        await host.provisionRuntime({ initialPrompt: 'first' });
        const completedTurn = host.waitForTurnCompletion?.();
        void completedTurn?.catch(() => undefined);
        if (resume !== 'pending-custody') await completedTurn;
        listener?.({ kind: 'runtime-ended', cause: 'processExited', retryable: true,
            diagnostic: { code: 'native_process_exited', severity: 'error' } });
        expect(recovery).not.toHaveBeenCalled();
        acknowledgeCustody();
        await expect(completedTurn).resolves.toBeUndefined();
        await vi.waitFor(async () => {
            await expect(host.waitForTurnCompletion?.()).rejects.toThrow('native_process_exited');
        });
        await expect(host.deliverInput('detached-idle', { text: 'must not run' }, { localId: 'second' })).rejects.toThrow('already terminated');
        expect(openConversation).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledOnce();
    } finally { await host.dispose(); }
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
});
