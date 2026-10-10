import type {
    ExecutionRunPublicState,
    ScmDiffSummaryGenerateInput,
    ScmDiffSummaryGenerateOutput,
    ScmDiffSummaryGenerateSuccess,
    ScmDiffSummaryGenerationState,
    ScmDiffSummaryCostMetadata,
    ScmDiffSummaryTruncation,
    ScmComparison,
    ScmDiffSummaryOutputs,
    ScmDiffSummaryOutputKind,
    ScmDiffSummaryAnalysisCoverage,
    ScmDiffSummaryResult,
} from '@happier-dev/protocol';
import { buildScmComparisonSourceKey } from '@happier-dev/protocol/scm';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';

export const SCM_DIFF_SUMMARY_GENERATE_ACTION_ID = 'scm.diffSummary.generate' as const;

export type ScmDiffSummaryRequestStatus = 'idle' | 'starting' | 'running' | 'succeeded' | 'failed';
export type ScmDiffSummaryOperationIntent = 'generate' | 'regenerate' | 'copy';

export type ScmDiffSummaryRequestKeyInput = Readonly<{
    sessionId: string | null;
    machineId?: string;
    input: ScmDiffSummaryGenerateInput;
    summarySchemaVersion?: number;
    resolvedSelector?: Readonly<{ catalogId: string }>;
}>;

export type ScmDiffSummaryPayload = Readonly<{
    summaryMarkdown: string | null;
    output: ScmDiffSummaryGenerateSuccess;
    truncation: ScmDiffSummaryTruncation | null;
    generationState: ScmDiffSummaryGenerationState | null;
    cost: ScmDiffSummaryCostMetadata | null;
    risks: readonly string[];
    testImpact: string | null;
    suggestedPrBody: string | null;
}>;

export type ScmDiffSummaryEntry = Readonly<{
    key: string;
    sessionId: string | null;
    machineId?: string;
    scopeKey?: string;
    savedResult?: ScmDiffSummaryResult;
    input: ScmDiffSummaryGenerateInput;
    status: ScmDiffSummaryRequestStatus;
    actionId: typeof SCM_DIFF_SUMMARY_GENERATE_ACTION_ID;
    executionRunId: string | null;
    callId: string | null;
    sidechainId: string | null;
    pendingIntent: ScmDiffSummaryOperationIntent | null;
    requestedAtMs: number | null;
    observedAtMs: number | null;
    streamingMarkdown: string | null;
    latestRun: ExecutionRunPublicState | null;
    finalSummary: ScmDiffSummaryPayload | null;
    lastKnownSummary: ScmDiffSummaryPayload | null;
    latestOutput: ScmDiffSummaryGenerateOutput | null;
    error: Readonly<{ message: string; code?: string }> | null;
    retryAttempt: number;
}>;

export type ScmDiffSummaryState = Readonly<{
    entriesByKey: Readonly<Record<string, ScmDiffSummaryEntry>>;
}>;

export type ScmDiffSummaryEvent =
    | Readonly<{
        type: 'request_started';
        key: string;
        sessionId: string | null;
        machineId?: string;
        scopeKey?: string;
        actionId: typeof SCM_DIFF_SUMMARY_GENERATE_ACTION_ID;
        input: ScmDiffSummaryGenerateInput;
        runId: string | null;
        callId?: string;
        sidechainId?: string;
        structuredOutput?: ScmDiffSummaryGenerateOutput;
        requestedAtMs: number;
        intent: Exclude<ScmDiffSummaryOperationIntent, 'copy'>;
    }>
    | Readonly<{
        type: 'run_snapshot';
        key: string;
        run: ExecutionRunPublicState;
        structuredOutput?: ScmDiffSummaryGenerateOutput | null;
        progressMarkdown?: string | null;
        observedAtMs: number;
    }>
    | Readonly<{
        type: 'request_failed';
        key: string;
        sessionId: string | null;
        machineId?: string;
        scopeKey?: string;
        actionId: typeof SCM_DIFF_SUMMARY_GENERATE_ACTION_ID;
        input: ScmDiffSummaryGenerateInput;
        error: string;
        errorCode?: string;
        failedAtMs: number;
        intent: Exclude<ScmDiffSummaryOperationIntent, 'copy'>;
    }>
    | Readonly<{
        type: 'cache_hit';
        key: string;
        sessionId: string | null;
        machineId?: string;
        scopeKey?: string;
        actionId: typeof SCM_DIFF_SUMMARY_GENERATE_ACTION_ID;
        input: ScmDiffSummaryGenerateInput;
        output: ScmDiffSummaryGenerateSuccess;
        observedAtMs: number;
    }>
    | Readonly<{
        type: 'saved_result';
        key: string;
        result: ScmDiffSummaryResult;
        observedAtMs: number;
    }>
    | Readonly<{
        type: 'copy_requested';
        key: string;
        requestedAtMs: number;
    }>;

