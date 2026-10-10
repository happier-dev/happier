import { DaemonContributionRegistryProjectionDescribeRequestSchema, DaemonPluginUiTargetedContributionsReadRequestSchema, DaemonPluginSettingsGetRequestSchema, DaemonPluginSettingsGetResponseSchema, DaemonPluginSettingsSetRequestSchema, DaemonPluginSettingsSetResponseSchema, DaemonPluginSecretStatusRequestSchema, DaemonPluginSecretStatusResponseSchema, DaemonPluginSecretSetRequestSchema, DaemonPluginSecretSetResponseSchema, DaemonPluginSecretDeleteRequestSchema, DaemonPluginSecretDeleteResponseSchema, DaemonPluginStructuredMessageActionExecuteResponseSchema, DaemonPluginActionFormConnectedAccountOptionsResolveRequestSchema, DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema, DaemonPluginActionSchemasReadRequestSchema, DaemonPluginActionSchemasReadResponseSchema, DaemonPluginUiResourceReadRequestSchema, DaemonPluginUiResourceReadResponseSchema, DaemonPluginUiResourceWatchOpenRequestSchema, DaemonPluginUiResourceWatchOpenResponseSchema, DaemonPluginUiResourceWatchNextRequestSchema, DaemonPluginUiResourceWatchNextResponseSchema, DaemonPluginUiResourceWatchCloseRequestSchema, DaemonPluginUiResourceWatchCloseResponseSchema, type DaemonPluginSettingsSnapshot, type DaemonPluginSettingsMutation, type DaemonPluginSettingsSetResponse, type DaemonPluginSecretStatusResponse, type DaemonPluginSecretSetResponse, type DaemonPluginSecretDeleteResponse, type DaemonPluginStructuredMessageActionExecuteResponse, type DaemonPluginActionFormConnectedAccountOptionsResolveRequest, type DaemonPluginActionFormConnectedAccountOptionsResolveResponse, type DaemonPluginActionSchemasReadRequest, type DaemonPluginActionSchemasReadResponse, type DaemonPluginUiResourceReadRequest, type DaemonPluginUiResourceReadResponse, type DaemonPluginUiResourceWatchOpenRequest, type DaemonPluginUiResourceWatchOpenResponse, type DaemonPluginUiResourceWatchNextRequest, type DaemonPluginUiResourceWatchNextResponse, type DaemonPluginUiResourceWatchCloseRequest, type DaemonContributionRegistryProjectionAutomationEligibleEventsV1, type DaemonPluginUiComposerSurfaceCatalogEntryV1, type DaemonPluginUiTargetedSurfaceMountV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { DaemonPluginStructuredMessageActionExecuteRequestSchema, type DaemonPluginStructuredMessageActionExecuteRequest } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import type { PluginUiTargetedContributionsV1 } from '@happier-dev/protocol/plugins/ui';
import {
    DaemonPluginSettingsWatchRequestSchema,
    DaemonPluginSettingsWatchResponseSchema,
    isRpcMethodNotFoundResult,
    RPC_METHODS,
    type DaemonPluginSettingsWatchRequest,
    type DaemonPluginSettingsWatchResponse,
} from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import {
    isRpcMethodNotAvailableError,
    isRpcMethodNotFoundError,
} from '@/sync/runtime/rpcErrors';
import {
    parseDaemonContributionRegistryProjectionDescribeResponse,
    parseDaemonPluginUiTargetedContributionsReadResponse,
    type DaemonContributionRegistryProjection,
} from '@/sync/api/daemon/daemonContributionRegistryProjectionProtocol';
import { resolveNativeReactNativeHostRuntimeIdentity } from '@/components/plugins/reactNative/hostRuntimeIdentity';
import { resolveHostedWebFrameCapability } from '@/components/plugins/hostedWeb/hostedWebFrameCapability';
import { getPreferredLanguage } from '@/text';
import { serverAccountScopeKeySuffix, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
// The projection revision/listener registry lives in its own dependency-light
// owner so the canonical machine-state writer can advance it without importing
// this RPC module. It is re-exported here because this is the seam every
// projection consumer already imports.
import {
    getMachineContributionRegistryProjectionRevision,
    machineContributionRegistryProjectionScopeKey,
    type MachineContributionRegistryProjectionScope,
} from './machineContributionRegistryProjectionRevision';

export {
    getMachineContributionRegistryProjectionRevision,
    publishMachineContributionRegistryProjectionInvalidation,
    publishMachineContributionRegistryProjectionReconnect,
    subscribeMachineContributionRegistryProjectionInvalidation,
    type MachineContributionRegistryProjectionScope,
} from './machineContributionRegistryProjectionRevision';

/**
 * Why a projection read produced no current answer. The transport classifies
 * the failure once so a fallback can say what actually happened:
 * - `not-supported`: the daemon does not serve the method;
 * - `timeout` / `aborted`: the machine RPC budget elapsed or the caller left;
 * - `invalid-response`: the daemon answered with a body this client cannot
 *   parse, or one that answers a different question than was asked;
 * - `error`: any other transport failure.
 */
export type MachineContributionRegistryProjectionFailureReason =
    | MachinePluginTransportReason
    | 'invalid-response';

export type MachineContributionRegistryProjectionDescribeResult =
    | Readonly<{
        supported: true;
        projection: DaemonContributionRegistryProjection;
        /** The daemon has already selected the concrete Composer renderer for every row. */
        composerSurfaceCatalog?: readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[];
        /** Global current Event-automation composer facts from the same projection response. */
        automationEligibleEvents?: DaemonContributionRegistryProjectionAutomationEligibleEventsV1;
    }>
    | Readonly<{ supported: false; reason: MachineContributionRegistryProjectionFailureReason }>;

/**
 * The current contributions to one mounted target, tagged with the daemon's
 * current occurrence of that target (`targetedContributions.target`). The tag
 * may differ from the occurrence the caller mounted: that is a newer plugin
 * reload, not an error.
 */
export type MachinePluginUiTargetedContributionsReadResult =
    | Readonly<{
        supported: true;
        targetedContributions: PluginUiTargetedContributionsV1;
        targetedSurfaceMounts: readonly DaemonPluginUiTargetedSurfaceMountV1[];
    }>
    | Readonly<{
        supported: false;
        reason: MachineContributionRegistryProjectionFailureReason | 'unavailable';
        /** The daemon's own code when it answered `unavailable`. */
        code?: string;
    }>;

export type MachinePluginSettingsResult =
    | Readonly<{ supported: true; snapshot: DaemonPluginSettingsSnapshot }>
    | Readonly<{ supported: false; reason: 'not-supported' | 'error' }>;

/**
 * A SET response is not interchangeable with a GET snapshot: conflict is a
 * daemon-owned CAS outcome, while a post-emission transport loss remains
 * semantically ambiguous until the scoped Settings adapter performs its one
 * safe readback.
 */
export type MachinePluginSettingsSetResult =
    | Readonly<{ supported: true; result: DaemonPluginSettingsSetResponse }>
    | Readonly<{ supported: false; reason: 'not-supported' | 'error' | 'outcomeUnknown' }>;

/** A content-free daemon Settings invalidation subscription. */
export type MachinePluginSettingsWatch = Readonly<{
    dispose(): void;
}>;

/** Secret custody has a deliberately smaller surface than Settings: safe state
 * and revision flow back, while a raw value exists only in the SET request. */
export type MachinePluginSecretStatusResult =
    | Readonly<{ supported: true; result: DaemonPluginSecretStatusResponse }>
    | Readonly<{ supported: false; reason: 'not-supported' | 'error' }>;

export type MachinePluginSecretSetResult =
    | Readonly<{ supported: true; result: DaemonPluginSecretSetResponse }>
    | Readonly<{ supported: false; reason: 'not-supported' | 'error' | 'outcomeUnknown' }>;

export type MachinePluginSecretDeleteResult =
    | Readonly<{ supported: true; result: DaemonPluginSecretDeleteResponse }>
    | Readonly<{ supported: false; reason: 'not-supported' | 'error' | 'outcomeUnknown' }>;

export type MachinePluginStructuredMessageActionResult =
    | Readonly<{ supported: true; result: DaemonPluginStructuredMessageActionExecuteResponse }>
    | Readonly<{ supported: false; reason: 'not-supported' | 'error' | 'outcomeUnknown' }>;

export type MachinePluginActionSchemasReadResult =
    | Readonly<{ supported: true; result: DaemonPluginActionSchemasReadResponse }>
    | Readonly<{ supported: false; reason: MachinePluginTransportReason }>;

export type MachinePluginActionFormConnectedAccountOptionsResult =
    | Readonly<{ supported: true; result: DaemonPluginActionFormConnectedAccountOptionsResolveResponse }>
    | Readonly<{ supported: false; reason: 'not-supported' | 'error' }>;

/**
 * Stable machine-RPC transport facts shared by registry-projected callers.
 * They are distinct from daemon result codes, which remain verbatim under
 * each supported caller's `result`.
 */
export type MachinePluginTransportReason =
    | 'not-supported'
    | 'aborted'
    | 'timeout'
    | 'error';

export type MachinePluginUiResourceTransportReason = MachinePluginTransportReason;


export type MachinePluginUiResourceReadResult =
    | Readonly<{ supported: true; result: DaemonPluginUiResourceReadResponse }>
    | Readonly<{ supported: false; reason: MachinePluginUiResourceTransportReason }>;

export type MachinePluginUiResourceWatchOpenResult =
    | Readonly<{ supported: true; result: DaemonPluginUiResourceWatchOpenResponse }>
    | Readonly<{ supported: false; reason: MachinePluginUiResourceTransportReason }>;

export type MachinePluginUiResourceWatchNextResult =
    | Readonly<{ supported: true; result: DaemonPluginUiResourceWatchNextResponse }>
    | Readonly<{ supported: false; reason: MachinePluginUiResourceTransportReason }>;

export type MachinePluginUiResourceTransportFailure = Readonly<{
    code: string;
    retryable: boolean;
}>;

/**
 * The one Resource transport-code mapper used by contextual and mounted
 * adapters. It intentionally derives abort/timeout only from stable RPC codes;
 * arbitrary error prose stays the generic transient transport failure.
 */
export function mapMachinePluginUiResourceTransportFailure(
    reason: MachinePluginUiResourceTransportReason,
): MachinePluginUiResourceTransportFailure {
    switch (reason) {
        case 'not-supported':
            return { code: 'plugin_resource_transport_not_supported', retryable: false };
        case 'aborted':
            return { code: 'plugin_resource_aborted', retryable: false };
        case 'timeout':
            return { code: 'plugin_resource_transport_timeout', retryable: true };
        case 'error':
            return { code: 'plugin_resource_transport_error', retryable: true };
    }
}

function classifyMachinePluginTransportError(error: unknown): MachinePluginTransportReason {
    const code = error && typeof error === 'object'
        ? (error as Readonly<{ code?: unknown }>).code
        : undefined;
    if (code === 'MACHINE_RPC_ABORTED' || code === 'SOCKET_RPC_ABORTED') return 'aborted';
    if (code === 'MACHINE_RPC_TIMEOUT') return 'timeout';
    return 'error';
}

/** Plugin work follows its caller's lifetime; setup retains the RPC admission budget. */
function pluginRpcOperationOptions(opts: Readonly<{ timeoutMs?: number | null; signal?: AbortSignal }>) {
    return {
        timeoutMs: opts.timeoutMs ?? undefined,
        operationTimeoutMs: opts.timeoutMs == null ? null : undefined,
        signal: opts.signal,
    };
}

/**
 * One in-flight read per question. The key is the routed machine scope, its
 * projection revision (endpoint identity: reconnect, daemon replacement,
 * explicit invalidation) and the request payload. Nothing caller-specific —
 * a timeout, a caller epoch — enters it, so every reader of the same question
 * shares one request.
 */
const projectionReadInflightByKey = new Map<string, Promise<unknown>>();

/**
 * The Account a read is for. Every handle of one Account shares its reads; a
 * successor Account never joins a read its predecessor started. Each caller
 * still fences what it does with the answer on its own lifetime.
 */
type ProjectionReadAccount = Readonly<{ scope: ServerAccountScope }>;

function shareProjectionRead<T>(
    scope: MachineContributionRegistryProjectionScope,
    payload: unknown,
    account: ProjectionReadAccount | null | undefined,
    read: () => Promise<T>,
): Promise<T> {
    const key = JSON.stringify([
        machineContributionRegistryProjectionScopeKey(scope),
        getMachineContributionRegistryProjectionRevision(scope),
        account ? serverAccountScopeKeySuffix(account.scope) : null,
        payload,
    ]);
    const incumbent = projectionReadInflightByKey.get(key) as Promise<T> | undefined;
    if (incumbent) return incumbent;
    const request = read();
    projectionReadInflightByKey.set(key, request);
    void request.then(() => {
        if (projectionReadInflightByKey.get(key) === request) {
            projectionReadInflightByKey.delete(key);
        }
    });
    return request;
}

/** A caller that leaves stops waiting; the shared read keeps serving the others. */
async function waitForSharedRead<T>(
    request: Promise<T>,
    signal: AbortSignal | undefined,
    aborted: () => T,
): Promise<T> {
    if (!signal) return await request;
    if (signal.aborted) return aborted();
    return await new Promise((resolve) => {
        const onAbort = () => resolve(aborted());
        signal.addEventListener('abort', onAbort, { once: true });
        void request.then((result) => {
            signal.removeEventListener('abort', onAbort);
            resolve(result);
        });
    });
}

async function readProjectionClientContext(machineId: string) {
    const locale = getPreferredLanguage();
    const reactNativeHostRuntimeIdentity = resolveNativeReactNativeHostRuntimeIdentity();
    const hostedWebFrameCapability = await resolveHostedWebFrameCapability();
    return {
        machineId,
        // Every projection read narrows plugin translation bundles to what this
        // client renders: its preferred locale merged over English. Capture it
        // before asynchronous platform probing so the request and its cache
        // qualification refer to the same locale, including remote settings updates.
        locale,
        ...(reactNativeHostRuntimeIdentity ? { reactNativeHostRuntimeIdentity } : {}),
        ...(hostedWebFrameCapability ? { hostedWebFrameCapability } : {}),
    };
}

/**
 * The machine-wide projection transport uses the RPC owner's connection/setup
 * budget without imposing an operation deadline on daemon projection work.
 */
export async function machineContributionRegistryProjectionDescribe(
    machineId: string,
    opts?: Readonly<{
        serverId?: string | null;
        signal?: AbortSignal;
        selection?: 'agents';
        /** The Account the read is for; reads are shared only within it. */
        accountLifetime?: ProjectionReadAccount | null;
    }>,
): Promise<MachineContributionRegistryProjectionDescribeResult> {
    if (opts?.signal?.aborted) return { supported: false, reason: 'aborted' };
    let payload: ReturnType<typeof DaemonContributionRegistryProjectionDescribeRequestSchema.parse>;
    try {
        payload = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(
            opts?.selection === 'agents'
                ? { machineId, selection: opts.selection }
                : await readProjectionClientContext(machineId),
        );
    } catch {
        return { supported: false, reason: 'error' };
    }
    const scope = {
        machineId: payload.machineId,
        serverId: opts?.serverId ?? null,
    } satisfies MachineContributionRegistryProjectionScope;
    const request = shareProjectionRead(scope, payload, opts?.accountLifetime, async (): Promise<MachineContributionRegistryProjectionDescribeResult> => {
        try {
            const response = await machineRpcWithServerScope<unknown, typeof payload>({
                machineId: payload.machineId,
                serverId: opts?.serverId,
                accountId: opts?.accountLifetime?.scope.accountId,
                method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
                payload,
                // Projection work has no operation deadline, like capability
                // detection. Connection/setup admission keeps its RPC budget.
                operationTimeoutMs: null,
            });
            if (isRpcMethodNotFoundResult(response)) {
                return { supported: false, reason: 'not-supported' };
            }
            const parsed = parseDaemonContributionRegistryProjectionDescribeResponse(response);
            if (!parsed) return { supported: false, reason: 'invalid-response' };
            return {
                supported: true,
                projection: parsed.projection,
                ...(parsed.composerSurfaceCatalog === undefined
                    ? {}
                    : { composerSurfaceCatalog: parsed.composerSurfaceCatalog }),
                ...(parsed.automationEligibleEvents === undefined
                    ? {}
                    : { automationEligibleEvents: parsed.automationEligibleEvents }),
            };
        } catch (error) {
            if (isRpcMethodNotFoundError(error) || isRpcMethodNotAvailableError(error)) {
                return { supported: false, reason: 'not-supported' };
            }
            return { supported: false, reason: classifyMachinePluginTransportError(error) };
        }
    });
    return await waitForSharedRead(request, opts?.signal, () => ({ supported: false, reason: 'aborted' }));
}

/**
 * Reads the current contributions to one mounted target. The daemon answers
 * with its current occurrence of that target; it never fences the read.
 */
export async function machinePluginUiTargetedContributionsRead(
    machineId: string,
    opts: Readonly<{
        serverId?: string | null;
        pluginId: string;
        signal?: AbortSignal;
        accountLifetime?: ProjectionReadAccount | null;
    }>,
): Promise<MachinePluginUiTargetedContributionsReadResult> {
    if (opts.signal?.aborted) return { supported: false, reason: 'aborted' };
    let payload: ReturnType<typeof DaemonPluginUiTargetedContributionsReadRequestSchema.parse>;
    try {
        payload = DaemonPluginUiTargetedContributionsReadRequestSchema.parse({
            ...(await readProjectionClientContext(machineId)),
            pluginId: opts.pluginId,
        });
    } catch {
        return { supported: false, reason: 'error' };
    }
    const scope = {
        machineId: payload.machineId,
        serverId: opts.serverId ?? null,
    } satisfies MachineContributionRegistryProjectionScope;
    const request = shareProjectionRead(scope, payload, opts.accountLifetime, async (): Promise<MachinePluginUiTargetedContributionsReadResult> => {
        try {
            const response = await machineRpcWithServerScope<unknown, typeof payload>({
                machineId: payload.machineId,
                serverId: opts.serverId,
                method: RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ,
                payload,
                operationTimeoutMs: null,
            });
            if (isRpcMethodNotFoundResult(response)) {
                return { supported: false, reason: 'not-supported' };
            }
            const parsed = parseDaemonPluginUiTargetedContributionsReadResponse(response);
            if (!parsed) return { supported: false, reason: 'invalid-response' };
            if (parsed.status === 'unavailable') {
                return { supported: false, reason: 'unavailable', code: parsed.code };
            }
            // A snapshot for another plugin, or mounts for another target,
            // answers a different question: it is never shown for this one.
            const target = parsed.targetedContributions.target;
            if (
                target.pluginId !== payload.pluginId
                || parsed.targetedSurfaceMounts.some((mount) => (
                    mount.target.pluginId !== target.pluginId
                    || mount.target.occurrenceId !== target.occurrenceId
                ))
            ) {
                return { supported: false, reason: 'invalid-response' };
            }
            return {
                supported: true,
                targetedContributions: parsed.targetedContributions,
                targetedSurfaceMounts: parsed.targetedSurfaceMounts,
            };
        } catch (error) {
            if (isRpcMethodNotFoundError(error) || isRpcMethodNotAvailableError(error)) {
                return { supported: false, reason: 'not-supported' };
            }
            return { supported: false, reason: classifyMachinePluginTransportError(error) };
        }
    });
    return await waitForSharedRead(request, opts.signal, () => ({ supported: false, reason: 'aborted' }));
}

export async function machinePluginSettingsGet(
    machineId: string,
    opts: Readonly<{
        /** Device-local routing id for the already-selected portable target. */
        serverId: string;
        /** Repeated at the daemon boundary; never replaced with `serverId`. */
        serverIdentityId: string;
        pluginId: string;
        timeoutMs?: number | null;
        signal?: AbortSignal;
    }>,
): Promise<MachinePluginSettingsResult> {
    try {
        const payload = DaemonPluginSettingsGetRequestSchema.parse({
            serverIdentityId: opts.serverIdentityId,
            machineId,
            pluginId: opts.pluginId,
            scope: { kind: 'daemon' },
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            ...pluginRpcOperationOptions(opts),
            method: RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET,
            payload,
        });
        if (isRpcMethodNotFoundResult(response)) {
            return { supported: false, reason: 'not-supported' };
        }
        const parsed = DaemonPluginSettingsGetResponseSchema.safeParse(response);
        if (!parsed.success) {
            return { supported: false, reason: 'error' };
        }
        return { supported: true, snapshot: parsed.data };
    } catch (error) {
        if (isRpcMethodNotFoundError(error) || isRpcMethodNotAvailableError(error)) {
            return { supported: false, reason: 'not-supported' };
        }
        return { supported: false, reason: 'error' };
    }
}

export async function machinePluginSettingsSet(
    machineId: string,
    opts: Readonly<{
        /** Device-local routing id for the already-selected portable target. */
        serverId: string;
        /** Repeated at the daemon boundary; never replaced with `serverId`. */
        serverIdentityId: string;
        pluginId: string;
        fieldId: string;
        /**
         * Explicitly distinguishes a persisted empty value from removal. The
         * daemon owns the mutation contract; callers must not revive the
         * retired top-level `value` wire shape.
         */
        mutation: DaemonPluginSettingsMutation;
        expectedRevision?: string;
        timeoutMs?: number | null;
        signal?: AbortSignal;
    }>,
): Promise<MachinePluginSettingsSetResult> {
    let issued = false;
    try {
        const payload = DaemonPluginSettingsSetRequestSchema.parse({
            serverIdentityId: opts.serverIdentityId,
            machineId,
            pluginId: opts.pluginId,
            scope: { kind: 'daemon' },
            fieldId: opts.fieldId,
            mutation: opts.mutation,
            ...(opts.expectedRevision === undefined ? {} : { expectedRevision: opts.expectedRevision }),
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            ...pluginRpcOperationOptions(opts),
            method: RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET,
            payload,
            onIssued: () => {
                issued = true;
            },
        });
        if (isRpcMethodNotFoundResult(response)) {
            return { supported: false, reason: 'not-supported' };
        }
        const parsed = DaemonPluginSettingsSetResponseSchema.safeParse(response);
        if (!parsed.success) {
            return { supported: false, reason: issued ? 'outcomeUnknown' : 'error' };
        }
        return { supported: true, result: parsed.data };
    } catch (error) {
        if (isRpcMethodNotFoundError(error) || isRpcMethodNotAvailableError(error)) {
            return { supported: false, reason: 'not-supported' };
        }
        return { supported: false, reason: issued ? 'outcomeUnknown' : 'error' };
    }
}

type MachinePluginSettingsWatchNextResult =
    | Readonly<{ supported: true; result: DaemonPluginSettingsWatchResponse }>
    | Readonly<{ supported: false; reason: MachinePluginTransportReason }>;

async function machinePluginSettingsWatchNext(
    machineId: string,
    opts: Readonly<Omit<DaemonPluginSettingsWatchRequest, 'machineId' | 'scope'> & {
        /** Device-local routing id for the already-selected portable target. */
        serverId: string;
        signal?: AbortSignal;
    }>,
): Promise<MachinePluginSettingsWatchNextResult> {
    try {
        const payload = DaemonPluginSettingsWatchRequestSchema.parse({
            serverIdentityId: opts.serverIdentityId,
            machineId,
            pluginId: opts.pluginId,
            scope: { kind: 'daemon' },
            ...(opts.knownRevision === undefined ? {} : { knownRevision: opts.knownRevision }),
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            // The daemon owns the bounded parked wait; disposal owns transport cancellation.
            operationTimeoutMs: null,
            signal: opts.signal,
            method: RPC_METHODS.DAEMON_PLUGIN_SETTINGS_WATCH,
            payload,
        });
        if (isRpcMethodNotFoundResult(response)) return { supported: false, reason: 'not-supported' };
        const parsed = DaemonPluginSettingsWatchResponseSchema.safeParse(response);
        return parsed.success
            ? { supported: true, result: parsed.data }
            : { supported: false, reason: 'error' };
    } catch (error) {
        return { supported: false, reason: classifyMachinePluginTransportError(error) };
    }
}

/**
 * Client-owned parked Settings invalidation transport. It holds no snapshot or
 * retry state: the cursor merely lets the daemon tell this observer whether
 * the canonical record projection needs one reread after a bounded request.
 */
export function watchMachinePluginSettingsChanges(
    machineId: string,
    opts: Readonly<{
        /** Device-local routing id for the already-selected portable target. */
        serverId: string;
        /** Repeated at the daemon boundary; never replaced with `serverId`. */
        serverIdentityId: string;
        pluginId: string;
        onInvalidated(): void;
    }>,
): MachinePluginSettingsWatch {
    const controller = new AbortController();
    let disposed = false;
    let knownRevision: string | undefined;

    const pump = async (): Promise<void> => {
        while (!disposed && !controller.signal.aborted) {
            const outcome = await machinePluginSettingsWatchNext(machineId, {
                serverId: opts.serverId,
                serverIdentityId: opts.serverIdentityId,
                pluginId: opts.pluginId,
                ...(knownRevision === undefined ? {} : { knownRevision }),
                signal: controller.signal,
            });
            if (disposed || controller.signal.aborted || !outcome.supported) return;

            const previousRevision = knownRevision;
            knownRevision = outcome.result.revision;
            // A changed status with the same cursor is a duplicate fact. It
            // must not cause a second projection reread or grant the UI a
            // competing revision owner.
            if (
                outcome.result.status === 'changed'
                && outcome.result.revision !== previousRevision
            ) {
                try {
                    opts.onInvalidated();
                } catch {
                    // The record-store subscriber owns visible failure state;
                    // a consumer callback cannot keep this transport alive.
                }
            }
        }
    };
    void pump();

    return Object.freeze({
        dispose(): void {
            if (disposed) return;
            disposed = true;
            // A daemon watch may be parked until its shared bounded budget.
            // Local retirement is immediate and prevents late callbacks.
            controller.abort();
        },
    });
}

type MachinePluginSecretExactTarget = Readonly<{
    /** Device-local routing id for the already-selected portable target. */
    serverId: string;
    /** Repeated at the daemon boundary; never replaced with `serverId`. */
    serverIdentityId: string;
    pluginId: string;
    secretId: string;
    /** Required by an origin-bound declaration and rejected by its owner when absent. */
    canonicalOrigin?: string;
    timeoutMs?: number | null;
    signal?: AbortSignal;
}>;

export async function machinePluginSecretStatus(
    machineId: string,
    opts: MachinePluginSecretExactTarget,
): Promise<MachinePluginSecretStatusResult> {
    try {
        const payload = DaemonPluginSecretStatusRequestSchema.parse({
            serverIdentityId: opts.serverIdentityId,
            machineId,
            pluginId: opts.pluginId,
            secretId: opts.secretId,
            ...(opts.canonicalOrigin === undefined ? {} : { canonicalOrigin: opts.canonicalOrigin }),
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            ...pluginRpcOperationOptions(opts),
            method: RPC_METHODS.DAEMON_PLUGIN_SECRET_STATUS,
            payload,
        });
        if (isRpcMethodNotFoundResult(response)) return { supported: false, reason: 'not-supported' };
        const parsed = DaemonPluginSecretStatusResponseSchema.safeParse(response);
        return parsed.success
            ? { supported: true, result: parsed.data }
            : { supported: false, reason: 'error' };
    } catch (error) {
        if (isRpcMethodNotFoundError(error) || isRpcMethodNotAvailableError(error)) {
            return { supported: false, reason: 'not-supported' };
        }
        return { supported: false, reason: 'error' };
    }
}

export async function machinePluginSecretSet(
    machineId: string,
    opts: MachinePluginSecretExactTarget & Readonly<{
        value: string;
        expectedRevision?: string;
    }>,
): Promise<MachinePluginSecretSetResult> {
    let issued = false;
    try {
        const payload = DaemonPluginSecretSetRequestSchema.parse({
            serverIdentityId: opts.serverIdentityId,
            machineId,
            pluginId: opts.pluginId,
            secretId: opts.secretId,
            ...(opts.canonicalOrigin === undefined ? {} : { canonicalOrigin: opts.canonicalOrigin }),
            value: opts.value,
            ...(opts.expectedRevision === undefined ? {} : { expectedRevision: opts.expectedRevision }),
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            ...pluginRpcOperationOptions(opts),
            method: RPC_METHODS.DAEMON_PLUGIN_SECRET_SET,
            payload,
            onIssued: () => {
                issued = true;
            },
        });
        if (isRpcMethodNotFoundResult(response)) return { supported: false, reason: 'not-supported' };
        const parsed = DaemonPluginSecretSetResponseSchema.safeParse(response);
        return parsed.success
            ? { supported: true, result: parsed.data }
            : { supported: false, reason: issued ? 'outcomeUnknown' : 'error' };
    } catch (error) {
        if (isRpcMethodNotFoundError(error) || isRpcMethodNotAvailableError(error)) {
            return { supported: false, reason: 'not-supported' };
        }
        return { supported: false, reason: issued ? 'outcomeUnknown' : 'error' };
    }
}

export async function machinePluginSecretDelete(
    machineId: string,
    opts: MachinePluginSecretExactTarget & Readonly<{
        expectedRevision?: string;
    }>,
): Promise<MachinePluginSecretDeleteResult> {
    let issued = false;
    try {
        const payload = DaemonPluginSecretDeleteRequestSchema.parse({
            serverIdentityId: opts.serverIdentityId,
            machineId,
            pluginId: opts.pluginId,
            secretId: opts.secretId,
            ...(opts.canonicalOrigin === undefined ? {} : { canonicalOrigin: opts.canonicalOrigin }),
            ...(opts.expectedRevision === undefined ? {} : { expectedRevision: opts.expectedRevision }),
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            ...pluginRpcOperationOptions(opts),
            method: RPC_METHODS.DAEMON_PLUGIN_SECRET_DELETE,
            payload,
            onIssued: () => {
                issued = true;
            },
        });
        if (isRpcMethodNotFoundResult(response)) return { supported: false, reason: 'not-supported' };
        const parsed = DaemonPluginSecretDeleteResponseSchema.safeParse(response);
        return parsed.success
            ? { supported: true, result: parsed.data }
            : { supported: false, reason: issued ? 'outcomeUnknown' : 'error' };
    } catch (error) {
        if (isRpcMethodNotFoundError(error) || isRpcMethodNotAvailableError(error)) {
            return { supported: false, reason: 'not-supported' };
        }
        return { supported: false, reason: issued ? 'outcomeUnknown' : 'error' };
    }
}

export async function machinePluginStructuredMessageActionExecute(
    machineId: string,
    opts: Readonly<Omit<DaemonPluginStructuredMessageActionExecuteRequest, 'machineId'> & {
        serverId?: string | null;
        timeoutMs?: number | null;
        signal?: AbortSignal;
        /** Host-only authority; the strict request schema below never publishes it. */
        accountLifetime?: ServerAccountScopeLifetime | null;
        isCurrent?: () => boolean;
    }>,
): Promise<MachinePluginStructuredMessageActionResult> {
    let issued = false;
    try {
        if (opts.accountLifetime !== undefined && (opts.accountLifetime?.isCurrent() !== true
            || (opts.serverId && !areServerProfileIdentifiersEquivalent(opts.serverId, opts.accountLifetime.scope.serverId)))) {
            return { supported: false, reason: 'error' };
        }
        const payload = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
            machineId,
            ...(opts.requestId ? { requestId: opts.requestId } : {}),
            expectedContributorOccurrenceId: opts.expectedContributorOccurrenceId,
            qualifiedActionId: opts.qualifiedActionId,
            ...(opts.input === undefined ? {} : { input: opts.input }),
            ...(opts.selectedActionInputCarrier === undefined
                ? {}
                : { selectedActionInputCarrier: opts.selectedActionInputCarrier }),
            ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
            ...(opts.messageActionReference ? { messageActionReference: opts.messageActionReference } : {}),
            executionSurface: opts.executionSurface,
            ...(opts.invocation ? { invocation: opts.invocation } : {}),
            ...(opts.presentUserIntent ? { presentUserIntent: opts.presentUserIntent } : {}),
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.accountLifetime?.scope.serverId ?? opts.serverId,
            accountId: opts.accountLifetime?.scope.accountId,
            ...pluginRpcOperationOptions(opts),
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            payload,
            onIssued: () => {
                // The canonical socket owner invokes this synchronously before emit.
                // Never reinterpret a consumed acknowledgement after retirement.
                if ((opts.accountLifetime !== undefined && opts.accountLifetime?.isCurrent() !== true)
                    || opts.isCurrent?.() === false) {
                    throw new Error('plugin_ui_generation_retired');
                }
                issued = true;
            },
        });
        if (isRpcMethodNotFoundResult(response)) return { supported: false, reason: 'not-supported' };
        const parsed = DaemonPluginStructuredMessageActionExecuteResponseSchema.safeParse(response);
        return parsed.success
            ? { supported: true, result: parsed.data }
            : { supported: false, reason: issued ? 'outcomeUnknown' : 'error' };
    } catch {
        return { supported: false, reason: issued ? 'outcomeUnknown' : 'error' };
    }
}

