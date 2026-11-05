import type {
    ExecutionRunPublicState,
    ScmDiffSummaryGenerateInput,
    ScmDiffSummaryGenerateOutput,
    ScmDiffSummaryGenerateSuccess,
    ScmDiffSummaryGenerationState,
    ScmDiffSummaryCostMetadata,
    ScmDiffSummaryTruncation,
    ScmComparison, ScmComparisonFile,
    ScmDiffSummaryOutputs,
    ScmDiffSummaryOutputKind,
    ScmDiffSummaryAnalysisCoverage,
    ScmDiffSummaryResult,
} from '@happier-dev/protocol';
import { buildScmComparisonSourceKey } from '@happier-dev/protocol/scm';
import { isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';

import type { ScmReviewComparisonSelector } from './selection';

export const SCM_DIFF_SUMMARY_GENERATE_ACTION_ID = 'scm.diffSummary.generate' as const;

export type ScmDiffSummaryRequestStatus = 'idle' | 'starting' | 'running' | 'unknown' | 'succeeded' | 'failed';
export type ScmDiffSummaryRestoreState = 'idle' | 'restoring' | 'ready' | 'unavailable';
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
    /** Display-only retained values; latestOutput remains the producer's wire facts. */
    displayOutputs: ScmDiffSummaryOutputs | null;
    error: Readonly<{ message: string; code?: string }> | null;
    retryAttempt: number;
}>;

/** Captured reads follow the same Account/host owner as generated readings, across view lifetimes. */
export type CapturedScmRead = Readonly<{
    key: string;
    comparison: ScmComparison | null;
    error: ScmDiffSummaryEntry['error'];
    loading: boolean;
    page: Readonly<{ totalFiles: number; nextCursor: number | null }> | null;
}>;

