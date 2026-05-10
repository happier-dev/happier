import type {
    BackendTargetRefV2,
    ExecutionRunGetRequest,
    ExecutionRunGetResponse,
    ExecutionRunPublicState,
    ExecutionRunScmDiffSummaryInputV1,
    ExecutionRunStartRequest,
    ExecutionRunStartResponse,
    ScmDiffSummaryGenerateInput,
    ScmDiffSummaryGenerateOutput,
    ScmDiffSummaryGenerateSuccess,
    TurnChangeSet,
} from '@happier-dev/protocol';
import { SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION, TurnChangeSetSchema } from '@happier-dev/protocol';

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
    getScmDiffSummaryCacheEntry,
    pruneScmDiffSummaryCacheByCheckpointCleanupReceipt,
    putScmDiffSummaryCacheEntry,
    type CheckpointCleanupReceiptLike,
    type ScmDiffSummaryCacheState,
    type ScmDiffSummaryUiCacheEntry,
} from '@/sync/domains/scm/diffSummary/cache/cacheState';
import type { ScmDiffSummaryCacheKeyInput } from '@/sync/domains/scm/diffSummary/cache/cacheKey';
import { sessionExecutionRunGet, sessionExecutionRunStart } from '@/sync/ops/sessionExecutionRuns';
import {
    resolveScmDiffSummarySettings,
    type ScmDiffSummaryCatalogProfile,
} from '@/settings/scmDiffSummary/settings';

export type ScmDiffSummaryStartExecutionRun = (
    sessionId: string,
    request: ExecutionRunStartRequest,
    opts?: Readonly<{ serverId?: string | null }>,
) => Promise<ExecutionRunStartResponse | { ok: false; error: string; errorCode?: string }>;

export type ScmDiffSummaryGetExecutionRun = (
    sessionId: string,
    request: ExecutionRunGetRequest,
    opts?: Readonly<{ serverId?: string | null }>,
) => Promise<ExecutionRunGetResponse | { ok: false; error: string; errorCode?: string }>;

export type ScmDiffSummaryOperationsDeps = Readonly<{
    startExecutionRun?: ScmDiffSummaryStartExecutionRun;
    getExecutionRun?: ScmDiffSummaryGetExecutionRun;
    nowMs?: () => number;
}>;

export type GenerateScmDiffSummaryParams = Readonly<{
    key?: string;
    sessionId: string;
    serverId?: string | null;
    backendTarget: BackendTargetRefV2;
    input: ScmDiffSummaryGenerateInput;
    turnChangeSet?: TurnChangeSet;
    intent?: Exclude<ScmDiffSummaryOperationIntent, 'copy'>;
    settings?: Readonly<Record<string, unknown>>;
    catalogProfiles?: readonly ScmDiffSummaryCatalogProfile[];
    resolvedSelector?: Readonly<{ catalogId: string }>;
}>;

export type RefreshScmDiffSummaryRunParams = Readonly<{
    key: string;
    sessionId: string;
    serverId?: string | null;
    runId: string;
    progressMarkdown?: string | null;
}>;

export type ScmDiffSummaryOperationResult =
    | Readonly<{ ok: true; key: string; runId: string | null; state: ScmDiffSummaryState; viewModel: ScmDiffSummaryViewModel }>
    | Readonly<{ ok: false; key: string; error: string; errorCode?: string; state: ScmDiffSummaryState; viewModel: ScmDiffSummaryViewModel }>;

type OperationError = Readonly<{ ok: false; error: string; errorCode?: string }>;

function readServerOptions(serverId: string | null | undefined): Readonly<{ serverId: string }> | undefined {
    const normalized = typeof serverId === 'string' ? serverId.trim() : '';
    return normalized ? { serverId: normalized } : undefined;
}

function readOperationError(value: unknown): OperationError | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Readonly<Record<string, unknown>>;
    if (record.ok !== false || typeof record.error !== 'string') return null;
    return {
        ok: false,
        error: record.error,
        ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
    };
}

function readStartedRun(value: unknown): ExecutionRunStartResponse | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Readonly<Record<string, unknown>>;
    if (
        typeof record.runId !== 'string'
        || typeof record.callId !== 'string'
        || typeof record.sidechainId !== 'string'
    ) {
        return null;
    }
    return {
        runId: record.runId,
        callId: record.callId,
        sidechainId: record.sidechainId,
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
    const latestToolResult = response.latestToolResult;
    if (latestToolResult && typeof latestToolResult === 'object' && 'success' in latestToolResult) {
        return latestToolResult as ScmDiffSummaryGenerateOutput;
    }
    if (response.structuredMeta?.kind === 'scm_diff_summary.v1') {
        const payload = response.structuredMeta.payload;
        if (payload && typeof payload === 'object' && 'success' in payload) {
            return payload as ScmDiffSummaryGenerateOutput;
        }
    }
    return null;
}

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : {};
}

