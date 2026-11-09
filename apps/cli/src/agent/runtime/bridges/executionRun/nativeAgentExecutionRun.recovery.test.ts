import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
    AgentRuntime, AgentSessionRuntime, AgentSessionRuntimeEvent, AgentSessionOpenRequest,
    AgentSessionSendRequest, AgentLaunchEnvironment,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import { createVoiceSessionContextLease } from './testkit/nativeSessionContext';
import {
    createNativeAgentSessionExecutionRunHostRuntime,
    createNativeAgentSessionInteractionHostRuntime,
    type NativeAgentSessionContextLeaseFactory,
} from './nativeAgentExecutionRun';

afterEach(() => vi.restoreAllMocks());

type EventInput = AgentSessionRuntimeEvent extends infer E
    ? E extends AgentSessionRuntimeEvent ? Omit<E, 'sessionId' | 'sequence' | 'emittedAtMs'> : never : never;
type RecoveryResult = Readonly<{ status: 'continue'; input: string; prepareResume(): Promise<AgentLaunchEnvironment | undefined> }>
    | Readonly<{ status: 'failed' }>;

describe.each(['finite', 'retained'] as const)('native %s Run recovery before terminalization', kind => {
    function fixture(prepareRuntimeFailureRecovery: (input: Readonly<{
        diagnostic: Extract<AgentSessionRuntimeEvent, { kind: 'turn-failed' }>['diagnostic'];
        providerSessionId: string; interruptedOriginId: string; signal: AbortSignal;
    }>) => Promise<RecoveryResult>, behavior: Readonly<{
        resumeFailure?: Error;
        holdContinuation?: boolean;
        failureCount?: number;
        connectedServiceRuntimeTurnCompleted?: () => Promise<void>;
        unknownCustodyOnSend?: number;
        resumedProviderSessionId?: string;
        rekeyBeforeFailure?: string;
        agentEnvironment?: Readonly<Record<string, string>>;
    }> = {}) {
        const { resumeFailure, holdContinuation = false, failureCount = 1,
            connectedServiceRuntimeTurnCompleted, unknownCustodyOnSend = 0 } = behavior;
        const opens: AgentSessionOpenRequest[] = [];
        const sends: AgentSessionSendRequest[] = [];
        const disposals: number[] = [];
        const policyUpdates: number[] = [];
        let policyListener: ((policy: NonNullable<AgentSessionOpenRequest['mcpToolPolicy']>) => void) | undefined;
        const nativeListeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        let sequence = 0;
        const runtime: AgentRuntime = { sessions: { async open(request): Promise<AgentSessionRuntime> {
            const occurrence = opens.push(request);
            if (request.kind === 'resume' && resumeFailure) throw resumeFailure;
            let listener: ((event: AgentSessionRuntimeEvent) => void) | null = null;
            const emit = (event: EventInput) => listener?.({
                ...event, sessionId: 'session-parent', sequence: ++sequence, emittedAtMs: sequence,
            } as AgentSessionRuntimeEvent);
            return {
                watch(next) {
                    listener = next; nativeListeners.add(next);
                    emit({ kind: 'provider-session-id', providerSessionId: request.kind === 'resume' ? behavior.resumedProviderSessionId ?? request.providerSessionId : 'vendor-original' });
                    return { dispose() { nativeListeners.delete(next); listener = null; } };
                },
                async send(request) {
                    sends.push(request);
                    const turnId = request.delivery.turnId;
                    if (sends.length === unknownCustodyOnSend) {
                        emit({ kind: 'input-custody-unknown', inputIds: request.inputIds,
                            issue: { code: 'acp_input_custody_unknown', severity: 'error', details: { requestErrorCode: 429 } } });
                        emit({ kind: 'turn-failed', turnId, diagnostic: { code: 'provider_quota', severity: 'error' } });
                        return { status: 'admitted' as const };
                    }
                    emit({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
                    emit({ kind: 'turn-start', turnId, startedBy: 'host' });
                    if (sends.length <= failureCount) {
                        if (behavior.rekeyBeforeFailure) emit({ kind: 'provider-session-id', providerSessionId: behavior.rekeyBeforeFailure });
                        emit({ kind: 'message-delta', turnId, channel: 'assistant', text: 'Partial work. ' });
                        emit({ kind: 'turn-failed', turnId, diagnostic: {
                            code: 'provider_capacity', severity: 'error', message: 'Provider temporarily unavailable',
                            details: { runtimeAuthClassification: {
                                kind: 'capacity', serviceId: 'happier.agent.codex/openai-codex', profileId: 'account-a', groupId: 'pool',
                                groupGeneration: 1, expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', resetsAtMs: null,
                                source: 'structured_provider_error',
                            } },
                        } });
                    } else {
                        emit({ kind: 'message-delta', turnId, channel: 'assistant', text: 'Continued work.' });
                        if (!holdContinuation) emit({ kind: 'turn-complete', turnId });
                    }
                    return { status: 'admitted' as const };
                },
                async cancel({ turnId }) { emit({ kind: 'turn-cancelled', turnId, cause: 'user' }); return { status: 'requested' as const, turnId }; },
                async dispose() { disposals.push(occurrence); },
                async updateConfiguration() { policyUpdates.push(occurrence); return { status: 'applied' as const, changed: [] }; },
            };
        } } };
        const options = {
            cwd: '/repo', runId: `recovery-${kind}`, scope: 'session_owned' as const,
            backendId: 'acme.recovery/default', permissionMode: 'read_only',
            start: { intent: 'review', runClass: kind === 'finite' ? 'bounded' as const : 'long_lived' as const, retentionPolicy: 'resumable' as const },
            prepareRuntimeFailureRecovery,
            ...(connectedServiceRuntimeTurnCompleted ? { connectedServiceRuntimeTurnCompleted } : {}),
            configuration: {
                mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
                permissionIntent: { value: null, updatedAtMs: 0 }, options: {},
            },
        } satisfies CreateCliExecutionRunBackendParams;
        const common = {
            runtime, options,
            lease: { pluginId: 'acme.recovery', pluginVersion: '1.0.0', agentId: 'acme.recovery/default', localAgentId: 'default', occurrenceId: 'recovery-fixture', isCurrent: () => true },
            createSessionContext: ({ services, signal }: Parameters<NativeAgentSessionContextLeaseFactory>[0]) => ({
                ...createVoiceSessionContextLease({ services, signal, async dispose() {} }),
                ...(behavior.agentEnvironment ? { agentEnvironment: behavior.agentEnvironment } : {}),
                subscribeMcpToolPolicy(listener: (policy: NonNullable<AgentSessionOpenRequest['mcpToolPolicy']>) => void) {
                    policyListener = listener;
                    return () => { policyListener = undefined; };
                },
            }),
        };
        const host = kind === 'finite'
            ? createNativeAgentSessionExecutionRunHostRuntime({ ...common, supportsResume: true })
            : createNativeAgentSessionInteractionHostRuntime({ ...common, sessionCapabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true, configuration: true } });
        const messages: AgentMessage[] = [];
        host.subscribeMessages(message => messages.push(message));
        return { host, opens, sends, messages, disposals, nativeListeners, policyUpdates, publishPolicy() { policyListener?.({}); } };
    }

    it('keeps partial work and resumes the same native conversation with continuation only', async () => {
        let resolve!: (result: RecoveryResult) => void;
        const response = new Promise<RecoveryResult>(r => { resolve = r; });
        const recovery = vi.fn(async () => await response);
        const f = fixture(recovery);
        try {
            await f.host.provisionRuntime({ initialPrompt: 'Perform effect once' });
            await vi.waitFor(() => expect(recovery).toHaveBeenCalledOnce());
            expect(f.messages.some(message => message.type === 'status' && message.status === 'error')).toBe(false);
            expect(f.disposals).toHaveLength(0);
            const completion = f.host.waitForTurnCompletion?.();
            resolve({ status: 'continue', input: 'Continue where you left off', async prepareResume() {
                expect(f.disposals).toEqual([1]);
                return { values: { AUTH_HOME: '/run/account-b' }, unset: [] };
            } });
            await completion;
            expect(f.opens).toMatchObject([{ kind: 'create' }, { kind: 'resume', providerSessionId: 'vendor-original', launchEnvironment: { values: { AUTH_HOME: '/run/account-b' } } }]);
            expect(f.sends.map(send => send.input.text)).toEqual(['Perform effect once', 'Continue where you left off']);
            expect(f.sends[1]?.inputIds).not.toEqual(f.sends[0]?.inputIds);
            expect(f.messages.some(message => message.type === 'status' && message.status === 'error')).toBe(false);
            expect(JSON.stringify(f.messages)).toContain('Partial work. ');
            expect(JSON.stringify(f.messages)).toContain('Continued work.');
        } finally { await f.host.dispose(); }
    });

    it('resumes the latest provider-reported conversation after a same-Session rekey', async () => {
        const recovery = vi.fn(async (): Promise<RecoveryResult> => ({
            status: 'continue', input: 'Continue', async prepareResume() { return undefined; },
        }));
        const f = fixture(recovery, { rekeyBeforeFailure: 'vendor-after-clear' });
        try {
            await f.host.provisionRuntime({ initialPrompt: 'Perform work' });
            await f.host.waitForTurnCompletion?.();
            expect(recovery).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: 'vendor-after-clear' }));
            expect(f.opens).toMatchObject([{ kind: 'create' }, { kind: 'resume', providerSessionId: 'vendor-after-clear' }]);
            expect(f.sends.map(send => send.input.text)).toEqual(['Perform work', 'Continue']);
        } finally { await f.host.dispose(); }
    });

    it('keeps the Session MCP context after a recovery launch environment overlay', async () => {
        const contextKey = 'HAPPIER_SESSION_MCP_CONTEXT_FILE';
        const f = fixture(async () => ({ status: 'continue', input: 'Continue', async prepareResume() {
            return { values: { AUTH_HOME: '/run/account-b', [contextKey]: '/stale-context' }, unset: [contextKey] };
        } }), { agentEnvironment: { [contextKey]: '/run/current-session-mcp.json' } });
        try {
            await f.host.provisionRuntime({ initialPrompt: 'Perform work' });
            await f.host.waitForTurnCompletion?.();
            expect(f.opens).toHaveLength(2);
            for (const request of f.opens) {
                expect(request.launchEnvironment?.values[contextKey]).toBe('/run/current-session-mcp.json');
                expect(request.launchEnvironment?.unset).not.toContain(contextKey);
            }
            expect(f.opens[1]?.launchEnvironment?.values.AUTH_HOME).toBe('/run/account-b');
        } finally { await f.host.dispose(); }
    });

    it('cancels backoff without a native continuation or parent cancellation', async () => {
        const recovery = vi.fn(async ({ signal }: Readonly<{ signal: AbortSignal }>) => await new Promise<RecoveryResult>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }));
        const f = fixture(recovery);
        try {
            const { runtimeId } = await f.host.provisionRuntime({ initialPrompt: 'Perform effect once' });
            await vi.waitFor(() => expect(recovery).toHaveBeenCalledOnce());
            const completion = f.host.waitForTurnCompletion?.();
            const observed = completion?.catch(() => undefined);
            await f.host.cancel(runtimeId);
            await observed;
            expect(f.sends).toHaveLength(1);
            expect(f.opens).toHaveLength(1);
            expect(f.messages.some(message => message.type === 'status' && message.status === 'error')).toBe(false);
        } finally { await f.host.dispose(); }
    });

    it('retains ordinary terminal failure when the shared policy refuses recovery', async () => {
        const recovery = vi.fn(async (): Promise<RecoveryResult> => ({ status: 'failed' }));
        const f = fixture(recovery);
        try {
            await f.host.provisionRuntime({ initialPrompt: 'Perform effect once' });
            await expect(f.host.waitForTurnCompletion?.()).rejects.toBeInstanceOf(Error);
            expect(f.sends).toHaveLength(1);
            expect(f.opens).toHaveLength(1);
        } finally { await f.host.dispose(); }
    });

    it('preserves a typed native resume refusal instead of masking it with the preceding capacity failure', async () => {
        const f = fixture(async () => ({ status: 'continue', input: 'Continue', async prepareResume() { return undefined; } }),
            { resumeFailure: Object.assign(new Error('Native state unavailable'), { code: 'native_resume_state_missing' }) });
        try {
            await f.host.provisionRuntime({ initialPrompt: 'Perform effect once' });
            await expect(f.host.waitForTurnCompletion?.()).rejects.toThrow('Native state unavailable');
            expect(f.sends).toHaveLength(1);
        } finally { await f.host.dispose(); }
    });

    it('applies live MCP policy changes to the resumed native writer, not the retired one', async () => {
        const f = fixture(async () => ({ status: 'continue', input: 'Continue', async prepareResume() { return undefined; } }), { holdContinuation: true });
        try {
            await f.host.provisionRuntime({ initialPrompt: 'Perform effect once' });
            await vi.waitFor(() => expect(f.sends).toHaveLength(2));
            f.publishPolicy();
            await vi.waitFor(() => expect(f.policyUpdates).toEqual([2]));
        } finally { await f.host.dispose(); }
    });

    it('correlates a second capacity failure to its fresh native continuation attempt', async () => {
        const recovery = vi.fn<NonNullable<CreateCliExecutionRunBackendParams['prepareRuntimeFailureRecovery']>>(async () => ({ status: 'continue', input: 'Continue', async prepareResume() { return undefined; } }));
        const f = fixture(recovery, { failureCount: 2 });
        try {
            await f.host.provisionRuntime({ initialPrompt: 'Perform effect once' });
            await f.host.waitForTurnCompletion?.();
            expect(recovery).toHaveBeenCalledTimes(2);
            expect(recovery.mock.calls.map(([input]) => input.interruptedOriginId)).toEqual(f.sends.slice(0, 2).map(send => send.delivery.turnId));
            expect(f.sends.map(send => send.input.text)).toEqual(['Perform effect once', 'Continue', 'Continue']);
        } finally { await f.host.dispose(); }
    });

    it('settles successful continuation after its exact Run success is recorded', async () => {
        // The pending reply represents the scoped daemon transport, not a
        // mocked recovery policy or internal turn lifecycle.
        let completeReply!: () => void;
        const reply = new Promise<void>(resolve => { completeReply = resolve; });
        const record = vi.fn(async () => await reply);
        const f = fixture(async () => ({ status: 'continue', input: 'Continue', async prepareResume() { return undefined; } }), { connectedServiceRuntimeTurnCompleted: record });
        try {
            await f.host.provisionRuntime({ initialPrompt: 'Perform effect once' });
            let completed = false;
            const completion = f.host.waitForTurnCompletion?.().then(() => { completed = true; });
            await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
            expect(completed).toBe(false);
            completeReply();
            await completion;
            expect(completed).toBe(true);
        } finally { completeReply(); await f.host.dispose(); }
    });

    it.each([1, 2])('does not recover a later failure after native input %s reported unknown custody', async sendOrdinal => {
        const recovery = vi.fn<NonNullable<CreateCliExecutionRunBackendParams['prepareRuntimeFailureRecovery']>>(async () => ({ status: 'continue', input: 'Continue', async prepareResume() { return undefined; } }));
        const f = fixture(recovery, { unknownCustodyOnSend: sendOrdinal });
        try {
            await f.host.provisionRuntime({ initialPrompt: 'Perform effect once' });
            // Initial unknown custody is observed through input outcomes, not
            // an accepted-turn completion waiter. Continuation failure belongs
            // to the already accepted outer turn and must settle that waiter.
            if (sendOrdinal > 1) await f.host.waitForTurnCompletion?.().catch(() => undefined);
            expect(recovery).toHaveBeenCalledTimes(sendOrdinal - 1);
            expect(f.sends).toHaveLength(sendOrdinal);
        } finally { await f.host.dispose(); }
    });

    it('refuses an observed replacement conversation before sending any continuation', async () => {
        const f = fixture(async () => ({ status: 'continue', input: 'Continue', async prepareResume() { return undefined; } }),
            { resumedProviderSessionId: 'wrong-fresh-conversation' });
        try {
            await f.host.provisionRuntime({ initialPrompt: 'Perform effect once' });
            await f.host.waitForTurnCompletion?.().catch(() => undefined);
            expect(f.sends.map(send => send.input.text)).toEqual(['Perform effect once']);
        } finally { await f.host.dispose(); }
    });
});
