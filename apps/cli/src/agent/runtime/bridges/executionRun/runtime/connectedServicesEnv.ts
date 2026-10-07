import type { ConnectedServiceBindingSelectionV2, ConnectedServiceBindingsV2 } from '@happier-dev/protocol';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';

import {
    releaseExecutionRunConnectedServices,
    requestExecutionRunConnectedServicesMaterialization,
    recoverExecutionRunConnectedServicesRejectedStart,
    requestExecutionRunConnectedServiceRuntimeAuthRefresh,
} from '@/daemon/controlClient';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import {
    createCredentialsSpawnConnectedServicesTeamResourceCatalogResolver,
    resolveSessionSpawnConnectedServicesDefaultsPayload,
} from '@/session/services/spawnConnectedServicesDefaults';
import { resolveCatalogAgentConnectedAccountServiceIds } from '@/agent/catalog/registry';
import { logger } from '@/ui/logger';
import type { ExecutionRunConnectedServicesRegistrationV1 } from '@/daemon/connectedServices/runs/materializeContract';
import { readConnectedServiceChildMemberLogContextFromEnv } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';
import { createExecutionRunCodedError } from '../errors';
import type { RuntimeAuthRefreshViaDaemon } from '@/plugins/runtime/context/runtimeAuthRefresh';

/**
 * Generic (provider-agnostic) connected-services env resolution for execution-run backends.
 *
 * Execution runs spawn their backend from inside the RUNNER process, so connected-service auth
 * cannot be materialized by the daemon spawn path. Instead this helper — the ONE attach point for
 * run CS env — asks the daemon over the scoped run-materialize control bridge and returns the
 * materialized env (e.g. CODEX_HOME) to merge into the run's isolation bundle BEFORE the
 * per-backend launch. Provider env keys come entirely from the daemon-side provider-owned
 * materializers; no provider branching happens here.
 *
 * Selection resolution (QA2-F02): an explicit per-target selection wins; otherwise the run
 * defaults through `resolveSessionSpawnConnectedServicesDefaultsPayload` — the SAME owner session
 * spawn uses (fresh, bounded blocking settings bootstrap). The runner's in-process settings
 * snapshot is NOT consulted: it is a second, potentially stale settings surface whose
 * empty/partial state silently killed defaulting on a live run. One defaulting owner, one
 * settings path. Explicit `null` = run native, no defaulting.
 *
 * Observability (QA2-F03): every run start emits exactly one info-level decision line —
 * materialized (env key NAMES + selection source), proceeding native, or a fail-closed warn.
 * Env VALUES and tokens never appear in logs (pinned by test).
 *
 * Fail-closed: when a connected selection exists but the daemon cannot resolve + materialize it,
 * this THROWS a typed error — the run must never silently start on the runner's inherited
 * (potentially wrong) account.
 */

export class ExecutionRunConnectedServicesError extends Error {
    readonly code = 'execution_run_connected_services_failed';
    readonly errorCode: string;

    constructor(message: string, errorCode?: string) {
        super(message);
        this.name = 'ExecutionRunConnectedServicesError';
        this.errorCode = errorCode ?? 'connected_service_run_materialization_failed';
    }
}

type ResolveSessionSpawnDefaults = (params: Readonly<{
    agentId: string;
    credentials: StoredCredentials;
}>) => Promise<Readonly<{ connectedServices: ConnectedServiceBindingsV2 }> | null>;

type MaterializationDeps = Readonly<{
    requestMaterialization: typeof requestExecutionRunConnectedServicesMaterialization;
    release: typeof releaseExecutionRunConnectedServices;
    readCredentials: () => Promise<StoredCredentials | null>;
    resolveSessionSpawnDefaults: ResolveSessionSpawnDefaults;
    runnerPid: number;
    recoverRejectedStart?: typeof recoverExecutionRunConnectedServicesRejectedStart;
    refreshRuntimeAuth?: typeof requestExecutionRunConnectedServiceRuntimeAuthRefresh;
}>;