/**
 * Resolves one target Action's host-owned Connected Account choices. This is a
 * direct transient request, never an account inventory cache or a caller-owned
 * authorization decision.
 */
export async function machinePluginActionFormConnectedAccountOptionsResolve(
    machineId: string,
    opts: Readonly<Omit<DaemonPluginActionFormConnectedAccountOptionsResolveRequest, 'machineId'> & {
        serverId?: string | null;
        timeoutMs?: number | null;
        signal?: AbortSignal;
    }>,
): Promise<MachinePluginActionFormConnectedAccountOptionsResult> {
    try {
        const payload = DaemonPluginActionFormConnectedAccountOptionsResolveRequestSchema.parse({
            machineId,
            expectedOccurrenceId: opts.expectedOccurrenceId,
            qualifiedActionId: opts.qualifiedActionId,
            fieldPath: opts.fieldPath,
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: payload.machineId,
            serverId: opts.serverId,
            ...pluginRpcOperationOptions(opts),
            method: RPC_METHODS.DAEMON_PLUGIN_ACTION_FORM_CONNECTED_ACCOUNT_OPTIONS_RESOLVE,
            payload,
        });
        if (isRpcMethodNotFoundResult(response)) return { supported: false, reason: 'not-supported' };
        const parsed = DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema.safeParse(response);
        return parsed.success
            ? { supported: true, result: parsed.data }
            : { supported: false, reason: 'error' };
    } catch {
        return { supported: false, reason: 'error' };
    }
}

