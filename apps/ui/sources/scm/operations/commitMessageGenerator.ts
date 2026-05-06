import { sessionExecutionRunGet, sessionExecutionRunStart } from '@/sync/ops/sessionExecutionRuns';

const COMMIT_MESSAGE_RESULT_POLL_ATTEMPTS = 80;
const COMMIT_MESSAGE_RESULT_POLL_INTERVAL_MS = 150;

export type ScmCommitMessageGeneratorResult =
    | { ok: true; message: string }
    | { ok: false; error: string; errorCode?: string };

function readObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readOperationError(value: unknown): { ok: false; error: string; errorCode?: string } | null {
    const record = readObject(value);
    if (record?.ok !== false || typeof record.error !== 'string') return null;
    return {
        ok: false,
        error: record.error,
        ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
    };
}

export async function generateScmCommitMessage(params: Readonly<{
    sessionId: string;
    backendId: string;
    instructions?: string;
    scopePaths?: ReadonlyArray<string>;
}>): Promise<ScmCommitMessageGeneratorResult> {
    const backendId = typeof params.backendId === 'string' ? params.backendId.trim() : '';
    if (!backendId) {
        return { ok: false, error: 'Missing backend id' };
    }

    const include = (params.scopePaths ?? [])
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter((v) => v.length > 0);

    const started = await sessionExecutionRunStart(
        params.sessionId,
        {
            kind: 'scm_commit_message.v1',
            intent: 'scm_commit_message',
            backendTarget: { kind: 'backend', backendId, sourceKind: 'built_in' },
            // Hard-safety: commit generation must not be tool-capable.
            permissionMode: 'no_tools',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
            intentInput: {
                ...(typeof params.instructions === 'string' && params.instructions.trim().length > 0
                    ? { instructions: params.instructions.trim() }
                    : {}),
                scope: { kind: 'paths', include },
            },
        },
    );

    const startError = readOperationError(started);
    if (startError) return startError;

    const startedRecord = readObject(started);
    const runId = typeof startedRecord?.runId === 'string' ? startedRecord.runId.trim() : '';
    if (!runId) {
        return { ok: false, error: 'Commit message generation failed' };
    }

    for (let attempt = 0; attempt < COMMIT_MESSAGE_RESULT_POLL_ATTEMPTS; attempt += 1) {
        const res = await sessionExecutionRunGet(params.sessionId, { runId, includeStructured: true });
        const getError = readOperationError(res);
        if (getError) return getError;

        const responseRecord = readObject(res);
        const runRecord = readObject(responseRecord?.run);
        const status = typeof runRecord?.status === 'string' ? runRecord.status : '';
        if (status === 'running') {
            await new Promise((resolve) => setTimeout(resolve, COMMIT_MESSAGE_RESULT_POLL_INTERVAL_MS));
            continue;
        }
        if (status !== 'succeeded') {
            const runError = readObject(runRecord?.error);
            return {
                ok: false,
                error: typeof runError?.message === 'string' ? runError.message : 'Commit message generation failed',
                ...(typeof runError?.code === 'string' ? { errorCode: runError.code } : {}),
            };
        }

        const structuredMeta = readObject(responseRecord?.structuredMeta);
        const result = readObject(responseRecord?.latestToolResult) ?? readObject(structuredMeta?.payload);
        const message = result?.message;
        const normalized = typeof message === 'string' ? message.trim() : '';
        if (!normalized) {
            return { ok: false, error: 'Empty commit message suggestion' };
        }

        return { ok: true, message: normalized };
    }

    return { ok: false, error: 'Commit message generation timed out' };
}
