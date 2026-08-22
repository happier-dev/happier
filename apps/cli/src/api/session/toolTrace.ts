import { recordToolTraceEvent } from '@/agent/tools/trace/toolTrace';

export function isToolTraceEnabled(): boolean {
    return ['1', 'true', 'yes', 'on'].includes((process.env.HAPPIER_STACK_TOOL_TRACE ?? '').toLowerCase());
}

export function recordCodexToolTraceEventIfNeeded(opts: { sessionId: string; body: any }): void {
    if (opts.body?.type !== 'tool-call' && opts.body?.type !== 'tool-call-result') return;

    recordToolTraceEvent({
        direction: 'outbound',
        sessionId: opts.sessionId,
        protocol: 'codex',
        provider: 'codex',
        kind: opts.body.type,
        payload: opts.body,
    });
}

export function recordAcpToolTraceEventIfNeeded(opts: {
    sessionId: string;
    provider: string;
    body: any;
    localId?: string;
}): void {
    if (
        opts.body?.type !== 'tool-call' &&
        opts.body?.type !== 'tool-result' &&
        opts.body?.type !== 'permission-request' &&
        opts.body?.type !== 'file-edit' &&
        opts.body?.type !== 'terminal-output' &&
        opts.body?.type !== 'task_complete'
    ) {
        return;
    }

    recordToolTraceEvent({
        direction: 'outbound',
        sessionId: opts.sessionId,
        protocol: 'acp',
        provider: opts.provider,
        kind: opts.body.type,
        payload: opts.body,
        localId: opts.localId,
    });
}