export type ScmDiffSummaryState = Readonly<{
    entriesByKey: Readonly<Record<string, ScmDiffSummaryEntry>>;
    capturedReadsByKey?: Readonly<Record<string, Readonly<{ scopeKey: string; hostKey: string; value: CapturedScmRead }>>>;
    capturedFilesByKey?: Readonly<Record<string, Readonly<{ scopeKey: string; hostKey: string; files: ReadonlyMap<string, ScmComparisonFile> }>>>;
    reviewComparisonsByHostKey?: Readonly<Record<string, Readonly<{ scopeKey: string; hostKey: string; comparison: ScmReviewComparisonSelector }>>>;

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
    admission?: ScmDiffSummaryGenerateOutput['admission'] | null;
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
    error: (NonNullable<ScmDiffSummaryEntry['error']> & ScmDiffSummaryFailurePresentation) | null;
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

/** Recorded authorship wins; a generation still writing can use its admitted Run selection. */
export function selectScmDiffSummaryProducerModel(viewModel: Pick<ScmDiffSummaryViewModel, 'producer' | 'latestRun' | 'savedResult'> | null | undefined) {
    const saved = viewModel?.savedResult;
    return {
        backendTarget: viewModel?.latestRun?.backendTarget ?? saved?.generator?.backendTarget,
        selection: viewModel?.latestRun?.resolvedSelection ?? saved?.generator,
        modelId: viewModel?.producer?.modelId
            ?? (viewModel?.producer?.kind !== 'review' ? saved?.generator?.modelId
                ?? viewModel?.latestRun?.resolvedSelection?.modelSelection?.modelId
                ?? viewModel?.latestRun?.resolvedSelection?.modelId : undefined),
    };
}

/** The presentation receives a typed recovery reason, never an RPC code as its copy key. */
export type ScmDiffSummaryFailurePresentation =
    | Readonly<{ reason: 'invalidRequest'; messageKey: 'walkthrough.generationFailure.invalidRequest'; nextAction: 'reviewRequest'; nextActionKey: 'walkthrough.generationFailure.reviewRequest' }>
    | Readonly<{ reason: 'modelUnavailable'; messageKey: 'walkthrough.generationFailure.modelUnavailable'; nextAction: 'chooseModel'; nextActionKey: 'walkthrough.notice.chooseModel' }>
    | Readonly<{ reason: 'machineUnavailable'; messageKey: 'walkthrough.generationFailure.machineUnavailable'; nextAction: 'reconnectMachine'; nextActionKey: 'walkthrough.generationFailure.reconnectMachine' }>
    | Readonly<{ reason: 'disabled'; messageKey: 'walkthrough.generationFailure.disabled'; nextAction: 'enableExplain'; nextActionKey: 'walkthrough.generationFailure.enableExplain' }>
    | Readonly<{ reason: 'cancelled'; messageKey: 'walkthrough.notice.cancelled'; nextAction: 'retry'; nextActionKey: 'walkthrough.notice.tryAgain' }>
    | Readonly<{ reason: 'generationFailed'; messageKey: 'walkthrough.notice.failedGeneric'; nextAction: 'retry'; nextActionKey: 'walkthrough.notice.tryAgain' }>;

/** A walkthrough that stopped for a reason nobody classified; the native reason and code stay in diagnostics. */
export const SCM_DIFF_SUMMARY_GENERIC_FAILURE = {
    reason: 'generationFailed', messageKey: 'walkthrough.notice.failedGeneric',
    nextAction: 'retry', nextActionKey: 'walkthrough.notice.tryAgain',
} as const satisfies ScmDiffSummaryFailurePresentation;

/** Explain changes (`scm.diffSummary.enabled`) is off: no model work starts until the person turns it on. */
export const SCM_DIFF_SUMMARY_DISABLED_FAILURE = {
    reason: 'disabled', messageKey: 'walkthrough.generationFailure.disabled',
    nextAction: 'enableExplain', nextActionKey: 'walkthrough.generationFailure.enableExplain',
} as const satisfies ScmDiffSummaryFailurePresentation;

function presentScmDiffSummaryFailure(error: NonNullable<ScmDiffSummaryEntry['error']>): ScmDiffSummaryFailurePresentation {
    if (isRpcMethodNotFoundError({ rpcErrorCode: error.code })) {
        return { reason: 'invalidRequest', messageKey: 'walkthrough.generationFailure.invalidRequest',
            nextAction: 'reviewRequest', nextActionKey: 'walkthrough.generationFailure.reviewRequest' };
    }
    switch (error.code) {
        case 'generation_cancelled':
            return { reason: 'cancelled', messageKey: 'walkthrough.notice.cancelled',
                nextAction: 'retry', nextActionKey: 'walkthrough.notice.tryAgain' };
        case 'invalid_parameters':
        case 'invalid_action_transport_input':
        case 'INVALID_REQUEST':
            return { reason: 'invalidRequest', messageKey: 'walkthrough.generationFailure.invalidRequest',
                nextAction: 'reviewRequest', nextActionKey: 'walkthrough.generationFailure.reviewRequest' };
        case 'MODEL_UNAVAILABLE':
        case 'SCM_DIFF_SUMMARY_MODEL_UNAVAILABLE':
        case 'SCM_DIFF_SUMMARY_MODEL_UNSUPPORTED':
        case 'model_structured_output_unsupported':
            return { reason: 'modelUnavailable', messageKey: 'walkthrough.generationFailure.modelUnavailable',
                nextAction: 'chooseModel', nextActionKey: 'walkthrough.notice.chooseModel' };
        case 'target_unavailable':
        case 'RPC_SESSION_MACHINE_CONTROL_UNAVAILABLE':
            return { reason: 'machineUnavailable', messageKey: 'walkthrough.generationFailure.machineUnavailable',
                nextAction: 'reconnectMachine', nextActionKey: 'walkthrough.generationFailure.reconnectMachine' };
        case 'SCM_DIFF_SUMMARY_DISABLED':
            return SCM_DIFF_SUMMARY_DISABLED_FAILURE;
        default:
            return SCM_DIFF_SUMMARY_GENERIC_FAILURE;
    }
}

/** The store's own words when a failed Run or output named no reason; it is a placeholder, never a reason. */
const SCM_DIFF_SUMMARY_NO_REASON_MESSAGE = 'Summary generation failed';

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
        ...(input.input.outputLanguage ? [`language:${input.input.outputLanguage}`] : []),
        ...(input.input.investigateSurroundingFiles === true ? ['investigation:surrounding-files'] : []),
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
    if (output.admission === 'outcomeUnknown' && states.some(status => status === 'pending' || status === 'writing')) return 'unknown';
    return states.every((status) => status === 'complete' || status === 'partial') ? 'succeeded' : 'running';
}