/**
 * Action schemas by routed machine scope and qualified Action id. The bulk
 * projection omits them, so this is the one reader: an Action occurrence's
 * declaration cannot change, so a settled answer is kept for that occurrence
 * and concurrent readers share one request. A reloaded plugin has a new
 * occurrence id, which replaces the entry and re-reads. Failures are not kept.
 */
const actionSchemaReadsByKey = new Map<string, Readonly<{
    occurrenceId: string;
    request: Promise<MachinePluginActionSchemasReadResult>;
}>>();

/** Forgets every shared in-flight projection read and memoised Action schema. */
export function resetMachineProjectionReadsForTests(): void {
    projectionReadInflightByKey.clear();
    actionSchemaReadsByKey.clear();
}

export async function machinePluginActionSchemasRead(
    machineId: string,
    opts: Readonly<Omit<DaemonPluginActionSchemasReadRequest, 'machineId'> & {
        serverId?: string | null;
        signal?: AbortSignal;
    }>,
): Promise<MachinePluginActionSchemasReadResult> {
    if (opts.signal?.aborted) return { supported: false, reason: 'aborted' };
    let payload: DaemonPluginActionSchemasReadRequest;
    try {
        payload = DaemonPluginActionSchemasReadRequestSchema.parse({
            machineId,
            expectedOccurrenceId: opts.expectedOccurrenceId,
            qualifiedActionId: opts.qualifiedActionId,
        });
    } catch {
        return { supported: false, reason: 'error' };
    }
    const key = JSON.stringify([
        machineContributionRegistryProjectionScopeKey({ machineId, serverId: opts.serverId ?? null }),
        payload.qualifiedActionId,
    ]);
    const incumbent = actionSchemaReadsByKey.get(key);
    let request = incumbent?.occurrenceId === payload.expectedOccurrenceId ? incumbent.request : null;
    if (!request) {
        const issued = (async (): Promise<MachinePluginActionSchemasReadResult> => {
            try {
                const response = await machineRpcWithServerScope<unknown, typeof payload>({
                    machineId,
                    serverId: opts.serverId,
                    method: RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ,
                    payload,
                    operationTimeoutMs: null,
                });
                if (isRpcMethodNotFoundResult(response)) return { supported: false, reason: 'not-supported' };
                const parsed = DaemonPluginActionSchemasReadResponseSchema.safeParse(response);
                return parsed.success
                    ? { supported: true, result: parsed.data }
                    : { supported: false, reason: 'error' };
            } catch (error) {
                return { supported: false, reason: classifyMachinePluginTransportError(error) };
            }
        })();
        const entry = Object.freeze({ occurrenceId: payload.expectedOccurrenceId, request: issued });
        actionSchemaReadsByKey.set(key, entry);
        void issued.then((result) => {
            if ((!result.supported || !result.result.ok) && actionSchemaReadsByKey.get(key) === entry) {
                actionSchemaReadsByKey.delete(key);
            }
        });
        request = issued;
    }
    return await waitForSharedRead(request, opts.signal, () => ({ supported: false, reason: 'aborted' }));
}