export type ResolvedExecutionRunConnectedServicesEnv = Readonly<{
    env: Readonly<Record<string, string>>;
    connectedServicesBindings: unknown;
    registration: ExecutionRunConnectedServicesRegistrationV1;
    cleanup: () => Promise<void>;
    recoverRejectedStart: (classification: ConnectedServiceRuntimeFailureClassification) => Promise<boolean>;
    refreshRuntimeAuth: RuntimeAuthRefreshViaDaemon;
}>;

export type ResolvedExecutionRunConnectedServicesSelection = Readonly<{
    bindings: ConnectedServiceBindingsV2;
    source: 'explicit' | 'session_default';
    hadCredentials: boolean | null;
}>;

export function hasConnectedExecutionRunBinding(bindings: ConnectedServiceBindingsV2): boolean {
    return Object.values(bindings.bindingsByServiceId)
        .some((binding) => binding.source === 'connected' || binding.source === 'team_resource');
}

function resolveExecutionRunDeclaredConnectedServiceIds(params: Readonly<{
    backendId: string;
    backendSourceKind: 'built_in' | 'configured' | (string & {});
}>): readonly string[] {
    return resolveCatalogAgentConnectedAccountServiceIds(params.backendId);
}

function hasUndeclaredConnectedExecutionRunBinding(
    bindings: ConnectedServiceBindingsV2,
    declaredServiceIds: readonly string[],
): boolean {
    return Object.entries(bindings.bindingsByServiceId).some(
        ([serviceId, binding]) => (
            (binding.source === 'connected' || binding.source === 'team_resource')
            && !declaredServiceIds.includes(serviceId)
        ),
    );
}

function defaultDeps(): MaterializationDeps {
    return {
        requestMaterialization: requestExecutionRunConnectedServicesMaterialization,
        release: releaseExecutionRunConnectedServices,
        readCredentials: async () => await readStoredCredentials(),
        resolveSessionSpawnDefaults: async (params) => {
            const resolveTeamCredentialResourceCatalog =
                createCredentialsSpawnConnectedServicesTeamResourceCatalogResolver(params.credentials);
            return await resolveSessionSpawnConnectedServicesDefaultsPayload({
                ...params,
                ...(resolveTeamCredentialResourceCatalog ? { resolveTeamCredentialResourceCatalog } : {}),
            });
        },
        runnerPid: process.pid,
        recoverRejectedStart: async (request) => await recoverExecutionRunConnectedServicesRejectedStart(request),
        refreshRuntimeAuth: requestExecutionRunConnectedServiceRuntimeAuthRefresh,
    };
}

/**
 * Resolves the one canonical explicit/default selection without materializing it.
 * Provider authorization consumes this phase first so its declared auth-isolation
 * policy can suppress competing native bindings before any credential side effect.
 */
