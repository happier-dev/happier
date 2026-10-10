import type {
    BackendTargetRefV2,
    ExecutionRunGetRequest,
    ExecutionRunGetResponse,
    ExecutionRunPublicState,
    ScmDiffSummaryGenerateInput,
    ScmDiffSummaryGenerateOutput,
    ScmDiffSummaryGenerateSuccess,
    ScmDiffSummaryOutputKind,
    ScmComparisonCaptureInput,
    ScmComparisonCaptureOutput,
    TurnChangeSet,
    ScmDiffSummaryResult,
} from '@happier-dev/protocol';
import { SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION, ScmComparisonCaptureOutputSchema, ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    SCM_DIFF_SUMMARY_GENERATE_ACTION_ID,
    applyScmDiffSummaryEvent,
    buildScmDiffSummaryRequestKey,
    createInitialScmDiffSummaryState,
    selectScmDiffSummaryViewModel,
    type ScmDiffSummaryOperationIntent,
    type ScmDiffSummaryState,
    type ScmDiffSummaryViewModel,
} from '@/sync/domains/scm/diffSummary/state';
import {
    createScmDiffSummaryCacheState,
    pruneScmDiffSummaryCacheByCheckpointCleanupReceipt,
    putScmDiffSummaryCacheEntry,
    type CheckpointCleanupReceiptLike,
    type ScmDiffSummaryCacheState,
} from '@/sync/domains/scm/diffSummary/cache/cacheState';
import type { ScmDiffSummaryCacheKeyInput } from '@/sync/domains/scm/diffSummary/cache/cacheKey';
import type { ScmDiffSummaryHost } from './results';
import { invokeUiScmAction, type UiScmActionExecutor } from '@/sync/ops/scm/scmActionInvocation';
import { scmReviewComparisonMatchesSource } from '@/sync/domains/scm/diffSummary/selection';
import { sessionExecutionRunGet } from '@/sync/ops/sessionExecutionRuns';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    resolveScmDiffSummarySettings,
    type ScmDiffSummaryCatalogProfile,
} from '@/settings/scmDiffSummary/settings';

export type ScmDiffSummaryGenerateRpc = (
    sessionId: string,
    request: ScmDiffSummaryGenerateInput,
    opts?: Readonly<{ serverId?: string | null; scope?: ServerAccountScope; signal?: AbortSignal }>,
) => Promise<ScmDiffSummaryGenerateOutput | { success: false; error: string; errorCode?: string }>;

export type ScmComparisonCaptureResult = ScmComparisonCaptureOutput | Readonly<{ success: false; error: string; errorCode?: string }>;
export type ScmComparisonCaptureRpc = (
    sessionId: string,
    request: ScmComparisonCaptureInput,
    opts?: Readonly<{ serverId?: string | null; scope?: ServerAccountScope; signal?: AbortSignal }>,
) => Promise<ScmComparisonCaptureResult>;

export type CaptureScmComparisonParams = ScmDiffSummaryHost & Readonly<{
    serverId?: string | null;
    scope?: ServerAccountScope;
    signal?: AbortSignal;
    shouldContinue?: () => boolean;
    input: ScmComparisonCaptureInput;
}>;

export type ScmDiffSummaryGetExecutionRun = (
    sessionId: string,
    request: ExecutionRunGetRequest,
    opts?: Readonly<{ serverId?: string | null; scope?: ServerAccountScope; signal?: AbortSignal }>,
) => Promise<ExecutionRunGetResponse | { ok: false; error: string; errorCode?: string }>;

export type ScmDiffSummaryOperationsDeps = Readonly<{
    actionExecutor?: UiScmActionExecutor;
    getExecutionRun?: ScmDiffSummaryGetExecutionRun;
    nowMs?: () => number;
}>;

export type GenerateScmDiffSummaryParams = ScmDiffSummaryHost & Readonly<{
    key?: string;
    serverId?: string | null;
    scope?: ServerAccountScope;
    signal?: AbortSignal;
    shouldContinue?: () => boolean;
    backendTarget: BackendTargetRefV2;
    input: ScmDiffSummaryGenerateInput;
    turnChangeSet?: TurnChangeSet;
    intent?: Exclude<ScmDiffSummaryOperationIntent, 'copy'>;
    settings?: Readonly<Record<string, unknown>>;
    catalogProfiles?: readonly ScmDiffSummaryCatalogProfile[];
    resolvedSelector?: Readonly<{ catalogId: string }>;
}>;