export type ScmDiffSummaryViewModel = Readonly<{
    requestKey: string;
    observedAtMs: number | null;
    status: ScmDiffSummaryRequestStatus;
    actionId: typeof SCM_DIFF_SUMMARY_GENERATE_ACTION_ID;
    executionRunId: string | null;
    /** The generating Run's actual first admitted input, when the producer supplies it. */
    inputId: string | null;
    callId: string | null;
    sidechainId: string | null;
    pendingIntent: ScmDiffSummaryOperationIntent | null;
    streamingMarkdown: string | null;
    summaryMarkdown: string | null;
    isShowingLastKnownSummary: boolean;
    isPartial: boolean;
    truncation: ScmDiffSummaryTruncation | null;
    generationState: ScmDiffSummaryGenerationState | null;
    cost: ScmDiffSummaryCostMetadata | null;
    risks: readonly string[];
    testImpact: string | null;
    suggestedPrBody: string | null;
    error: Readonly<{ message: string; code?: string }> | null;
    canRetry: boolean;
    retryAttempt: number;
    latestRun: ExecutionRunPublicState | null;
    comparison: ScmComparison | null;
    requestedOutputs: readonly ScmDiffSummaryOutputKind[];
    outputs: ScmDiffSummaryOutputs | null;
    analysis: ScmDiffSummaryAnalysisCoverage | null;
    resultId: string | null;
    revision: number | null;
    producer: ScmDiffSummaryGenerateOutput['producer'] | null;
    savedResult: ScmDiffSummaryResult | null;
}>;

const EMPTY_STATE: ScmDiffSummaryState = Object.freeze({ entriesByKey: Object.freeze({}) });

export function createInitialScmDiffSummaryState(): ScmDiffSummaryState {
    return EMPTY_STATE;
}

export function buildScmDiffSummaryRequestKey(input: ScmDiffSummaryRequestKeyInput): string {
    const sessionId = input.sessionId?.trim() ?? JSON.stringify(['machine', input.machineId]);
    const sourceKey = input.input.comparisonId ?? buildScmComparisonSourceKey(input.input);
    const cwd = input.input.cwd.trim();
    const schemaVersion = typeof input.summarySchemaVersion === 'number'
        ? String(input.summarySchemaVersion)
        : '';
    const selectorCatalogId = input.resolvedSelector?.catalogId.trim() ?? '';
    return [
        sessionId,
        sourceKey,
        cwd,
        `schema:${schemaVersion}`,
        `selector:${selectorCatalogId}`,
        `model:${JSON.stringify([input.input.modelSelector?.profileId ?? null, input.input.modelSelector?.modelId ?? null, input.input.modelSelector?.backendTargetKey ?? null])}`,
        `outputs:${[...new Set(input.input.outputs ?? ['summary'])].sort().join(',')}`,
    ].join('|');
}

function readPayload(output: ScmDiffSummaryGenerateOutput | null | undefined): ScmDiffSummaryPayload | null {
    if (!output || output.success !== true) return null;
    if (!output.summaryMarkdown && !Object.values(output.outputs ?? {}).some((progress) => progress?.value !== undefined)) return null;
    const summary = output.outputs?.summary?.value;
    return {
        summaryMarkdown: summary?.summaryMarkdown ?? output.summaryMarkdown ?? null,
        output,
        truncation: output.truncation ?? null,
        generationState: output.generationState ?? null,
        cost: output.cost ?? null,
        risks: summary?.risks ?? output.risks ?? [],
        testImpact: summary?.testImpact ?? output.testImpact ?? null,
        suggestedPrBody: summary?.suggestedPrBody ?? output.suggestedPrBody ?? null,
    };
}

