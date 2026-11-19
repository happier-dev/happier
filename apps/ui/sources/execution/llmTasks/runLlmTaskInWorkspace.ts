import { executionRunKindForIntent } from '@happier-dev/protocol/execution/runs/startRequest';
import { ExecutionRunGetResponseSchema, ExecutionRunStartResponseSchema, type ExecutionRunError, type ExecutionRunGetResponse, type ExecutionRunStatus } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { parseBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { isLlmTaskRunnerAutoV1, type LlmTaskRunnerChoiceV1, type LlmTaskRunnerConfigV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import { type LlmTaskRunnerUnavailableAgentV1, type LlmTaskIdV1, LLM_TASK_DECLARATIONS_V1, LlmTaskRunnerResolutionWireV1Schema, resolveLlmTaskRunnerV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerSelection';

import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

const executeAction = createFrontDoorActionExecute();

export type LlmTaskRunResult =
    | { ok: true; terminal: ExecutionRunGetResponse }
    | { ok: false; error: string; errorCode?: string; runId?: string; outcome?: 'pending' | 'unknown'; reason?: 'no_ready_agent' | 'no_matching_model'; unavailableAgents?: readonly LlmTaskRunnerUnavailableAgentV1[];
        /** The settled Run's own typed error (its runtime issue included), when the Run itself failed. */
        runError?: ExecutionRunError };

export type LlmTaskHostV1 =
    /** `machineId`: the Session's machine, where Auto resolves the runner; `agentTargetKey`: the Session's own Agent, which wins Auto's cost ties. */
    | Readonly<{ kind: 'session'; sessionId: string; serverId?: string; machineId?: string | null; agentTargetKey?: string | null }>
    | Readonly<{ kind: 'workspace'; workspace: Pick<WorkspaceAddressV1, 'serverId' | 'machineId' | 'rootPath'>
        & Partial<Pick<WorkspaceAddressV1, 'workspaceId'>> }>;

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

function llmTaskActionContext(host: LlmTaskHostV1): ActionExecutorContext {
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

function waitObservationFailure(code: string, runId: string): LlmTaskRunResult {
    if (code === 'timeout') {
        return { ok: false, error: 'Task is still running', errorCode: code, runId, outcome: 'pending' };
    }
    if (code === 'cancelled') {
        return { ok: false, error: 'Task observation was cancelled', errorCode: code, runId, outcome: 'unknown' };
    }
    return { ok: false, error: 'Task could not be observed', errorCode: code, runId, outcome: 'unknown' };
}

/**
 * The runner owner decides: an explicit choice resolves without a machine read
 * (the owner applies the task's permission levels); Auto resolves on the executing
 * machine, preferring the Session's own Agent on a cost tie.
 * Nothing ready ⇒ a typed failure.
 */
export async function resolveWorkspaceLlmTaskRunner(host: LlmTaskHostV1, choice: LlmTaskRunnerChoiceV1 | null, task: LlmTaskIdV1):
    Promise<Readonly<{ ok: true; runner: LlmTaskRunnerConfigV1; title?: string }> | Extract<LlmTaskRunResult, { ok: false }>> {
    if (!isLlmTaskRunnerAutoV1(choice)) {
        const explicit = resolveLlmTaskRunnerV1({ task, choice, candidates: [] });
        if (explicit.ok) return { ok: true, runner: explicit.runner };
    }
    const machineId = host.kind === 'workspace' ? host.workspace.machineId : host.machineId;
    const serverId = host.kind === 'workspace' ? host.workspace.serverId : host.serverId;
    if (!machineId) return { ok: false, error: 'The machine for this task is unknown', errorCode: 'LLM_TASK_RUNNER_UNAVAILABLE' };
    const result = await executeAction('agents.models.list', {
        purpose: 'llm_task_runner', task, machineId, ...(choice ? { choice } : {}),
        ...(host.kind === 'session' && host.agentTargetKey ? { sessionAgentTargetKey: host.agentTargetKey } : {}),
    }, { actionCaller: { kind: 'host' }, surface: 'ui', ...(serverId === undefined ? {} : { serverId }) });
    if (!result.ok) return readActionError(result);
    const resolution = LlmTaskRunnerResolutionWireV1Schema.safeParse(readObject(result.result)?.llmTaskRunner);
    if (!resolution.success) return { ok: false, error: 'Task failed' };
    if (!resolution.data.ok) {
        return { ok: false, errorCode: resolution.data.errorCode, reason: resolution.data.reason,
            unavailableAgents: resolution.data.unavailableAgents, error: resolution.data.reason === 'no_ready_agent'
            ? 'No Agent on this machine is ready. Sign in to an Agent or choose one in Settings.'
            : 'No ready Agent offers a model for this task. Choose one in Settings.' };
    }
    return { ok: true, runner: resolution.data.runner,
        ...(resolution.data.title === undefined ? {} : { title: resolution.data.title }) };
}

export async function runLlmTaskInWorkspace(params: Readonly<{
    host: LlmTaskHostV1;
    /** The stored runner choice; null or `{ mode: 'auto' }` is Auto. */
    choice: LlmTaskRunnerChoiceV1 | null;
    task: LlmTaskIdV1;
    instructions?: string;
    resolvedRunner?: LlmTaskRunnerConfigV1;
    onStarted?: (runId: string) => void;
    signal?: AbortSignal;
    intent: 'task' | 'scm_commit_message';
    intentInput: Record<string, unknown>;
}>): Promise<LlmTaskRunResult> {
    if (params.signal?.aborted) return { ok: false, error: 'Task cancelled', errorCode: 'cancelled' };
    const resolved = params.resolvedRunner
        ? { ok: true as const, runner: params.resolvedRunner }
        : await resolveWorkspaceLlmTaskRunner(params.host, params.choice, params.task);
    if (!resolved.ok) return resolved;
    if (params.signal?.aborted) return { ok: false, error: 'Task cancelled', errorCode: 'cancelled' };
    const { runner } = resolved;

    const accepted: { runId?: string; stop?: Promise<ActionExecuteResult> } = {};
    const stopAcceptedRun = () => {
        if (accepted.runId && !accepted.stop) {
            accepted.stop = stopLlmTaskRun({ host: params.host, runId: accepted.runId });
        }
    };
    const context: ActionExecutorContext = { ...llmTaskActionContext(params.host),
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.onStarted || params.signal ? { onExecutionRunStarted: (runId: string) => {
            accepted.runId = runId;
            params.onStarted?.(runId);
            if (params.signal?.aborted) stopAcceptedRun();
        } } : {}),
    };
    const sessionId = params.host.kind === 'session' ? params.host.sessionId : null;
    params.signal?.addEventListener('abort', stopAcceptedRun, { once: true });
    let startResult: ActionExecuteResult;
    try {
        startResult = await executeAction(
        'execution.run.start',
        {
            sessionId,
            ...(params.host.kind === 'workspace' ? { cwd: params.host.workspace.rootPath } : {}),
            kind: executionRunKindForIntent(params.intent),
            intent: params.intent,
            ...(params.instructions === undefined ? {} : { instructions: params.instructions }),
            backendTarget: readBackendTargetRefV2(parseBackendTargetKeyV2(runner.modelSelection.agentTargetKey)),
            modelSelection: runner.modelSelection,
            ...(runner.connectedServices !== undefined ? { connectedServices: runner.connectedServices } : {}),
            ...(runner.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: runner.sessionConfigOptionOverrides } : {}),
            // Hard-safety: the task declares only `no_tools`, and the owner clamps every runner to it.
            permissionMode: runner.permissionMode ?? LLM_TASK_DECLARATIONS_V1[params.task].permissionModes[0],
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
            intentInput: params.intentInput,
            waitForCompletion: true,
        },
        context,
        );
    } finally {
        params.signal?.removeEventListener('abort', stopAcceptedRun);
    }

    if (accepted.stop) {
        const stopped = await accepted.stop;
        if (!stopped.ok) return { ...readActionError(stopped), runId: accepted.runId, outcome: 'unknown' };
        return { ok: false, error: 'Task cancelled', errorCode: 'cancelled', runId: accepted.runId };
    }

    if (!startResult.ok) return readActionError(startResult);

    const started = ExecutionRunStartResponseSchema.safeParse(startResult.result);
    if (!started.success) {
        return { ok: false, error: 'Task failed' };
    }
    if (!started.data.wait) return waitObservationFailure('execution_run_failed', started.data.runId);

    const wait = started.data.wait;
    if (!wait.ok) return waitObservationFailure(wait.code, started.data.runId);
    if (wait.status === 'running') return waitObservationFailure('timeout', started.data.runId);
    if (
        wait.result.run.runId !== started.data.runId
        || wait.result.run.status !== wait.status
    ) {
        return { ok: false, error: 'Task failed', runId: started.data.runId, outcome: 'unknown' };
    }

    return readLlmTaskRunResult(wait.result, started.data.runId);
}

/** Observes the accepted Run on its original target; never starts a replacement. */
export async function readLlmTaskRun(params: Readonly<{
    host: LlmTaskHostV1;
    runId: string;
    expectedStatus?: ExecutionRunStatus;
}>): Promise<LlmTaskRunResult> {
    const context = llmTaskActionContext(params.host);
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
        return { ok: false, error: 'Task failed', runId: params.runId, outcome: 'unknown' };
    }
    return readLlmTaskRunResult(terminal.data, params.runId);
}

function readLlmTaskRunResult(terminal: ExecutionRunGetResponse, runId: string): LlmTaskRunResult {
    if (terminal.run.status === 'running') return waitObservationFailure('timeout', runId);
    if (terminal.run.status !== 'succeeded') {
        const runError = terminal.run.error;
        return {
            ok: false,
            error: runError?.message ?? 'Task failed',
            ...(runError?.code ? { errorCode: runError.code, runError } : {}),
            runId,
        };
    }

    return { ok: true, terminal };
}

export async function stopLlmTaskRun(params: Readonly<{ host: LlmTaskHostV1; runId: string }>) {
    return executeAction('execution.run.stop', {
        sessionId: params.host.kind === 'session' ? params.host.sessionId : null,
        runId: params.runId,
    }, llmTaskActionContext(params.host));
}