export type RefreshScmDiffSummaryRunParams = ScmDiffSummaryHost & Readonly<{
    key: string;
    serverId?: string | null;
    runId: string;
    progressMarkdown?: string | null;
    scope?: ServerAccountScope;
    signal?: AbortSignal;
    shouldContinue?: () => boolean;
    waitForOutput?: ExecutionRunGetRequest['waitForOutput'];
    waitForInputId?: string;
}>;

export type ScmDiffSummaryOperationResult =
    | Readonly<{ ok: true; key: string; runId: string | null; state: ScmDiffSummaryState; viewModel: ScmDiffSummaryViewModel }>
    | Readonly<{ ok: false; key: string; error: string; errorCode?: string; state: ScmDiffSummaryState; viewModel: ScmDiffSummaryViewModel }>;

type OperationError = Readonly<{ ok: false; error: string; errorCode?: string }>;

async function machineSummaryRpc<R>(machineId: string, method: string, payload: object,
    options: Readonly<{ serverId?: string | null; scope?: ServerAccountScope; signal?: AbortSignal }> = {}): Promise<R> {
    const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
    return machineRpcWithServerScope<R, object>({ machineId, method, payload,
        ...(method === RPC_METHODS.DAEMON_EXECUTION_RUN_GET && ('waitForOutput' in payload || 'waitForInputId' in payload)
            ? { operationTimeoutMs: null } : {}),
        ...(options.scope ? { serverId: options.scope.serverId, accountId: options.scope.accountId }
            : options.serverId ? { serverId: options.serverId } : {}), ...(options.signal ? { signal: options.signal } : {}) });
}

function readServerOptions(serverId: string | null | undefined): Readonly<{ serverId: string }> | undefined {
    const normalized = typeof serverId === 'string' ? serverId.trim() : '';
    return normalized ? { serverId: normalized } : undefined;
}

function readOperationError(value: unknown): OperationError | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Readonly<Record<string, unknown>>;
    if ((record.ok !== false && record.success !== false) || typeof record.error !== 'string') return null;
    return {
        ok: false,
        error: record.error,
        ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
    };
}

function readRunResponse(value: unknown): ExecutionRunGetResponse | null {
    if (!value || typeof value !== 'object') return null;
    const run = (value as Readonly<Record<string, unknown>>).run;
    if (!run || typeof run !== 'object' || typeof (run as Readonly<Record<string, unknown>>).runId !== 'string') {
        return null;
    }
    return value as ExecutionRunGetResponse;
}

function readStructuredOutput(response: ExecutionRunGetResponse): ScmDiffSummaryGenerateOutput | null {
    const latestToolResult = ScmDiffSummaryGenerateOutputSchema.safeParse(response.latestToolResult);
    if (latestToolResult.success) return latestToolResult.data;
    if (response.structuredMeta?.kind === 'scm_diff_summary.v1') {
        const payload = response.structuredMeta.payload;
        const parsed = ScmDiffSummaryGenerateOutputSchema.safeParse(payload);
        if (parsed.success) return parsed.data;
    }
    return null;
}

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveSelectorCatalogId(params: GenerateScmDiffSummaryParams): string {
    const resolvedSettings = resolveScmDiffSummarySettings({
        storedSettings: params.settings ?? {},
        catalogProfiles: params.catalogProfiles ?? [],
    });
    if (resolvedSettings.modelOverride) return resolvedSettings.modelOverride.catalogId;

    const explicit = readNonEmptyString(params.resolvedSelector?.catalogId);
    if (explicit) return explicit;

    return buildBackendTargetKeyV2(params.backendTarget);
}

function buildResolvedSelector(params: GenerateScmDiffSummaryParams): Readonly<{ catalogId: string }> {
    const modelSelector = buildGenerateRequest(params).modelSelector;
    return { catalogId: JSON.stringify([resolveSelectorCatalogId(params), modelSelector?.profileId ?? null, modelSelector?.modelId ?? null, modelSelector?.backendTargetKey ?? null]) };
}