export async function resolveExecutionRunConnectedServicesSelection(params: Readonly<{
    backendId: string;
    backendSourceKind: 'built_in' | 'configured' | (string & {});
    connectedServices?: ConnectedServiceBindingsV2 | null;
    connectedServicesDefaultServiceIds?: readonly string[];
    deps?: Pick<MaterializationDeps, 'readCredentials' | 'resolveSessionSpawnDefaults'>;
}>): Promise<ResolvedExecutionRunConnectedServicesSelection | null> {
    const backendId = params.backendId.trim();
    const declaredServiceIds = resolveExecutionRunDeclaredConnectedServiceIds({
        backendId,
        backendSourceKind: params.backendSourceKind,
    });
    const supportsCatalogConnectedServices = declaredServiceIds.length > 0;
    const deps = params.deps ?? defaultDeps();

    if (params.connectedServices === null) return null;

    if (
        params.connectedServices !== undefined
        && hasConnectedExecutionRunBinding(params.connectedServices)
        && (
            !supportsCatalogConnectedServices
            || hasUndeclaredConnectedExecutionRunBinding(
                params.connectedServices,
                declaredServiceIds,
            )
        )
    ) {
        throw new ExecutionRunConnectedServicesError(
            `Connected services selection is not supported for backend '${backendId}'`,
        );
    }

    const explicitBindingsByServiceId: Record<string, ConnectedServiceBindingSelectionV2> =
        params.connectedServices !== undefined
            ? { ...params.connectedServices.bindingsByServiceId }
            : {};
    const hadExplicit = Object.keys(explicitBindingsByServiceId).length > 0;
    const defaultServiceIdsToResolve = (params.connectedServicesDefaultServiceIds ?? []).filter(
        (serviceId) => !Object.prototype.hasOwnProperty.call(explicitBindingsByServiceId, serviceId),
    );

    if (defaultServiceIdsToResolve.length > 0) {
        if (
            !supportsCatalogConnectedServices
            || defaultServiceIdsToResolve.some((serviceId) =>
                !declaredServiceIds.includes(serviceId))
        ) {
            throw new ExecutionRunConnectedServicesError(
                `Connected services selection is not supported for backend '${backendId}'`,
            );
        }
        const credentials = await deps.readCredentials();
        const resolvedDefaults = credentials
            ? await deps.resolveSessionSpawnDefaults({ agentId: backendId, credentials })
            : null;
        const merged: Record<string, ConnectedServiceBindingSelectionV2> = {
            ...explicitBindingsByServiceId,
        };
        for (const serviceId of defaultServiceIdsToResolve) {
            const binding = resolvedDefaults?.connectedServices.bindingsByServiceId[serviceId];
            if (!binding || binding.source === 'native') {
                throw new ExecutionRunConnectedServicesError(
                    `No stored connected-service default for '${serviceId}' on backend '${backendId}'`,
                );
            }
            merged[serviceId] = binding;
        }
        const bindings = ConnectedServiceBindingsV2Schema.parse({
            v: 2,
            bindingsByServiceId: merged,
        });
        return {
            bindings,
            source: hadExplicit ? 'explicit' : 'session_default',
            hadCredentials: credentials !== null,
        };
    }

    if (params.connectedServices !== undefined) {
        return hasConnectedExecutionRunBinding(params.connectedServices)
            ? {
                bindings: params.connectedServices,
                source: 'explicit',
                hadCredentials: null,
            }
            : null;
    }
    if (!supportsCatalogConnectedServices) return null;

    const credentials = await deps.readCredentials();
    if (!credentials) return null;
    const resolved = await deps.resolveSessionSpawnDefaults({
        agentId: backendId,
        credentials,
    });
    return resolved && hasConnectedExecutionRunBinding(resolved.connectedServices)
        ? {
            bindings: resolved.connectedServices,
            source: 'session_default',
            hadCredentials: true,
        }
        : null;
}

