import { DaemonContributionRegistryProjectionDescribeRequestSchema, DaemonPluginUiTargetedContributionsReadRequestSchema, DaemonPluginSettingsGetRequestSchema, DaemonPluginSettingsGetResponseSchema, DaemonPluginSettingsSetRequestSchema, DaemonPluginSettingsSetResponseSchema, DaemonPluginSecretStatusRequestSchema, DaemonPluginSecretStatusResponseSchema, DaemonPluginSecretSetRequestSchema, DaemonPluginSecretSetResponseSchema, DaemonPluginSecretDeleteRequestSchema, DaemonPluginSecretDeleteResponseSchema, DaemonPluginStructuredMessageActionExecuteResponseSchema, DaemonPluginActionFormConnectedAccountOptionsResolveRequestSchema, DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema, DaemonPluginActionSchemasReadRequestSchema, DaemonPluginActionSchemasReadResponseSchema, DaemonPluginUiResourceReadRequestSchema, DaemonPluginUiResourceReadResponseSchema, DaemonPluginUiResourceWatchOpenRequestSchema, DaemonPluginUiResourceWatchOpenResponseSchema, DaemonPluginUiResourceWatchNextRequestSchema, DaemonPluginUiResourceWatchNextResponseSchema, DaemonPluginUiResourceWatchCloseRequestSchema, DaemonPluginUiResourceWatchCloseResponseSchema, type DaemonPluginSettingsSnapshot, type DaemonPluginSettingsMutation, type DaemonPluginSettingsSetResponse, type DaemonPluginSecretStatusResponse, type DaemonPluginSecretSetResponse, type DaemonPluginSecretDeleteResponse, type DaemonPluginStructuredMessageActionExecuteResponse, type DaemonPluginActionFormConnectedAccountOptionsResolveRequest, type DaemonPluginActionFormConnectedAccountOptionsResolveResponse, type DaemonPluginActionSchemasReadRequest, type DaemonPluginActionSchemasReadResponse, type DaemonPluginUiResourceReadRequest, type DaemonPluginUiResourceReadResponse, type DaemonPluginUiResourceWatchOpenRequest, type DaemonPluginUiResourceWatchOpenResponse, type DaemonPluginUiResourceWatchNextRequest, type DaemonPluginUiResourceWatchNextResponse, type DaemonPluginUiResourceWatchCloseRequest, type DaemonContributionRegistryProjectionAutomationEligibleEventsV1, type DaemonPluginUiComposerSurfaceCatalogEntryV1, type DaemonPluginUiTargetedSurfaceMountV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { DaemonPluginStructuredMessageActionExecuteRequestSchema, type DaemonPluginStructuredMessageActionExecuteRequest } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import type { PluginActionInvocationSurfaceV2 } from '@happier-dev/plugin-sdk/actions';
import type { PluginUiTargetedContributionsV1 } from '@happier-dev/protocol/plugins/ui';
import type { DaemonPluginTargetedSourceDeclarationV1, DaemonPluginUiResourceDeclarationsByPluginIdV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { preparePluginContributionPointDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/targeted';
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
import { DaemonContributionRegistryProjectionSectionsResponseSchema, reassembleDaemonProjectionSections,
    DaemonProjectionDeferredSectionsResponseSchema, demandedDaemonProjectionSections,
    DAEMON_PROJECTION_SECTION_FRAME_BYTES, DAEMON_PROJECTION_SECTION_STALE_CODE,
    type DaemonProjectionDeferredSectionsResponse } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { createMachineRpcReadAdmission, resetAdmittedMachineRpcReadsForTests, type MachineRpcReadAdmission, type MachineRpcReadAdmissionInput } from '@/sync/runtime/orchestration/serverScopedRpc/machineRpcReadAdmission';
import {
    isRpcMethodNotAvailableError,
    isRpcMethodNotFoundError,
    readRpcErrorCode,
    RpcError,
} from '@/sync/runtime/rpcErrors';
import {
    parseDaemonContributionRegistryProjectionDescribeResponse,
    parseDaemonPluginUiTargetedContributionsReadResponse,
    type DaemonContributionRegistryProjection,
    type DaemonContributionRegistryProjectionDescribeParsedResponse,
} from '@/sync/api/daemon/daemonContributionRegistryProjectionProtocol';
import { buildProjectionDescribeRequest, readProjectionClientContext, type ProjectionDescribeSelection } from './machineProjectionRequest';
import { InvalidDaemonProjectionSection, readDeferredProjection, type DeferredDaemonProjection, type DaemonProjectionSectionCache } from './machineProjectionSections';
export type { DeferredDaemonProjection, DaemonProjectionSectionCache } from './machineProjectionSections';
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
 * - transport, access, authentication, update and encryption failures retain
 *   their stable RPC category, without exposing the error's message or data;
 * - `request-failed` / `transport-error`: local request preparation failed,
 *   or the RPC failed without a more specific stable category;
 * - `error`: a less-specific failure from a targeted read or projection cache.
 */
export type MachineContributionRegistryProjectionFailureReason =
    | MachinePluginTransportReason
    | 'invalid-response'
    | 'projection-stale'
    | 'request-failed'
    | 'transport-error'
    | 'transport-unavailable'
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
    }>
    | Readonly<{ supported: false; reason: MachineContributionRegistryProjectionFailureReason }>
) & Readonly<{ /** Content-free branch name, including when a legacy full read recovered. */
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
    | Readonly<{ supported: true; sourceDeclarations: readonly DaemonPluginTargetedSourceDeclarationV1[] }>
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
    const code = readRpcErrorCode(error) ?? (error && typeof error === 'object'
        ? (error as Readonly<{ code?: unknown }>).code
        : undefined);
    if (code === 'MACHINE_RPC_ABORTED' || code === 'SOCKET_RPC_ABORTED') return 'aborted';
    if (code === 'MACHINE_RPC_TIMEOUT') return 'timeout';
    return 'error';
}

/** Projection reads expose recovery categories, never arbitrary peer codes or prose. */
function classifyMachineProjectionReadError(error: unknown): MachineContributionRegistryProjectionFailureReason {
    switch (readRpcErrorCode(error)) {
        case DAEMON_PROJECTION_SECTION_STALE_CODE:
            return 'projection-stale';
        case RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE:
        case RPC_ERROR_CODES.OUTCOME_UNKNOWN:
            // This is a read: losing its reply means no current projection is
            // available, not that the Machine is offline or lacks integrations.
            return 'transport-unavailable';
        case RPC_ERROR_CODES.FORBIDDEN:
            return 'access-denied';
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
        sections?: readonly string[];
        deferredProjection?: DeferredDaemonProjection;
        /** Current manifest, fresh authority already established; hydrate new demand only. */
        reuseManifest?: boolean;
        /** Captured by the loader before a cold Home inventory may be awaited. */
        locale?: string;
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
    let hydrationRejection: DaemonProjectionHydrationRejection | undefined;
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
                // while fallback, fresh demand or stale recovery starts.
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
                        signal: abort.signal,
                        read: (digest, offset, candidates) => {
                            const includeDigests: string[] = [];
                            const request = () => ({ ...payload, sectionRead: { digest, offset, includeDigests }, deferredSections: true as const,
                                ...(manifest.sectionFrameVersion === 2 ? { sectionFrameVersion: 2 as const } : {}) });
                            for (const candidate of candidates) {
                                includeDigests.push(candidate);
                                if (new TextEncoder().encode(JSON.stringify(request())).length > DAEMON_PROJECTION_SECTION_FRAME_BYTES) {
                                    includeDigests.pop(); break;
                                }
                            }
                            return invoke(DaemonContributionRegistryProjectionDescribeRequestSchema.parse(request()), abort.signal);
                        },
                    });
                } catch (error) {
                    cancel();
                    throw error;
                } finally {
                    opts?.signal?.removeEventListener('abort', cancel);
                }
            };
            const fullDescribe = async (deferredHydrationRejection: DaemonProjectionHydrationRejection): Promise<MachineContributionRegistryProjectionDescribeResult> => {
                hydrationRejection = deferredHydrationRejection;
                // One compatibility read, never recursive negotiation or a retry.
                // No held digest: even an unchanged reply cannot answer this read.
                const request = payload;
                if (request.selection !== undefined) return { supported: false, reason: 'invalid-response', deferredHydrationRejection };
                const { deferredSections: _deferred, sectionRead: _read, sectionFrameVersion: _version,
                    supportedSectionFrameVersions: _versions, knownProjectionDigest: _digest,
                    knownSectionDigests: _sections, ...fullRequest } = request;
                const parsed = parseDaemonContributionRegistryProjectionDescribeResponse(await invoke(fullRequest));
                return parsed ? { supported: true, ...parsed, deferredHydrationRejection }
                    : { supported: false, reason: 'invalid-response', deferredHydrationRejection };
            };
            const hydrateResult = async (initialManifest: DaemonProjectionDeferredSectionsResponse): Promise<MachineContributionRegistryProjectionDescribeResult> => {
                let manifest = initialManifest;
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
                        if (manifest.sectionFrameVersion === undefined) return await fullDescribe(error.reason);
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
                if (opts.deferredProjection && demandedDaemonProjectionSections(opts.deferredProjection.manifest, opts.sections)
                    .some(id => !opts.deferredProjection!.loadedSections.includes(id))) {
                    return await hydrateResult(opts.deferredProjection.manifest);
                }
                return { supported: true, ...opts.knownProjection,
                    ...(opts.deferredProjection ? { deferredProjection: opts.deferredProjection } : {}), unchanged: true };
            }
            if (response && typeof response === 'object' && 'deferredSections' in response) {
                if (opts?.selection) return { supported: false, reason: 'invalid-response' };
                const manifest = DaemonProjectionDeferredSectionsResponseSchema.safeParse(response);
                if (!manifest.success) return await fullDescribe('manifest-admission');
                return await hydrateResult(manifest.data);
            }
            let completeResponse = response;
            let sectionBodies: ReadonlyMap<string, readonly string[]> | undefined;
            if (response && typeof response === 'object' && 'sectioned' in response) {
                const held = opts?.sectionCache?.bodies ?? opts?.sectionBodies;
                if (opts?.selection || !held) return { supported: false, reason: 'invalid-response' };
                const framed = DaemonContributionRegistryProjectionSectionsResponseSchema.safeParse(response);
                if (!framed.success) return { supported: false, reason: 'invalid-response' };
                const assembled = reassembleDaemonProjectionSections(framed.data, held);
                if (!assembled) return { supported: false, reason: 'invalid-response' };
                completeResponse = assembled.response;
                sectionBodies = assembled.bodies;
            }
            const parsed = parseDaemonContributionRegistryProjectionDescribeResponse(completeResponse);
            if (!parsed) return { supported: false, reason: 'invalid-response' };
            return {
                supported: true,
                ...(sectionBodies ? { sectionBodies } : {}),
                projection: parsed.projection,
                ...(parsed.projectionDigest === undefined ? {} : { projectionDigest: parsed.projectionDigest }),
                ...(parsed.composerSurfaceCatalog === undefined
                    ? {}
                    : { composerSurfaceCatalog: parsed.composerSurfaceCatalog }),
                ...(parsed.automationEligibleEvents === undefined
                    ? {}
                    : { automationEligibleEvents: parsed.automationEligibleEvents }),
            };
        } catch (error) {
            const diagnostic = hydrationRejection ? { deferredHydrationRejection: hydrationRejection } : {};
            if (isRpcMethodNotFoundError(error) || isRpcMethodNotAvailableError(error)) {
                return { supported: false, reason: 'not-supported', ...diagnostic };
            }
            return { supported: false, reason: classifyMachineProjectionReadError(error), ...diagnostic };
        }
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
                readAdmission: projectionReadAdmission(scope, payload),
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
                if (parsed.status !== 'sourceDeclarations' || parsed.pluginId !== payload.pluginId) {
                    return { supported: false, reason: 'invalid-response' };
                }
                return { supported: true, sourceDeclarations: parsed.sourceDeclarations.map(row => ({ ...row,
                    manifest: { ...row.manifest,
                        contributes: preparePluginContributionPointDeclarationsV1(row.manifest.contributes) },
                })) };
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
            ...(opts.resolveClientMessageContext ? { resolveClientMessageContext: true } : {}),
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
type ActionSchemaRead = {
    occurrenceId: string;
    bindingKey: string;
    scope: readonly (object | string)[];
    result?: DaemonPluginActionSchemasReadResponse;
};
const actionSchemaReadsByKey = new Map<string, ActionSchemaRead>();