function statusFromOutput(output: ScmDiffSummaryGenerateOutput | null, input: ScmDiffSummaryGenerateInput): ScmDiffSummaryRequestStatus {
    if (output?.success === false) return 'failed';
    if (!output) return 'running';
    if (!output.outputs) return output.success && output.summaryMarkdown && (input.outputs ?? ['summary']).every((kind) => kind === 'summary') ? 'succeeded' : 'running';
    const requested: readonly ScmDiffSummaryOutputKind[] = input.outputs ?? ['summary'];
    const states = requested.map((kind) => output.outputs?.[kind]?.state);
    if (states.some((status) => status === 'failed' || status === 'cancelled')) return 'failed';
    return states.every((status) => status === 'complete' || status === 'partial') ? 'succeeded' : 'running';
}

function writeEntry(state: ScmDiffSummaryState, entry: ScmDiffSummaryEntry): ScmDiffSummaryState {
    return {
        entriesByKey: {
            ...state.entriesByKey,
            [entry.key]: entry,
        },
    };
}

function makeStartedEntry(
    event: Extract<ScmDiffSummaryEvent, { type: 'request_started' }>,
    previous: ScmDiffSummaryEntry | null,
): ScmDiffSummaryEntry {
    return {
        key: event.key,
        sessionId: event.sessionId,
        ...(event.machineId ? { machineId: event.machineId } : {}),
        scopeKey: event.scopeKey,
        input: event.input,
        status: event.structuredOutput ? statusFromOutput(event.structuredOutput, event.input) : 'starting',
        actionId: event.actionId,
        executionRunId: event.runId,
        callId: event.callId ?? null,
        sidechainId: event.sidechainId ?? null,
        pendingIntent: event.structuredOutput && statusFromOutput(event.structuredOutput, event.input) !== 'running' ? null : event.intent,
        requestedAtMs: event.requestedAtMs,
        observedAtMs: null,
        streamingMarkdown: null,
        latestRun: null,
        finalSummary: readPayload(event.structuredOutput),
        lastKnownSummary: previous?.finalSummary ?? previous?.lastKnownSummary ?? null,
        latestOutput: event.structuredOutput ?? null,
        error: event.structuredOutput?.success === false ? { message: event.structuredOutput.error, code: event.structuredOutput.errorCode } : null,
        retryAttempt: event.intent === 'regenerate' ? previous?.retryAttempt ?? 0 : 0,
    };
}