export async function resolveExecutionRunConnectedServicesEnv(params: Readonly<{
    runId: string;
    backendId: string;
    backendSourceKind: 'built_in' | 'configured' | (string & {});
    connectedServices?: ConnectedServiceBindingsV2 | null;
    /**
     * Bare per-service default tokens (RO-F5): serviceIds asking for their STORED account default,
     * threaded from the run-start request alongside `connectedServices`. Each is resolved to a concrete
     * binding here and merged UNDER any explicit pin (explicit wins; the grammar rejects same-service
     * duplicates pre-resolution). A named default with no stored connected default fails CLOSED — never
     * silently native/ambient. On resume this stays empty: the persisted selection is already concrete.
     */
    connectedServicesDefaultServiceIds?: readonly string[];
    resolvedSelection?: ResolvedExecutionRunConnectedServicesSelection | null;
    cwd: string;
    modelId?: string;
    deps?: MaterializationDeps;
}>): Promise<ResolvedExecutionRunConnectedServicesEnv | null> {
    const backendId = params.backendId.trim();
    const supportsCatalogConnectedServices =
        resolveExecutionRunDeclaredConnectedServiceIds({
            backendId,
            backendSourceKind: params.backendSourceKind,
        }).length > 0;
    const deps = params.deps ?? defaultDeps();

    if (params.connectedServices === null && params.resolvedSelection === undefined) return null;

    const selection = params.resolvedSelection !== undefined
        ? params.resolvedSelection
        : await resolveExecutionRunConnectedServicesSelection({
            backendId,
            backendSourceKind: params.backendSourceKind,
            ...(params.connectedServices !== undefined
                ? { connectedServices: params.connectedServices }
                : {}),
            ...(params.connectedServicesDefaultServiceIds
                ? {
                    connectedServicesDefaultServiceIds:
                        params.connectedServicesDefaultServiceIds,
                }
                : {}),
            deps,
        });

    if (!selection) {
        if (supportsCatalogConnectedServices && params.connectedServices === undefined) {
            // QA2-F03: the one decision line for the native path — a run silently starting on the
            // runner-inherited account must always be diagnosable from the log.
            logger.info('[EXECUTION RUN] connected services: no selection resolved; proceeding native', {
                runId: params.runId,
                agentId: backendId,
            });
        }
        return null;
    }

    const response = await deps.requestMaterialization({
        runId: params.runId,
        runnerPid: deps.runnerPid,
        agentId: backendId,
        connectedServices: selection.bindings,
        cwd: params.cwd,
        ...(params.modelId ? { modelId: params.modelId } : {}),
    });

    if (!response || response.ok !== true || !('result' in response) || !response.result) {
        const errorMessage =
            (response && 'errorMessage' in response && typeof response.errorMessage === 'string' && response.errorMessage)
            || (response && 'error' in response && typeof response.error === 'string' && response.error)
            || 'Connected services materialization failed for execution run';
        const errorCode = response && 'errorCode' in response && typeof response.errorCode === 'string'
            ? response.errorCode
            : undefined;
        // QA2-F03: fail-closed decision line (no secrets; error text is the bridge's own message).
        logger.warn('[EXECUTION RUN] connected services: materialization FAILED; failing run start closed', {
            runId: params.runId,
            agentId: backendId,
            source: selection.source,
            ...(errorCode ? { errorCode } : {}),
        });
        throw new ExecutionRunConnectedServicesError(errorMessage, errorCode);
    }

    // QA2-F03: the one decision line for the materialized path. Env key NAMES only — values and
    // tokens never appear in logs.
    logger.info('[EXECUTION RUN] connected services: materialized', {
        runId: params.runId,
        agentId: backendId,
        source: selection.source,
        envKeys: Object.keys(response.result.env),
        selectedMembers: readConnectedServiceChildMemberLogContextFromEnv(response.result.env),
    });

    let cleanupPromise: Promise<void> | null = null;
    const cleanup = async (): Promise<void> => {
        if (cleanupPromise) return await cleanupPromise;
        const attempt = (async () => {
            const result = await deps.release({
                runId: params.runId,
                runnerPid: deps.runnerPid,
                activationId: response.result.activationId,
            });
            if (result.ok !== true || result.released !== true) {
                throw new Error(result.error ?? 'Execution-run connected-services cleanup did not complete');
            }
        })();
        cleanupPromise = attempt;
        try {
            await attempt;
        } catch (error) {
            if (cleanupPromise === attempt) cleanupPromise = null;
            throw error;
        }
    };

    return {
        env: { ...response.result.env },
        connectedServicesBindings: response.result.connectedServicesBindings,
        registration: response.result.registration,
        cleanup,
        async refreshRuntimeAuth(request, options) {
            if (cleanupPromise || !deps.refreshRuntimeAuth) {
                return { status: 'unavailable', reason: 'connected_service_run_materialization_unavailable' };
            }
            return await deps.refreshRuntimeAuth({
                ...request,
                runId: params.runId,
                runnerPid: deps.runnerPid,
                activationId: response.result.activationId,
            }, options);
        },
        async recoverRejectedStart(classification) {
            const modelId = params.modelId ?? classification.providerLimitId;
            if (!modelId || !deps.recoverRejectedStart) return false;
            const result = await deps.recoverRejectedStart({
                runId: params.runId,
                runnerPid: deps.runnerPid,
                activationId: response.result.activationId,
                modelId,
                classification,
            });
            if (result.ok && result.retry) return true;
            if (!result.ok) {
                throw createExecutionRunCodedError(result.errorCode ?? 'connected_service_run_materialization_unavailable',
                    result.errorCode === 'connected_service_run_model_unavailable'
                        ? `No enabled pool member can serve model '${modelId}'`
                        : 'Connected account Run startup recovery was refused');
            }
            return false;
        },
    };
}