/**
 * Read one declared plugin resource for a mounted plugin UI surface (§3.6).
 *
 * This is the transport for the snapshot authority; the daemon owns admission,
 * generation currentness, containment, byte bounds and integrity verification.
 */
export async function machinePluginUiResourceRead(
    machineId: string,
    opts: Readonly<Omit<DaemonPluginUiResourceReadRequest, 'machineId'> & {
        serverId?: string | null;
        timeoutMs?: number | null;
        signal?: AbortSignal;
    }>,
): Promise<MachinePluginUiResourceReadResult> {
    try {
        const payload = DaemonPluginUiResourceReadRequestSchema.parse({
            machineId,
            expectedCallerOccurrenceId: opts.expectedCallerOccurrenceId,
            callerPluginId: opts.callerPluginId,
            resource: opts.resource,
            ...(opts.context === undefined ? {} : { context: opts.context }),
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            ...pluginRpcOperationOptions(opts),
            method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ,
            payload,
        });
        if (isRpcMethodNotFoundResult(response)) return { supported: false, reason: 'not-supported' };
        const parsed = DaemonPluginUiResourceReadResponseSchema.safeParse(response);
        return parsed.success
            ? { supported: true, result: parsed.data }
            : { supported: false, reason: 'error' };
    } catch (error) {
        return { supported: false, reason: classifyMachinePluginTransportError(error) };
    }
}

