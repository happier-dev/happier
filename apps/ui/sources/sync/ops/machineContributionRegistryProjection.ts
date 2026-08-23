import {
    DaemonContributionRegistryProjectionDescribeRequestSchema,
    DaemonPluginSettingsGetRequestSchema,
    DaemonPluginSettingsGetResponseSchema,
    DaemonPluginSettingsSetRequestSchema,
    DaemonPluginSettingsSetResponseSchema,
    DAEMON_PLUGIN_UI_RESOURCE_WATCH_DEFAULT_WAIT_MS,
    DaemonPluginSecretStatusRequestSchema,
    DaemonPluginSecretStatusResponseSchema,
    DaemonPluginSecretSetRequestSchema,
    DaemonPluginSecretSetResponseSchema,
    DaemonPluginSecretDeleteRequestSchema,
    DaemonPluginSecretDeleteResponseSchema,
    DaemonPluginComposerAttachmentPrepareRequestSchema,
    DaemonPluginComposerAttachmentPrepareResponseSchema,
    DaemonPluginStructuredMessageActionExecuteRequestSchema,
    DaemonPluginStructuredMessageActionExecuteResponseSchema,
    DaemonPluginActionFormConnectedAccountOptionsResolveRequestSchema,
    DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema,
    DaemonPluginUiResourceReadRequestSchema,
    DaemonPluginUiResourceReadResponseSchema,
    DAEMON_PLUGIN_UI_RESOURCE_WATCH_MAX_WAIT_MS,
    DaemonPluginUiResourceWatchOpenRequestSchema,
    DaemonPluginUiResourceWatchOpenResponseSchema,
    DaemonPluginUiResourceWatchNextRequestSchema,
    DaemonPluginUiResourceWatchNextResponseSchema,
    DaemonPluginUiResourceWatchCloseRequestSchema,
    DaemonPluginUiResourceWatchCloseResponseSchema,
    type DaemonPluginSettingsSnapshot,
    type DaemonPluginSettingsMutation,
    type DaemonPluginSettingsSetResponse,
    type DaemonPluginSecretStatusResponse,
    type DaemonPluginSecretSetResponse,
    type DaemonPluginSecretDeleteResponse,
    type DaemonPluginComposerAttachmentPrepareRequest,
    type DaemonPluginComposerAttachmentPrepareResponse,
    type DaemonPluginStructuredMessageActionExecuteRequest,
    type DaemonPluginStructuredMessageActionExecuteResponse,
    type DaemonPluginActionFormConnectedAccountOptionsResolveRequest,
    type DaemonPluginActionFormConnectedAccountOptionsResolveResponse,
    type DaemonPluginUiResourceReadRequest,
    type DaemonPluginUiResourceReadResponse,
    type DaemonPluginUiResourceWatchOpenRequest,
    type DaemonPluginUiResourceWatchOpenResponse,
    type DaemonPluginUiResourceWatchNextRequest,
    type DaemonPluginUiResourceWatchNextResponse,
    type DaemonPluginUiResourceWatchCloseRequest,
    type DaemonContributionRegistryProjectionMountedTargetV1,
    type DaemonContributionRegistryProjectionAutomationEligibleEventsV1,
    type DaemonPluginUiComposerSurfaceCatalogEntryV1,
    type DaemonPluginUiTargetedSurfaceMountV1,
} from '@happier-dev/protocol';
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
    type DaemonContributionRegistryProjection,
} from '@/sync/api/daemon/daemonContributionRegistryProjectionProtocol';
import {
    resolveNativeReactNativeHostRuntimeIdentity,
    resolveReactNativeWebLoaderCapability,
} from '@/components/plugins/reactNative/hostRuntimeIdentity';
import { resolveHostedWebFrameCapability } from '@/components/plugins/hostedWeb/hostedWebFrameCapability';

export type MachineContributionRegistryProjectionDescribeResult =
    | Readonly<{
        supported: true;
        projection: DaemonContributionRegistryProjection;
        /** The daemon has already selected the concrete Composer renderer for every row. */
        composerSurfaceCatalog?: readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[];
        /** Present only after this transport correlates it to `mountedTarget`. */
        targetedContributions?: PluginUiTargetedContributionsV1;
        /** Present only after every mount is correlated to the same `mountedTarget`. */
        targetedSurfaceMounts?: readonly DaemonPluginUiTargetedSurfaceMountV1[];
        /** Global current Event-automation composer facts from the same projection response. */
        automationEligibleEvents?: DaemonContributionRegistryProjectionAutomationEligibleEventsV1;
    }>
    | Readonly<{ supported: false; reason: 'not-supported' | 'error' }>;

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