function errorFromOutput(output: ScmDiffSummaryGenerateOutput | null | undefined, input: ScmDiffSummaryGenerateInput): ScmDiffSummaryEntry['error'] {
    if (!output) return null;
    if (!output.success) return { message: output.error, code: output.errorCode };
    for (const kind of input.outputs ?? ['summary']) {
        const progress = output.outputs?.[kind];
        if (progress?.state === 'failed' || progress?.state === 'cancelled') {
            return { message: progress.reason ?? SCM_DIFF_SUMMARY_NO_REASON_MESSAGE,
                ...(progress.state === 'cancelled' && progress.reasonCode ? { code: progress.reasonCode } : {}) };
        }
    }
    return null;
}

function writeEntry(state: ScmDiffSummaryState, entry: Omit<ScmDiffSummaryEntry, 'displayOutputs'>): ScmDiffSummaryState {
    const output = entry.latestOutput;
    const summary = entry.finalSummary ?? entry.lastKnownSummary;
    const previousOutputs = output?.comparison?.id && summary && output.comparison.id === summary.output.comparison?.id
        ? summary.output.outputs : undefined;
    const outputs = output?.outputs && previousOutputs ? retainOutputValues(output.outputs, previousOutputs)
        : output?.outputs ?? summary?.output.outputs ?? null;
    const displayOutputs = reconcileSnapshotFacts(state.entriesByKey[entry.key]?.displayOutputs, outputs);
    return {
        ...state,
        entriesByKey: {
            ...state.entriesByKey,
            [entry.key]: { ...entry, displayOutputs },
        },
    };
}

/** Snapshot ingress has already admitted these data objects. Reuse unchanged facts
 * here so observation carriers never replace captured evidence or published prose. */
function reconcileSnapshotFacts<T>(previous: T | null | undefined, incoming: T): T {
    if (Object.is(previous, incoming)) return incoming;
    if (!previous || !incoming || typeof previous !== 'object' || typeof incoming !== 'object') return incoming;
    if (Array.isArray(previous) !== Array.isArray(incoming)) return incoming;
    const previousRecord = previous as Readonly<Record<string, unknown>>;
    const incomingRecord = incoming as Readonly<Record<string, unknown>>;
    const keys = Object.keys(incoming);
    const shapeChanged = keys.length !== Object.keys(previous).length
        || (Array.isArray(incoming) && incoming.length !== (previous as readonly unknown[]).length);
    let entries: Array<readonly [string, unknown]> | null = shapeChanged ? [] : null;
    for (const [index, key] of keys.entries()) {
        const value = reconcileSnapshotFacts(previousRecord[key], incomingRecord[key]);
        if (!entries && (!Object.hasOwn(previous, key) || !Object.is(value, previousRecord[key]))) {
            entries = keys.slice(0, index).map(previousKey => [previousKey, previousRecord[previousKey]] as const);
        }
        entries?.push([key, value]);
    }
    return entries ? (Array.isArray(incoming) ? entries.map(([, value]) => value) : Object.fromEntries(entries)) as T : previous;
}

function makeStartedEntry(
    event: Extract<ScmDiffSummaryEvent, { type: 'request_started' }>,
    previous: ScmDiffSummaryEntry | null,
): Omit<ScmDiffSummaryEntry, 'displayOutputs'> {
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
        error: errorFromOutput(event.structuredOutput, event.input),
        retryAttempt: event.intent === 'regenerate' ? previous?.retryAttempt ?? 0 : 0,
    };
}

