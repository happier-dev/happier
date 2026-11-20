import {
    PluginUiOpenNewSessionRequestV1Schema,
    PluginUiPreparedReviewWorkspaceResultV1Schema,
    PluginUiSelectActionInputResultV1Schema,
    pluginUiSelectedActionInputMatchesOperation,
    type PluginUiHostApiErrorCodeV1,
    type PluginUiJsonValueV1,
    type PluginUiExecuteActionRequestV1,
    type SessionNewSessionSeedOutcome,
} from '@happier-dev/protocol/plugins/ui';

import { openOrdinaryNewSessionSeed } from '@/components/sessions/new/newSessionSeedNavigation';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationSelectors } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { observeActionOperationByRequestId } from '@/sync/domains/actionOperations/observeActionOperationByRequestId';

import {
    createPluginSurfaceHostApiError,
    readPluginSurfaceHostApiErrorPayload,
    type PluginSurfaceHostApiMethodHandler,
    type PluginSurfaceHostApiRequestOptions,
} from './createPluginSurfaceHostApi';

function errorPayload(code: PluginUiHostApiErrorCodeV1, diagnostic: string): PluginUiJsonValueV1 {
    return createPluginSurfaceHostApiError(code, [diagnostic]);
}

type OpenNewSession = (params: Readonly<{
    seed: unknown;
    teamModelSeed?: Parameters<typeof openOrdinaryNewSessionSeed>[0]['teamModelSeed'];
    pluginId: string;
    scope: ServerAccountScope;
    signal?: AbortSignal;
    isCurrent: () => boolean;
    /** The control that asked, so a docked New Session seats in that control's pane. */
    origin?: unknown;
}>) => Promise<SessionNewSessionSeedOutcome>;

function failure(outcome: Exclude<SessionNewSessionSeedOutcome, Readonly<{ kind: 'opened' }>>): PluginUiJsonValueV1 {
    if (outcome.kind === 'stale') return errorPayload('stale_surface', outcome.reason);
    return errorPayload(outcome.kind === 'invalid' ? 'invalid_payload' : 'unavailable', outcome.reason);
}

type PreparedWorkspaceExecutionTarget = Readonly<{
    serverId: string;
    machineId: string;
}>;

function isJsonRecord(value: PluginUiJsonValueV1): value is Readonly<Record<string, PluginUiJsonValueV1>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Project only the source-neutral fact New Session needs. The selected
 * contribution protocol already parsed the whole operation result; this owner
 * neither recreates that schema nor interprets provider-specific facts.
 */
function readPreparedRepositoryPath(value: PluginUiJsonValueV1): string | null {
    const prepared = PluginUiPreparedReviewWorkspaceResultV1Schema.safeParse(value);
    return prepared.success ? prepared.data.repositoryPath : null;
}

/**
 * Shared binding for the dedicated New Session navigation producer.
 *
 * It borrows the caller's exact currentness and Account lifetime but owns no draft or
 * navigation state itself; the incumbent one-shot handoff and mounted New
 * Session repository remain the only settlement owners.
 */
type PluginOpenNewSessionBinding = Readonly<{
    pluginId: string;
    accountLifetime: ActiveServerAccountScopeLifetime;
    lifetimeSignal?: AbortSignal;
    isCurrent: () => boolean;
    executionTarget?: PreparedWorkspaceExecutionTarget;
    executeSelectedOperation: (
        payload: PluginUiExecuteActionRequestV1,
        options?: PluginSurfaceHostApiRequestOptions,
    ) => Promise<PluginUiJsonValueV1>;
    openNewSession?: OpenNewSession;
    /** The mounted control that asked (a press in the page); absent for client Actions. */
    origin?: unknown;
}>;

