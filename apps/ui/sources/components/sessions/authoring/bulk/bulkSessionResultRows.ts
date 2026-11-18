import { projectSessionMessageInvocationV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageInvocationV1';
import { projectSessionMessageInvocationRead, type SessionMessageInvocationTarget } from '@/components/sessions/transcript/references/useSessionMessageInvocation';
import { isBulkSessionRetryable, type BulkSessionChangeRow } from './executeBulkSessionChanges';

/** The existing Ask target anatomy plus the bulk host's control-plane result. No transcript reads. */
export function buildBulkSessionResultRowData(row: BulkSessionChangeRow, localId: string) {
    let target: SessionMessageInvocationTarget | undefined;
    if (row.actionId === 'session.message.send' && row.result) {
        const invocation = projectSessionMessageInvocationV1({ serverId: row.target.serverId, localId,
            target: row.target.sessionId, reply: 'none', result: row.result });
        const read = projectSessionMessageInvocationRead({ entry: { invocation, text: '', origin: 'composer' },
            homeServerId: row.target.serverId, sourceRowId: localId, replies: null,
            returnedAnswers: [], refreshing: false, refresh: () => {} });
        if (read.status === 'ready') target = read.targets[0];
    }
    // Settings have no receiver input/reply: never fabricate message admission.
    target ??= { target: row.target, localId: null, requestBound: false,
        status: row.state === 'failed' || row.state === 'skipped' ? 'failed'
            : row.state === 'approval_pending' || row.state === 'waking' ? 'held' : 'queued',
        ...(row.code ? { code: row.code } : {}), resultRef: null, replyStatus: 'not_requested' };
    return { target, state: row.state, reason: row.reason, code: row.code,
        canRetry: isBulkSessionRetryable(row), result: row.result };
}