/**
 * Live resource invalidation transport for a mounted plugin UI surface
 * (§3.6, EU-4b).
 *
 * The app owns the connection: `open` establishes one daemon-side subscription
 * and answers with the digest the daemon currently observes, `next` parks until
 * an invalidation or its bounded budget elapses, `close` retires it. The event
 * carries no bytes — the observer re-reads through
 * `machinePluginUiResourceRead`, which stays the single snapshot authority.
 */
export async function machinePluginUiResourceWatchOpen(
    machineId: string,
    opts: Readonly<Omit<DaemonPluginUiResourceWatchOpenRequest, 'machineId'> & {
        serverId?: string | null;
        timeoutMs?: number | null;
        signal?: AbortSignal;
    }>,
): Promise<MachinePluginUiResourceWatchOpenResult> {
    try {
        const payload = DaemonPluginUiResourceWatchOpenRequestSchema.parse({
            machineId,
            expectedCallerOccurrenceId: opts.expectedCallerOccurrenceId,
            callerPluginId: opts.callerPluginId,
            subscriptionId: opts.subscriptionId,
            resource: opts.resource,
            ...(opts.context === undefined ? {} : { context: opts.context }),
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            ...pluginRpcOperationOptions(opts),
            method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN,
            payload,
        });
        if (isRpcMethodNotFoundResult(response)) return { supported: false, reason: 'not-supported' };
        const parsed = DaemonPluginUiResourceWatchOpenResponseSchema.safeParse(response);
        return parsed.success
            ? { supported: true, result: parsed.data }
            : { supported: false, reason: 'error' };
    } catch (error) {
        return { supported: false, reason: classifyMachinePluginTransportError(error) };
    }
}