export type MachinePluginComposerAttachmentPrepareResult =
    | Readonly<{ supported: true; result: DaemonPluginComposerAttachmentPrepareResponse }>
    | Readonly<{ supported: false; reason: MachinePluginTransportReason }>;

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

export type MachineContributionRegistryProjectionScope = Readonly<{
    machineId: string;
    serverId: string | null;
}>;

const projectionRevisionByScope = new Map<string, number>();
const projectionListenersByScope = new Map<string, Set<() => void>>();
const projectionDescribeInflightByKey = new Map<string, Promise<MachineContributionRegistryProjectionDescribeResult>>();

function projectionScopeKey(scope: MachineContributionRegistryProjectionScope): string {
    return JSON.stringify([scope.serverId, scope.machineId]);
}

export function getMachineContributionRegistryProjectionRevision(
    scope: MachineContributionRegistryProjectionScope,
): number {
    return projectionRevisionByScope.get(projectionScopeKey(scope)) ?? 0;
}

export function subscribeMachineContributionRegistryProjectionInvalidation(
    scope: MachineContributionRegistryProjectionScope,
    listener: () => void,
): () => void {
    const key = projectionScopeKey(scope);
    const listeners = projectionListenersByScope.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    projectionListenersByScope.set(key, listeners);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) projectionListenersByScope.delete(key);
    };
}

export function publishMachineContributionRegistryProjectionInvalidation(
    scope: MachineContributionRegistryProjectionScope,
): void {
    const key = projectionScopeKey(scope);
    projectionRevisionByScope.set(key, (projectionRevisionByScope.get(key) ?? 0) + 1);
    for (const listener of projectionListenersByScope.get(key) ?? []) listener();
}

export function publishMachineContributionRegistryProjectionReconnect(): void {
    for (const key of [...projectionListenersByScope.keys()]) {
        projectionRevisionByScope.set(key, (projectionRevisionByScope.get(key) ?? 0) + 1);
        for (const listener of projectionListenersByScope.get(key) ?? []) listener();
    }
}

function projectionDescribeInflightKey(params: Readonly<{
    scope: MachineContributionRegistryProjectionScope;
    timeoutMs: number | null;
    revision: number;
    requestEpoch: string | number | null;
    payload: unknown;
}>): string {
    return JSON.stringify([
        projectionScopeKey(params.scope),
        params.timeoutMs,
        params.revision,
        params.requestEpoch,
        params.payload,
    ]);
}

function targetedContributionsMatchMountedTarget(
    snapshot: PluginUiTargetedContributionsV1 | undefined,
    target: DaemonContributionRegistryProjectionMountedTargetV1,
): snapshot is PluginUiTargetedContributionsV1 {
    return snapshot?.target.pluginId === target.pluginId
        && snapshot.target.immutableGenerationId === target.immutableGenerationId;
}

function targetedSurfaceMountsMatchMountedTarget(
    mounts: readonly DaemonPluginUiTargetedSurfaceMountV1[] | undefined,
    target: DaemonContributionRegistryProjectionMountedTargetV1,
): boolean {
    return mounts === undefined || mounts.every((mount) => (
        mount.target.pluginId === target.pluginId
        && mount.target.immutableGenerationId === target.immutableGenerationId
    ));
}

async function waitForProjectionDescribeResult(
    request: Promise<MachineContributionRegistryProjectionDescribeResult>,
    signal: AbortSignal | undefined,
): Promise<MachineContributionRegistryProjectionDescribeResult> {
    if (!signal) return await request;
    if (signal.aborted) return { supported: false, reason: 'error' };

    return await new Promise((resolve) => {
        const onAbort = () => resolve({ supported: false, reason: 'error' });
        signal.addEventListener('abort', onAbort, { once: true });
        request.then((result) => {
            signal.removeEventListener('abort', onAbort);
            resolve(result);
        });
    });
}

