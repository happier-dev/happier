import {
    ExecutionRunGetResponseSchema,
    ExecutionRunStartResponseSchema,
    type ActionExecuteResult,
    type ActionExecutorContext,
} from '@happier-dev/protocol';

import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

const COMMIT_MESSAGE_WAIT_TIMEOUT_SECONDS = 12;
const executeAction = createFrontDoorActionExecute();

export type ScmCommitMessageGeneratorResult =
    | { ok: true; message: string }
    | { ok: false; error: string; errorCode?: string };

function readObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readActionError(
    value: Extract<ActionExecuteResult, Readonly<{ ok: false }>>,
): { ok: false; error: string; errorCode?: string } {
    return {
        ok: false,
        error: value.error,
        ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {}),
    };
}

function commitMessageActionContext(sessionId: string): ActionExecutorContext {
    return {
        actionCaller: { kind: 'host' },
        defaultSessionId: sessionId,
        surface: 'ui',
    };
}

function waitObservationFailure(code: string): ScmCommitMessageGeneratorResult {
    if (code === 'timeout') {
        return { ok: false, error: 'Commit message generation timed out', errorCode: code };
    }
    if (code === 'cancelled') {
        return { ok: false, error: 'Commit message generation was cancelled', errorCode: code };
    }
    return { ok: false, error: 'Commit message generation failed', errorCode: code };
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

    const context = commitMessageActionContext(params.sessionId);
    const startResult = await executeAction(
        'execution.run.start',
        {
            sessionId: params.sessionId,
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
            waitForCompletion: true,
            waitTimeoutSeconds: COMMIT_MESSAGE_WAIT_TIMEOUT_SECONDS,
        },
        context,
    );

    if (!startResult.ok) return readActionError(startResult);

    const started = ExecutionRunStartResponseSchema.safeParse(startResult.result);
    if (!started.success || !started.data.wait) {
        return { ok: false, error: 'Commit message generation failed' };
    }

    const wait = started.data.wait;
    if (!wait.ok) return waitObservationFailure(wait.code);
    if (
        wait.result.run.runId !== started.data.runId
        || wait.result.run.status !== wait.status
    ) {
        return { ok: false, error: 'Commit message generation failed' };
    }

    const terminalResult = await executeAction(
        'execution.run.get',
        { sessionId: params.sessionId, runId: started.data.runId, includeStructured: true },
        context,
    );
    if (!terminalResult.ok) return readActionError(terminalResult);

    const terminal = ExecutionRunGetResponseSchema.safeParse(terminalResult.result);
    if (
        !terminal.success
        || terminal.data.run.runId !== started.data.runId
        || terminal.data.run.status !== wait.status
    ) {
        return { ok: false, error: 'Commit message generation failed' };
    }
    if (wait.status !== 'succeeded') {
        const runError = terminal.data.run.error;
        return {
            ok: false,
            error: runError?.message ?? 'Commit message generation failed',
            ...(runError?.code ? { errorCode: runError.code } : {}),
        };
    }

    const result = readObject(terminal.data.latestToolResult) ?? readObject(terminal.data.structuredMeta?.payload);
    const message = result?.message;
    const normalized = typeof message === 'string' ? message.trim() : '';
    return normalized
        ? { ok: true, message: normalized }
        : { ok: false, error: 'Empty commit message suggestion' };
}
