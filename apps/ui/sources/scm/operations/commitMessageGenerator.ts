import { ExecutionRunGetResponseSchema, ExecutionRunStartResponseSchema, type ExecutionRunStatus } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

const COMMIT_MESSAGE_WAIT_TIMEOUT_SECONDS = 12;
const executeAction = createFrontDoorActionExecute();

export type ScmCommitMessageGeneratorResult =
    | { ok: true; message: string }
    | { ok: false; error: string; errorCode?: string; runId?: string; outcome?: 'pending' | 'unknown' };

export type CommitMessageHostV1 =
    | Readonly<{ kind: 'session'; sessionId: string; serverId?: string }>
    | Readonly<{ kind: 'workspace'; workspace: WorkspaceAddressV1 }>;

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

function commitMessageActionContext(host: CommitMessageHostV1): ActionExecutorContext {
    return {
        actionCaller: { kind: 'host' },
        ...(host.kind === 'workspace' ? {
            defaultSessionId: null,
            serverId: host.workspace.serverId,
            executionRunTargetMachineId: host.workspace.machineId,
        } : {
            defaultSessionId: host.sessionId,
            ...(host.serverId === undefined ? {} : { serverId: host.serverId }),
        }),
        surface: 'ui',
    };
}

function waitObservationFailure(code: string, runId: string): ScmCommitMessageGeneratorResult {
    if (code === 'timeout') {
        return { ok: false, error: 'Commit message generation is still running', errorCode: code, runId, outcome: 'pending' };
    }
    if (code === 'cancelled') {
        return { ok: false, error: 'Commit message observation was cancelled', errorCode: code, runId, outcome: 'unknown' };
    }
    return { ok: false, error: 'Commit message generation could not be observed', errorCode: code, runId, outcome: 'unknown' };
}

export async function generateScmCommitMessage(params: Readonly<{
    host: CommitMessageHostV1;
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

    const context = commitMessageActionContext(params.host);
    const sessionId = params.host.kind === 'session' ? params.host.sessionId : null;
    const startResult = await executeAction(
        'execution.run.start',
        {
            sessionId,
            ...(params.host.kind === 'workspace' ? { cwd: params.host.workspace.rootPath } : {}),
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
    if (!started.success) {
        return { ok: false, error: 'Commit message generation failed' };
    }
    if (!started.data.wait) return waitObservationFailure('execution_run_failed', started.data.runId);

    const wait = started.data.wait;
    if (!wait.ok) return waitObservationFailure(wait.code, started.data.runId);
    if (wait.status === 'running') return waitObservationFailure('timeout', started.data.runId);
    if (
        wait.result.run.runId !== started.data.runId
        || wait.result.run.status !== wait.status
    ) {
        return { ok: false, error: 'Commit message generation failed', runId: started.data.runId, outcome: 'unknown' };
    }

    return readScmCommitMessageSuggestion({ host: params.host, runId: started.data.runId, expectedStatus: wait.status });
}

/** Observes the accepted Run on its original target; never starts a replacement. */
export async function readScmCommitMessageSuggestion(params: Readonly<{
    host: CommitMessageHostV1;
    runId: string;
    expectedStatus?: ExecutionRunStatus;
}>): Promise<ScmCommitMessageGeneratorResult> {
    const context = commitMessageActionContext(params.host);
    const sessionId = params.host.kind === 'session' ? params.host.sessionId : null;

    const terminalResult = await executeAction(
        'execution.run.get',
        { sessionId, runId: params.runId, includeStructured: true },
        context,
    );
    if (!terminalResult.ok) return { ...readActionError(terminalResult), runId: params.runId, outcome: 'unknown' };

    const terminal = ExecutionRunGetResponseSchema.safeParse(terminalResult.result);
    if (
        !terminal.success
        || terminal.data.run.runId !== params.runId
        || (params.expectedStatus !== undefined && terminal.data.run.status !== params.expectedStatus)
    ) {
        return { ok: false, error: 'Commit message generation failed', runId: params.runId, outcome: 'unknown' };
    }
    if (terminal.data.run.status === 'running') return waitObservationFailure('timeout', params.runId);
    if (terminal.data.run.status !== 'succeeded') {
        const runError = terminal.data.run.error;
        return {
            ok: false,
            error: runError?.message ?? 'Commit message generation failed',
            ...(runError?.code ? { errorCode: runError.code } : {}),
            runId: params.runId,
        };
    }

    const result = readObject(terminal.data.latestToolResult) ?? readObject(terminal.data.structuredMeta?.payload);
    const message = result?.message;
    const normalized = typeof message === 'string' ? message.trim() : '';
    return normalized
        ? { ok: true, message: normalized }
        : { ok: false, error: 'Empty commit message suggestion' };
}

export async function stopScmCommitMessageSuggestion(params: Readonly<{ host: CommitMessageHostV1; runId: string }>) {
    return executeAction('execution.run.stop', {
        sessionId: params.host.kind === 'session' ? params.host.sessionId : null,
        runId: params.runId,
    }, commitMessageActionContext(params.host));
}