export async function machinePluginUiResourceWatchNext(
    machineId: string,
    opts: Readonly<Omit<DaemonPluginUiResourceWatchNextRequest, 'machineId'> & {
        serverId?: string | null;
        signal?: AbortSignal;
    }>,
): Promise<MachinePluginUiResourceWatchNextResult> {
    try {
        const payload = DaemonPluginUiResourceWatchNextRequestSchema.parse({
            machineId,
            expectedCallerOccurrenceId: opts.expectedCallerOccurrenceId,
            callerPluginId: opts.callerPluginId,
            subscriptionId: opts.subscriptionId,
            ...(opts.waitMs === undefined ? {} : { waitMs: opts.waitMs }),
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            // Keep the daemon's protocol wait; caller retirement cancels the transport.
            operationTimeoutMs: null,
            signal: opts.signal,
            method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT,
            payload,
        });
        if (isRpcMethodNotFoundResult(response)) return { supported: false, reason: 'not-supported' };
        const parsed = DaemonPluginUiResourceWatchNextResponseSchema.safeParse(response);
        return parsed.success
            ? { supported: true, result: parsed.data }
            : { supported: false, reason: 'error' };
    } catch (error) {
        return { supported: false, reason: classifyMachinePluginTransportError(error) };
    }
}

export async function machinePluginUiResourceWatchClose(
    machineId: string,
    opts: Readonly<Omit<DaemonPluginUiResourceWatchCloseRequest, 'machineId'> & {
        serverId?: string | null;
        timeoutMs?: number | null;
        signal?: AbortSignal;
    }>,
): Promise<void> {
    try {
        const payload = DaemonPluginUiResourceWatchCloseRequestSchema.parse({
            machineId,
            callerPluginId: opts.callerPluginId,
            subscriptionId: opts.subscriptionId,
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            ...pluginRpcOperationOptions(opts),
            method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE,
            payload,
        });
        DaemonPluginUiResourceWatchCloseResponseSchema.safeParse(response);
    } catch {
        // Local retirement stays authoritative when the daemon cleanup boundary
        // is unreachable; the daemon reclaims an unpolled subscription itself.
    }
}