/** Forgets every shared in-flight projection read and memoised Action schema. */
export function resetMachineProjectionReadsForTests(): void {
    resetAdmittedMachineRpcReadsForTests();
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
    const pending = projectionReadAdmission({ machineId, serverId: opts.serverId ?? null }, payload);
    try {
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId, serverId: opts.serverId, method: RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ,
            payload, operationTimeoutMs: null, signal: opts.signal,
            readAdmission: {
                async run<T>(input: MachineRpcReadAdmissionInput<T>): Promise<T> {
                    const incumbent = actionSchemaReadsByKey.get(key);
                    const matches = incumbent?.occurrenceId === payload.expectedOccurrenceId
                        && incumbent.bindingKey === input.binding.key
                        && incumbent.scope.length === input.binding.scope.length
                        && incumbent.scope.every((part, index) => part === input.binding.scope[index]);
                    const entry: ActionSchemaRead = matches ? incumbent : {
                        occurrenceId: payload.expectedOccurrenceId, bindingKey: input.binding.key, scope: input.binding.scope,
                    };
                    if (entry.result) return entry.result as T;
                    actionSchemaReadsByKey.set(key, entry);
                    const forget = () => {
                        if (actionSchemaReadsByKey.get(key) === entry) actionSchemaReadsByKey.delete(key);
                    };
                    return await pending.run({ ...input,
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
                                const parsed = DaemonPluginActionSchemasReadResponseSchema.safeParse(value);
                                input.binding.assertCurrent();
                                if (!parsed.success || !parsed.data.ok || signal.aborted) forget();
                                else if (actionSchemaReadsByKey.get(key) === entry) entry.result = parsed.data;
                                return value;
                            } catch (error) { forget(); throw error; }
                        },
                    }) as T;
                },
            },
        });
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
