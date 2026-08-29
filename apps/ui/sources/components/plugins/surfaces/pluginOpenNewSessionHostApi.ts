import {
    PluginUiOpenNewSessionRequestV1Schema,
    PluginUiPreparedReviewWorkspaceResultV1Schema,
    PluginUiHostApiErrorCodeV1Schema,
    PluginUiSelectActionInputResultV1Schema,
    pluginUiSelectedActionInputMatchesOperation,
    type PluginUiHostApiErrorCodeV1,
    type PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';

import type { SessionNewSessionSeedOutcome } from '@/components/sessions/new/newSessionSeedComposer';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

import {
    createPluginSurfaceHostApiError,
    type PluginSurfaceHostApiMethodHandler,
    type PluginSurfaceHostApiRequestOptions,
} from './createPluginSurfaceHostApi';

function errorPayload(code: PluginUiHostApiErrorCodeV1, diagnostic: string): PluginUiJsonValueV1 {
    return createPluginSurfaceHostApiError(code, [diagnostic]);
}

type OpenNewSession = (params: Readonly<{
    seed: unknown;
    pluginId: string;
    scope: ServerAccountScope;
    signal?: AbortSignal;
    isCurrent: () => boolean;
}>) => Promise<SessionNewSessionSeedOutcome>;

async function openDefaultNewSession(params: Parameters<OpenNewSession>[0]): Promise<SessionNewSessionSeedOutcome> {
    try {
        const [{ seedAndOpenNewSession }, { router }] = await Promise.all([
            import('@/components/sessions/new/newSessionSeedComposer'),
            import('expo-router'),
        ]);
        return seedAndOpenNewSession({
            seed: params.seed,
            pluginId: params.pluginId,
            scope: params.scope,
            ...(params.signal ? { signal: params.signal } : {}),
            isCurrent: params.isCurrent,
            navigateToNewSession: ({
                dataId,
                draftId,
                worktree,
                spawnServerId,
                machineId,
                directory,
            }) => {
                router.push({
                    pathname: '/new',
                    params: {
                        draftId,
                        ...(dataId === null ? {} : { dataId }),
                        ...(worktree === undefined ? {} : { worktree }),
                        ...(spawnServerId === undefined ? {} : { spawnServerId }),
                        ...(machineId === undefined ? {} : { machineId }),
                        ...(directory === undefined ? {} : { directory }),
                    },
                });
            },
        });
    } catch {
        return { kind: 'unavailable', reason: 'navigation_unavailable' };
    }
}

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

function asHostApiFailure(value: PluginUiJsonValueV1): PluginUiJsonValueV1 | null {
    if (!isJsonRecord(value)) return null;
    return PluginUiHostApiErrorCodeV1Schema.safeParse(value.code).success
        && Array.isArray(value.diagnostics)
        ? value
        : null;
}

/**
 * Mounted producer for the dedicated New Session navigation method.
 *
 * It borrows the caller's exact mount and Account lifetime but owns no draft or
 * navigation state itself; the incumbent one-shot handoff and mounted New
 * Session repository remain the only settlement owners.
 */
export function createPluginOpenNewSessionHostApiHandler(input: Readonly<{
    pluginId: string;
    accountLifetime: ActiveServerAccountScopeLifetime;
    lifetimeSignal?: AbortSignal;
    isCurrent: () => boolean;
    executionTarget?: PreparedWorkspaceExecutionTarget;
    executeSelectedOperation: PluginSurfaceHostApiMethodHandler;
    openNewSession?: OpenNewSession;
}>): PluginSurfaceHostApiMethodHandler {
    return async (request, options?: PluginSurfaceHostApiRequestOptions) => {
        if (request.method !== 'openNewSession') {
            return errorPayload('unsupported_method', 'open_new_session_method_mismatch');
        }
        const parsed = PluginUiOpenNewSessionRequestV1Schema.safeParse(request.payload);
        if (!parsed.success) return errorPayload('invalid_payload', 'open_new_session_request_invalid');
        const mergedSignal = mergeAbortSignals([input.lifetimeSignal, options?.signal]);
        const signal = mergedSignal.signal;
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
                            || parsed.data.placement.serverId !== target.serverId
                            || parsed.data.placement.machineId !== target.machineId
                            || parsed.data.placement.directory !== undefined))
                ) {
                    return errorPayload('invalid_payload', 'prepared_review_workspace_selection_invalid');
                }
                const result = await input.executeSelectedOperation({
                    ...request,
                    method: 'executeAction',
                    payload: {
                        action: selected.data.action,
                        input: selected.data.input,
                    },
                }, {
                    ...(signal ? { signal } : {}),
                    targetedOperation: operation,
                    selectedActionInput: selected.data,
                });
                const actionFailure = asHostApiFailure(result);
                if (actionFailure !== null) return actionFailure;
                const repositoryPath = readPreparedRepositoryPath(result);
                if (repositoryPath === null) {
                    return errorPayload('unavailable', 'prepared_review_workspace_unavailable');
                }
                if (signal?.aborted || !isCurrent()) {
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
            const outcome = await (input.openNewSession ?? openDefaultNewSession)({
                seed: settledSeed,
                pluginId: input.pluginId,
                scope: input.accountLifetime.scope,
                ...(signal ? { signal } : {}),
                isCurrent,
            });
            return outcome.kind === 'opened' ? null : failure(outcome);
        } finally {
            mergedSignal.dispose();
        }
    };
}
