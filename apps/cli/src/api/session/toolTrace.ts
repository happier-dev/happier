import { recordToolTraceEvent } from '@/agent/tools/trace/toolTrace';
import type { ToolNormalizationSourceV3 } from '@happier-dev/protocol/tools/v2/meta';
import type { ACPMessageData } from './sessionMessageTypes';

export { isToolTraceEnabled } from '@/agent/tools/trace/toolTrace';

export function recordAcpToolTraceEventIfNeeded(opts: {
    sessionId: string;
    source: ToolNormalizationSourceV3;
    body: ACPMessageData;
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
        source: opts.source,
        kind: opts.body.type,
        payload: opts.body,
        localId: opts.localId,
    });
}
