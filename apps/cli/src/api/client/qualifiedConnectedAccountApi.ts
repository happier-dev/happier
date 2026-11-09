import * as z from 'zod/mini';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from '@/api/client/credentialAxios';
import { classifyActionTransportFailure } from './classifyServerEndpointError';
import { classifyHomeDomainHttpMutationFailureV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { QualifiedProviderAccountUsageHistoryRequestV4Schema, QualifiedProviderAccountUsageHistoryResponseV4Schema, openProviderAccountUsageRecordV4 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { openSealedProviderAccountUsageSnapshot } from '@happier-dev/protocol/connect/accountUsage';
import { serializeProviderAccountUsageSnapshotMaterialV1 } from '@happier-dev/protocol/connect/account-usage-primitives';
import { mergeProviderAccountSubscription } from '@happier-dev/protocol/connect/accountSubscription';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { QualifiedConnectedAccountCredentialDeleteResponseV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type { ManagedResourceDependencyV1 } from '@happier-dev/protocol';
import type { QualifiedConnectedAccountLegacyPeerClass } from '@happier-dev/protocol/connect/connected-service-bindings';
import { QualifiedConnectedAccountConfigurationPatchV4Schema, QualifiedConnectedAccountCredentialDeleteV4Schema, QualifiedConnectedAccountCredentialHealthPatchV4Schema, QualifiedConnectedAccountCredentialErrorV4Schema, QualifiedConnectedAccountCredentialMutationSuccessV4Schema, QualifiedConnectedAccountCredentialMutationV4Schema, QualifiedConnectedAccountGroupActiveAccountV4Schema, QualifiedConnectedAccountGroupListResponseV4Schema, QualifiedConnectedAccountGroupMemberMutationV4Schema, QualifiedConnectedAccountGroupResponseV4Schema, QualifiedConnectedAccountGroupRuntimeStatePatchV4Schema, QualifiedConnectedAccountQuotaResponseV4Schema, QualifiedConnectedAccountRefreshLeaseResponseV4Schema, QualifiedConnectedAccountRefreshLeaseV4Schema, QualifiedConnectedAccountSuccessV4Schema, QualifiedConnectedServiceUsageSourceResolveV4Schema, QualifiedConnectedServiceUsageSourceResolutionV4Schema, QualifiedProviderAccountUsageRecordQueryV4Schema, QualifiedProviderAccountUsageReadErrorV4Schema, QualifiedProviderAccountUsageRecordResponseV4Schema, QualifiedProviderAccountUsageWriteSuccessV4Schema, QualifiedProviderAccountUsageWriteV4Schema, sameQualifiedConnectedAccountGroupRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { QualifiedConnectedAccountConfigurationSnapshotV4Schema, QualifiedConnectedAccountConfigurationTargetV4Schema, QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountGroupRefSchema, QualifiedConnectedAccountListResponseV4Schema, QualifiedConnectedAccountServiceRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { QualifiedConnectedAccountServiceListV4Schema, QualifiedConnectedAccountMultiServiceListResponseV4Schema, QualifiedConnectedAccountRefListV4Schema, QualifiedConnectedAccountSummaryListResponseV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { encodeQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import type { BuiltInLegacyConnectedAccountOperation, BuiltInLegacyConnectedServiceId, QualifiedConnectedAccountConfigurationTargetV4, QualifiedConnectedAccountGroupRef, QualifiedConnectedAccountRef, QualifiedConnectedAccountServiceRef, QualifiedConnectedServiceUsageSourceV4, ProviderAccountUsageRecordId } from '@happier-dev/protocol';

import { HttpStatusError, readHttpStatus } from "@/api/client/httpStatusError";
import type {
    CliServerFeaturesSnapshot,
} from "@/features/serverFeaturesClient";
import type {
    SessionSyncPendingInputServerContractResult,
} from "@/api/clientCompatibility/sessionSyncPendingInputServerContract";
import { resolveConnectedServicesServerApiTimeoutMs } from "./connectedServicesServerApiTimeout";
import { resolveServerHttpBaseUrl } from "./serverHttpBaseUrl";

function requestHeaders(token: string, requestPurpose?: QualifiedConnectedAccountReadRequestPurpose): Readonly<Record<string, string>> {
    return {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${token}`,
        ...(requestPurpose ? { 'X-Happier-Request-Purpose': requestPurpose } : {}),
    };
}

export type QualifiedProviderAccountUsageReadAuthorization = (request: Readonly<{ method: 'GET'; path: string }>) => Readonly<Record<string, string>> | null;
function providerUsageReadHeaders(params: Readonly<{ token: string; requestPurpose?: QualifiedConnectedAccountReadRequestPurpose; authorizeRequest?: QualifiedProviderAccountUsageReadAuthorization }>, path: string) {
    const requestPurpose = params.requestPurpose ?? 'connected-accounts:quota-qualification';
    if (!params.authorizeRequest) return requestHeaders(params.token, requestPurpose);
    const headers = params.authorizeRequest({ method: 'GET', path });
    if (!headers) throw new Error('provider_account_usage_request_authority_unavailable');
    return { ...headers, 'X-Happier-Request-Purpose': requestPurpose };
}

export type QualifiedConnectedAccountCompatibilityErrorCode =
    | "connected_account_service_identity_unsupported"
    | "connected_account_v4_contract_violation"
    | "connected_account_legacy_operation_unsupported"
    | "connected_account_capability_indeterminate";

export class QualifiedConnectedAccountCompatibilityError extends Error {
    readonly code: QualifiedConnectedAccountCompatibilityErrorCode;

    constructor(code: QualifiedConnectedAccountCompatibilityErrorCode) {
        super(code);
        this.name = "QualifiedConnectedAccountCompatibilityError";
        this.code = code;
    }
}

/** A malformed Home projection is a contract refusal, never payload-bearing diagnostic text. */
function parseQualifiedConnectedAccountReadResponse<T>(
    schema: Readonly<{ safeParse(value: unknown): { success: true; data: T } | { success: false } }>,
    value: unknown,
): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new QualifiedConnectedAccountCompatibilityError('connected_account_v4_contract_violation');
    return parsed.data;
}

/**
 * The exact cause the server named for a refused credential mutation.
 *
 * `/v4/connect/qualified/credential` answers 409 with a CLOSED discriminated
 * union, and each member means something different to the caller: an identity
 * or authentication-mode mismatch needs a different reconnect, and only the
 * superseded member is an ordinary CAS race.
 * Reading only the status code collapses all of them into "conflict", so the
 * discriminator is parsed here, at the boundary that still has the body.
 */
export type QualifiedConnectedAccountCredentialConflictCode =
    | ReturnType<typeof QualifiedConnectedAccountCredentialErrorV4Schema.parse>['error']
    | "connected_account_credential_conflict_response_invalid";

export class QualifiedConnectedAccountCredentialConflictError extends HttpStatusError {
    readonly status = 409;
    readonly code: QualifiedConnectedAccountCredentialConflictCode;
    readonly resources: readonly ManagedResourceDependencyV1[] | undefined;
    readonly reason?: Extract<ReturnType<typeof QualifiedConnectedAccountCredentialErrorV4Schema.parse>, { error: 'connect_credential_mutation_superseded' }>['reason'];

    constructor(code: QualifiedConnectedAccountCredentialConflictCode, resources?: readonly ManagedResourceDependencyV1[], reason?: QualifiedConnectedAccountCredentialConflictError['reason']) {
        super(409, code);
        this.name = "QualifiedConnectedAccountCredentialConflictError";
        this.code = code;
        this.resources = resources;
        this.reason = reason;
    }
}

function throwQualifiedConnectedAccountCredentialConflict(data: unknown): never {
    const parsed =
        QualifiedConnectedAccountCredentialErrorV4Schema.safeParse(data);
    throw new QualifiedConnectedAccountCredentialConflictError(
        parsed.success
            ? parsed.data.error
            : "connected_account_credential_conflict_response_invalid",
        parsed.success && parsed.data.error === 'managed_resources_review_required' ? parsed.data.resources : undefined,
        parsed.success && parsed.data.error === 'connect_credential_mutation_superseded' ? parsed.data.reason : undefined,
    );
}

export class QualifiedConnectedAccountGroupConflictError extends Error {
    readonly status = 409;
    readonly code: string;
    readonly generation: number | null;
    readonly runtimeStateRevision: number | null;

    constructor(params: Readonly<{
        code: string;
        generation?: number | null;
        runtimeStateRevision?: number | null;
    }>) {
        const message =
            params.code ===
                "connect_group_runtime_state_revision_conflict"
                ? "connected_service_auth_group_runtime_state_revision_conflict"
                : params.code === "connect_group_generation_conflict"
                    ? "connected_service_auth_group_generation_conflict"
                    : params.code;
        super(message);
        this.name = "QualifiedConnectedAccountGroupConflictError";
        this.code = params.code;
        this.generation = params.generation ?? null;
        this.runtimeStateRevision =
            params.runtimeStateRevision ?? null;
    }
}

export class QualifiedProviderAccountUsageReadConflictError extends HttpStatusError {
    readonly status = 409;
    readonly code = "provider_account_usage_storage_mode_mismatch";

    constructor() {
        super(409, "provider_account_usage_storage_mode_mismatch");
        this.name = "QualifiedProviderAccountUsageReadConflictError";
    }
}

function throwQualifiedProviderAccountUsageReadConflict(
    data: unknown,
): never {
    QualifiedProviderAccountUsageReadErrorV4Schema.parse(data);
    throw new QualifiedProviderAccountUsageReadConflictError();
}

function throwQualifiedConnectedAccountGroupConflict(
    data: unknown,
): never {
    const record =
        typeof data === "object"
        && data !== null
        && !Array.isArray(data)
            ? data as Record<string, unknown>
            : null;
    const code =
        typeof record?.error === "string"
            ? record.error
            : "connected_account_group_conflict_response_invalid";
    const generation =
        typeof record?.generation === "number"
        && Number.isInteger(record.generation)
        && record.generation >= 0
            ? record.generation
            : null;
    const runtimeStateRevision =
        typeof record?.runtimeStateRevision === "number"
        && Number.isInteger(record.runtimeStateRevision)
        && record.runtimeStateRevision >= 0
            ? record.runtimeStateRevision
            : null;
    throw new QualifiedConnectedAccountGroupConflictError({
        code,
        generation,
        runtimeStateRevision,
    });
}

export type QualifiedConnectedAccountAtomicV4Negotiation =
    | "advertised"
    | "absent"
    | "indeterminate";

export function resolveQualifiedConnectedAccountAtomicV4Negotiation(
    snapshot?: CliServerFeaturesSnapshot,
): QualifiedConnectedAccountAtomicV4Negotiation {
    if (!snapshot) return "indeterminate";
    if (snapshot.status === "ready") {
        const capability =
            snapshot.features.capabilities.connectedServices
                ?.qualifiedAccounts;
        if (!capability) return "absent";
        return capability.protocolVersion === 4
            ? "advertised"
            : "indeterminate";
    }
    if (
        snapshot.status === "unsupported"
        && snapshot.reason === "endpoint_missing"
    ) {
        return "absent";
    }
    return "indeterminate";
}

/** New DELETE fields belong only to the server's explicitly advertised operation. */
export function resolveQualifiedConnectedAccountRemovalReviewNegotiation(
    snapshot?: CliServerFeaturesSnapshot,
): QualifiedConnectedAccountAtomicV4Negotiation {
    const v4 = resolveQualifiedConnectedAccountAtomicV4Negotiation(snapshot);
    if (v4 !== "advertised") return v4;
    if (snapshot?.status !== "ready") return "indeterminate";
    const capability = snapshot.features.capabilities.connectedServices?.credentialRemovalReview;
    if (!capability) return "absent";
    return capability.protocolVersion === 1 ? "advertised" : "indeterminate";
}

function isExactLegacyUnfencedServer(
    snapshot: CliServerFeaturesSnapshot | undefined,
    serverContract:
        SessionSyncPendingInputServerContractResult | null | undefined,
): boolean {
    // `released_server_v0_2_1` names the exact supported observable contract:
    // the legacy HTTP shape plus the empty socket ping ACK on the current
    // connection epoch. Contract-equivalent historical dev builds receive no
    // operations beyond the same bounded exact-old table.
    return snapshot?.status === "ready"
        && serverContract?.mode === "released_server_v0_2_1"
        && serverContract.socket.connected === true;
}

export type QualifiedConnectedAccountPeerClass =
    | "advertised_v4"
    | QualifiedConnectedAccountLegacyPeerClass
    | "indeterminate";

export function resolveQualifiedConnectedAccountPeerClass(
    snapshot: CliServerFeaturesSnapshot | undefined,
    serverContract?:
        SessionSyncPendingInputServerContractResult | null,
): QualifiedConnectedAccountPeerClass {
    const exactLegacy =
        isExactLegacyUnfencedServer(snapshot, serverContract);
    const negotiation =
        resolveQualifiedConnectedAccountAtomicV4Negotiation(snapshot);
    if (exactLegacy && negotiation === "advertised") {
        return "indeterminate";
    }
    if (negotiation === "advertised") return "advertised_v4";
    // Retained 0.2 credential content is opened by the current V4 reader.
    // Old-server wire evidence does not authorize a scalar transport.
    return "indeterminate";
}

export type QualifiedConnectedAccountPeerOperationTransport =
    | Readonly<{ kind: "v4" }>
    | Readonly<{
        kind: "legacy";
        peerClass: QualifiedConnectedAccountLegacyPeerClass;
        serviceId: BuiltInLegacyConnectedServiceId;
    }>;

/**
 * Canonical current transport owner. Retained-content compatibility never
 * selects an older server's scalar wire protocol.
 */
export function resolveQualifiedConnectedAccountPeerOperationTransport(
    params: Readonly<{
        snapshot: CliServerFeaturesSnapshot | undefined;
        serverContract?:
            SessionSyncPendingInputServerContractResult | null;
        service: QualifiedConnectedAccountServiceRef;
        operation: BuiltInLegacyConnectedAccountOperation;
    }>,
): Readonly<{ kind: "v4" }> {
    return resolveCurrentQualifiedConnectedAccountTransport(params);
}

function resolveCurrentQualifiedConnectedAccountTransport(
    params: Readonly<{
        snapshot: CliServerFeaturesSnapshot | undefined;
        serverContract?: SessionSyncPendingInputServerContractResult | null;
        service: QualifiedConnectedAccountServiceRef;
    }>,
): Readonly<{ kind: "v4" }> {
    QualifiedConnectedAccountServiceRefSchema.parse(params.service);
    const peerClass =
        resolveQualifiedConnectedAccountPeerClass(
            params.snapshot,
            params.serverContract,
        );
    if (peerClass === "advertised_v4") return { kind: "v4" };
    throw new QualifiedConnectedAccountCompatibilityError(
        "connected_account_capability_indeterminate",
    );
}

type QualifiedConnectedAccountLegacyCapableOperationKind =
    Exclude<BuiltInLegacyConnectedAccountOperation, "account_list">;

export type QualifiedConnectedAccountNegotiatedOperation =
    | Readonly<{ kind: "account_list" }>
    | Readonly<{
        kind: QualifiedConnectedAccountLegacyCapableOperationKind;
        // Current V4 admission depends on the advertised transport, not the
        // retired scalar projection's configuration or mode-cardinality limits.
        configurationState?: "unconfigured" | "configured";
        authenticationModeCardinality?: "single" | "multiple";
    }>
    | Readonly<{
        kind:
            | "configuration_read"
            | "configuration_write"
            | "group_operation"
            | "qualified_usage_operation";
    }>;

export type QualifiedConnectedAccountOperationTransport =
    | Readonly<{ kind: "v4" }>
    | Readonly<{
        kind: "legacy";
        peerClass: QualifiedConnectedAccountLegacyPeerClass;
        serviceId: BuiltInLegacyConnectedServiceId;
    }>;

export function resolveQualifiedConnectedAccountOperationTransport(
    params: Readonly<{
        snapshot: CliServerFeaturesSnapshot | undefined;
        serverContract?:
            SessionSyncPendingInputServerContractResult | null;
        service: QualifiedConnectedAccountServiceRef;
        operation: QualifiedConnectedAccountNegotiatedOperation;
    }>,
): QualifiedConnectedAccountOperationTransport {
    return resolveCurrentQualifiedConnectedAccountTransport(params);
}

export async function executeQualifiedConnectedAccountNegotiatedOperation<
    V4Result,
>(
    params: Readonly<{
        snapshot: CliServerFeaturesSnapshot | undefined;
        serverContract?:
            SessionSyncPendingInputServerContractResult | null;
        service: QualifiedConnectedAccountServiceRef;
        operation: QualifiedConnectedAccountNegotiatedOperation;
        executeV4(): Promise<V4Result>;
    }>,
): Promise<V4Result> {
    resolveQualifiedConnectedAccountOperationTransport(params);
    try {
        return await params.executeV4();
    } catch (error) {
        const status = axios.isAxiosError(error)
            ? error.response?.status
            : undefined;
        if (status === 404 || status === 405 || status === 501) {
            throw new QualifiedConnectedAccountCompatibilityError(
                "connected_account_v4_contract_violation",
            );
        }
        throw error;
    }
}

type QualifiedConnectedAccountReadRequestPurpose =
    | 'connected-accounts:qualification'
    | 'connected-accounts:daemon-coordinator'
    | 'connected-accounts:requester-coordinator'
    | 'connected-accounts:requester-qualification'
    | 'connected-accounts:purpose-binding'
    | 'connected-accounts:startup-hydration'
    | 'connected-accounts:quota-qualification'
    | 'connected-accounts:usage-persistence'
    | 'connected-accounts:request-auth-replacement'
    | 'connected-accounts:auth-group'
    | 'connected-accounts:team-reconciliation'
    | 'connected-accounts:spawn'
    | 'connected-accounts:persistence';

type QualifiedConnectedAccountListRequest = Readonly<{
    token: string;
    signal?: AbortSignal;
    requestPurpose?: QualifiedConnectedAccountReadRequestPurpose;
}>;

export function listQualifiedConnectedAccountsV4(params: QualifiedConnectedAccountListRequest & Readonly<{
    accounts: readonly QualifiedConnectedAccountRef[];
    service?: never;
    services?: never;
}>): Promise<ReturnType<typeof QualifiedConnectedAccountSummaryListResponseV4Schema.parse>>;
export function listQualifiedConnectedAccountsV4(params: QualifiedConnectedAccountListRequest & Readonly<{
    services: readonly QualifiedConnectedAccountServiceRef[];
    service?: never;
    accounts?: never;
}>): Promise<ReturnType<typeof QualifiedConnectedAccountMultiServiceListResponseV4Schema.parse>>;
export function listQualifiedConnectedAccountsV4(params: QualifiedConnectedAccountListRequest & Readonly<{
    service: QualifiedConnectedAccountServiceRef;
    services?: never;
    accounts?: never;
}>): Promise<ReturnType<typeof QualifiedConnectedAccountListResponseV4Schema.parse>>;
export async function listQualifiedConnectedAccountsV4(params: QualifiedConnectedAccountListRequest & (
    Readonly<{ service: QualifiedConnectedAccountServiceRef; services?: never; accounts?: never }>
    | Readonly<{ services: readonly QualifiedConnectedAccountServiceRef[]; service?: never; accounts?: never }>
    | Readonly<{ accounts: readonly QualifiedConnectedAccountRef[]; service?: never; services?: never }>
)) {
    const accounts = params.accounts === undefined ? undefined : QualifiedConnectedAccountRefListV4Schema.parse(params.accounts);
    if (accounts?.length === 0) return { accounts: [] };
    const services = params.services === undefined ? undefined : QualifiedConnectedAccountServiceListV4Schema.parse(params.services);
    if (services?.length === 0) return { services, accounts: [] };
    // A scoped coordinator demand keeps the exact single-service wire contract.
    if (services?.length === 1) {
        const result = await listQualifiedConnectedAccountsV4({ token: params.token, service: services[0],
            signal: params.signal, requestPurpose: params.requestPurpose });
        return { services: [result.service], accounts: result.accounts };
    }
    const query = new URLSearchParams(accounts ? {
        accounts: encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountRefListV4Schema, accounts),
    } : services ? {
        services: encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountServiceListV4Schema, services),
    } : {
        service: encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountServiceRefSchema, params.service),
    });
    const response = await axios.get(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/accounts?${query.toString()}`,
        {
            headers: requestHeaders(params.token, params.requestPurpose ?? 'connected-accounts:qualification'),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
            ...(params.signal ? { signal: params.signal } : {}),
        },
    );
    if (response.status !== 200) {
        throw new Error(
            `Qualified Connected Account list returned ${response.status}`,
        );
    }
    if (accounts) return parseQualifiedConnectedAccountReadResponse(QualifiedConnectedAccountSummaryListResponseV4Schema, response.data);
    return services
        ? parseQualifiedConnectedAccountReadResponse(QualifiedConnectedAccountMultiServiceListResponseV4Schema, response.data)
        : parseQualifiedConnectedAccountReadResponse(QualifiedConnectedAccountListResponseV4Schema, response.data);
}

export async function listQualifiedConnectedAccountGroupsV4(
    params: Readonly<{
        token: string;
        service: QualifiedConnectedAccountServiceRef;
        signal?: AbortSignal;
    }>,
) {
    const service =
        QualifiedConnectedAccountServiceRefSchema.parse(params.service);
    const query = new URLSearchParams({
        service: encodeQualifiedConnectedAccountV4StructuredQueryValue(
            QualifiedConnectedAccountServiceRefSchema,
            service,
        ),
    });
    const response = await axios.get(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/groups?${query.toString()}`,
        {
            headers: requestHeaders(params.token),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
            ...(params.signal ? { signal: params.signal } : {}),
        },
    );
    if (response.status !== 200) {
        throw new Error(
            `Qualified Connected Account group list returned ${response.status}`,
        );
    }
    return parseQualifiedConnectedAccountReadResponse(QualifiedConnectedAccountGroupListResponseV4Schema,
        response.data,
    );
}

export async function readQualifiedConnectedAccountGroupV4(
    params: Readonly<{
        token: string;
        group: QualifiedConnectedAccountGroupRef;
        signal?: AbortSignal;
    }>,
) {
    const group = QualifiedConnectedAccountGroupRefSchema.parse(
        params.group,
    );
    const query = new URLSearchParams({
        group: encodeQualifiedConnectedAccountV4StructuredQueryValue(
            QualifiedConnectedAccountGroupRefSchema,
            group,
        ),
    });
    const response = await axios.get(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/group?${query.toString()}`,
        {
            headers: requestHeaders(params.token),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
            validateStatus: (status) => status === 200 || status === 404,
            ...(params.signal ? { signal: params.signal } : {}),
        },
    );
    if (response.status === 404) return null;
    if (response.status !== 200) {
        throw new Error(
            `Qualified Connected Account group read returned ${response.status}`,
        );
    }
    const resolvedGroup = parseQualifiedConnectedAccountReadResponse(QualifiedConnectedAccountGroupResponseV4Schema,
        response.data,
    ).group;
    if (!sameQualifiedConnectedAccountGroupRef(resolvedGroup.ref, group)) {
        throw new QualifiedConnectedAccountCompatibilityError(
            "connected_account_v4_contract_violation",
        );
    }
    return resolvedGroup;
}

export async function setQualifiedConnectedAccountGroupActiveAccountV4(
    params: Readonly<{
        token: string;
        mutation: unknown;
    }>,
) {
    const mutation =
        QualifiedConnectedAccountGroupActiveAccountV4Schema.parse(
            params.mutation,
        );
    const response = await axios.post(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/group/active-account`,
        mutation,
        {
            headers: requestHeaders(params.token),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
            validateStatus: (status) => status === 200 || status === 409,
        },
    );
    if (response.status === 409) {
        throwQualifiedConnectedAccountGroupConflict(response.data);
    }
    if (response.status !== 200) {
        throw new Error(
            `Qualified Connected Account group active-account mutation returned ${response.status}`,
        );
    }
    return QualifiedConnectedAccountGroupResponseV4Schema.parse(
        response.data,
    ).group;
}

export async function updateQualifiedConnectedAccountGroupRuntimeStateV4(
    params: Readonly<{
        token: string;
        patch: unknown;
    }>,
) {
    const patch =
        QualifiedConnectedAccountGroupRuntimeStatePatchV4Schema.parse(
            params.patch,
        );
    const response = await axios.patch(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/group/runtime-state`,
        patch,
        {
            headers: requestHeaders(params.token),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
            validateStatus: (status) => status === 200 || status === 409,
        },
    );
    if (response.status === 409) {
        throwQualifiedConnectedAccountGroupConflict(response.data);
    }
    if (response.status !== 200) {
        throw new Error(
            `Qualified Connected Account group runtime-state mutation returned ${response.status}`,
        );
    }
    return QualifiedConnectedAccountGroupResponseV4Schema.parse(
        response.data,
    ).group;
}

export async function updateQualifiedConnectedAccountGroupMemberV4(
    params: Readonly<{ token: string; mutation: unknown }>,
) {
    const mutation =
        QualifiedConnectedAccountGroupMemberMutationV4Schema.parse(
            params.mutation,
        );
    const response = await axios.patch(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/group/member`,
        mutation,
        {
            headers: requestHeaders(params.token),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
            validateStatus: (status) => status === 200 || status === 409,
        },
    );
    if (response.status === 409) {
        throwQualifiedConnectedAccountGroupConflict(response.data);
    }
    if (response.status !== 200) {
        throw new Error(
            `Qualified Connected Account group member mutation returned ${response.status}`,
        );
    }
    return QualifiedConnectedAccountGroupResponseV4Schema.parse(
        response.data,
    ).group;
}

export async function mutateQualifiedConnectedAccountCredentialV4(
    params: Readonly<{
        token: string;
        signal?: AbortSignal;
        mutation: unknown;
    }>,
) {
    const mutation =
        QualifiedConnectedAccountCredentialMutationV4Schema.parse(
            params.mutation,
        );
    const response = await axios.post(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/credential`,
        mutation,
        {
            ...(params.signal ? { signal: params.signal } : {}),
            headers: requestHeaders(params.token),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
            validateStatus: (status) => status === 200 || status === 409,
        },
    );
    if (response.status === 409) {
        throwQualifiedConnectedAccountCredentialConflict(response.data);
    }
    if (response.status !== 200) {
        throw new Error(
            `Qualified Connected Account mutation returned ${response.status}`,
        );
    }
    return QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse(
        response.data,
    );
}

export async function readQualifiedConnectedAccountCredentialV4(
    params: Readonly<{
        token: string;
        ref: QualifiedConnectedAccountRef;
        requestPurpose?: QualifiedConnectedAccountReadRequestPurpose;
        signal?: AbortSignal;
    }>,
) {
    const ref = QualifiedConnectedAccountRefSchema.parse(params.ref);
    const query = new URLSearchParams({
        ref: encodeQualifiedConnectedAccountV4StructuredQueryValue(
            QualifiedConnectedAccountRefSchema,
            ref,
        ),
    });
    const response = await axios.get(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/credential?${query.toString()}`,
        {
            headers: requestHeaders(params.token, params.requestPurpose ?? 'connected-accounts:qualification'),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
            validateStatus: (status) => status === 200 || status === 404,
            ...(params.signal ? { signal: params.signal } : {}),
        },
    );
    if (response.status === 404) return null;
    if (response.status !== 200) {
        throw new Error(
            `Qualified Connected Account credential read returned ${response.status}`,
        );
    }
    return parseQualifiedConnectedAccountReadResponse(QualifiedConnectedAccountCredentialSnapshotV4Schema,
        response.data,
    );
}

export async function readQualifiedConnectedAccountConfigurationV4(
    params: Readonly<{
        token: string;
        target: QualifiedConnectedAccountConfigurationTargetV4;
        requestPurpose?: QualifiedConnectedAccountReadRequestPurpose;
        signal?: AbortSignal;
    }>,
) {
    const target =
        QualifiedConnectedAccountConfigurationTargetV4Schema.parse(
            params.target,
        );
    const query = new URLSearchParams({
        target: encodeQualifiedConnectedAccountV4StructuredQueryValue(
            QualifiedConnectedAccountConfigurationTargetV4Schema,
            target,
        ),
    });
    const response = await axios.get(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/configuration?${query.toString()}`,
        {
            headers: requestHeaders(params.token, params.requestPurpose ?? 'connected-accounts:qualification'),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
            validateStatus: (status) => status === 200 || status === 404,
            ...(params.signal ? { signal: params.signal } : {}),
        },
    );
    if (response.status === 404) return null;
    if (response.status !== 200) {
        throw new Error(
            `Qualified Connected Account configuration read returned ${response.status}`,
        );
    }
    return parseQualifiedConnectedAccountReadResponse(QualifiedConnectedAccountConfigurationSnapshotV4Schema,
        response.data,
    );
}

export async function mutateQualifiedConnectedAccountConfigurationV4(
    params: Readonly<{
        token: string;
        patch: unknown;
    }>,
) {
    const patch =
        QualifiedConnectedAccountConfigurationPatchV4Schema.parse(
            params.patch,
        );
    const response = await axios.patch(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/configuration`,
        patch,
        {
            headers: requestHeaders(params.token),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
    );
    if (response.status !== 200) {
        throw new Error(
            `Qualified Connected Account configuration mutation returned ${response.status}`,
        );
    }
    return QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse(
        response.data,
    );
}

export async function mutateQualifiedConnectedAccountCredentialHealthV4(
    params: Readonly<{
        token: string;
        signal?: AbortSignal;
        patch: unknown;
    }>,
) {
    const patch =
        QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse(
            params.patch,
        );
    const response = await axios.patch(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/credential/health`,
        patch,
        {
            ...(params.signal ? { signal: params.signal } : {}),
            headers: requestHeaders(params.token),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
    );
    if (response.status !== 200) {
        throw new Error(
            `Qualified Connected Account health mutation returned ${response.status}`,
        );
    }
    return QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse(
        response.data,
    );
}

export async function deleteQualifiedConnectedAccountCredentialV4(
    params: Readonly<{
        token: string;
        deletion: unknown;
    }>,
) {
    const deletion =
        QualifiedConnectedAccountCredentialDeleteV4Schema.parse(
            params.deletion,
        );
    const query = new URLSearchParams({
        ref: encodeQualifiedConnectedAccountV4StructuredQueryValue(
            QualifiedConnectedAccountRefSchema,
            deletion.ref,
        ),
        expectedCredentialRevision:
            deletion.expectedCredentialRevision,
        cleanupGroupReferences:
            String(deletion.cleanupGroupReferences),
    });
    if (deletion.reviewOnly !== undefined) query.set('reviewOnly', String(deletion.reviewOnly));
    if (deletion.emergencyRevoke !== undefined) query.set('emergencyRevoke', String(deletion.emergencyRevoke));
    if (deletion.managedResourceDispositions !== undefined) query.set('managedResourceDispositions', encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountCredentialDeleteV4Schema.shape.managedResourceDispositions._zod.def.innerType, deletion.managedResourceDispositions));
    const response = await axios.delete(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/credential?${query.toString()}`,
        {
            headers: requestHeaders(params.token),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
            validateStatus: status => status === 200 || status === 409,
        },
    ).catch((cause: unknown) => {
        const status = readHttpStatus(cause);
        const response = cause && typeof cause === 'object' && 'response' in cause ? cause.response : null;
        const data = response && typeof response === 'object' && 'data' in response ? response.data : null;
        if (status === 503 && data && typeof data === 'object' && 'error' in data
            && data.error === 'database_transaction_conflict_exhausted') {
            throw Object.assign(new Error('Connected Account deletion rolled back'), { code: data.error, cause });
        }
        // Review is read-only; only the effectful DELETE can lose a committed acknowledgement.
        if (deletion.reviewOnly || status !== null && status < 500) throw cause;
        throw Object.assign(new Error('Connected Account deletion transport failed'), {
            code: classifyHomeDomainHttpMutationFailureV1({ error: cause, issued: true, aborted: false }), cause,
        });
    });
    if (response.status === 409) throwQualifiedConnectedAccountCredentialConflict(response.data);
    if (response.status !== 200) {
        throw new Error(
            `Qualified Connected Account credential delete returned ${response.status}`,
        );
    }
    const result = QualifiedConnectedAccountCredentialDeleteResponseV4Schema.parse(response.data);
    if (deletion.reviewOnly ? !('status' in result) : !('success' in result)) throw new QualifiedConnectedAccountCompatibilityError('connected_account_v4_contract_violation');
    return result;
}

export async function acquireQualifiedConnectedAccountRefreshLeaseV4(
    params: Readonly<{
        token: string;
        signal?: AbortSignal;
        lease: unknown;
    }>,
) {
    const lease =
        QualifiedConnectedAccountRefreshLeaseV4Schema.parse(params.lease);
    const response = await axios.post(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/credential/refresh-lease`,
        lease,
        {
            ...(params.signal ? { signal: params.signal } : {}),
            headers: requestHeaders(params.token),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
    );
    if (response.status !== 200) {
        throw new Error(
            `Qualified Connected Account refresh lease returned ${response.status}`,
        );
    }
    return QualifiedConnectedAccountRefreshLeaseResponseV4Schema.parse(
        response.data,
    );
}

function qualifiedRefQuery(ref: QualifiedConnectedAccountRef): string {
    return new URLSearchParams({
        ref: encodeQualifiedConnectedAccountV4StructuredQueryValue(
            QualifiedConnectedAccountRefSchema,
            ref,
        ),
    }).toString();
}

export async function readQualifiedConnectedAccountQuotaV4(
    params: Readonly<{
        token: string;
        ref: QualifiedConnectedAccountRef;
        requestPurpose?: QualifiedConnectedAccountReadRequestPurpose;
        signal?: AbortSignal;
    }>,
) {
    const ref = QualifiedConnectedAccountRefSchema.parse(params.ref);
    const response = await axios.get(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/quotas?${qualifiedRefQuery(ref)}`,
        {
            headers: requestHeaders(params.token, params.requestPurpose ?? 'connected-accounts:quota-qualification'),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
            validateStatus: (status) =>
                status === 200 || status === 404 || status === 409,
            ...(params.signal ? { signal: params.signal } : {}),
        },
    );
    if (response.status === 404) return null;
    if (response.status === 409) {
        return throwQualifiedProviderAccountUsageReadConflict(response.data);
    }
    if (response.status !== 200) {
        throw new Error(
            `Qualified Connected Account quota read returned ${response.status}`,
        );
    }
    return QualifiedConnectedAccountQuotaResponseV4Schema.parse(
        response.data,
    );
}

export async function unlinkQualifiedConnectedAccountQuotaV4(
    params: Readonly<{
        token: string;
        ref: QualifiedConnectedAccountRef;
    }>,
) {
    const ref = QualifiedConnectedAccountRefSchema.parse(params.ref);
    const response = await axios.delete(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/quotas?${qualifiedRefQuery(ref)}`,
        {
            headers: requestHeaders(params.token),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
            validateStatus: (status) => status === 200 || status === 409,
        },
    );
    if (response.status === 409) {
        return throwQualifiedProviderAccountUsageReadConflict(response.data);
    }
    if (response.status !== 200) {
        throw new Error(
            `Qualified Connected Account quota unlink returned ${response.status}`,
        );
    }
    return QualifiedConnectedAccountSuccessV4Schema.parse(response.data);
}

export async function requestQualifiedConnectedAccountQuotaRefreshV4(
    params: Readonly<{
        token: string;
        ref: QualifiedConnectedAccountRef;
    }>,
) {
    const ref = QualifiedConnectedAccountRefSchema.parse(params.ref);
    const response = await axios.post(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/quotas/refresh`,
        { ref },
        {
            headers: requestHeaders(params.token),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
            validateStatus: (status) => status === 200 || status === 409,
        },
    );
    if (response.status === 409) {
        return throwQualifiedProviderAccountUsageReadConflict(response.data);
    }
    if (response.status !== 200) {
        throw new Error(
            `Qualified Connected Account quota refresh returned ${response.status}`,
        );
    }
    return QualifiedConnectedAccountSuccessV4Schema.parse(response.data);
}

export async function writeQualifiedProviderAccountUsageV4(
    params: Readonly<{
        token: string;
        write: unknown;
        signal?: AbortSignal;
        /** Local opening material only; never part of the HTTP write. */
        material?: AccountScopedCryptoMaterial;
    }>,
) {
    const write = QualifiedProviderAccountUsageWriteV4Schema.parse(
        params.write,
    );
    params.signal?.throwIfAborted();
    const response = await axios.post(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/provider-account-usage`,
        write,
        {
            headers: requestHeaders(params.token),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
            ...(params.signal ? { signal: params.signal } : {}),
        },
    ).catch(async (error: unknown) => {
        params.signal?.throwIfAborted();
        const response = error && typeof error === 'object' && 'response' in error ? error.response : null;
        const data = response && typeof response === 'object' && 'data' in response ? response.data : null;
        const conflictExhausted = readHttpStatus(error) === 503
            && data && typeof data === 'object' && 'error' in data && data.error === 'database_transaction_conflict_exhausted';
        const acknowledgementLost = classifyActionTransportFailure(error, {
            mutation: true, requestIssued: true, cancelled: false,
        }) === 'outcome_unknown';
        if (!conflictExhausted && !acknowledgementLost) throw error;
        // All daemon producers share this writer. Re-read after confirmed
        // rollback exhaustion or a lost acknowledgement, under the same Home.
        // A failed reconciliation must preserve the original write failure.
        const record = await readQualifiedProviderAccountUsageRecordV4({ token: params.token, recordId: write.recordId,
            requestPurpose: 'connected-accounts:usage-persistence', signal: params.signal }).catch(error => {
                params.signal?.throwIfAborted();
                return null;
            });
        params.signal?.throwIfAborted();
        if (!record || !record.sources.some(source => JSON.stringify(source) === JSON.stringify(write.source))) throw error;
        const snapshot = write.snapshot ?? (write.sealedPayload && params.material
            ? openSealedProviderAccountUsageSnapshot({ material: params.material, sealed: write.sealedPayload }) : null);
        if (!snapshot) throw error;
        const current = openProviderAccountUsageRecordV4({ recordId: write.recordId, record,
            accountMode: write.payloadMode === 'plain_json_v1' ? 'plain' : 'e2ee', material: params.material });
        if (!current || record.metadata.status !== write.status || current.fetchedAtMs < (write.fetchedAt ?? snapshot.fetchedAtMs)
            || serializeProviderAccountUsageSnapshotMaterialV1(current) !== serializeProviderAccountUsageSnapshotMaterialV1(snapshot)
            || JSON.stringify(mergeProviderAccountSubscription(current.subscription, snapshot.subscription)) !== JSON.stringify(current.subscription)) throw error;
        return { status: 200, data: { success: true, source: { status: 'linked' } } };
    });
    if (response.status !== 200) {
        throw new Error(
            `Qualified provider-account usage write returned ${response.status}`,
        );
    }
    return QualifiedProviderAccountUsageWriteSuccessV4Schema.parse(
        response.data,
    );
}

export async function resolveQualifiedProviderAccountUsageSourceV4(
    params: Readonly<{
        token: string;
        source: QualifiedConnectedServiceUsageSourceV4;
        requestPurpose?: QualifiedConnectedAccountReadRequestPurpose;
        authorizeRequest?: QualifiedProviderAccountUsageReadAuthorization;
        signal?: AbortSignal;
    }>,
) {
    const source = QualifiedConnectedServiceUsageSourceResolveV4Schema.parse(
        params.source,
    );
    const query = new URLSearchParams({
        source: encodeQualifiedConnectedAccountV4StructuredQueryValue(
            QualifiedConnectedServiceUsageSourceResolveV4Schema,
            source,
        ),
    });
    const response = await axios.get(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/provider-account-usage/sources/resolve?${query.toString()}`,
        {
            headers: providerUsageReadHeaders(params, `/v4/connect/qualified/provider-account-usage/sources/resolve?${query.toString()}`),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
            validateStatus: (status) => status === 200 || status === 404,
            ...(params.signal ? { signal: params.signal } : {}),
        },
    );
    if (response.status === 404) return null;
    if (response.status !== 200) {
        throw new Error(
            `Qualified provider-account usage source resolution returned ${response.status}`,
        );
    }
    return QualifiedConnectedServiceUsageSourceResolutionV4Schema.parse(
        response.data,
    );
}

export async function readQualifiedProviderAccountUsageRecordV4(
    params: Readonly<{
        token: string;
        recordId: ProviderAccountUsageRecordId;
        requestPurpose?: QualifiedConnectedAccountReadRequestPurpose;
        authorizeRequest?: QualifiedProviderAccountUsageReadAuthorization;
        signal?: AbortSignal;
    }>,
) {
    const query = QualifiedProviderAccountUsageRecordQueryV4Schema.parse({
        recordId: params.recordId,
    });
    const response = await axios.get(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/provider-account-usage/record?${new URLSearchParams(query).toString()}`,
        {
            headers: providerUsageReadHeaders(params, `/v4/connect/qualified/provider-account-usage/record?${new URLSearchParams(query).toString()}`),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
            validateStatus: (status) =>
                status === 200 || status === 404 || status === 409,
            ...(params.signal ? { signal: params.signal } : {}),
        },
    );
    if (response.status === 404) return null;
    if (response.status === 409) {
        QualifiedProviderAccountUsageReadErrorV4Schema.parse(response.data);
        throw new QualifiedProviderAccountUsageReadConflictError();
    }
    if (response.status !== 200) {
        throw new Error(
            `Qualified provider-account usage record read returned ${response.status}`,
        );
    }
    return QualifiedProviderAccountUsageRecordResponseV4Schema.parse(
        response.data,
    );
}

export async function readQualifiedProviderAccountUsageHistoryV4(params: Readonly<{ token: string; query: ReturnType<typeof QualifiedProviderAccountUsageHistoryRequestV4Schema.parse>; signal?: AbortSignal; requestPurpose?: QualifiedConnectedAccountReadRequestPurpose; authorizeRequest?: QualifiedProviderAccountUsageReadAuthorization }>) {
    const query = QualifiedProviderAccountUsageHistoryRequestV4Schema.parse(params.query);
    const path = `/v4/connect/qualified/provider-account-usage/history?${new URLSearchParams({ query: encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema, query) }).toString()}`;
    const response = await axios.get(`${resolveServerHttpBaseUrl()}${path}`, { headers: providerUsageReadHeaders(params, path), timeout: resolveConnectedServicesServerApiTimeoutMs(), validateStatus: status => status === 200 || status === 404 || status === 409, ...(params.signal ? { signal: params.signal } : {}) });
    if (response.status === 404) return null;
    if (response.status === 409) throwQualifiedProviderAccountUsageReadConflict(response.data);
    if (response.status !== 200) throw new Error(`Qualified provider-account usage history read returned ${response.status}`);
    return QualifiedProviderAccountUsageHistoryResponseV4Schema.parse(response.data);
}

export async function requestQualifiedProviderAccountUsageRefreshV4(
    params: Readonly<{
        token: string;
        recordId: ProviderAccountUsageRecordId;
    }>,
) {
    const body = QualifiedProviderAccountUsageRecordQueryV4Schema.parse({
        recordId: params.recordId,
    });
    const response = await axios.post(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/provider-account-usage/record/refresh`,
        body,
        {
            headers: requestHeaders(params.token),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
            validateStatus: (status) =>
                status === 200 || status === 404 || status === 409,
        },
    );
    if (response.status === 404) return null;
    if (response.status === 409) {
        return throwQualifiedProviderAccountUsageReadConflict(response.data);
    }
    if (response.status !== 200) {
        throw new Error(
            `Qualified provider-account usage refresh returned ${response.status}`,
        );
    }
    return QualifiedConnectedAccountSuccessV4Schema.parse(response.data);
}