function resolveBackendCatalogId(backendTarget: BackendTargetRefV2): string {
    const record = backendTarget as Readonly<Record<string, unknown>>;
    const kind = readNonEmptyString(record.kind) ?? 'backend';
    const backendId = readNonEmptyString(record.backendId);
    if (backendId) return `${kind}:${backendId}`;
    const agentId = readNonEmptyString(record.agentId);
    if (agentId) return `${kind}:${agentId}`;
    return `${kind}:default`;
}

function resolveSelectorCatalogId(params: GenerateScmDiffSummaryParams): string {
    const resolvedSettings = resolveScmDiffSummarySettings({
        storedSettings: params.settings ?? {},
        catalogProfiles: params.catalogProfiles ?? [],
    });
    if (resolvedSettings.modelOverride) return resolvedSettings.modelOverride.catalogId;

    const explicit = readNonEmptyString(params.resolvedSelector?.catalogId);
    if (explicit) return explicit;

    return resolveBackendCatalogId(params.backendTarget);
}

function buildResolvedSelector(params: GenerateScmDiffSummaryParams): Readonly<{ catalogId: string }> {
    return { catalogId: resolveSelectorCatalogId(params) };
}

function buildRequestKey(params: GenerateScmDiffSummaryParams): string {
    return buildScmDiffSummaryRequestKey({
        sessionId: params.sessionId,
        input: params.input,
        summarySchemaVersion: SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION,
        resolvedSelector: buildResolvedSelector(params),
    });
}

function buildCacheKeyInput(params: GenerateScmDiffSummaryParams): ScmDiffSummaryCacheKeyInput | null {
    if (params.input.source.kind !== 'turnCheckpoint') return null;
    const checkpointReceiptId = params.input.checkpointReceiptId?.trim();
    if (!checkpointReceiptId) return null;
    const checkpointRef = readCheckpointRef(params);
    if (!checkpointRef) return null;
    return {
        source: {
            kind: 'turnCheckpoint',
            checkpointReceiptId,
            checkpointRef,
            ...(params.input.turnEvidenceMode ? { turnEvidenceMode: params.input.turnEvidenceMode } : {}),
        },
        summarySchemaVersion: SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION,
        resolvedSelector: buildResolvedSelector(params),
    };
}

function readCheckpointRef(params: GenerateScmDiffSummaryParams): string | undefined {
    const receipts = params.turnChangeSet?.repositoryCheckpoint?.receipts ?? [];
    const checkpointReceiptId = params.input.checkpointReceiptId?.trim();
    const exact = receipts.find((receipt) => checkpointReceiptId && receipt.id === checkpointReceiptId)?.ref?.trim();
    if (exact) return exact;
    const fallback = receipts.length === 1 ? receipts[0]?.ref?.trim() : '';
    return fallback || undefined;
}

function readSuccessfulCacheOutput(
    entry: ScmDiffSummaryUiCacheEntry | null,
    input: ScmDiffSummaryGenerateInput,
): ScmDiffSummaryGenerateSuccess | null {
    if (!entry || typeof entry !== 'object') return null;
    if ('success' in entry) {
        return entry.success === true ? entry : null;
    }
    return {
        success: true,
        summaryMarkdown: entry.summaryMarkdown,
        sourceKey: buildScmDiffSummaryRequestKey({ sessionId: '', input }),
        ...(input.checkpointReceiptId ? { checkpointReceiptId: input.checkpointReceiptId } : {}),
        metadata: {
            source: input.source,
            sourceKey: buildScmDiffSummaryRequestKey({ sessionId: '', input }),
            ...(input.turnId ? { turnId: input.turnId } : {}),
            ...(input.checkpointReceiptId ? { checkpointReceiptId: input.checkpointReceiptId } : {}),
        },
        generationState: entry.state,
        ...(entry.truncation ? { truncation: entry.truncation as ScmDiffSummaryGenerateSuccess['truncation'] } : {}),
        ...(entry.cost ? { cost: entry.cost as ScmDiffSummaryGenerateSuccess['cost'] } : {}),
    };
}

function buildStartRequest(params: GenerateScmDiffSummaryParams): ExecutionRunStartRequest {
    const resolvedSelector = buildResolvedSelector(params);
    const intent = params.intent ?? 'generate';
    const intentInput: ExecutionRunScmDiffSummaryInputV1 = {
        ...params.input,
        summarySchemaVersion: SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION,
        resolvedSelector,
        ...(intent === 'regenerate' ? { cachePolicy: { mode: 'bypass' } } : {}),
        ...(params.turnChangeSet ? { turnChangeSet: TurnChangeSetSchema.parse(params.turnChangeSet) } : {}),
    };
    return {
        kind: 'scm_diff_summary.v1',
        intent: 'scm_diff_summary',
        backendTarget: params.backendTarget,
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'streaming',
        intentInput,
    };
}