export function applyScmDiffSummaryEvent(state: ScmDiffSummaryState, event: ScmDiffSummaryEvent): ScmDiffSummaryState {
    const previous = state.entriesByKey[event.key] ?? null;

    if (event.type === 'request_started') {
        return writeEntry(state, makeStartedEntry(event, previous));
    }

    if (event.type === 'request_failed') {
        const entry: Omit<ScmDiffSummaryEntry, 'displayOutputs'> = {
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
        const entry: Omit<ScmDiffSummaryEntry, 'displayOutputs'> = {
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
        const savedResult = reconcileSnapshotFacts(previous.savedResult, event.result);
        const output = reconcileSnapshotFacts(previous.latestOutput, {
            ...savedResult.output, resultId: savedResult.resultId, revision: savedResult.revision,
        });
        // Machine reads can echo unchanged results while commit progress is polled.
        // Equal revisions alone are insufficient: apply progress and Undo availability
        // can change independently, and a successful reread must clear a read error.
        if (output.success && previous.error === null
            && previous.status === statusFromOutput(output, previous.input)
            && savedResult === previous.savedResult
            && output === previous.latestOutput) return state;
        const payload = output === previous.latestOutput && previous.finalSummary ? previous.finalSummary : readPayload(output);
        const nextRunId = output.runId ?? previous.executionRunId;
        return writeEntry(state, {
            ...previous,
            savedResult,
            latestOutput: output,
            status: statusFromOutput(output, previous.input),
            finalSummary: payload,
            lastKnownSummary: payload ?? previous.lastKnownSummary,
            executionRunId: nextRunId,
            latestRun: previous.latestRun?.runId === nextRunId ? previous.latestRun : null,
            observedAtMs: event.observedAtMs,
            error: errorFromOutput(output, previous.input),
        });
    }
    if (previous.executionRunId && previous.executionRunId !== event.run.runId) return state;

    const currentRevision = previous.latestOutput?.revision ?? -1;
    const incoming = event.structuredOutput;
    const foreignResult = incoming?.resultId && previous.latestOutput?.resultId && incoming.resultId !== previous.latestOutput.resultId;
    const olderRevision = incoming?.resultId === previous.latestOutput?.resultId && (incoming?.revision ?? -1) < currentRevision;
    const accepted = foreignResult || olderRevision ? null : incoming;
    const output = accepted ? reconcileSnapshotFacts(previous.latestOutput, accepted) : previous.latestOutput;
    const structuredPayload = accepted && output !== previous.latestOutput ? readPayload(output) : null;
    const outputStatus = statusFromOutput(output, previous.input);
    const runFailure = errorFromOutput(output, previous.input)
        ?? (outputStatus !== 'succeeded' && (event.run.status === 'failed' || event.run.status === 'cancelled')
            ? {
                message: event.run.error?.message ?? SCM_DIFF_SUMMARY_NO_REASON_MESSAGE,
                ...(event.run.error?.code ? { code: event.run.error.code } : {}),
            }
            : null);
    const nextStatus = runFailure ? 'failed' : outputStatus;
    const nextSummary = structuredPayload ?? previous.finalSummary;

    const next = reconcileSnapshotFacts(previous, {
        ...previous,
        status: nextStatus,
        executionRunId: event.run.runId,
        callId: event.run.callId,
        sidechainId: event.run.sidechainId,
        pendingIntent: nextStatus === 'running' ? previous.pendingIntent : null,
        observedAtMs: previous.observedAtMs,
        streamingMarkdown: typeof event.progressMarkdown === 'string' ? event.progressMarkdown : previous.streamingMarkdown,
        latestRun: reconcileSnapshotFacts(previous.latestRun, event.run),
        latestOutput: output,
        finalSummary: nextSummary,
        lastKnownSummary: nextSummary ?? previous.finalSummary ?? previous.lastKnownSummary,
        error: runFailure,
    });
    return next === previous ? state : writeEntry(state, { ...next, observedAtMs: event.observedAtMs });
}

export function selectScmDiffSummaryEntry(state: ScmDiffSummaryState, key: string): ScmDiffSummaryEntry | null {
    return state.entriesByKey[key] ?? null;
}

function retainOutputValue<T extends Readonly<{ value?: unknown }>>(current: T | undefined, previous: T | undefined): T | undefined {
    return current && current.value === undefined && previous?.value !== undefined
        ? { ...current, value: previous.value }
        : current;
}

function retainOutputValues(current: ScmDiffSummaryOutputs, previous: ScmDiffSummaryOutputs): ScmDiffSummaryOutputs {
    const summary = retainOutputValue(current.summary, previous.summary);
    const walkthrough = retainOutputValue(current.walkthrough, previous.walkthrough);
    const commitPlan = retainOutputValue(current.commitPlan, previous.commitPlan);
    return summary === current.summary && walkthrough === current.walkthrough && commitPlan === current.commitPlan
        ? current : { ...current, summary, walkthrough, commitPlan };
}

export function selectScmDiffSummaryViewModel(state: ScmDiffSummaryState, key: string, requestedOutput?: ScmDiffSummaryOutputKind): ScmDiffSummaryViewModel {
    const entry = selectScmDiffSummaryEntry(state, key);
    const summary = entry?.finalSummary ?? entry?.lastKnownSummary ?? null;
    const output = entry?.latestOutput ?? null;
    const requestedOutputs: readonly ScmDiffSummaryOutputKind[] = requestedOutput ? [requestedOutput] : entry?.input.outputs ?? output?.requestedOutputs ?? ['summary'];
    // A reader asks for one output. A failed sibling must not relabel its completed proposal/reading.
    // Admission failures still belong to the request and remain visible over a retained previous value.
    const selectedInput = entry && requestedOutput ? { ...entry.input, outputs: [requestedOutput] } : entry?.input;
    const outputFailure = entry ? errorFromOutput(output, entry.input) : null;
    // request_failed retains the old output and its intent; a terminal run clears that intent.
    const requestFailed = entry?.status === 'failed' && entry.pendingIntent !== null;
    const projectOutput = Boolean(requestedOutput && output && !requestFailed && (outputFailure || !entry?.error));
    const error = projectOutput && selectedInput ? errorFromOutput(output, selectedInput) : entry?.error;
    const status = projectOutput && selectedInput ? statusFromOutput(output, selectedInput) : entry?.status ?? 'idle';
    const isShowingLastKnownSummary = Boolean(entry && !entry.finalSummary && entry.lastKnownSummary);
    return {
        requestKey: key,
        observedAtMs: entry?.observedAtMs ?? null,
        status,
        admission: output?.admission ?? null,
        actionId: SCM_DIFF_SUMMARY_GENERATE_ACTION_ID,
        executionRunId: entry?.executionRunId ?? null,
        inputId: (output?.success === true ? output.inputId : undefined) ?? summary?.output.inputId ?? null,
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
        error: error ? { ...error, ...presentScmDiffSummaryFailure(error) } : null,
        canRetry: Boolean(entry && (status === 'failed' || status === 'succeeded')),
        retryAttempt: entry?.retryAttempt ?? 0,
        latestRun: entry?.latestRun ?? null,
        comparison: output?.comparison ?? summary?.output.comparison ?? null,
        requestedOutputs,
        outputs: entry?.displayOutputs ?? null,
        analysis: output?.analysis ?? summary?.output.analysis ?? null,
        resultId: output?.resultId ?? summary?.output.resultId ?? null,
        revision: output?.revision ?? summary?.output.revision ?? null,
        producer: output?.producer ?? summary?.output.producer ?? null,
        savedResult: entry?.savedResult ?? null,
    };
}