export async function machineContributionRegistryProjectionDescribe(
    machineId: string,
    opts?: Readonly<{
        serverId?: string | null;
        timeoutMs?: number | null;
        signal?: AbortSignal;
        requestEpoch?: string | number;
        /** The sole target whose cold-admitted snapshot this caller may receive. */
        mountedTarget?: DaemonContributionRegistryProjectionMountedTargetV1;
    }>,
): Promise<MachineContributionRegistryProjectionDescribeResult> {
    if (opts?.signal?.aborted) return { supported: false, reason: 'error' };
    try {
        const reactNativeHostRuntimeIdentity = resolveNativeReactNativeHostRuntimeIdentity();
        const reactNativeWebLoaderCapability = resolveReactNativeWebLoaderCapability();
        const hostedWebFrameCapability = await resolveHostedWebFrameCapability();
        const payload = DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
            machineId,
            ...(reactNativeHostRuntimeIdentity ? { reactNativeHostRuntimeIdentity } : {}),
            ...(reactNativeWebLoaderCapability ? { reactNativeWebLoaderCapability } : {}),
            ...(hostedWebFrameCapability ? { hostedWebFrameCapability } : {}),
            ...(opts?.mountedTarget ? { mountedTarget: opts.mountedTarget } : {}),
        });
        const scope = {
            machineId: payload.machineId,
            serverId: opts?.serverId ?? null,
        } satisfies MachineContributionRegistryProjectionScope;
        const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : null;
        const key = projectionDescribeInflightKey({
            scope,
            timeoutMs,
            revision: getMachineContributionRegistryProjectionRevision(scope),
            requestEpoch: opts?.requestEpoch ?? null,
            payload,
        });
        let request = projectionDescribeInflightByKey.get(key);
        if (!request) {
            request = (async (): Promise<MachineContributionRegistryProjectionDescribeResult> => {
                try {
                    const response = await machineRpcWithServerScope<unknown, typeof payload>({
                        machineId: payload.machineId,
                        serverId: opts?.serverId,
                        timeoutMs: timeoutMs ?? undefined,
                        method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
                        payload,
                    });
                    if (isRpcMethodNotFoundResult(response)) {
                        return { supported: false, reason: 'not-supported' };
                    }
                    const parsed = parseDaemonContributionRegistryProjectionDescribeResponse(response);
                    if (!parsed) {
                        return { supported: false, reason: 'error' };
                    }
                    const mountedTarget = payload.mountedTarget;
                    if (mountedTarget) {
                        if (!targetedContributionsMatchMountedTarget(
                            parsed.targetedContributions,
                            mountedTarget,
                        ) || !targetedSurfaceMountsMatchMountedTarget(
                            parsed.targetedSurfaceMounts,
                            mountedTarget,
                        )) {
                            return { supported: false, reason: 'error' };
                        }
                        return {
                            supported: true,
                            projection: parsed.projection,
                            ...(parsed.composerSurfaceCatalog === undefined
                                ? {}
                                : { composerSurfaceCatalog: parsed.composerSurfaceCatalog }),
                            targetedContributions: parsed.targetedContributions,
                            ...(parsed.targetedSurfaceMounts === undefined
                                ? {}
                                : { targetedSurfaceMounts: parsed.targetedSurfaceMounts }),
                            ...(parsed.automationEligibleEvents === undefined
                                ? {}
                                : { automationEligibleEvents: parsed.automationEligibleEvents }),
                        };
                    }
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
                } catch {
                    return { supported: false, reason: 'error' };
                }
            })();
            projectionDescribeInflightByKey.set(key, request);
            void request.then(() => {
                if (projectionDescribeInflightByKey.get(key) === request) {
                    projectionDescribeInflightByKey.delete(key);
                }
            });
        }
        return await waitForProjectionDescribeResult(request, opts?.signal);
    } catch {
        return { supported: false, reason: 'error' };
    }
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
            timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined,
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
            timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined,
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
            // This is one bounded parked RPC. Its deadline follows the
            // incumbent Resource-watch budget plus the same round-trip margin.
            timeoutMs: DAEMON_PLUGIN_UI_RESOURCE_WATCH_DEFAULT_WAIT_MS + 10_000,
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
            timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined,
            signal: opts.signal,
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
            timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined,
            signal: opts.signal,
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
            timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined,
            signal: opts.signal,
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
    }>,
): Promise<MachinePluginStructuredMessageActionResult> {
    let issued = false;
    try {
        const payload = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
            machineId,
            ...(opts.requestId ? { requestId: opts.requestId } : {}),
            expectedGeneration: opts.expectedGeneration,
            qualifiedActionId: opts.qualifiedActionId,
            ...(opts.input === undefined ? {} : { input: opts.input }),
            ...(opts.expectedContributorImmutableGenerationId === undefined
                ? {}
                : { expectedContributorImmutableGenerationId: opts.expectedContributorImmutableGenerationId }),
            ...(opts.selectedActionInputCarrier === undefined
                ? {}
                : { selectedActionInputCarrier: opts.selectedActionInputCarrier }),
            ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
            ...(opts.messageActionReference ? { messageActionReference: opts.messageActionReference } : {}),
            executionSurface: opts.executionSurface,
            ...(opts.invocation ? { invocation: opts.invocation } : {}),
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined,
            signal: opts.signal,
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            payload,
            onIssued: () => {
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
 * Invokes one current Composer attachment contributor's pre-send callback.
 * The projection/daemon remain authoritative for contributor admission and
 * generation leases; this is only their server-scoped transport client.
 */
export async function machinePluginComposerAttachmentPrepare(
    machineId: string,
    opts: Readonly<Omit<DaemonPluginComposerAttachmentPrepareRequest, 'machineId'> & {
        serverId?: string | null;
        timeoutMs?: number | null;
        signal?: AbortSignal;
    }>,
): Promise<MachinePluginComposerAttachmentPrepareResult> {
    if (opts.signal?.aborted) return { supported: false, reason: 'aborted' };
    try {
        const payload = DaemonPluginComposerAttachmentPrepareRequestSchema.parse({
            machineId,
            expectedGeneration: opts.expectedGeneration,
            attachment: opts.attachment,
            request: opts.request,
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: payload.machineId,
            serverId: opts.serverId,
            timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined,
            signal: opts.signal,
            method: RPC_METHODS.DAEMON_PLUGIN_COMPOSER_ATTACHMENT_PREPARE,
            payload,
        });
        if (isRpcMethodNotFoundResult(response)) return { supported: false, reason: 'not-supported' };
        const parsed = DaemonPluginComposerAttachmentPrepareResponseSchema.safeParse(response);
        return parsed.success
            ? { supported: true, result: parsed.data }
            : { supported: false, reason: 'error' };
    } catch (error) {
        if (isRpcMethodNotFoundError(error) || isRpcMethodNotAvailableError(error)) {
            return { supported: false, reason: 'not-supported' };
        }
        return { supported: false, reason: classifyMachinePluginTransportError(error) };
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
            expectedGeneration: opts.expectedGeneration,
            qualifiedActionId: opts.qualifiedActionId,
            fieldPath: opts.fieldPath,
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: payload.machineId,
            serverId: opts.serverId,
            timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined,
            signal: opts.signal,
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
            expectedGeneration: opts.expectedGeneration,
            callerPluginId: opts.callerPluginId,
            resource: opts.resource,
            ...(opts.context === undefined ? {} : { context: opts.context }),
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined,
            signal: opts.signal,
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
            expectedGeneration: opts.expectedGeneration,
            callerPluginId: opts.callerPluginId,
            subscriptionId: opts.subscriptionId,
            resource: opts.resource,
            ...(opts.context === undefined ? {} : { context: opts.context }),
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined,
            signal: opts.signal,
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
            expectedGeneration: opts.expectedGeneration,
            callerPluginId: opts.callerPluginId,
            subscriptionId: opts.subscriptionId,
            ...(opts.waitMs === undefined ? {} : { waitMs: opts.waitMs }),
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            // The call deliberately outlives the default RPC budget: it is a
            // long poll, so its timeout is the daemon's parked budget plus a
            // margin for the round trip rather than a generic request timeout.
            timeoutMs: (payload.waitMs ?? DAEMON_PLUGIN_UI_RESOURCE_WATCH_MAX_WAIT_MS) + 10_000,
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
            timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined,
            method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE,
            payload,
        });
        DaemonPluginUiResourceWatchCloseResponseSchema.safeParse(response);
    } catch {
        // Local retirement stays authoritative when the daemon cleanup boundary
        // is unreachable; the daemon reclaims an unpolled subscription itself.
    }
}