export function createScmDiffSummaryOperations(deps: ScmDiffSummaryOperationsDeps = {}) {
    const startExecutionRun = deps.startExecutionRun ?? sessionExecutionRunStart;
    const getExecutionRun = deps.getExecutionRun ?? sessionExecutionRunGet;
    const nowMs = deps.nowMs ?? Date.now;
    let state = createInitialScmDiffSummaryState();
    let cacheState: ScmDiffSummaryCacheState = createScmDiffSummaryCacheState();
    const cacheKeyByRequestKey = new Map<string, ScmDiffSummaryCacheKeyInput>();
    const checkpointRefByRequestKey = new Map<string, string>();
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

    const generateFromUserAction = async (params: GenerateScmDiffSummaryParams): Promise<ScmDiffSummaryOperationResult> => {
        const key = params.key ?? buildRequestKey(params);
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
        applyCheckpointCleanupReceiptsFromTurnChangeSet(params.turnChangeSet);
        const cacheKeyInput = buildCacheKeyInput(params);
        if (cacheKeyInput && intent !== 'regenerate') {
            const cachedOutput = readSuccessfulCacheOutput(getScmDiffSummaryCacheEntry(cacheState, cacheKeyInput), params.input);
            if (cachedOutput) {
                setState(applyScmDiffSummaryEvent(state, {
                    type: 'cache_hit',
                    key,
                    sessionId: params.sessionId,
                    actionId: SCM_DIFF_SUMMARY_GENERATE_ACTION_ID,
                    input: params.input,
                    output: cachedOutput,
                    observedAtMs: nowMs(),
                }));
                return {
                    ok: true,
                    key,
                    runId: null,
                    state,
                    viewModel: selectScmDiffSummaryViewModel(state, key),
                };
            }
        }
        const serverOptions = readServerOptions(params.serverId);
        const started = serverOptions
            ? await startExecutionRun(params.sessionId, buildStartRequest(params), serverOptions)
            : await startExecutionRun(params.sessionId, buildStartRequest(params));
        const error = readOperationError(started);
        if (error) {
            setState(applyScmDiffSummaryEvent(state, {
                type: 'request_failed',
                key,
                sessionId: params.sessionId,
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
        const run = readStartedRun(started);
        if (!run) {
            const message = 'Unsupported diff-summary execution-run start response';
            setState(applyScmDiffSummaryEvent(state, {
                type: 'request_failed',
                key,
                sessionId: params.sessionId,
                actionId: SCM_DIFF_SUMMARY_GENERATE_ACTION_ID,
                input: params.input,
                error: message,
                failedAtMs: nowMs(),
                intent,
            }));
            return {
                ok: false,
                key,
                error: message,
                state,
                viewModel: selectScmDiffSummaryViewModel(state, key),
            };
        }

        if (cacheKeyInput) {
            cacheKeyByRequestKey.set(key, cacheKeyInput);
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
            sessionId: params.sessionId,
            actionId: SCM_DIFF_SUMMARY_GENERATE_ACTION_ID,
            input: params.input,
            runId: run.runId,
            callId: run.callId,
            sidechainId: run.sidechainId,
            requestedAtMs: nowMs(),
            intent,
        }));
        return {
            ok: true,
            key,
            runId: run.runId,
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
        return generateFromUserAction({ ...params, intent: 'generate' });
    };

    const refreshRun = async (params: RefreshScmDiffSummaryRunParams): Promise<ScmDiffSummaryOperationResult> => {
        const serverOptions = readServerOptions(params.serverId);
        const response = serverOptions
            ? await getExecutionRun(params.sessionId, { runId: params.runId, includeStructured: true }, serverOptions)
            : await getExecutionRun(params.sessionId, { runId: params.runId, includeStructured: true });
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
        const cacheKeyInput = cacheKeyByRequestKey.get(params.key);
        if (cacheKeyInput && structuredOutput?.success === true) {
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
        generateFromUserAction,
        prefetch,
        refreshRun,
        applyCheckpointCleanupReceipt,
        recordCopyIntent,
    } as const;
}

const defaultOperations = createScmDiffSummaryOperations();

export const generateScmDiffSummaryFromUserAction = defaultOperations.generateFromUserAction;
export const refreshScmDiffSummaryRun = defaultOperations.refreshRun;
export const prefetchScmDiffSummary = defaultOperations.prefetch;
export const applyScmDiffSummaryCheckpointCleanupReceipt = defaultOperations.applyCheckpointCleanupReceipt;
export const recordScmDiffSummaryCopyIntent = defaultOperations.recordCopyIntent;
export const getScmDiffSummaryState = defaultOperations.getState;
export const subscribeScmDiffSummaryState = defaultOperations.subscribe;

export function getScmDiffSummaryOperationState(state: ScmDiffSummaryState, key: string): ScmDiffSummaryViewModel {
    return selectScmDiffSummaryViewModel(state, key);
}