export function applyScmDiffSummaryEvent(state: ScmDiffSummaryState, event: ScmDiffSummaryEvent): ScmDiffSummaryState {
    const previous = state.entriesByKey[event.key] ?? null;

    if (event.type === 'request_started') {
        return writeEntry(state, makeStartedEntry(event, previous));
    }

    if (event.type === 'request_failed') {
        const entry: ScmDiffSummaryEntry = {
            key: event.key,
            sessionId: event.sessionId,
            ...(event.machineId ? { machineId: event.machineId } : previous?.machineId ? { machineId: previous.machineId } : {}),
            scopeKey: event.scopeKey ?? previous?.scopeKey,
            savedResult: previous?.savedResult,
            input: event.input,
            status: 'failed',
            actionId: event.actionId,
            executionRunId: previous?.executionRunId ?? null,
            callId: previous?.callId ?? null,
            sidechainId: previous?.sidechainId ?? null,
            pendingIntent: event.intent,
            requestedAtMs: previous?.requestedAtMs ?? null,
            observedAtMs: event.failedAtMs,
            streamingMarkdown: previous?.streamingMarkdown ?? null,
            latestRun: previous?.latestRun ?? null,
            finalSummary: null,
            lastKnownSummary: previous?.finalSummary ?? previous?.lastKnownSummary ?? null,
            latestOutput: previous?.latestOutput ?? null,
            error: {
                message: event.error,
                ...(event.errorCode ? { code: event.errorCode } : {}),
            },
            retryAttempt: (previous?.retryAttempt ?? 0) + 1,
        };
        return writeEntry(state, entry);
    }

    if (event.type === 'cache_hit') {
        const payload = readPayload(event.output);
        if (!payload) return state;
        const entry: ScmDiffSummaryEntry = {
            key: event.key,
            sessionId: event.sessionId,
            machineId: event.machineId,
            scopeKey: event.scopeKey ?? previous?.scopeKey,
            input: event.input,
            status: statusFromOutput(event.output, event.input),
            actionId: event.actionId,
            executionRunId: event.output.runId ?? null,
            callId: null,
            sidechainId: null,
            pendingIntent: null,
            requestedAtMs: previous?.requestedAtMs ?? event.observedAtMs,
            observedAtMs: event.observedAtMs,
            streamingMarkdown: null,
            latestRun: null,
            finalSummary: payload,
            lastKnownSummary: payload,
            latestOutput: event.output,
            error: null,
            retryAttempt: previous?.retryAttempt ?? 0,
        };
        return writeEntry(state, entry);
    }

    if (event.type === 'copy_requested') {
        if (!previous) return state;
        return writeEntry(state, {
            ...previous,
            pendingIntent: 'copy',
            requestedAtMs: event.requestedAtMs,
        });
    }

    if (!previous) return state;
    if (event.type === 'saved_result') {
        const current = previous.latestOutput ?? previous.finalSummary?.output;
        if (current?.resultId !== event.result.resultId
            || (current.revision ?? -1) > event.result.revision
            || current.comparison?.id !== event.result.output.comparison?.id) return state;
        const output = { ...event.result.output, resultId: event.result.resultId, revision: event.result.revision };
        // Machine reads can echo unchanged results while commit progress is polled.
        // Equal revisions alone are insufficient: apply progress and Undo availability
        // can change independently, and a successful reread must clear a read error.
        if (output.success && previous.error === null
            && previous.status === statusFromOutput(output, previous.input)
            && pluginJsonValuesEqual(previous.savedResult, event.result)
            && pluginJsonValuesEqual(previous.latestOutput, output)) return state;
        const payload = readPayload(output);
        const nextRunId = output.runId ?? previous.executionRunId;
        return writeEntry(state, {
            ...previous,
            savedResult: event.result,
            latestOutput: output,
            status: statusFromOutput(output, previous.input),
            finalSummary: payload,
            lastKnownSummary: payload ?? previous.lastKnownSummary,
            executionRunId: nextRunId,
            latestRun: previous.latestRun?.runId === nextRunId ? previous.latestRun : null,
            observedAtMs: event.observedAtMs,
            error: output.success ? null : { message: output.error, code: output.errorCode },
        });
    }
    if (previous.executionRunId && previous.executionRunId !== event.run.runId) return state;

    const currentRevision = previous.latestOutput?.revision ?? -1;
    const incoming = event.structuredOutput;
    const foreignResult = incoming?.resultId && previous.latestOutput?.resultId && incoming.resultId !== previous.latestOutput.resultId;
    const olderRevision = incoming?.resultId === previous.latestOutput?.resultId && (incoming?.revision ?? -1) < currentRevision;
    const accepted = foreignResult || olderRevision ? null : incoming;
    const output = accepted ?? previous.latestOutput;
    const structuredPayload = readPayload(accepted);
    const outputStatus = statusFromOutput(output, previous.input);
    const runFailure =
        accepted?.success === false
            ? {
                message: accepted.error,
                code: accepted.errorCode,
            }
            : outputStatus !== 'succeeded' && (event.run.status === 'failed' || event.run.status === 'cancelled')
                ? {
                    message: event.run.error?.message ?? 'Summary generation failed',
                    ...(event.run.error?.code ? { code: event.run.error.code } : {}),
                }
                : null;
    const nextStatus = runFailure ? 'failed' : outputStatus;
    const nextSummary = structuredPayload ?? previous.finalSummary;

    return writeEntry(state, {
        ...previous,
        status: nextStatus,
        executionRunId: event.run.runId,
        callId: event.run.callId,
        sidechainId: event.run.sidechainId,
        pendingIntent: nextStatus === 'running' ? previous.pendingIntent : null,
        observedAtMs: event.observedAtMs,
        streamingMarkdown: typeof event.progressMarkdown === 'string' ? event.progressMarkdown : previous.streamingMarkdown,
        latestRun: event.run,
        latestOutput: output,
        finalSummary: nextSummary,
        lastKnownSummary: nextSummary ?? previous.finalSummary ?? previous.lastKnownSummary,
        error: runFailure,
    });
}