function buildRequestKey(params: GenerateScmDiffSummaryParams): string {
    const key = buildScmDiffSummaryRequestKey({
        sessionId: params.sessionId ?? null, ...(params.machineId ? { machineId: params.machineId } : {}),
        input: buildGenerateRequest(params),
        summarySchemaVersion: SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION,
        resolvedSelector: buildResolvedSelector(params),
    });
    return params.scope ? `${serverAccountScopeKeySuffix(params.scope)}|${key}` : key;
}

function hasDurableCheckpointHint(params: GenerateScmDiffSummaryParams): boolean {
    if (params.input.source.kind !== 'turnCheckpoint') return false;
    const checkpointReceiptId = (params.input.source.checkpointReceiptId ?? params.input.checkpointReceiptId)?.trim();
    const turn = params.turnChangeSet;
    const receipt = readCompletedScmDiffSummaryCheckpointReceipt(turn);
    return Boolean(receipt && checkpointReceiptId === receipt.id
        && turn?.sessionId === params.sessionId
        && (params.input.source.turnId ?? params.input.turnId) === turn.turnId);
}

/** Only a completed turn's durable final receipt can authorize automatic analysis. */
export function readCompletedScmDiffSummaryCheckpointReceipt(turn: TurnChangeSet | undefined): NonNullable<TurnChangeSet['repositoryCheckpoint']>['receipts'][number] | null {
    const checkpoint = turn?.repositoryCheckpoint;
    if (turn?.status !== 'completed' || !checkpoint || checkpoint.unavailableReason || !checkpoint.startRef?.trim() || !checkpoint.finalRef?.trim()) return null;
    return checkpoint.receipts.find((receipt) => receipt.id === 'checkpoint.finalized'
        && receipt.phase === 'turn-final' && receipt.ref?.trim() === checkpoint.finalRef?.trim()) ?? null;
}

function buildCacheKeyInput(params: Readonly<{ sessionId?: string | null; machineId?: string; serverId?: string | null; input: ScmDiffSummaryGenerateInput }>, output: ScmDiffSummaryGenerateSuccess, resolvedSelector: Readonly<{ catalogId: string }>): ScmDiffSummaryCacheKeyInput | null {
    if (!output.comparison) return null;
    return {
        source: { kind: 'comparison', comparisonId: output.comparison.id },
        summarySchemaVersion: SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION,
        resolvedSelector,
        outputs: params.input.outputs,
        scopeKey: JSON.stringify([params.serverId?.trim() ?? null, params.sessionId ?? null, params.machineId ?? null, params.input.cwd]),
    };
}

function readCheckpointRef(params: GenerateScmDiffSummaryParams): string | undefined {
    const receipts = params.turnChangeSet?.repositoryCheckpoint?.receipts ?? [];
    const checkpointReceiptId = params.input.source.kind === 'turnCheckpoint'
        ? (params.input.source.checkpointReceiptId ?? params.input.checkpointReceiptId)?.trim() : undefined;
    const exact = receipts.find((receipt) => checkpointReceiptId && receipt.id === checkpointReceiptId)?.ref?.trim();
    if (exact) return exact;
    const fallback = receipts.length === 1 ? receipts[0]?.ref?.trim() : '';
    return fallback || undefined;
}

function hasCompletedRequestedOutputs(output: ScmDiffSummaryGenerateSuccess, input: ScmDiffSummaryGenerateInput): boolean {
    const requested: readonly ScmDiffSummaryOutputKind[] = input.outputs ?? ['summary'];
    if (!output.outputs) return Boolean(output.summaryMarkdown) && requested.every((kind) => kind === 'summary');
    return requested.every((kind) => output.outputs?.[kind]?.state === 'complete');
}

function buildGenerateRequest(params: GenerateScmDiffSummaryParams): ScmDiffSummaryGenerateInput {
    const settings = resolveScmDiffSummarySettings({ storedSettings: params.settings ?? {}, catalogProfiles: params.catalogProfiles ?? [] });
    const override = settings.modelOverride?.catalogId;
    return {
        ...params.input,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        modelSelector: {
            backendTargetKey: buildBackendTargetKeyV2(params.backendTarget),
            ...params.input.modelSelector,
            ...(settings.modelOverride?.modelSelector ?? (override?.startsWith('profile:') ? { profileId: override.slice('profile:'.length) } : override ? { backendTargetKey: override } : {})),
        },
        ...(params.intent === 'regenerate' ? { cachePolicy: { mode: 'bypass' } } : {}),
    };
}

