import type { AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ClaudeSdkQuery } from '../../../sdk/query.js';
import { readClaudeCompactionMetadata } from '../../../transcripts/compactionMetadata.js';
import { isClaudePrimaryNativeActivity } from '../../nativeActivity.js';

type CompactionEvent = Extract<AgentSessionRuntimeEvent, { kind: 'context-compaction' }>;

/** A compact owns a resumed query, without borrowing foreground turn ownership. */
export function createClaudeSdkCompactionControl(params: Readonly<{
    sessionId: string;
    signal?: AbortSignal;
    isUnavailable(): boolean;
    isBusy(): boolean;
    readResumeIdentity(): string | null;
    launch(prompt: string, resume: string, signal: AbortSignal): Promise<ClaudeSdkQuery>;
    publish(event: CompactionEvent): void;
}>) {
    let active: { query: ClaudeSdkQuery | null; abort: AbortController; done: Promise<void> } | null = null;
    const compact: NonNullable<AgentSessionRuntime['compact']> = async (request, options) => {
        if (params.isUnavailable()) return { status: 'unavailable', retryable: false,
            diagnostic: { code: 'claude_sdk_disposed', severity: 'error' } };
        if (active || params.isBusy()) return { status: 'rejected', retryable: true,
            diagnostic: { code: 'claude_sdk_compaction_busy', severity: 'warning' } };
        const resume = params.readResumeIdentity();
        if (!resume) return { status: 'unavailable', retryable: false,
            diagnostic: { code: 'claude_sdk_compaction_resume_unavailable', severity: 'warning' } };
        if (options?.signal?.aborted) return { status: 'rejected', retryable: false,
            diagnostic: { code: 'claude_sdk_compaction_cancelled', severity: 'warning' } };
        const abort = new AbortController();
        const signal = AbortSignal.any([abort.signal, ...(params.signal ? [params.signal] : []),
            ...(options?.signal ? [options.signal] : [])]);
        let finish!: () => void;
        const operation = { query: null as ClaudeSdkQuery | null, abort, done: new Promise<void>(resolve => { finish = resolve; }) };
        active = operation;
        let settled = false;
        const base = { kind: 'context-compaction' as const, sequence: 0, sessionId: params.sessionId,
            compactionId: request.compactionId, trigger: request.trigger };
        const publish = (event: CompactionEvent): void => {
            if (settled) return;
            if (event.phase !== 'started' && event.phase !== 'progress') settled = true;
            params.publish(event);
        };
        const terminal = (phase: 'failed' | 'cancelled'): void => {
            publish({ ...base, emittedAtMs: Date.now(), phase,
                diagnostic: { code: `claude_sdk_compaction_${phase}`, severity: phase === 'cancelled' ? 'warning' : 'error' } });
        };
        const cleanup = async (): Promise<void> => {
            signal.removeEventListener('abort', cancel);
            await operation.query?.dispose().catch(() => undefined);
            if (active === operation) active = null;
            finish();
        };
        const cancel = (): void => {
            terminal('cancelled');
            // Query abort closes prompt custody; the operation owns closing the live reader too.
            if (operation.query) void operation.query.dispose().catch(() => undefined);
        };
        signal.addEventListener('abort', cancel, { once: true });
        const consume = async (query: ClaudeSdkQuery): Promise<void> => {
            try {
                while (true) {
                    const next = await query.next();
                    if (next.done) break;
                    const message = next.value;
                    if (!isClaudePrimaryNativeActivity(message)) continue;
                    if (typeof message.session_id === 'string' && message.session_id !== resume) {
                        terminal('failed');
                        return;
                    }
                    if (message.type === 'system' && message.subtype === 'compact_boundary') {
                        publish({ ...base, emittedAtMs: Date.now(), phase: 'completed', ...readClaudeCompactionMetadata(message) });
                    }
                    if (message.type === 'result') {
                        if (!settled) terminal(signal.aborted ? 'cancelled' : 'failed');
                        return;
                    }
                }
                if (!settled) terminal(signal.aborted ? 'cancelled' : 'failed');
            } catch {
                terminal(signal.aborted ? 'cancelled' : 'failed');
            } finally { await cleanup(); }
        };
        publish({ ...base, emittedAtMs: Date.now(), phase: 'started' });
        try {
            const instructions = request.instructions?.trim();
            const query = await params.launch(instructions ? `/compact ${instructions}` : '/compact', resume, signal);
            operation.query = query;
            if (signal.aborted) {
                await cleanup();
                return { status: 'rejected', retryable: false,
                    diagnostic: { code: 'claude_sdk_compaction_cancelled', severity: 'warning' } };
            }
            void consume(query);
            const outcome = await query.promptTransportOutcome;
            if (outcome.kind === 'rejected_before_effect') {
                terminal(signal.aborted ? 'cancelled' : 'failed');
                await query.dispose();
                return { status: 'rejected', retryable: true,
                    diagnostic: { code: 'claude_sdk_compaction_rejected', severity: 'error' } };
            }
            return { status: 'admitted' };
        } catch {
            terminal(signal.aborted ? 'cancelled' : 'failed');
            await cleanup();
            return { status: 'unavailable', retryable: false,
                diagnostic: { code: 'claude_sdk_compaction_launch_failed', severity: 'error' } };
        }
    };
    return {
        compact,
        readQuery: () => active?.query ?? null,
        readCompletion: () => active?.done,
        async dispose() { active?.abort.abort(); await active?.done; },
    };
}