export function selectScmDiffSummaryEntry(state: ScmDiffSummaryState, key: string): ScmDiffSummaryEntry | null {
    return state.entriesByKey[key] ?? null;
}

function retainOutputValue<T extends Readonly<{ value?: unknown }>>(current: T | undefined, previous: T | undefined): T | undefined {
    return current && current.value === undefined && previous?.value !== undefined
        ? { ...current, value: previous.value }
        : current;
}

export function selectScmDiffSummaryViewModel(state: ScmDiffSummaryState, key: string): ScmDiffSummaryViewModel {
    const entry = selectScmDiffSummaryEntry(state, key);
    const summary = entry?.finalSummary ?? entry?.lastKnownSummary ?? null;
    const output = entry?.latestOutput ?? null;
    const previousOutputs = output?.comparison?.id && summary && output.comparison.id === summary.output.comparison?.id
        ? summary.output.outputs : undefined;
    const outputs = output?.outputs && previousOutputs ? {
        ...output.outputs,
        summary: retainOutputValue(output.outputs.summary, previousOutputs.summary),
        walkthrough: retainOutputValue(output.outputs.walkthrough, previousOutputs.walkthrough),
        commitPlan: retainOutputValue(output.outputs.commitPlan, previousOutputs.commitPlan),
    } : output?.outputs ?? summary?.output.outputs ?? null;
    const requestedOutputs: readonly ScmDiffSummaryOutputKind[] = entry?.input.outputs ?? output?.requestedOutputs ?? ['summary'];
    const isShowingLastKnownSummary = Boolean(entry && !entry.finalSummary && entry.lastKnownSummary);
    return {
        requestKey: key,
        observedAtMs: entry?.observedAtMs ?? null,
        status: entry?.status ?? 'idle',
        actionId: SCM_DIFF_SUMMARY_GENERATE_ACTION_ID,
        executionRunId: entry?.executionRunId ?? null,
        inputId: output?.inputId ?? summary?.output.inputId ?? null,
        callId: entry?.callId ?? null,
        sidechainId: entry?.sidechainId ?? null,
        pendingIntent: entry?.pendingIntent ?? null,
        streamingMarkdown: entry?.streamingMarkdown ?? null,
        summaryMarkdown: summary?.summaryMarkdown ?? null,
        isShowingLastKnownSummary,
        isPartial: summary?.generationState === 'partial' || Boolean(summary?.truncation) || requestedOutputs.some((kind) => output?.outputs?.[kind]?.state === 'partial' || summary?.output.outputs?.[kind]?.state === 'partial'),
        truncation: summary?.truncation ?? null,
        generationState: summary?.generationState ?? null,
        cost: summary?.cost ?? null,
        risks: summary?.risks ?? [],
        testImpact: summary?.testImpact ?? null,
        suggestedPrBody: summary?.suggestedPrBody ?? null,
        error: entry?.error ?? null,
        canRetry: Boolean(entry && (entry.status === 'failed' || entry.status === 'succeeded')),
        retryAttempt: entry?.retryAttempt ?? 0,
        latestRun: entry?.latestRun ?? null,
        comparison: output?.comparison ?? summary?.output.comparison ?? null,
        requestedOutputs,
        outputs,
        analysis: output?.analysis ?? summary?.output.analysis ?? null,
        resultId: output?.resultId ?? summary?.output.resultId ?? null,
        revision: output?.revision ?? summary?.output.revision ?? null,
        producer: output?.producer ?? summary?.output.producer ?? null,
        savedResult: entry?.savedResult ?? null,
    };
}