export function createScmDiffSummaryOperations(deps: ScmDiffSummaryOperationsDeps = {}) {
    const actionContext = (params: CaptureScmComparisonParams | GenerateScmDiffSummaryParams) => ({
        ...(params.sessionId ? { defaultSessionId: params.sessionId, externalActionTarget: { kind: 'session' as const, sessionId: params.sessionId } }
            : { externalActionTarget: { kind: 'machine' as const, machineId: params.machineId! } }),
        ...(params.scope ? { serverId: params.scope.serverId, expectedAccountId: params.scope.accountId }
            : params.serverId ? { serverId: params.serverId } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
    });
    const getExecutionRun = deps.getExecutionRun ?? sessionExecutionRunGet;
    const nowMs = deps.nowMs ?? Date.now;
    let state = createInitialScmDiffSummaryState();
    let cacheState: ScmDiffSummaryCacheState = createScmDiffSummaryCacheState();
    const selectorByRequestKey = new Map<string, Readonly<{ catalogId: string }>>();
    const checkpointRefByRequestKey = new Map<string, string>();
    const prefetchByRequestKey = new Map<string, Promise<ScmDiffSummaryOperationResult>>();
    const listeners = new Set<() => void>();

    const setState = (next: ScmDiffSummaryState) => {
        if (Object.is(next, state)) return;
        state = next;
        for (const listener of listeners) listener();
    };

    const getState = () => state;
    const subscribe = (listener: () => void) => {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    };

    const applyCheckpointCleanupReceiptsFromTurnChangeSet = (turnChangeSet: TurnChangeSet | undefined): void => {
        const receipts = turnChangeSet?.repositoryCheckpoint?.receipts ?? [];
        for (const receipt of receipts) {
            if (receipt.id !== 'checkpoint.cleanup_pruned') continue;
            const pruned = pruneScmDiffSummaryCacheByCheckpointCleanupReceipt(cacheState, receipt);
            cacheState = pruned.state;
        }
    };

    const captureComparison = async (params: CaptureScmComparisonParams): Promise<ScmComparisonCaptureResult> => {
        const current = () => !params.signal?.aborted && params.shouldContinue?.() !== false;
        const retired = (): ScmComparisonCaptureResult => ({ success: false,
            error: 'The captured Account or Session retired.', errorCode: 'SCM_DIFF_SUMMARY_SCOPE_RETIRED' });
        if (!current()) return retired();
        const request = { ...params.input, ...(params.sessionId ? { sessionId: params.sessionId } : {}) };
        const result = await invokeUiScmAction({ actionId: 'scm.diffSummary.capture', input: request,
            schema: ScmComparisonCaptureOutputSchema, context: actionContext(params), executor: deps.actionExecutor,
            shouldContinue: current });
        if (!current()) return retired();
        const parsed = ScmComparisonCaptureOutputSchema.safeParse(result);
        if (parsed.success) {
            const requestedSource = request.source.kind === 'turnCheckpoint' ? { ...request.source,
                ...(request.turnId ? { turnId: request.turnId } : {}),
                ...(request.checkpointReceiptId ? { checkpointReceiptId: request.checkpointReceiptId } : {}),
                ...(request.turnEvidenceMode ? { evidenceMode: request.turnEvidenceMode } : {}) } : request.source;
            if (parsed.data.success && (parsed.data.comparison.repository.rootPath !== request.cwd
                || (request.comparisonId && parsed.data.comparison.id !== request.comparisonId)
                || !scmReviewComparisonMatchesSource(requestedSource, parsed.data.comparison.source, parsed.data.comparison))) {
                return { success: false, error: 'Captured comparison evidence does not match the requested checkout or source.', errorCode: 'DIFF_UNAVAILABLE' };
            }
            return parsed.data;
        }
        const error = readOperationError(result);
        return { success: false, error: error?.error ?? 'Unsupported SCM comparison capture response', ...(error?.errorCode ? { errorCode: error.errorCode } : {}) };
    };

    const generateFromUserAction = async (params: GenerateScmDiffSummaryParams): Promise<ScmDiffSummaryOperationResult> => {
        const key = params.key ?? buildRequestKey(params);
        const current = () => !params.signal?.aborted && params.shouldContinue?.() !== false;
        const retired = (): ScmDiffSummaryOperationResult => ({
            ok: false, key, error: 'The captured Account or Session retired.',
            errorCode: 'SCM_DIFF_SUMMARY_SCOPE_RETIRED', state, viewModel: selectScmDiffSummaryViewModel(state, key),
        });
        if (!current()) return retired();
        const intent = params.intent ?? 'generate';
        const resolvedSettings = resolveScmDiffSummarySettings({
            storedSettings: params.settings ?? {},
            catalogProfiles: params.catalogProfiles ?? [],
        });
        if (!resolvedSettings.enabled) {
            return {
                ok: false,
                key,
                error: 'SCM diff summary generation is disabled',
                errorCode: 'SCM_DIFF_SUMMARY_DISABLED',
                state,
                viewModel: selectScmDiffSummaryViewModel(state, key),
            };
        }
        if (resolvedSettings.modelOverrideError) {
            const error = resolvedSettings.modelOverrideError === 'SCM_DIFF_SUMMARY_MODEL_UNSUPPORTED'
                ? 'Structured output is unavailable for the selected model.'
                : 'The selected model is unavailable.';
            const errorCode = resolvedSettings.modelOverrideError === 'SCM_DIFF_SUMMARY_MODEL_UNSUPPORTED'
                ? 'model_structured_output_unsupported'
                : 'SCM_DIFF_SUMMARY_MODEL_UNAVAILABLE';
            setState(applyScmDiffSummaryEvent(state, {
                type: 'request_failed', key, sessionId: params.sessionId ?? null, ...(params.machineId ? { machineId: params.machineId } : {}),
                scopeKey: params.scope ? serverAccountScopeKeySuffix(params.scope) : undefined,
                actionId: SCM_DIFF_SUMMARY_GENERATE_ACTION_ID, input: params.input,
                error, errorCode, failedAtMs: nowMs(), intent,
            }));
            return { ok: false, key, error, errorCode, state, viewModel: selectScmDiffSummaryViewModel(state, key) };
        }
        applyCheckpointCleanupReceiptsFromTurnChangeSet(params.turnChangeSet);
        const generated = await invokeUiScmAction({ actionId: 'scm.diffSummary.generate', input: buildGenerateRequest(params),
            schema: ScmDiffSummaryGenerateOutputSchema, context: actionContext(params), executor: deps.actionExecutor,
            shouldContinue: current });
        if (!current()) return retired();
        const parsed = ScmDiffSummaryGenerateOutputSchema.safeParse(generated);
        const output = parsed.success ? parsed.data : null;
        if (!output) {
            const error = readOperationError(generated) ?? { ok: false, error: 'Unsupported diff-summary generate response' };
            setState(applyScmDiffSummaryEvent(state, {
                type: 'request_failed',
                key,
                sessionId: params.sessionId ?? null, ...(params.machineId ? { machineId: params.machineId } : {}),
                scopeKey: params.scope ? serverAccountScopeKeySuffix(params.scope) : undefined,
                actionId: SCM_DIFF_SUMMARY_GENERATE_ACTION_ID,
                input: params.input,
                error: error.error,
                ...(error.errorCode ? { errorCode: error.errorCode } : {}),
                failedAtMs: nowMs(),
                intent,
            }));
            return {
                ok: false,
                key,
                error: error.error,
                ...(error.errorCode ? { errorCode: error.errorCode } : {}),
                state,
                viewModel: selectScmDiffSummaryViewModel(state, key),
            };
        }

        const selector = buildResolvedSelector(params);
        selectorByRequestKey.set(key, selector);
        const cacheKeyInput = output.success ? buildCacheKeyInput(params, output, selector) : null;
        if (cacheKeyInput) {
            const checkpointRef = readCheckpointRef(params);
            if (checkpointRef) {
                checkpointRefByRequestKey.set(key, checkpointRef);
            } else {
                checkpointRefByRequestKey.delete(key);
            }
        }

        setState(applyScmDiffSummaryEvent(state, {
            type: 'request_started',
            key,
            sessionId: params.sessionId ?? null, ...(params.machineId ? { machineId: params.machineId } : {}),
            scopeKey: params.scope ? serverAccountScopeKeySuffix(params.scope) : undefined,
            actionId: SCM_DIFF_SUMMARY_GENERATE_ACTION_ID,
            input: params.input,
            runId: output.runId ?? null,
            structuredOutput: output,
            requestedAtMs: nowMs(),
            intent,
        }));
        if (cacheKeyInput && output.success && hasCompletedRequestedOutputs(output, params.input)) {
            cacheState = putScmDiffSummaryCacheEntry(cacheState, {
                keyInput: cacheKeyInput, checkpointRef: checkpointRefByRequestKey.get(key), entry: output,
            });
        }
        if (!output.success) {
            return { ok: false, key, error: output.error, errorCode: output.errorCode, state, viewModel: selectScmDiffSummaryViewModel(state, key) };
        }
        return {
            ok: true,
            key,
            runId: output.runId ?? null,
            state,
            viewModel: selectScmDiffSummaryViewModel(state, key),
        };
    };

    const prefetch = async (params: Omit<GenerateScmDiffSummaryParams, 'intent'>): Promise<ScmDiffSummaryOperationResult> => {
        const key = params.key ?? buildRequestKey(params);
        const resolvedSettings = resolveScmDiffSummarySettings({
            storedSettings: params.settings ?? {},
            catalogProfiles: params.catalogProfiles ?? [],
        });
        if (!resolvedSettings.prefetch) {
            return {
                ok: false,
                key,
                error: 'SCM diff summary prefetch is disabled',
                errorCode: 'SCM_DIFF_SUMMARY_PREFETCH_DISABLED',
                state,
                viewModel: selectScmDiffSummaryViewModel(state, key),
            };
        }
        if (!hasDurableCheckpointHint(params)) {
            return {
                ok: false, key, error: 'SCM diff summary prefetch requires a durable checkpoint comparison',
                errorCode: 'SCM_DIFF_SUMMARY_PREFETCH_SOURCE_UNSUPPORTED', state,
                viewModel: selectScmDiffSummaryViewModel(state, key),
            };
        }
        if (params.signal?.aborted || params.shouldContinue?.() === false) {
            return { ok: false, key, error: 'The captured Account or Session retired.', errorCode: 'SCM_DIFF_SUMMARY_SCOPE_RETIRED', state,
                viewModel: selectScmDiffSummaryViewModel(state, key) };
        }
        const inFlight = prefetchByRequestKey.get(key);
        if (inFlight) return inFlight;
        const entry = state.entriesByKey[key];
        if (entry) {
            const viewModel = selectScmDiffSummaryViewModel(state, key);
            return entry.error
                ? { ok: false, key, error: entry.error.message, errorCode: entry.error.code, state, viewModel }
                : { ok: true, key, runId: entry.executionRunId, state, viewModel };
        }
        // Socket delivery, catch-up and remounts share the existing request identity.
        // A failed admission remains explicit state; only a user action retries it.
        const request = generateFromUserAction({ ...params, intent: 'generate' });
        prefetchByRequestKey.set(key, request);
        try { return await request; }
        finally { if (prefetchByRequestKey.get(key) === request) prefetchByRequestKey.delete(key); }
    };

    const refreshRun = async (params: RefreshScmDiffSummaryRunParams): Promise<ScmDiffSummaryOperationResult> => {
        const current = () => !params.signal?.aborted && params.shouldContinue?.() !== false;
        const retired = (): ScmDiffSummaryOperationResult => ({ ok: false, key: params.key,
            error: 'The captured Account or Session retired.', errorCode: 'SCM_DIFF_SUMMARY_SCOPE_RETIRED',
            state, viewModel: selectScmDiffSummaryViewModel(state, params.key) });
        if (!current()) return retired();
        const serverOptions = params.scope || params.signal
            ? { ...readServerOptions(params.serverId), ...(params.scope ? { scope: params.scope } : {}), ...(params.signal ? { signal: params.signal } : {}) }
            : readServerOptions(params.serverId);
        const request: ExecutionRunGetRequest = { runId: params.runId, includeStructured: true,
            ...(params.waitForOutput ? { waitForOutput: params.waitForOutput } : {}),
            ...(params.waitForInputId ? { waitForInputId: params.waitForInputId } : {}) };
        const response = params.machineId !== undefined
            ? await machineSummaryRpc<unknown>(params.machineId, RPC_METHODS.DAEMON_EXECUTION_RUN_GET, request, serverOptions)
            : serverOptions ? await getExecutionRun(params.sessionId, request, serverOptions)
                : await getExecutionRun(params.sessionId, request);
        if (!current()) return retired();
        const error = readOperationError(response);
        if (error) {
            const entry = state.entriesByKey[params.key];
            if (!entry) {
                return {
                    ok: false,
                    key: params.key,
                    error: error.error,
                    ...(error.errorCode ? { errorCode: error.errorCode } : {}),
                    state,
                    viewModel: selectScmDiffSummaryViewModel(state, params.key),
                };
            }
            setState(applyScmDiffSummaryEvent(state, {
                type: 'request_failed',
                key: params.key,
                sessionId: entry.sessionId,
                actionId: SCM_DIFF_SUMMARY_GENERATE_ACTION_ID,
                input: entry.input,
                error: error.error,
                ...(error.errorCode ? { errorCode: error.errorCode } : {}),
                failedAtMs: nowMs(),
                intent: 'regenerate',
            }));
            return {
                ok: false,
                key: params.key,
                error: error.error,
                ...(error.errorCode ? { errorCode: error.errorCode } : {}),
                state,
                viewModel: selectScmDiffSummaryViewModel(state, params.key),
            };
        }
        const runResponse = readRunResponse(response);
        if (!runResponse) {
            return {
                ok: false,
                key: params.key,
                error: 'Unsupported diff-summary execution-run get response',
                state,
                viewModel: selectScmDiffSummaryViewModel(state, params.key),
            };
        }
        const run = runResponse.run as ExecutionRunPublicState;
        const structuredOutput = readStructuredOutput(runResponse);
        setState(applyScmDiffSummaryEvent(state, {
            type: 'run_snapshot',
            key: params.key,
            run,
            structuredOutput,
            progressMarkdown: params.progressMarkdown ?? null,
            observedAtMs: nowMs(),
        }));
        const entry = state.entriesByKey[params.key];
        const selector = selectorByRequestKey.get(params.key);
        const cacheKeyInput = entry && selector && structuredOutput?.success
            ? buildCacheKeyInput({ sessionId: entry.sessionId, machineId: entry.machineId, serverId: params.serverId, input: entry.input }, structuredOutput, selector) : null;
        if (cacheKeyInput && structuredOutput?.success === true && entry && hasCompletedRequestedOutputs(structuredOutput, entry.input)) {
            cacheState = putScmDiffSummaryCacheEntry(cacheState, {
                keyInput: cacheKeyInput,
                checkpointRef: checkpointRefByRequestKey.get(params.key),
                entry: structuredOutput,
            });
        }
        return {
            ok: true,
            key: params.key,
            runId: run.runId,
            state,
            viewModel: selectScmDiffSummaryViewModel(state, params.key),
        };
    };

    const recordCopyIntent = (key: string): ScmDiffSummaryViewModel => {
        setState(applyScmDiffSummaryEvent(state, {
            type: 'copy_requested',
            key,
            requestedAtMs: nowMs(),
        }));
        return selectScmDiffSummaryViewModel(state, key);
    };

    const applyCheckpointCleanupReceipt = (receipt: CheckpointCleanupReceiptLike): Readonly<{ prunedEntries: number }> => {
        const pruned = pruneScmDiffSummaryCacheByCheckpointCleanupReceipt(cacheState, receipt);
        cacheState = pruned.state;
        return { prunedEntries: pruned.prunedEntries };
    };

    return {
        getState,
        subscribe,
        captureComparison,
        generateFromUserAction,
        prefetch,
        refreshRun,
        loadSavedResult: (params: ScmDiffSummaryHost & Readonly<{ scope: ServerAccountScope; result: ScmDiffSummaryResult }>): string | null => {
            const output = params.result.output;
            if (!output.success || !output.comparison) return null;
            const scopeKey = serverAccountScopeKeySuffix(params.scope);
            const existing = Object.values(state.entriesByKey).find((entry) => entry.scopeKey === scopeKey
                && entry.sessionId === (params.sessionId ?? null) && entry.machineId === params.machineId && entry.input.cwd === output.comparison?.repository.rootPath && (entry.savedResult?.resultId ?? (entry.latestOutput?.success ? entry.latestOutput.resultId : null)) === params.result.resultId);
            const key = existing?.key ?? JSON.stringify([scopeKey, params.sessionId ?? null, params.machineId ?? null, output.comparison.repository.rootPath, 'saved', params.result.resultId]);
            let next = state;
            if (!existing) next = applyScmDiffSummaryEvent(next, { type: 'request_started', key, scopeKey,
                sessionId: params.sessionId ?? null, ...(params.machineId ? { machineId: params.machineId } : {}), actionId: SCM_DIFF_SUMMARY_GENERATE_ACTION_ID,
                input: { cwd: output.comparison.repository.rootPath, source: output.comparison.source, outputs: output.requestedOutputs ?? ['walkthrough'] },
                runId: output.runId ?? null, structuredOutput: output, requestedAtMs: nowMs(), intent: 'generate' });
            setState(applyScmDiffSummaryEvent(next, { type: 'saved_result', key, result: params.result, observedAtMs: nowMs() }));
            return key;
        },
        applySavedResult: (key: string, result: ScmDiffSummaryResult) => {
            setState(applyScmDiffSummaryEvent(state, { type: 'saved_result', key, result, observedAtMs: nowMs() }));
        },
        deleteSavedResults: (scope: ServerAccountScope, resultIds: readonly string[]) => {
            const scopeKey = serverAccountScopeKeySuffix(scope);
            const ids = new Set(resultIds);
            const entries = Object.entries(state.entriesByKey).filter(([key, entry]) => {
                const resultId = entry.savedResult?.resultId ?? (entry.latestOutput?.success ? entry.latestOutput.resultId : null);
                if (entry.scopeKey !== scopeKey || !resultId || !ids.has(resultId)) return true;
                selectorByRequestKey.delete(key);
                checkpointRefByRequestKey.delete(key);
                return false;
            });
            if (entries.length !== Object.keys(state.entriesByKey).length) setState({ entriesByKey: Object.fromEntries(entries) });
        },
        retireScope: (scope: ServerAccountScope) => {
            const scopeKey = serverAccountScopeKeySuffix(scope);
            const entries = Object.entries(state.entriesByKey).filter(([, entry]) => entry.scopeKey !== scopeKey);
            if (entries.length === Object.keys(state.entriesByKey).length) return;
            setState({ entriesByKey: Object.fromEntries(entries) });
        },
        applyCheckpointCleanupReceipt,
        recordCopyIntent,
    } as const;
}

const defaultOperations = createScmDiffSummaryOperations();

export const generateScmDiffSummaryFromUserAction = defaultOperations.generateFromUserAction;
export const captureScmComparisonForSession = defaultOperations.captureComparison;
export const refreshScmDiffSummaryRun = defaultOperations.refreshRun;
export const applySavedScmDiffSummaryResult = defaultOperations.applySavedResult;
export const loadSavedScmDiffSummaryResult = defaultOperations.loadSavedResult;
export const deleteSavedScmDiffSummaryResults = defaultOperations.deleteSavedResults;
export const retireScmDiffSummaryScope = defaultOperations.retireScope;
export const prefetchScmDiffSummary = defaultOperations.prefetch;
export const applyScmDiffSummaryCheckpointCleanupReceipt = defaultOperations.applyCheckpointCleanupReceipt;
export const recordScmDiffSummaryCopyIntent = defaultOperations.recordCopyIntent;
export const getScmDiffSummaryState = defaultOperations.getState;
export const subscribeScmDiffSummaryState = defaultOperations.subscribe;

export function getScmDiffSummaryOperationState(state: ScmDiffSummaryState, key: string): ScmDiffSummaryViewModel {
    return selectScmDiffSummaryViewModel(state, key);
}
