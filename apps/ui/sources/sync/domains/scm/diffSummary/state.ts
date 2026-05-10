import type {
    ExecutionRunPublicState,
    ScmDiffSummaryGenerateInput,
    ScmDiffSummaryGenerateOutput,
    ScmDiffSummaryGenerateSuccess,
    ScmDiffSummaryGenerationState,
    ScmDiffSummaryCostMetadata,
    ScmDiffSummaryTruncation,
} from '@happier-dev/protocol';

export const SCM_DIFF_SUMMARY_GENERATE_ACTION_ID = 'scm.diffSummary.generate' as const;

export type ScmDiffSummaryRequestStatus = 'idle' | 'starting' | 'running' | 'succeeded' | 'failed';
export type ScmDiffSummaryOperationIntent = 'generate' | 'regenerate' | 'copy';

export type ScmDiffSummaryRequestKeyInput = Readonly<{
    sessionId: string;
    input: ScmDiffSummaryGenerateInput;
    summarySchemaVersion?: number;
    resolvedSelector?: Readonly<{ catalogId: string }>;
}>;

export type ScmDiffSummaryPayload = Readonly<{
    summaryMarkdown: string;
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
    sessionId: string;
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
        sessionId: string;
        actionId: typeof SCM_DIFF_SUMMARY_GENERATE_ACTION_ID;
        input: ScmDiffSummaryGenerateInput;
        runId: string;
        callId: string;
        sidechainId: string;
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
        sessionId: string;
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
        sessionId: string;
        actionId: typeof SCM_DIFF_SUMMARY_GENERATE_ACTION_ID;
        input: ScmDiffSummaryGenerateInput;
        output: ScmDiffSummaryGenerateSuccess;
        observedAtMs: number;
    }>
    | Readonly<{
        type: 'copy_requested';
        key: string;
        requestedAtMs: number;
    }>;

export type ScmDiffSummaryViewModel = Readonly<{
    status: ScmDiffSummaryRequestStatus;
    actionId: typeof SCM_DIFF_SUMMARY_GENERATE_ACTION_ID;
    executionRunId: string | null;
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
}>;

const EMPTY_STATE: ScmDiffSummaryState = Object.freeze({ entriesByKey: Object.freeze({}) });

export function createInitialScmDiffSummaryState(): ScmDiffSummaryState {
    return EMPTY_STATE;
}

export function buildScmDiffSummaryRequestKey(input: ScmDiffSummaryRequestKeyInput): string {
    const sessionId = input.sessionId.trim();
    const sourceKind = input.input.source.kind;
    const turnId = input.input.turnId?.trim() ?? '';
    const checkpointReceiptId = input.input.checkpointReceiptId?.trim() ?? '';
    const turnEvidenceMode = input.input.turnEvidenceMode?.trim() ?? '';
    const cwd = input.input.cwd.trim();
    const schemaVersion = typeof input.summarySchemaVersion === 'number'
        ? String(input.summarySchemaVersion)
        : '';
    const selectorCatalogId = input.resolvedSelector?.catalogId.trim() ?? '';
    return [
        sessionId,
        sourceKind,
        turnId,
        checkpointReceiptId,
        turnEvidenceMode,
        cwd,
        `schema:${schemaVersion}`,
        `selector:${selectorCatalogId}`,
    ].join('|');
}

function readPayload(output: ScmDiffSummaryGenerateOutput | null | undefined): ScmDiffSummaryPayload | null {
    if (!output || output.success !== true) return null;
    return {
        summaryMarkdown: output.summaryMarkdown,
        output,
        truncation: output.truncation ?? null,
        generationState: output.generationState ?? null,
        cost: output.cost ?? null,
        risks: output.risks ?? [],
        testImpact: output.testImpact ?? null,
        suggestedPrBody: output.suggestedPrBody ?? null,
    };
}

function statusFromRun(run: ExecutionRunPublicState): ScmDiffSummaryRequestStatus {
    if (run.status === 'succeeded') return 'succeeded';
    if (run.status === 'failed' || run.status === 'cancelled') return 'failed';
    return 'running';
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
        input: event.input,
        status: 'starting',
        actionId: event.actionId,
        executionRunId: event.runId,
        callId: event.callId,
        sidechainId: event.sidechainId,
        pendingIntent: event.intent,
        requestedAtMs: event.requestedAtMs,
        observedAtMs: null,
        streamingMarkdown: null,
        latestRun: null,
        finalSummary: null,
        lastKnownSummary: previous?.finalSummary ?? previous?.lastKnownSummary ?? null,
        error: null,
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
            input: event.input,
            status: 'succeeded',
            actionId: event.actionId,
            executionRunId: null,
            callId: null,
            sidechainId: null,
            pendingIntent: null,
            requestedAtMs: previous?.requestedAtMs ?? event.observedAtMs,
            observedAtMs: event.observedAtMs,
            streamingMarkdown: null,
            latestRun: null,
            finalSummary: payload,
            lastKnownSummary: payload,
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

    const structuredPayload = readPayload(event.structuredOutput);
    const runFailure =
        event.structuredOutput?.success === false
            ? {
                message: event.structuredOutput.error,
                code: event.structuredOutput.errorCode,
            }
            : event.run.status === 'failed'
                ? {
                    message: event.run.error?.message ?? 'Summary generation failed',
                    ...(event.run.error?.code ? { code: event.run.error.code } : {}),
                }
                : null;
    const nextStatus = structuredPayload ? 'succeeded' : runFailure ? 'failed' : statusFromRun(event.run);
    const nextSummary = structuredPayload ?? null;

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
        finalSummary: nextSummary,
        lastKnownSummary: nextSummary ?? previous.finalSummary ?? previous.lastKnownSummary,
        error: runFailure,
    });
}

export function selectScmDiffSummaryEntry(state: ScmDiffSummaryState, key: string): ScmDiffSummaryEntry | null {
    return state.entriesByKey[key] ?? null;
}

export function selectScmDiffSummaryViewModel(state: ScmDiffSummaryState, key: string): ScmDiffSummaryViewModel {
    const entry = selectScmDiffSummaryEntry(state, key);
    const summary = entry?.finalSummary ?? entry?.lastKnownSummary ?? null;
    const isShowingLastKnownSummary = Boolean(entry && !entry.finalSummary && entry.lastKnownSummary);
    return {
        status: entry?.status ?? 'idle',
        actionId: SCM_DIFF_SUMMARY_GENERATE_ACTION_ID,
        executionRunId: entry?.executionRunId ?? null,
        callId: entry?.callId ?? null,
        sidechainId: entry?.sidechainId ?? null,
        pendingIntent: entry?.pendingIntent ?? null,
        streamingMarkdown: entry?.streamingMarkdown ?? null,
        summaryMarkdown: summary?.summaryMarkdown ?? null,
        isShowingLastKnownSummary,
        isPartial: summary?.generationState === 'partial' || Boolean(summary?.truncation),
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
    };
}
