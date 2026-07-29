import { isAgentId } from '@happier-dev/agents';
import type { ConnectedServiceBindingSelectionV1, ConnectedServiceBindingsV1 } from '@happier-dev/protocol';
import { ConnectedServiceBindingsV1Schema } from '@happier-dev/protocol';

import {
    releaseExecutionRunConnectedServices,
    requestExecutionRunConnectedServicesMaterialization,
} from '@/daemon/controlClient';
import { readCredentials, type Credentials } from '@/persistence';
import { resolveSessionSpawnConnectedServicesDefaultsPayload } from '@/session/services/spawnConnectedServicesDefaults';
import { logger } from '@/ui/logger';
import type { ExecutionRunConnectedServicesRegistrationV1 } from '@/daemon/connectedServices/runs/materializeContract';

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
    credentials: Credentials;
}>) => Promise<Readonly<{ connectedServices: ConnectedServiceBindingsV1 }> | null>;

type MaterializationDeps = Readonly<{
    requestMaterialization: typeof requestExecutionRunConnectedServicesMaterialization;
    release: typeof releaseExecutionRunConnectedServices;
    readCredentials: () => Promise<Credentials | null>;
    resolveSessionSpawnDefaults: ResolveSessionSpawnDefaults;
    runnerPid: number;
}>;

export type ResolvedExecutionRunConnectedServicesEnv = Readonly<{
    env: Readonly<Record<string, string>>;
    connectedServicesBindings: unknown;
    registration: ExecutionRunConnectedServicesRegistrationV1;
    cleanup: () => Promise<void>;
}>;

type ResolvedRunSelection = Readonly<{
    bindings: ConnectedServiceBindingsV1;
    source: 'explicit' | 'session_default';
}>;

function hasConnectedBinding(bindings: ConnectedServiceBindingsV1): boolean {
    return Object.values(bindings.bindingsByServiceId).some((binding) => binding.source === 'connected');
}

function defaultDeps(): MaterializationDeps {
    return {
        requestMaterialization: requestExecutionRunConnectedServicesMaterialization,
        release: releaseExecutionRunConnectedServices,
        readCredentials: async () => await readCredentials(),
        resolveSessionSpawnDefaults: resolveSessionSpawnConnectedServicesDefaultsPayload,
        runnerPid: process.pid,
    };
}

export async function resolveExecutionRunConnectedServicesEnv(params: Readonly<{
    runId: string;
    backendId: string;
    backendSourceKind: 'built_in' | 'configured' | (string & {});
    connectedServices?: ConnectedServiceBindingsV1 | null;
    /**
     * Bare per-service default tokens (RO-F5): serviceIds asking for their STORED account default,
     * threaded from the run-start request alongside `connectedServices`. Each is resolved to a concrete
     * binding here and merged UNDER any explicit pin (explicit wins; the grammar rejects same-service
     * duplicates pre-resolution). A named default with no stored connected default fails CLOSED — never
     * silently native/ambient. On resume this stays empty: the persisted selection is already concrete.
     */
    connectedServicesDefaultServiceIds?: readonly string[];
    cwd: string;
    deps?: MaterializationDeps;
}>): Promise<ResolvedExecutionRunConnectedServicesEnv | null> {
    const backendId = params.backendId.trim();
    const isBuiltInAgent = params.backendSourceKind === 'built_in' && isAgentId(backendId);
    const deps = params.deps ?? defaultDeps();

    // Explicit opt-out: run native, no defaulting, no decision line needed (caller chose native).
    if (params.connectedServices === null) {
        return null;
    }

    // Explicit connected selection for a backend that cannot consume connected services fails closed —
    // it must never silently degrade to the backend's ambient auth.
    if (params.connectedServices !== undefined && !isBuiltInAgent && hasConnectedBinding(params.connectedServices)) {
        throw new ExecutionRunConnectedServicesError(
            `Connected services selection is not supported for backend '${backendId}'`,
        );
    }

    // Explicit per-service pins are authoritative; they always win over a bare default.
    const explicitBindingsByServiceId: Record<string, ConnectedServiceBindingSelectionV1> =
        params.connectedServices !== undefined ? { ...params.connectedServices.bindingsByServiceId } : {};
    const hadExplicit = Object.keys(explicitBindingsByServiceId).length > 0;
    const defaultServiceIdsToResolve = (params.connectedServicesDefaultServiceIds ?? []).filter(
        (serviceId) => !Object.prototype.hasOwnProperty.call(explicitBindingsByServiceId, serviceId),
    );

    let selection: ResolvedRunSelection | null = null;
    let hadCredentials: boolean | null = null;

    if (defaultServiceIdsToResolve.length > 0) {
        // RO-F5: resolve each bare per-service DEFAULT token to that service's stored default and merge
        // it UNDER the explicit pins. A named default with no stored connected default fails CLOSED.
        if (!isBuiltInAgent) {
            throw new ExecutionRunConnectedServicesError(
                `Connected services selection is not supported for backend '${backendId}'`,
            );
        }
        const credentials = await deps.readCredentials();
        hadCredentials = credentials !== null;
        const resolvedDefaults = credentials
            ? await deps.resolveSessionSpawnDefaults({ agentId: backendId, credentials })
            : null;
        const merged: Record<string, ConnectedServiceBindingSelectionV1> = { ...explicitBindingsByServiceId };
        for (const serviceId of defaultServiceIdsToResolve) {
            const binding = resolvedDefaults?.connectedServices.bindingsByServiceId[serviceId];
            if (!binding || binding.source !== 'connected') {
                // The caller explicitly asked to default this service but no stored connected default
                // exists → fail closed rather than silently proceeding native/ambient.
                throw new ExecutionRunConnectedServicesError(
                    `No stored connected-service default for '${serviceId}' on backend '${backendId}'`,
                );
            }
            merged[serviceId] = binding;
        }
        const bindings = ConnectedServiceBindingsV1Schema.parse({ v: 1, bindingsByServiceId: merged });
        selection = { bindings, source: hadExplicit ? 'explicit' : 'session_default' };
    } else if (params.connectedServices !== undefined) {
        selection = hasConnectedBinding(params.connectedServices)
            ? { bindings: params.connectedServices, source: 'explicit' }
            : null;
    } else if (isBuiltInAgent) {
        // QA2-F02: session-mirrored defaulting through the ONE session spawn-defaulting owner
        // (fresh bounded settings bootstrap) — never the runner's in-process settings snapshot.
        const credentials = await deps.readCredentials();
        hadCredentials = credentials !== null;
        if (credentials) {
            const resolved = await deps.resolveSessionSpawnDefaults({ agentId: backendId, credentials });
            if (resolved && hasConnectedBinding(resolved.connectedServices)) {
                selection = { bindings: resolved.connectedServices, source: 'session_default' };
            }
        }
    }

    if (!selection) {
        if (isBuiltInAgent && params.connectedServices === undefined) {
            // QA2-F03: the one decision line for the native path — a run silently starting on the
            // runner-inherited account must always be diagnosable from the log.
            logger.info('[EXECUTION RUN] connected services: no selection resolved; proceeding native', {
                runId: params.runId,
                agentId: backendId,
                ...(hadCredentials !== null ? { hadCredentials } : {}),
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
    };
}