/** Shared New Session producer for mounted surfaces and client Actions; owns no draft state. */
export function createPluginOpenNewSessionHandler(input: PluginOpenNewSessionBinding) {
    return async (payload: unknown, options?: PluginSurfaceHostApiRequestOptions): Promise<PluginUiJsonValueV1> => {
        const parsed = PluginUiOpenNewSessionRequestV1Schema.safeParse(payload);
        if (!parsed.success) return errorPayload('invalid_payload', 'open_new_session_request_invalid');
        const mergedSignal = mergeAbortSignals([input.lifetimeSignal, options?.signal]);
        const signal = mergedSignal.signal;
        let admittedRequestId: string | undefined;
        let continuationAddress: Readonly<{ serverId: string; operationId: string }> | undefined;
        try {
            const isCurrent = () => input.isCurrent() && input.accountLifetime.isCurrent();
            if (signal?.aborted || !isCurrent()) {
                return errorPayload(isCurrent() ? 'unavailable' : 'stale_surface', 'open_new_session_aborted');
            }
            let settledSeed = parsed.data;
            if (parsed.data.checkoutIntent === 'preparedReviewWorkspace') {
                const operation = options?.targetedOperation;
                const selected = PluginUiSelectActionInputResultV1Schema.safeParse(
                    options?.selectedActionInput,
                );
                const target = input.executionTarget;
                if (
                    operation === undefined
                    || !selected.success
                    || selected.data.kind !== 'submitted'
                    || !pluginUiSelectedActionInputMatchesOperation(selected.data, operation)
                    || target === undefined
                    || (parsed.data.placement !== undefined
                        && (parsed.data.placement.kind !== 'exactTarget'
                            || parsed.data.placement.directory !== undefined))
                ) {
                    return errorPayload('invalid_payload', 'prepared_review_workspace_selection_invalid');
                }
                if (parsed.data.placement !== undefined
                    && (parsed.data.placement.serverId !== target.serverId
                        || parsed.data.placement.machineId !== target.machineId)) {
                    // A valid saved-project choice can belong to a different Machine.
                    // Keep the source's admitted target and report the placement refusal.
                    return errorPayload('unavailable', 'workspaceMismatch');
                }
                const result = await input.executeSelectedOperation({
                    action: selected.data.action,
                    input: selected.data.input,
                }, {
                    ...(signal ? { signal } : {}),
                    onDaemonActionOperationAdmitted: requestId => {
                        admittedRequestId = requestId;
                        options?.onDaemonActionOperationAdmitted?.(requestId);
                    },
                    targetedOperation: operation,
                    selectedActionInput: selected.data,
                });
                if (readPluginSurfaceHostApiErrorPayload(result) !== null) return result;
                const repositoryPath = readPreparedRepositoryPath(result);
                if (repositoryPath === null) {
                    // The selected contribution has already parsed its result.
                    // Preserve its secret-free kind and reason so preparation
                    // failures retain the fact the person needs to resolve.
                    if (!isJsonRecord(result) || typeof result.kind !== 'string') {
                        return errorPayload('unavailable', 'prepared_review_workspace_result_invalid');
                    }
                    return createPluginSurfaceHostApiError('unavailable', [
                        result.kind,
                        ...(typeof result.reason === 'string' ? [result.reason] : []),
                    ]);
                }
                if (!admittedRequestId && (signal?.aborted || !isCurrent())) {
                    return errorPayload(isCurrent() ? 'unavailable' : 'stale_surface', 'open_new_session_aborted');
                }
                const { candidates: _preparedCandidates, ...seedWithoutCandidates } = parsed.data;
                settledSeed = {
                    ...seedWithoutCandidates,
                    // Materialization is complete. The incumbent New Session
                    // screen must reuse the exact path; asking it to prepare a
                    // second workspace would duplicate the mutation owner.
                    checkoutIntent: 'reuseWorkspace',
                    // Candidate paths describe choices before preparation. Once
                    // the exact selected operation materializes a repository,
                    // retaining them would let New Session replace that fact.
                    placement: {
                        kind: 'exactTarget',
                        serverId: target.serverId,
                        machineId: target.machineId,
                        directory: repositoryPath,
                    },
                };
            } else if (
                options?.targetedOperation !== undefined
                || options?.selectedActionInput !== undefined
            ) {
                return errorPayload('invalid_payload', 'prepared_review_workspace_selection_unexpected');
            }
            const openDraft = async (): Promise<SessionNewSessionSeedOutcome> => {
                const { teamModelFromSessionId, ...seed } = settledSeed;
                const scope = input.accountLifetime.scope;
                const mayOpen = admittedRequestId ? input.accountLifetime.isCurrent : isCurrent;
                const openSignal = admittedRequestId ? undefined : signal;
                let teamModelSeed: Parameters<OpenNewSession>[0]['teamModelSeed'];
                if (teamModelFromSessionId !== undefined) {
                    const { readNewSessionTeamModelSeed } = await import('@/components/sessions/new/readNewSessionTeamModelSeed');
                    if (!mayOpen() || openSignal?.aborted) {
                        return mayOpen() ? { kind: 'unavailable', reason: 'aborted' } : { kind: 'stale', reason: 'host_retired' };
                    }
                    const source = await readNewSessionTeamModelSeed({ scope, sessionId: teamModelFromSessionId,
                        agentTarget: seed.agentTarget, signal: openSignal, isCurrent: mayOpen,
                    });
                    if (!mayOpen()) return { kind: 'stale', reason: 'host_retired' };
                    if (openSignal?.aborted) return { kind: 'unavailable', reason: 'aborted' };
                    if (source.kind === 'unavailable') return { kind: 'unavailable', reason: 'origin_unavailable' };
                    teamModelSeed = source.seed;
                }
                return (input.openNewSession ?? openOrdinaryNewSessionSeed)({
                    seed,
                    ...(teamModelSeed === undefined ? {} : { teamModelSeed }),
                    pluginId: input.pluginId,
                    scope,
                    ...(openSignal ? { signal: openSignal } : {}),
                    isCurrent: mayOpen,
                    ...(input.origin === undefined ? {} : { origin: input.origin }),
                });
            };
            const resume = async () => {
                const outcome = await openDraft();
                if (outcome.kind !== 'opened' && outcome.kind !== 'stale' && continuationAddress && admittedRequestId) {
                    actionOperationStore.retainNewSessionContinuation(continuationAddress, resume);
                    actionOperationStore.markFollowUpNeedsAttention({ ...input.accountLifetime.scope,
                        requestId: admittedRequestId, message: outcome.reason });
                }
                return outcome.kind === 'opened' ? null : failure(outcome);
            };
            if (admittedRequestId && input.executionTarget) {
                const scope = input.accountLifetime.scope;
                let operation = actionOperationSelectors.selectSnapshotByRequestId(
                    actionOperationStore.getSnapshot(), admittedRequestId, scope.serverId, scope.accountId,
                );
                // The finite result owner also joins immediate completions when
                // the transport answered before its snapshot reached this client.
                if (!operation && (signal?.aborted || !isCurrent()) && options?.targetedOperation) {
                    operation = await observeActionOperationByRequestId({ ...scope,
                        machineId: input.executionTarget.machineId,
                        requestIdentity: { requestId: admittedRequestId,
                            actionId: buildQualifiedPluginContributionKey(options.targetedOperation.action) },
                    });
                }
                if (operation) {
                    const address = { serverId: scope.serverId, operationId: operation.operationId };
                    continuationAddress = address;
                    actionOperationStore.retainNewSessionContinuation(address, resume);
                    if (signal?.aborted || !isCurrent()) return null;
                    const continuation = actionOperationStore.takeNewSessionContinuation(address);
                    return continuation ? await continuation() : null;
                }
            }
            return await resume();
        } finally {
            mergedSignal.dispose();
        }
    };
}

export function createPluginOpenNewSessionHostApiHandler(input: Omit<PluginOpenNewSessionBinding, 'executeSelectedOperation'> & Readonly<{
    executeSelectedOperation: PluginSurfaceHostApiMethodHandler;
}>): PluginSurfaceHostApiMethodHandler {
    return async (request, options) => {
        if (request.method !== 'openNewSession') {
            return errorPayload('unsupported_method', 'open_new_session_method_mismatch');
        }
        // The mounted request arrives with the asking control still focused (a press keeps focus on web); read it
        // before any await so the docked New Session can seat in that control's pane.
        const origin = typeof document === 'undefined' ? undefined : document.activeElement ?? undefined;
        return await createPluginOpenNewSessionHandler({
            ...input,
            ...(origin === undefined ? {} : { origin }),
            executeSelectedOperation: async (payload, operationOptions) => await input.executeSelectedOperation({
                ...request, method: 'executeAction', payload,
            }, operationOptions),
        })(request.payload, options);
    };
}
