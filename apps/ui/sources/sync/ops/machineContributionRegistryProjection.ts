import { projectDatabaseConnectionResourceReadV1 } from '@happier-dev/protocol/daemon/machineServiceLogsResource';
import { DATABASE_CAPTURE_RESOURCE_REF_V1, TELEMETRY_METRICS_READ_ACTION_ID_V1, TELEMETRY_REQUESTS_WINDOW_MS_V1 } from '@happier-dev/database-protocol';
import { PluginServiceListFieldResourceInputV1Schema } from '@happier-dev/plugin-sdk/ui';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { resolvePluginUiHostReadActionIdV1 } from '@happier-dev/protocol/plugins/ui/subscriptions';
import { confirmOwnUiRefusal } from './actions/executeMachineActionAtDaemon';
import { projectExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { bindPresentUserActionConfirmation } from '@/sync/ops/actions/presentUserConfirmation';
import { DaemonContributionRegistryProjectionDescribeRequestSchema, DaemonPluginUiTargetedContributionsReadRequestSchema, DaemonPluginSettingsGetRequestSchema, DaemonPluginSettingsGetResponseSchema, DaemonPluginSettingsSetRequestSchema, DaemonPluginSettingsSetResponseSchema, DaemonPluginSecretStatusRequestSchema, DaemonPluginSecretStatusResponseSchema, DaemonPluginSecretSetRequestSchema, DaemonPluginSecretSetResponseSchema, DaemonPluginSecretDeleteRequestSchema, DaemonPluginSecretDeleteResponseSchema, DaemonPluginStructuredMessageActionExecuteResponseSchema, DaemonPluginActionFormConnectedAccountOptionsResolveRequestSchema, DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema, DaemonPluginActionSchemasReadRequestSchema, DaemonPluginActionSchemasReadResponseSchema, DaemonPluginUiResourceReadRequestSchema, DaemonPluginUiResourceReadResponseSchema, DaemonPluginUiResourceWatchOpenRequestSchema, DaemonPluginUiResourceWatchOpenResponseSchema, DaemonPluginUiResourceWatchNextRequestSchema, DaemonPluginUiResourceWatchNextResponseSchema, DaemonPluginUiResourceWatchCloseRequestSchema, DaemonPluginUiResourceWatchCloseResponseSchema, type DaemonPluginSettingsSnapshot, type DaemonPluginSettingsMutation, type DaemonPluginSettingsSetResponse, type DaemonPluginSecretStatusResponse, type DaemonPluginSecretSetResponse, type DaemonPluginSecretDeleteResponse, type DaemonPluginStructuredMessageActionExecuteResponse, type DaemonPluginActionFormConnectedAccountOptionsResolveRequest, type DaemonPluginActionFormConnectedAccountOptionsResolveResponse, type DaemonPluginActionSchemasReadRequest, type DaemonPluginActionSchemasReadResponse, type DaemonPluginUiResourceReadRequest, type DaemonPluginUiResourceReadResponse, type DaemonPluginUiResourceWatchOpenRequest, type DaemonPluginUiResourceWatchOpenResponse, type DaemonPluginUiResourceWatchNextRequest, type DaemonPluginUiResourceWatchNextResponse, type DaemonPluginUiResourceWatchCloseRequest, type DaemonContributionRegistryProjectionAutomationEligibleEventsV1, type DaemonPluginUiComposerSurfaceCatalogEntryV1, type DaemonPluginUiTargetedSurfaceMountV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { DaemonPluginStructuredMessageActionExecuteRequest } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { readPluginActionFailureHandlerInvocation } from '@happier-dev/protocol/plugins/actions/invocation';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ActionApprovalRequestCreatedResultSchema, isActionOutcomeUnknownErrorCodeV1, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resumeActionExecutionResult, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { readActionOperationTerminalResultV1, type ActionOperationDeclarationV1 } from '@happier-dev/protocol/actions/operations/v1';
import { observeActionOperationByRequestId } from '@/sync/domains/actionOperations/observeActionOperationByRequestId';
import { buildMachinePluginActionExecuteRequest, isMachinePluginActionScopeCurrent } from './machinePluginActionRequest';
import type { PluginActionInvocationSurfaceV2 } from '@happier-dev/plugin-sdk/actions';
import type { PluginUiTargetedContributionsV1 } from '@happier-dev/protocol/plugins/ui';
import type { DaemonPluginTargetedSourceDeclarationV1, DaemonPluginUiResourceDeclarationsByPluginIdV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { MachineRecipeReadTargetV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { preparePluginContributionPointDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/targeted';
import { normalizePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import {
    DaemonPluginSettingsWatchRequestSchema,
    DaemonPluginSettingsWatchResponseSchema,
    isRpcMethodNotFoundResult,
    RPC_ERROR_CODES,
    RPC_METHODS,
    type DaemonPluginSettingsWatchRequest,
    type DaemonPluginSettingsWatchResponse,
} from '@happier-dev/protocol/rpc';
import { DaemonContributionRegistryProjectionDescribeUnchangedResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { DaemonProjectionDeferredSectionsResponseSchema, daemonProjectionSectionsCover,
    DAEMON_PROJECTION_SECTION_FRAME_BYTES, DAEMON_PROJECTION_SECTION_STALE_CODE,
    type DaemonProjectionDeferredSectionsResponse } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { resolveMachineRpcTargetServerId } from '@/sync/runtime/orchestration/serverScopedRpc/resolveMachineRpcTargetServerId';
import { createMachineRpcReadAdmission, resetAdmittedMachineRpcReadsForTests, type MachineRpcReadAdmission, type MachineRpcReadAdmissionInput } from '@/sync/runtime/orchestration/serverScopedRpc/machineRpcReadAdmission';
import {
    isRpcMethodNotAvailableError,
    isRpcMethodNotFoundError,
    readRpcErrorCode,
} from '@/sync/runtime/rpcErrors';
import { isRpcError, isRpcMachineAdmissionUnavailableError } from '@happier-dev/protocol/rpcErrors';
import type { MachineAvailabilityDiagnosticV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import {
    parseDaemonContributionRegistryProjectionDescribeResponse,
    parseDaemonPluginUiTargetedContributionsReadResponse,
    type DaemonContributionRegistryProjection,
    type DaemonContributionRegistryProjectionDescribeParsedResponse,
} from '@/sync/api/daemon/daemonContributionRegistryProjectionProtocol';
import { buildProjectionDescribeRequest, readProjectionClientContext, type ProjectionDescribeSelection } from './machineProjectionRequest';
import { InvalidDaemonProjectionSection, packSectionReadIncludeDigests, readDeferredProjection, type DeferredDaemonProjection, type DaemonProjectionSectionCache } from './machineProjectionSections';
export type { DeferredDaemonProjection, DaemonProjectionSectionCache } from './machineProjectionSections';
import type { DaemonProjectionSectionStore } from './machineProjectionSectionStore';
import { serverAccountScopeKeySuffix, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { isEnvironmentDatabaseAdmissionV1, projectDeploymentReadAdmissionV1, projectPrivateMountedDatabaseReadInputV1 } from '@happier-dev/protocol/deployments/deploymentReadAdmissionV1';
import { PluginActionFailureResponseV1Schema } from '@happier-dev/protocol/plugins/actions/failureResponse';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { randomUUID } from '@/platform/randomUUID';
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
    getMachineContributionRegistryProjectionAuthorityRevision,
    getMachineContributionRegistryProjectionRevision,
    publishMachineContributionRegistryProjectionInvalidation,
    publishMachineContributionRegistryProjectionRefresh,
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
 * - transport, access, authentication, update and encryption failures retain
 *   their stable RPC category, without exposing the error's message or data;
 * - `request-failed` / `transport-error`: local request preparation failed,
 *   or the RPC failed without a more specific stable category;
 * - `error`: a less-specific failure from a targeted read or projection cache.
 */
export type MachineContributionRegistryProjectionFailureReason =
    | MachinePluginTransportReason
    | MachineAvailabilityDiagnosticV1['reason']
    | 'invalid-response'
    | 'projection-stale'
    | 'request-failed'
    | 'transport-error'
    | 'transport-unavailable'
    | 'machine-unavailable'
    | 'access-denied'
    | 'authentication-required'
    | 'authentication-unavailable'
    | 'update-required'
    | 'encryption-unavailable';

export type DaemonProjectionHydrationRejection =
    | 'manifest-admission' | 'section-json' | 'section-page' | 'section-page-position'
    | 'included-section' | 'section-spans' | 'section-digest' | 'section-index'
    | 'section-index-schema' | 'section-assembly' | 'section-identity'
    | 'section-projection' | 'projection-admission';

export type MachineContributionRegistryProjectionDescribeResult = (
    | Readonly<{
        supported: true;
        projection: DaemonContributionRegistryProjection;
        projectionDigest?: string;
        /** Byte templates only, admitted by the full response parser below. */
        sectionBodies?: ReadonlyMap<string, readonly string[]>;
        deferredProjection?: DeferredDaemonProjection;
        /** This read revalidated the held projection without transferring its body. */
        unchanged?: true;
        /** The daemon has already selected the concrete Composer renderer for every row. */
        composerSurfaceCatalog?: readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[];
        /** Global current Event-automation composer facts from the same projection response. */
        automationEligibleEvents?: DaemonContributionRegistryProjectionAutomationEligibleEventsV1;
        machineRecipeTarget?: MachineRecipeReadTargetV1;
    }>
    | Readonly<{ supported: false; reason: MachineContributionRegistryProjectionFailureReason }>
) & Readonly<{ /** Content-free name of the section check that refused the hydration. */
    deferredHydrationRejection?: DaemonProjectionHydrationRejection }>;


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
        resourceDeclarationsByPluginId?: DaemonPluginUiResourceDeclarationsByPluginIdV1;
    }>
    | Readonly<{
        supported: false;
        reason: MachineContributionRegistryProjectionFailureReason | 'unavailable';
        /** The daemon's own code when it answered `unavailable`. */
        code?: string;
    }>;

export type MachinePluginTargetedSourceDeclarationsReadResult =
    | Readonly<{ supported: true; sourceDeclarations: readonly DaemonPluginTargetedSourceDeclarationV1[];
        unavailablePlugins?: SourceDeclarationsAnswer['unavailablePlugins'] }>
    | Extract<MachinePluginUiTargetedContributionsReadResult, Readonly<{ supported: false }>>;

type MachinePluginTargetedReadOptions = Readonly<{
    serverId?: string | null;
    pluginId: string;
    signal?: AbortSignal;
    accountLifetime?: ProjectionReadAccount | null;
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

/** Home refusals that settle a Resource read or watch. */
export function classifyMachinePluginUiResourceRefusal(code: string): 'target_unavailable' | 'denied' | undefined {
    if (code === 'target_unavailable') return 'target_unavailable';
    if (code === 'credential_scope_denied' || code === RPC_ERROR_CODES.FORBIDDEN) return 'denied';
    return undefined;
}

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

/** Home's socket admission refusal (`buildForbiddenRpcResponse`): nothing reached the daemon. */
function readHomeRpcAdmissionRefusal(response: unknown): DaemonPluginStructuredMessageActionExecuteResponse | null {
    if (!response || typeof response !== 'object') return null;
    const value = response as Readonly<{ ok?: unknown; errorCode?: unknown; failureCause?: unknown }>;
    if (value.ok !== false || value.errorCode !== RPC_ERROR_CODES.FORBIDDEN) return null;
    const refusal = PluginActionFailureResponseV1Schema.safeParse({ ok: false, code: RPC_ERROR_CODES.FORBIDDEN,
        effectAttempted: false, ...(value.failureCause === undefined ? {} : { failureCause: value.failureCause }) });
    return refusal.success ? refusal.data : { ok: false, code: RPC_ERROR_CODES.FORBIDDEN, effectAttempted: false };
}

function classifyMachinePluginTransportError(error: unknown): MachinePluginTransportReason {
    const code = readRpcErrorCode(error) ?? (error && typeof error === 'object'
        ? (error as Readonly<{ code?: unknown }>).code
        : undefined);
    if (code === 'MACHINE_RPC_ABORTED' || code === 'SOCKET_RPC_ABORTED') return 'aborted';
    if (code === 'MACHINE_RPC_TIMEOUT') return 'timeout';
    return 'error';
}

/** Projection reads expose recovery categories, never arbitrary peer codes or prose. */
function classifyMachineProjectionReadError(error: unknown): MachineContributionRegistryProjectionFailureReason {
    if (isRpcError(error) && error.rpcErrorCode === 'target_unavailable' && error.details && 'reason' in error.details) {
        return error.details.reason;
    }
    switch (readRpcErrorCode(error)) {
        case DAEMON_PROJECTION_SECTION_STALE_CODE:
            return 'projection-stale';
        case RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE:
        case RPC_ERROR_CODES.OUTCOME_UNKNOWN:
            // This is a read: losing its reply means no current projection is
            // available, not that the Machine is offline or lacks integrations.
            return 'transport-unavailable';
        case RPC_ERROR_CODES.FORBIDDEN:
            return isRpcMachineAdmissionUnavailableError(error) ? 'machine-unavailable' : 'access-denied';
        case RPC_ERROR_CODES.TEAM_AUTHENTICATION_REQUIRED:
            return 'authentication-required';
        case RPC_ERROR_CODES.TEAM_AUTHENTICATION_UNAVAILABLE:
            return 'authentication-unavailable';
        case RPC_ERROR_CODES.UPDATE_REQUIRED:
            return 'update-required';
        case 'MACHINE_ENCRYPTION_UNAVAILABLE':
            return 'encryption-unavailable';
        default: {
            const reason = classifyMachinePluginTransportError(error);
            return reason === 'error' ? 'transport-error' : reason;
        }
    }
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
 * The Account a read is for. Every handle of one Account shares its reads; a
 * successor Account never joins a read its predecessor started. Each caller
 * still fences what it does with the answer on its own lifetime.
 */
type ProjectionReadAccount = Readonly<{ scope: ServerAccountScope }>;

function projectionReadAdmission(
    scope: MachineContributionRegistryProjectionScope,
    payload: unknown,
): MachineRpcReadAdmission {
    return createMachineRpcReadAdmission(['machine-contribution-registry', machineContributionRegistryProjectionScopeKey(scope),
        getMachineContributionRegistryProjectionRevision(scope), payload]);
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
        /** The Account the read is for; reads are shared only within it. */
        accountLifetime?: ProjectionReadAccount | null;
        /** Already-held full answer, qualified by the loader's Account and locale. */
        knownProjection?: DaemonContributionRegistryProjectionDescribeParsedResponse & Readonly<{ projectionDigest: string }>;
        /** Home/Account/locale-owned byte inventory supplied by the canonical loader. */
        sectionBodies?: ReadonlyMap<string, readonly string[]>;
        sectionCache?: DaemonProjectionSectionCache;
        /** The Account's device copy of section bodies, supplied with its section cache. */
        sectionStore?: DaemonProjectionSectionStore | null;
        sections?: readonly string[];
        deferredProjection?: DeferredDaemonProjection;
        /** Current manifest, fresh authority already established; hydrate new demand only. */
        reuseManifest?: boolean;
        /** Captured by the loader before a cold Home inventory may be awaited. */
        locale?: string;
        /** Observes the admitted manifest before its sections hydrate, so other demand can hydrate beside it. */
        onManifest?: (manifest: DaemonProjectionDeferredSectionsResponse) => void;
    }> & ProjectionDescribeSelection,
): Promise<MachineContributionRegistryProjectionDescribeResult> {
    if (opts?.signal?.aborted) return { supported: false, reason: 'aborted' };
    let payload: ReturnType<typeof DaemonContributionRegistryProjectionDescribeRequestSchema.parse>;
    try {
        payload = await buildProjectionDescribeRequest(machineId, opts);
    } catch {
        return { supported: false, reason: 'request-failed' };
    }
    const scope = {
        machineId: payload.machineId,
        serverId: opts?.serverId ?? null,
    } satisfies MachineContributionRegistryProjectionScope;
    try {
            const invoke = (request: typeof payload, signal = opts?.signal) => machineRpcWithServerScope<unknown, typeof payload>({
                machineId: payload.machineId,
                serverId: opts?.serverId,
                accountId: opts?.accountLifetime?.scope.accountId,
                method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
                payload: request,
                // Projection work has no operation deadline, like capability
                // detection. Connection/setup admission keeps its RPC budget.
                operationTimeoutMs: null,
                signal,
                readAdmission: projectionReadAdmission(scope, request),
            });
            const hydrate = async (manifest: DaemonProjectionDeferredSectionsResponse) => {
                // Parallel carrier reads belong to this hydration, including
                // its failure. A retired batch must not retain sibling reads
                // while fresh demand or stale recovery starts.
                const abort = new AbortController();
                const cancel = () => abort.abort();
                opts?.signal?.addEventListener('abort', cancel, { once: true });
                if (opts?.signal?.aborted) cancel();
                try {
                    return await readDeferredProjection({
                        manifest,
                        sections: opts?.sections,
                        held: opts?.sectionBodies ?? new Map(),
                        shared: opts?.sectionCache,
                        store: opts?.sectionStore,
                        signal: abort.signal,
                        read: (digest, offset, candidates) => {
                            const request = (includeDigests: readonly string[]) => ({ ...payload,
                                sectionRead: { digest, offset, includeDigests: [...includeDigests] }, deferredSections: true as const,
                                sectionBindingOverlay: manifest.bindingSections === undefined ? undefined : true as const });
                            const includeDigests = packSectionReadIncludeDigests(
                                peers => new TextEncoder().encode(JSON.stringify(request(peers))).length,
                                candidates, DAEMON_PROJECTION_SECTION_FRAME_BYTES);
                            return invoke(DaemonContributionRegistryProjectionDescribeRequestSchema.parse(request(includeDigests)), abort.signal);
                        },
                    });
                } catch (error) {
                    cancel();
                    throw error;
                } finally {
                    opts?.signal?.removeEventListener('abort', cancel);
                }
            };
            const hydrateResult = async (initialManifest: DaemonProjectionDeferredSectionsResponse): Promise<MachineContributionRegistryProjectionDescribeResult> => {
                let manifest = initialManifest;
                opts?.onManifest?.(manifest);
                try {
                    try { return { supported: true, ...await hydrate(manifest) }; }
                    catch (error) {
                        if (opts?.signal?.aborted || readRpcErrorCode(error) !== DAEMON_PROJECTION_SECTION_STALE_CODE) throw error;
                        if (payload.selection !== undefined) throw error;
                        // A live authority/activation change can replace the build
                        // without advancing registry generation. Re-establish once
                        // through current authority, without a held conditional digest.
                        const { knownProjectionDigest: _known, ...freshRequest } = payload;
                        const fresh = DaemonProjectionDeferredSectionsResponseSchema.safeParse(await invoke(freshRequest));
                        if (!fresh.success) throw new InvalidDaemonProjectionSection('manifest-admission');
                        manifest = fresh.data;
                        return { supported: true, ...await hydrate(manifest) };
                    }
                }
                catch (error) {
                    if (opts?.signal?.aborted) return { supported: false, reason: 'aborted' };
                    if (error instanceof InvalidDaemonProjectionSection) {
                        return { supported: false, reason: 'invalid-response', deferredHydrationRejection: error.reason };
                    }
                    throw error;
                }
            };
            if (opts?.reuseManifest && opts.deferredProjection) {
                return await hydrateResult(opts.deferredProjection.manifest);
            }
            const response = await invoke(payload);
            if (isRpcMethodNotFoundResult(response)) {
                return { supported: false, reason: 'not-supported' };
            }
            if (response && typeof response === 'object' && 'unchanged' in response) {
                const unchanged = DaemonContributionRegistryProjectionDescribeUnchangedResponseSchema.safeParse(response);
                if (!unchanged.success || opts?.selection || !opts?.knownProjection
                    || unchanged.data.projectionDigest !== opts.knownProjection.projectionDigest) {
                    return { supported: false, reason: 'invalid-response' };
                }
                if (opts.deferredProjection && !daemonProjectionSectionsCover(opts.deferredProjection.manifest,
                    opts.deferredProjection.loadedSections, opts.sections)) {
                    return await hydrateResult(opts.deferredProjection.manifest);
                }
                return { supported: true, ...opts.knownProjection,
                    ...(opts.deferredProjection ? { deferredProjection: opts.deferredProjection } : {}), unchanged: true };
            }
            if (response && typeof response === 'object' && 'deferredSections' in response) {
                if (opts?.selection) return { supported: false, reason: 'invalid-response' };
                const manifest = DaemonProjectionDeferredSectionsResponseSchema.safeParse(response);
                if (!manifest.success) return { supported: false, reason: 'invalid-response', deferredHydrationRejection: 'manifest-admission' };
                return await hydrateResult(manifest.data);
            }
            const parsed = parseDaemonContributionRegistryProjectionDescribeResponse(response);
            if (!parsed) return { supported: false, reason: 'invalid-response' };
            return {
                supported: true,
                projection: parsed.projection,
                ...(parsed.projectionDigest === undefined ? {} : { projectionDigest: parsed.projectionDigest }),
                ...(parsed.composerSurfaceCatalog === undefined
                    ? {}
                    : { composerSurfaceCatalog: parsed.composerSurfaceCatalog }),
                ...(parsed.automationEligibleEvents === undefined
                    ? {}
                    : { automationEligibleEvents: parsed.automationEligibleEvents }),
                ...(parsed.machineRecipeTarget === undefined
                    ? {}
                    : { machineRecipeTarget: parsed.machineRecipeTarget }),
            };
        } catch (error) {
            if (isRpcMethodNotFoundError(error) || isRpcMethodNotAvailableError(error)) {
                return { supported: false, reason: 'not-supported' };
            }
            return { supported: false, reason: classifyMachineProjectionReadError(error) };
        }
}

type SourceDeclarationsAnswer = Extract<NonNullable<ReturnType<typeof parseDaemonPluginUiTargetedContributionsReadResponse>>, Readonly<{ status: 'sourceDeclarations' }>>;

function isSourceDeclarationsAnswer(value: unknown, pluginId: string): value is SourceDeclarationsAnswer {
    return Boolean(value && typeof value === 'object' && (value as { status?: unknown }).status === 'sourceDeclarations'
        && (value as { pluginId?: unknown }).pluginId === pluginId);
}

/** A retained answer keeps one prepared declaration list, so repeated operations share its identity. */
const preparedSourceDeclarations = new WeakMap<SourceDeclarationsAnswer, MachinePluginTargetedSourceDeclarationsReadResult>();
function readPreparedSourceDeclarations(answer: SourceDeclarationsAnswer): MachinePluginTargetedSourceDeclarationsReadResult {
    let prepared = preparedSourceDeclarations.get(answer);
    if (!prepared) {
        prepared = { supported: true,
            ...(answer.unavailablePlugins === undefined ? {} : { unavailablePlugins: answer.unavailablePlugins }),
            sourceDeclarations: answer.sourceDeclarations.map(row => ({ ...row,
            manifest: { ...row.manifest,
                contributes: preparePluginContributionPointDeclarationsV1(row.manifest.contributes) },
        })) };
        preparedSourceDeclarations.set(answer, prepared);
    }
    return prepared;
}

function decodeTargetedContributionsReadResponse(raw: unknown) {
    return isRpcMethodNotFoundResult(raw) ? raw : parseDaemonPluginUiTargetedContributionsReadResponse(raw);
}

/**
 * Reads the current contributions to one mounted target. The daemon answers
 * with its current occurrence of that target; it never fences the read.
 */
export function machinePluginUiTargetedContributionsRead(
    machineId: string,
    opts: MachinePluginTargetedReadOptions & Readonly<{ readMode: 'sourceDeclarations' }>,
): Promise<MachinePluginTargetedSourceDeclarationsReadResult>;
export function machinePluginUiTargetedContributionsRead(
    machineId: string,
    opts: MachinePluginTargetedReadOptions,
): Promise<MachinePluginUiTargetedContributionsReadResult>;
export async function machinePluginUiTargetedContributionsRead(
    machineId: string,
    opts: MachinePluginTargetedReadOptions & Readonly<{ readMode?: 'sourceDeclarations' }>,
): Promise<MachinePluginUiTargetedContributionsReadResult | MachinePluginTargetedSourceDeclarationsReadResult> {
    if (opts.signal?.aborted) return { supported: false, reason: 'aborted' };
    let payload: ReturnType<typeof DaemonPluginUiTargetedContributionsReadRequestSchema.parse>;
    try {
        payload = DaemonPluginUiTargetedContributionsReadRequestSchema.parse({
            ...(await readProjectionClientContext(machineId)),
            pluginId: opts.pluginId,
            ...(opts.readMode === undefined ? {} : { readMode: opts.readMode }),
        });
    } catch {
        return { supported: false, reason: 'error' };
    }
    const scope = {
        machineId: payload.machineId,
        serverId: opts.serverId ?? null,
    } satisfies MachineContributionRegistryProjectionScope;
    try {
            const response = await machineRpcWithServerScope<ReturnType<typeof decodeTargetedContributionsReadResponse>, typeof payload>({
                machineId: payload.machineId,
                serverId: opts.serverId,
                accountId: opts.accountLifetime?.scope.accountId,
                method: RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ,
                payload,
                operationTimeoutMs: null,
                signal: opts.signal,
                // A target's answer (its points and mounts, or its source declarations) changes only with the
                // Machine's registry, which advances the projection revision on every invalidation. Each caller
                // asks (a mount, its re-open, an Account-origin page); equal revisions answer from the one kept answer.
                readAdmission: retainedReadAdmission({
                    key: JSON.stringify([opts.readMode ?? 'targetedContributions', machineContributionRegistryProjectionScopeKey(scope), payload]),
                    version: String(getMachineContributionRegistryProjectionRevision(scope)),
                    pending: projectionReadAdmission(scope, payload),
                    retain: value => (opts.readMode === 'sourceDeclarations'
                        ? isSourceDeclarationsAnswer(value, payload.pluginId)
                        : isCurrentTargetedContributionsAnswer(value, payload.pluginId)) ? value : undefined,
                    onAnswer: () => {},
                }),
                decodeResult: decodeTargetedContributionsReadResponse,
            });
            if (isRpcMethodNotFoundResult(response)) {
                return { supported: false, reason: 'not-supported' };
            }
            const parsed = response;
            if (!parsed) return { supported: false, reason: 'invalid-response' };
            if (parsed.status === 'unavailable') {
                return { supported: false, reason: 'unavailable', code: parsed.code };
            }
            if (opts.readMode === 'sourceDeclarations') {
                if (!isSourceDeclarationsAnswer(parsed, payload.pluginId)) {
                    return { supported: false, reason: 'invalid-response' };
                }
                return readPreparedSourceDeclarations(parsed);
            }
            if (parsed.status !== 'current') return { supported: false, reason: 'invalid-response' };
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
                resourceDeclarationsByPluginId: parsed.resourceDeclarationsByPluginId,
            };
        } catch (error) {
            if (isRpcMethodNotFoundError(error) || isRpcMethodNotAvailableError(error)) {
                return { supported: false, reason: 'not-supported' };
            }
            return { supported: false, reason: classifyMachinePluginTransportError(error) };
        }
}

/** Only a current answer for the asked plugin is kept; refusals and another plugin's slice are not. */
function isCurrentTargetedContributionsAnswer(value: unknown, pluginId: string): boolean {
    if (!value || typeof value !== 'object' || (value as { status?: unknown }).status !== 'current') return false;
    const target = (value as { targetedContributions?: { target?: { pluginId?: unknown } } }).targetedContributions?.target;
    return target?.pluginId === pluginId;
}

/** The same target-read transport, requesting current Machine sources for an invoking Account target. */
export function machinePluginTargetedSourceDeclarationsRead(
    machineId: string,
    opts: MachinePluginTargetedReadOptions,
): Promise<MachinePluginTargetedSourceDeclarationsReadResult> {
    return machinePluginUiTargetedContributionsRead(machineId, { ...opts, readMode: 'sourceDeclarations' });
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

function projectMachinePluginActionExecutionResponse(result: ActionExecuteResult): DaemonPluginStructuredMessageActionExecuteResponse {
    if (result.ok) return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({ ok: true, result: result.result });
    const actionHandlerInvocation = readPluginActionFailureHandlerInvocation({
        code: result.errorCode,
        message: result.error,
        data: result.details,
    });
    return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
        ok: false, code: result.errorCode, message: result.error,
        details: StrictJsonValueSchema.safeParse(result.details).data,
        failureCause: result.failureCause, requestId: result.requestId, effectAttempted: result.effectAttempted,
        ...(actionHandlerInvocation === undefined ? {} : { actionHandlerInvocation }),
    });
}

export async function machinePluginStructuredMessageActionExecute(
    machineId: string,
    opts: Readonly<Omit<DaemonPluginStructuredMessageActionExecuteRequest, 'machineId' | 'executionSurface'> & {
        /** The strict daemon schema admits supported caller surfaces before any RPC is issued. */
        executionSurface: PluginActionInvocationSurfaceV2;
        serverId?: string | null;
        timeoutMs?: number | null;
        signal?: AbortSignal;
        /** Host-only authority; the strict request schema below never publishes it. */
        accountLifetime?: ServerAccountScopeLifetime | null;
        isCurrent?: () => boolean;
        /** The mounted host presents and observes the existing durable approval. */
        onApprovalPending?: (registration: ActionApprovalRegistration) => void;
        /** Host-owned declaration; never part of the plugin invocation DTO. */
        operation?: ActionOperationDeclarationV1;
        /** The mounted host is presenting this Environment database request for a Person. */
        presentedByPerson?: true;
    }>,
): Promise<MachinePluginStructuredMessageActionResult> {
    let issued = false;
    try {
        if (!isMachinePluginActionScopeCurrent(opts)) {
            return { supported: false, reason: 'error' };
        }
        const payload = buildMachinePluginActionExecuteRequest(machineId, opts);
        const onIssued = () => {
            if (!isMachinePluginActionScopeCurrent(opts) || opts.isCurrent?.() === false) {
                throw new Error('plugin_ui_generation_retired');
            }
            issued = true;
        };
        const action = parseQualifiedPluginContributionKey(payload.qualifiedActionId);
        const actionInput = action ? { action,
            ...(payload.expectedContributorOccurrenceId === undefined ? {} : { expectedContributorOccurrenceId: payload.expectedContributorOccurrenceId }),
            ...(payload.input === undefined ? {} : { input: payload.input }),
            ...(payload.messageActionReference ? { messageActionReference: payload.messageActionReference } : {}),
        } : undefined;
        const selectedRead = payload.selectedActionInputCarrier && actionInput
            ? projectPrivateMountedDatabaseReadInputV1(actionInput) : undefined;
        const mounted = payload.invocation?.kind === 'mountedPluginSurface' || payload.invocation?.kind === 'clientPluginAction'
            ? payload.invocation : undefined;
        // An Environment database Action is admitted by its Environment owner at Home's mint (P3 M7);
        // the raw Machine RPC carries no such decision, so it always takes the Home relay below.
        const environmentDatabase = Boolean(mounted && actionInput && !selectedRead
            && isEnvironmentDatabaseAdmissionV1(projectDeploymentReadAdmissionV1(ACTION_INVOKE_ACTION_ID_V1, actionInput)));
        if (!payload.invocation || selectedRead || environmentDatabase) {
            // A mounted selected database read requires the same Home admission as
            // an ordinary signed Action. A refused selection cannot fall through to Machine RPC.
            if (!actionInput || (selectedRead ? !mounted
                : !environmentDatabase && payload.requiredReadOnly)) return {
                supported: true, result: { ok: false, code: 'plugin_action_unavailable' },
            };
            const serverId = resolveMachineRpcTargetServerId(opts.accountLifetime?.scope.serverId ?? opts.serverId);
            if (!serverId) return { supported: false, reason: 'error' };
            const account = await captureLazyActionAccountContext(serverId, opts.signal);
            try {
                if (opts.accountLifetime && account.accountId !== opts.accountLifetime.scope.accountId) {
                    return { supported: false, reason: 'error' };
                }
                const requestId = payload.requestId ?? randomUUID();
                // Retain the established host repair wrapper. Mounted selection
                // uses only the contributed Action's allowed wrapper fields.
                const input = !mounted && payload.sessionId !== undefined ? { ...actionInput, sessionId: payload.sessionId } : actionInput;
                const target = { kind: 'machine' as const, machineId };
                const pluginInvocation = environmentDatabase && opts.presentedByPerson ? undefined : mounted;
                const authority = pluginInvocation ? 'account_automation' as const : 'present_user' as const;
                const callerBinding = pluginInvocation?.kind === 'mountedPluginSurface' ? pluginInvocation.mountedBinding : pluginInvocation?.clientActionBinding;
                const context = { surface: payload.executionSurface, authority,
                    actionCaller: callerBinding ? { kind: 'plugin' as const, pluginId: callerBinding.pluginId,
                        contributionLocalId: callerBinding.contributionLocalId, occurrenceId: callerBinding.occurrenceId,
                        ...(callerBinding.sourceCustody ? { sourceCustody: callerBinding.sourceCustody } : {}),
                    } : { kind: 'host' as const }, actionRequestId: requestId,
                    runtimeAccountId: account.accountId, serverId: account.serverId,
                    ...(payload.sessionId === undefined ? {} : { defaultSessionId: payload.sessionId }),
                    ...(account.serverIdentityId ? { serverIdentityId: account.serverIdentityId } : {}),
                    externalActionTarget: target };
                const invocation = projectExternalActionRequesterInvocationV1({ actionId: ACTION_INVOKE_ACTION_ID_V1,
                    context: payload.presentUserIntent === 'confirmed'
                        ? bindPresentUserActionConfirmation(ACTION_INVOKE_ACTION_ID_V1, input, context) : context,
                    account, target });
                if (mounted && !invocation) return {
                    supported: true, result: { ok: false, code: 'plugin_selected_action_input_unavailable' },
                };
                let result = await executeOriginalAccountMachineAction({ account, actionId: ACTION_INVOKE_ACTION_ID_V1,
                    requestId, machineId, authority, input,
                    ...(pluginInvocation ? { pluginInvocation } : {}),
                    ...(invocation ? { invocation: { ...invocation,
                        ...(mounted && payload.selectedActionInputCarrier ? { selectedActionInput: {
                            carrier: payload.selectedActionInputCarrier, input: projectNativeJsonValueForTransport(input),
                        } } : {}),
                    } } : {}),
                    ...(opts.signal ? { signal: opts.signal } : {}),
                    ...(opts.timeoutMs == null ? {} : { timeoutMs: opts.timeoutMs }), onTransportIssued: onIssued });
                if (opts.onApprovalPending) {
                    result = await resumeActionExecutionResult({ result, actionId: 'action.invoke', actionInput: input,
                        requestId, scope: account.accountLifetime.scope, signal: opts.signal,
                        onApprovalPending: opts.onApprovalPending });
                } else if (result.ok && ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) {
                    return { supported: true, result: { ok: false, code: 'approval_request_created' } };
                }
                if (!result.ok && isActionOutcomeUnknownErrorCodeV1(result.errorCode)) return { supported: false, reason: 'outcomeUnknown' };
                return { supported: true, result: projectMachinePluginActionExecutionResponse(result) };
            } finally { account.dispose(); }
        }
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.accountLifetime?.scope.serverId ?? opts.serverId,
            accountId: opts.accountLifetime?.scope.accountId,
            ...pluginRpcOperationOptions(opts),
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            requestId: payload.requestId,
            payload,
            onIssued,
        });
        if (isRpcMethodNotFoundResult(response)) return { supported: false, reason: 'not-supported' };
        // Home's definite admission refusal is a typed cause, never an unknown outcome.
        const homeRefusal = readHomeRpcAdmissionRefusal(response);
        if (homeRefusal) return { supported: true, result: homeRefusal };
        const parsed = DaemonPluginStructuredMessageActionExecuteResponseSchema.safeParse(response);
        if (!parsed.success) return { supported: false, reason: issued ? 'outcomeUnknown' : 'error' };
        const approval = parsed.data.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(parsed.data.result) : null;
        if (!opts.operation || !approval?.success) return { supported: true, result: parsed.data };
        const scope = opts.accountLifetime?.scope;
        if (!scope || !payload.requestId) return { supported: false, reason: 'outcomeUnknown' };
        // The native child remains held by the parent runner. Its Artifact is
        // presentation only; the source Action's terminal result owns completion.
        opts.onApprovalPending?.(approval.data.artifactId);
        const operation = await observeActionOperationByRequestId({
            serverId: scope.serverId, accountId: scope.accountId, machineId,
            requestIdentity: { actionId: payload.qualifiedActionId, requestId: payload.requestId },
            signal: opts.signal,
            onUpdate: snapshot => {
                if (snapshot.state === 'running' && snapshot.progress?.kind === 'phase'
                    && snapshot.progress.approval) opts.onApprovalPending?.(snapshot.progress.approval.artifactId);
            },
        });
        const terminal = operation ? readActionOperationTerminalResultV1(operation) : null;
        if (!terminal) return { supported: false, reason: 'outcomeUnknown' };
        if (!terminal.ok) {
            const refusal = DaemonPluginStructuredMessageActionExecuteResponseSchema.safeParse(operation?.result);
            if (refusal.success && !refusal.data.ok) return { supported: true, result: refusal.data };
        }
        return { supported: true, result: projectMachinePluginActionExecutionResponse(terminal) };
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
 * Settled Machine reads whose answer is fixed for one version of their question: an Action
 * occurrence's schemas, or a plugin's source declarations at one Machine projection revision.
 * Concurrent readers share one request; a settled answer is kept for that version and route
 * binding (Account and credentials) and replaced when either changes. Failures are not kept.
 */
type RetainedRead = {
    version: string;
    bindingKey: string;
    scope: readonly (object | string)[];
    result?: unknown;
};
const retainedReadsByKey = new Map<string, RetainedRead>();

/** Forgets every shared in-flight projection read and retained answer. */
export function resetMachineProjectionReadsForTests(): void {
    resetAdmittedMachineRpcReadsForTests();
    retainedReadsByKey.clear();
}

/**
 * Wraps the in-flight admission with the retained answer. `retain` returns the value to keep
 * (or undefined to keep nothing); `onAnswer` receives the retained value, cached or fresh.
 */
function retainedReadAdmission(params: Readonly<{
    key: string;
    version: string;
    pending: MachineRpcReadAdmission;
    retain(value: unknown): unknown;
    onAnswer(value: unknown): void;
}>): MachineRpcReadAdmission {
    const { key, version, pending } = params;
    return {
        async run<T>(input: MachineRpcReadAdmissionInput<T>): Promise<T> {
            const incumbent = retainedReadsByKey.get(key);
            const matches = incumbent?.version === version
                && incumbent.bindingKey === input.binding.key
                && incumbent.scope.length === input.binding.scope.length
                && incumbent.scope.every((part, index) => part === input.binding.scope[index]);
            const entry: RetainedRead = matches ? incumbent : {
                version, bindingKey: input.binding.key, scope: input.binding.scope,
            };
            if (entry.result !== undefined) {
                params.onAnswer(entry.result);
                return entry.result as T;
            }
            retainedReadsByKey.set(key, entry);
            const forget = () => {
                if (retainedReadsByKey.get(key) === entry) retainedReadsByKey.delete(key);
            };
            const response = await pending.run({ ...input,
                onPhysicalAcquire: signal => {
                    const release = input.onPhysicalAcquire(signal);
                    signal.addEventListener('abort', forget, { once: true });
                    return async () => {
                        signal.removeEventListener('abort', forget);
                        if (signal.aborted) forget();
                        await release();
                    };
                },
                resolve: async (signal, onIssued) => {
                    try {
                        const value = await input.resolve(signal, onIssued);
                        input.binding.assertCurrent();
                        const retained = signal.aborted ? undefined : params.retain(value);
                        if (retained === undefined) forget();
                        else if (retainedReadsByKey.get(key) === entry) entry.result = retained;
                        return value;
                    } catch (error) { forget(); throw error; }
                },
            }) as T;
            if (entry.result !== undefined) params.onAnswer(entry.result);
            return response;
        },
    };
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
    const key = JSON.stringify(['actionSchemas',
        machineContributionRegistryProjectionScopeKey({ machineId, serverId: opts.serverId ?? null }),
        payload.qualifiedActionId,
    ]);
    const pending = projectionReadAdmission({ machineId, serverId: opts.serverId ?? null }, payload);
    let admittedResult: DaemonPluginActionSchemasReadResponse | undefined;
    try {
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId, serverId: opts.serverId, method: RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ,
            payload, operationTimeoutMs: null, signal: opts.signal,
            // An Action occurrence's declaration cannot change; a reloaded plugin is a new occurrence.
            readAdmission: retainedReadAdmission({ key, version: payload.expectedOccurrenceId, pending,
                retain: (value) => {
                    const parsed = DaemonPluginActionSchemasReadResponseSchema.safeParse(value);
                    return !parsed.success || !parsed.data.ok ? undefined : Object.freeze({
                        ...parsed.data,
                        ...(parsed.data.inputSchema === undefined ? {} : {
                            inputSchema: normalizePluginJsonSchema(parsed.data.inputSchema),
                        }),
                        ...(parsed.data.outputSchema === undefined ? {} : {
                            outputSchema: normalizePluginJsonSchema(parsed.data.outputSchema),
                        }),
                    });
                },
                onAnswer: (value) => { admittedResult = value as DaemonPluginActionSchemasReadResponse; },
            }),
        });
        // The route has admitted this exact occurrence and Account binding.
        // Re-parsing its owned answer would copy the schemas on every dispatch
        // and defeat the compiler's lifetime-bound identity memoization.
        if (admittedResult) return { supported: true, result: admittedResult };
        if (isRpcMethodNotFoundResult(response)) return { supported: false, reason: 'not-supported' };
        const parsed = DaemonPluginActionSchemasReadResponseSchema.safeParse(response);
        return parsed.success ? { supported: true, result: parsed.data } : { supported: false, reason: 'error' };
    } catch (error) {
        return { supported: false, reason: classifyMachinePluginTransportError(error) };
    }
}

/**
 * Read one declared plugin resource for a mounted plugin UI surface (§3.6).
 *
 * This is the transport for the snapshot authority; the daemon owns admission,
 * generation currentness, containment, byte bounds and integrity verification.
 */
type ResourceTransportInput<T> = T extends unknown ? Omit<T, 'machineId'> : never;

/** Built-in Resources with a semantic read Action enter through its original Account custody. */
export function projectDeclaredHostResource(binding: Parameters<typeof projectDatabaseConnectionResourceReadV1>[0]) {
    const { resource, context } = binding;
    if (binding.callerPluginId === DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId
        && resource.pluginId === binding.callerPluginId && resource.localId === DATABASE_CAPTURE_RESOURCE_REF_V1.contributionId
        && context?.kind === 'surface') {
        const demand = PluginServiceListFieldResourceInputV1Schema.safeParse(context.launchInput);
        if (demand.success) return { hostRead: 'telemetry.capture' as const, windowMs: TELEMETRY_REQUESTS_WINDOW_MS_V1,
            input: { action: parseQualifiedPluginActionId(TELEMETRY_METRICS_READ_ACTION_ID_V1)!, input: demand.data } };
    }
    return projectDatabaseConnectionResourceReadV1(binding);
}

/** Native host Resources continue through the same original-Account Action ingress. */
export type MachinePluginUiSelectedResourceInvocation = Readonly<{
    pluginInvocation: NonNullable<Parameters<typeof executeOriginalAccountMachineAction>[0]['pluginInvocation']>;
    selectedActionInput: NonNullable<NonNullable<Parameters<typeof executeOriginalAccountMachineAction>[0]['invocation']>['selectedActionInput']>;
}>;

async function invokeOriginalAccountHostResource(
    continuation: NonNullable<Parameters<typeof executeOriginalAccountMachineAction>[0]['resourceContinuation']>,
    options: Readonly<{ serverId?: string | null; accountId?: string | null; signal?: AbortSignal;
        onHostResourceFrame?: (value: unknown) => void }> & Partial<MachinePluginUiSelectedResourceInvocation>,
): Promise<unknown> {
    const { resource, machineId } = continuation.params;
    const serverId = options.serverId ?? ('serverId' in resource.input && typeof resource.input.serverId === 'string' ? resource.input.serverId : undefined);
    const account = await captureLazyActionAccountContext(serverId, options.signal);
    try {
        if (options.accountId && account.accountId !== options.accountId) return {
            ok: false, code: 'action_account_scope_changed', reason: 'unavailable',
        };
        const actionId = resolvePluginUiHostReadActionIdV1(resource.hostRead);
        const mounted = options.pluginInvocation;
        const callerBinding = mounted?.kind === 'mountedPluginSurface' ? mounted.mountedBinding : mounted?.clientActionBinding;
        const authority = mounted ? 'account_automation' as const : 'present_user' as const;
        const context: ActionExecutorContext = { surface: 'ui', authority,
            actionCaller: callerBinding ? { kind: 'plugin', pluginId: callerBinding.pluginId,
                contributionLocalId: callerBinding.contributionLocalId, occurrenceId: callerBinding.occurrenceId,
                ...(callerBinding.sourceCustody ? { sourceCustody: callerBinding.sourceCustody } : {}),
            } : { kind: 'host' },
            runtimeAccountId: account.accountId, serverId: account.serverId, serverIdentityId: account.serverIdentityId,
            actionRequestId: randomUUID(), externalActionTarget: { kind: 'machine', machineId },
            ...(options.signal ? { signal: options.signal } : {}) };
        const issue = (input: unknown, invocationContext: ActionExecutorContext, confirmed = false) => {
            const invocation = confirmed || mounted ? projectExternalActionRequesterInvocationV1({ actionId,
                context: invocationContext, account, target: { kind: 'machine', machineId } }) : null;
            if ((confirmed || mounted) && !invocation) return Promise.resolve({ ok: false as const,
                errorCode: 'admission_unavailable', error: 'admission_unavailable' });
            return executeOriginalAccountMachineAction({ account, actionId, requestId: invocationContext.actionRequestId!,
                machineId, input, authority, resourceContinuation: continuation,
                ...(mounted ? { pluginInvocation: mounted } : {}),
                ...(invocation ? { invocation: { ...invocation,
                    ...(options.selectedActionInput ? { selectedActionInput: options.selectedActionInput } : {}),
                } } : {}),
                ...(options.onHostResourceFrame ? { onHostResourceFrame: options.onHostResourceFrame } : {}),
                ...(options.signal ? { signal: options.signal } : {}) });
        };
        const originalInput = options.selectedActionInput?.input ?? resource.input;
        const first = await issue(originalInput, context);
        const result = mounted ? first : await confirmOwnUiRefusal(actionId, originalInput, context, first, async args => {
            const { createActionConfirmationPresenter } = await import('./actions/actionConfirmationPresenter');
            return createActionConfirmationPresenter(account)(args);
        }, (input, reviewDigest) => issue(input, bindPresentUserActionConfirmation(actionId, input,
            { ...context, actionRequestId: randomUUID() }, reviewDigest), true));
        return result.ok ? result.result : { ok: false, code: result.errorCode, reason: 'unavailable' };
    } finally { account.dispose(); }
}

export async function machinePluginUiResourceRead(
    machineId: string,
    opts: Readonly<ResourceTransportInput<DaemonPluginUiResourceReadRequest> & {
        serverId?: string | null;
        accountId?: string | null;
        timeoutMs?: number | null;
        signal?: AbortSignal;
    }>,
): Promise<MachinePluginUiResourceReadResult> {
    try {
        const { serverId: _server, accountId: _account, timeoutMs: _timeout, signal: _signal, ...request } = opts;
        const declared = DaemonPluginUiResourceReadRequestSchema.parse({ machineId, ...request });
        const host = 'callerPluginId' in declared && !('readAuthority' in declared.resource) && !('actionRead' in declared.resource)
            ? projectDeclaredHostResource({ expectedCallerOccurrenceId: declared.expectedCallerOccurrenceId,
                callerPluginId: declared.callerPluginId, resource: declared.resource,
                ...(declared.context === undefined ? {} : { context: declared.context }) }) : null;
        const payload = host ? { machineId, resource: host } : declared;
        const response = 'callerPluginId' in payload ? await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            ...pluginRpcOperationOptions(opts),
            method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ,
            accountId: opts.accountId,
            payload,
        }) : await invokeOriginalAccountHostResource({ method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ, params: payload }, opts);
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
    opts: Readonly<ResourceTransportInput<DaemonPluginUiResourceWatchOpenRequest> & {
        serverId?: string | null;
        accountId?: string | null;
        timeoutMs?: number | null;
        signal?: AbortSignal;
    }>,
): Promise<MachinePluginUiResourceWatchOpenResult> {
    try {
        const { serverId: _server, accountId: _account, timeoutMs: _timeout, signal: _signal, ...request } = opts;
        const declared = DaemonPluginUiResourceWatchOpenRequestSchema.parse({ machineId, ...request });
        const host = 'callerPluginId' in declared && !('readAuthority' in declared.resource) && !('actionRead' in declared.resource)
            ? projectDeclaredHostResource({ expectedCallerOccurrenceId: declared.expectedCallerOccurrenceId,
                callerPluginId: declared.callerPluginId, resource: declared.resource,
                ...(declared.context === undefined ? {} : { context: declared.context }) }) : null;
        const payload = host ? { machineId, resource: host, subscriptionId: declared.subscriptionId } : declared;
        const response = 'callerPluginId' in payload ? await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            ...pluginRpcOperationOptions(opts),
            method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN,
            accountId: opts.accountId,
            payload,
        }) : await invokeOriginalAccountHostResource({ method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN, params: payload }, opts);
        if (isRpcMethodNotFoundResult(response)) return { supported: false, reason: 'not-supported' };
        const parsed = DaemonPluginUiResourceWatchOpenResponseSchema.safeParse(response);
        return parsed.success
            ? { supported: true, result: parsed.data }
            : { supported: false, reason: 'error' };
    } catch (error) {
        return { supported: false, reason: classifyMachinePluginTransportError(error) };
    }
}

/** A native host watch uses the originating Account's Action codec for the whole observation. */
export async function machinePluginUiHostResourceFollow(
    machineId: string,
    opts: Readonly<{
        serverId?: string | null; accountId?: string | null; signal: AbortSignal;
        subscriptionId: string;
        resource: Extract<DaemonPluginUiResourceWatchOpenRequest, { resource: { hostRead: string } }>['resource'];
        onOpen: (digest: string | undefined) => void;
        onEvent: (event: Extract<DaemonPluginUiResourceWatchNextResponse, { ok: true; status: 'event' }>['event']) => void;
    }> & Partial<MachinePluginUiSelectedResourceInvocation>,
): Promise<MachinePluginUiResourceWatchOpenResult> {
    try {
        const { subscriptionId, resource } = opts;
        const response = await invokeOriginalAccountHostResource({
            method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN, params: { machineId, resource, subscriptionId },
        }, { ...opts, onHostResourceFrame(value) {
            const open = DaemonPluginUiResourceWatchOpenResponseSchema.safeParse(value);
            if (open.success && open.data.ok && open.data.subscriptionId === subscriptionId) {
                opts.onOpen(open.data.digest);
                return;
            }
            const next = DaemonPluginUiResourceWatchNextResponseSchema.safeParse(value);
            if (!next.success || !next.data.ok || next.data.status !== 'event' || next.data.event.subscriptionId !== subscriptionId) {
                throw new Error('Invalid host Resource watch frame');
            }
            opts.onEvent(next.data.event);
        } });
        const parsed = DaemonPluginUiResourceWatchOpenResponseSchema.safeParse(response);
        return parsed.success ? { supported: true, result: parsed.data } : { supported: false, reason: 'error' };
    } catch (error) {
        return { supported: false, reason: classifyMachinePluginTransportError(error) };
    }
}

export async function machinePluginUiResourceWatchNext(
    machineId: string,
    opts: Readonly<ResourceTransportInput<DaemonPluginUiResourceWatchNextRequest> & {
        serverId?: string | null;
        accountId?: string | null;
        signal?: AbortSignal;
    }>,
): Promise<MachinePluginUiResourceWatchNextResult> {
    try {
        const { serverId: _server, accountId: _account, signal: _signal, ...request } = opts;
        const payload = DaemonPluginUiResourceWatchNextRequestSchema.parse({ machineId, ...request });
        const response = 'callerPluginId' in payload ? await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            // Keep the daemon's protocol wait; caller retirement cancels the transport.
            operationTimeoutMs: null,
            signal: opts.signal,
            method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT,
            accountId: opts.accountId,
            payload,
        }) : await invokeOriginalAccountHostResource({ method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT, params: payload }, opts);
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
    opts: Readonly<ResourceTransportInput<DaemonPluginUiResourceWatchCloseRequest> & {
        serverId?: string | null;
        accountId?: string | null;
        timeoutMs?: number | null;
        signal?: AbortSignal;
    }>,
): Promise<void> {
    try {
        const { serverId: _server, accountId: _account, timeoutMs: _timeout, signal: _signal, ...request } = opts;
        const payload = DaemonPluginUiResourceWatchCloseRequestSchema.parse({ machineId, ...request });
        const response = 'callerPluginId' in payload ? await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            ...pluginRpcOperationOptions(opts),
            method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE,
            accountId: opts.accountId,
            payload,
        }) : await invokeOriginalAccountHostResource({ method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE, params: payload }, opts);
        DaemonPluginUiResourceWatchCloseResponseSchema.safeParse(response);
    } catch {
        // Local retirement stays authoritative when the daemon cleanup boundary
        // is unreachable; the daemon reclaims an unpolled subscription itself.
    }
}
