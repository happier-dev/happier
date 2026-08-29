import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from "axios";
import {
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    QualifiedConnectedAccountConfigurationPatchV4Schema,
    QualifiedConnectedAccountConfigurationSnapshotV4Schema,
    QualifiedConnectedAccountConfigurationTargetV4Schema,
    QualifiedConnectedAccountCredentialSnapshotV4Schema,
    QualifiedConnectedAccountCredentialDeleteV4Schema,
    QualifiedConnectedAccountCredentialHealthPatchV4Schema,
    QualifiedConnectedAccountCredentialErrorV4Schema,
    QualifiedConnectedAccountCredentialMutationSuccessV4Schema,
    QualifiedConnectedAccountCredentialMutationV4Schema,
    QualifiedConnectedAccountGroupActiveAccountV4Schema,
    QualifiedConnectedAccountGroupRefSchema,
    QualifiedConnectedAccountGroupListResponseV4Schema,
    QualifiedConnectedAccountGroupResponseV4Schema,
    QualifiedConnectedAccountGroupRuntimeStatePatchV4Schema,
    QualifiedConnectedAccountListResponseV4Schema,
    QualifiedConnectedAccountQuotaResponseV4Schema,
    QualifiedConnectedAccountRefSchema,
    QualifiedConnectedAccountRefreshLeaseResponseV4Schema,
    QualifiedConnectedAccountRefreshLeaseV4Schema,
    QualifiedConnectedAccountServiceRefSchema,
    QualifiedConnectedAccountSuccessV4Schema,
    QualifiedConnectedServiceUsageSourceResolveV4Schema,
    QualifiedConnectedServiceUsageSourceResolutionV4Schema,
    QualifiedProviderAccountUsageRecordQueryV4Schema,
    QualifiedProviderAccountUsageReadErrorV4Schema,
    QualifiedProviderAccountUsageRecordResponseV4Schema,
    QualifiedProviderAccountUsageWriteSuccessV4Schema,
    QualifiedProviderAccountUsageWriteV4Schema,
    encodeQualifiedConnectedAccountV4StructuredQueryValue,
    sameQualifiedConnectedAccountGroupRef,
    type BuiltInLegacyConnectedAccountOperation,
    type BuiltInLegacyConnectedServiceId,
    type QualifiedConnectedAccountConfigurationTargetV4,
    type QualifiedConnectedAccountGroupRef,
    type QualifiedConnectedAccountRef,
    type QualifiedConnectedAccountServiceRef,
    type QualifiedConnectedServiceUsageSourceV4,
    type ProviderAccountUsageRecordId,
} from "@happier-dev/protocol";

import { HttpStatusError } from "@/api/client/httpStatusError";
import type {
    CliServerFeaturesSnapshot,
} from "@/features/serverFeaturesClient";
import type {
    SessionSyncPendingInputServerContractResult,
} from "@/api/clientCompatibility/sessionSyncPendingInputServerContract";
import { resolveConnectedServicesServerApiTimeoutMs } from "./connectedServicesServerApiTimeout";
import { resolveServerHttpBaseUrl } from "./serverHttpBaseUrl";

function requestHeaders(token: string): Readonly<Record<string, string>> {
    return {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${token}`,
    };
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

    constructor(code: QualifiedConnectedAccountCredentialConflictCode) {
        super(409, code);
        this.name = "QualifiedConnectedAccountCredentialConflictError";
        this.code = code;
    }
}

function throwQualifiedConnectedAccountCredentialConflict(data: unknown): never {
    const parsed =
        QualifiedConnectedAccountCredentialErrorV4Schema.safeParse(data);
    throw new QualifiedConnectedAccountCredentialConflictError(
        parsed.success
            ? parsed.data.error
            : "connected_account_credential_conflict_response_invalid",
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

function resolveLegacyServiceId(
    service: QualifiedConnectedAccountServiceRef,
): BuiltInLegacyConnectedServiceId | null {
    for (const [serviceId, compatibility] of Object.entries(
        BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    )) {
        if (
            compatibility.service.pluginId === service.pluginId
            && compatibility.service.localId === service.localId
        ) {
            return serviceId as BuiltInLegacyConnectedServiceId;
        }
    }
    return null;
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

export type QualifiedConnectedAccountLegacyPeerClass =
    | "exact_v0_2_1"
    | "revisioned_v2_v3";

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
    if (exactLegacy) return "exact_v0_2_1";
    if (negotiation === "advertised") return "advertised_v4";
    if (negotiation === "indeterminate") return "indeterminate";
    if (
        snapshot?.status === "ready"
        && snapshot.features.capabilities.connectedServices
            ?.credentialDelete?.revisionGuard === true
    ) {
        return "revisioned_v2_v3";
    }
    return "indeterminate";
}

export function isBuiltInLegacyConnectedAccountPeerOperationSupported(
    params: Readonly<{
        serviceId: string;
        peerClass: QualifiedConnectedAccountLegacyPeerClass;
        operation: BuiltInLegacyConnectedAccountOperation;
    }>,
): boolean {
    const compatibility =
        BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
            params.serviceId as BuiltInLegacyConnectedServiceId
        ];
    if (!compatibility) return false;
    const operations: readonly BuiltInLegacyConnectedAccountOperation[] =
        params.peerClass === "exact_v0_2_1"
            ? compatibility.peerOperations.exactV0_2_1
            : compatibility.peerOperations.revisionedV2V3;
    return operations.includes(params.operation);
}

export type QualifiedConnectedAccountPeerOperationTransport =
    | Readonly<{ kind: "v4" }>
    | Readonly<{
        kind: "legacy";
        peerClass: QualifiedConnectedAccountLegacyPeerClass;
        serviceId: BuiltInLegacyConnectedServiceId;
    }>;

/**
 * Canonical peer-class/operation negotiation owner.
 *
 * A known service with no operation at all for the selected peer is not an
 * accepted peer identity. A service accepted for other operations receives
 * the narrower operation-unsupported result.
 */
export function resolveQualifiedConnectedAccountPeerOperationTransport(
    params: Readonly<{
        snapshot: CliServerFeaturesSnapshot | undefined;
        serverContract?:
            SessionSyncPendingInputServerContractResult | null;
        service: QualifiedConnectedAccountServiceRef;
        operation: BuiltInLegacyConnectedAccountOperation;
    }>,
): QualifiedConnectedAccountPeerOperationTransport {
    const service =
        QualifiedConnectedAccountServiceRefSchema.parse(params.service);
    const peerClass =
        resolveQualifiedConnectedAccountPeerClass(
            params.snapshot,
            params.serverContract,
        );
    if (peerClass === "advertised_v4") return { kind: "v4" };
    if (peerClass === "indeterminate") {
        throw new QualifiedConnectedAccountCompatibilityError(
            "connected_account_capability_indeterminate",
        );
    }
    const serviceId = resolveLegacyServiceId(service);
    if (!serviceId) {
        throw new QualifiedConnectedAccountCompatibilityError(
            "connected_account_service_identity_unsupported",
        );
    }
    const compatibility =
        BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
            serviceId
        ];
    const peerOperations: readonly BuiltInLegacyConnectedAccountOperation[] =
        peerClass === "exact_v0_2_1"
            ? compatibility.peerOperations.exactV0_2_1
            : compatibility.peerOperations.revisionedV2V3;
    if (peerOperations.length === 0) {
        throw new QualifiedConnectedAccountCompatibilityError(
            "connected_account_service_identity_unsupported",
        );
    }
    if (!peerOperations.includes(params.operation)) {
        throw new QualifiedConnectedAccountCompatibilityError(
            "connected_account_legacy_operation_unsupported",
        );
    }
    return {
        kind: "legacy",
        peerClass,
        serviceId,
    };
}

type QualifiedConnectedAccountLegacyCapableOperationKind =
    Exclude<BuiltInLegacyConnectedAccountOperation, "account_list">;

export type QualifiedConnectedAccountNegotiatedOperation =
    | Readonly<{ kind: "account_list" }>
    | Readonly<{
        kind: QualifiedConnectedAccountLegacyCapableOperationKind;
        configurationState: "unconfigured" | "configured";
        authenticationModeCardinality: "single" | "multiple";
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
    const peerClass =
        resolveQualifiedConnectedAccountPeerClass(
            params.snapshot,
            params.serverContract,
        );
    if (peerClass === "advertised_v4") {
        return { kind: "v4" };
    }
    if (peerClass === "indeterminate") {
        throw new QualifiedConnectedAccountCompatibilityError(
            "connected_account_capability_indeterminate",
        );
    }
    if (params.operation.kind === "account_list") {
        return resolveQualifiedConnectedAccountPeerOperationTransport({
            snapshot: params.snapshot,
            serverContract: params.serverContract,
            service: params.service,
            operation: "account_list",
        });
    }
    if (
        !("configurationState" in params.operation)
        || params.operation.configurationState !== "unconfigured"
        || params.operation.authenticationModeCardinality !== "single"
    ) {
        throw new QualifiedConnectedAccountCompatibilityError(
            "connected_account_legacy_operation_unsupported",
        );
    }
    return resolveQualifiedConnectedAccountPeerOperationTransport({
        snapshot: params.snapshot,
        serverContract: params.serverContract,
        service: params.service,
        operation: params.operation.kind,
    });
}

export async function executeQualifiedConnectedAccountNegotiatedOperation<
    V4Result,
    LegacyResult,
>(
    params: Readonly<{
        snapshot: CliServerFeaturesSnapshot | undefined;
        serverContract?:
            SessionSyncPendingInputServerContractResult | null;
        service: QualifiedConnectedAccountServiceRef;
        operation: QualifiedConnectedAccountNegotiatedOperation;
        executeV4(): Promise<V4Result>;
        executeLegacy(
            serviceId: BuiltInLegacyConnectedServiceId,
        ): Promise<LegacyResult>;
    }>,
): Promise<V4Result | LegacyResult> {
    const transport =
        resolveQualifiedConnectedAccountOperationTransport(params);
    if (transport.kind === "legacy") {
        return await params.executeLegacy(transport.serviceId);
    }
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

export async function listQualifiedConnectedAccountsV4(params: Readonly<{
    token: string;
    service: QualifiedConnectedAccountServiceRef;
    signal?: AbortSignal;
}>) {
    const service =
        QualifiedConnectedAccountServiceRefSchema.parse(params.service);
    const query = new URLSearchParams({
        service: encodeQualifiedConnectedAccountV4StructuredQueryValue(
            QualifiedConnectedAccountServiceRefSchema,
            service,
        ),
    });
    const response = await axios.get(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/accounts?${query.toString()}`,
        {
            headers: requestHeaders(params.token),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
            ...(params.signal ? { signal: params.signal } : {}),
        },
    );
    if (response.status !== 200) {
        throw new Error(
            `Qualified Connected Account list returned ${response.status}`,
        );
    }
    return QualifiedConnectedAccountListResponseV4Schema.parse(response.data);
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
    return QualifiedConnectedAccountGroupListResponseV4Schema.parse(
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
    const resolvedGroup = QualifiedConnectedAccountGroupResponseV4Schema.parse(
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

export async function mutateQualifiedConnectedAccountCredentialV4(
    params: Readonly<{
        token: string;
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
            headers: requestHeaders(params.token),
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
    return QualifiedConnectedAccountCredentialSnapshotV4Schema.parse(
        response.data,
    );
}

export async function readQualifiedConnectedAccountConfigurationV4(
    params: Readonly<{
        token: string;
        target: QualifiedConnectedAccountConfigurationTargetV4;
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
            headers: requestHeaders(params.token),
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
    return QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse(
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
    const response = await axios.delete(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/credential?${query.toString()}`,
        {
            headers: requestHeaders(params.token),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
    );
    if (response.status !== 200) {
        throw new Error(
            `Qualified Connected Account credential delete returned ${response.status}`,
        );
    }
    return QualifiedConnectedAccountSuccessV4Schema.parse(response.data);
}

export async function acquireQualifiedConnectedAccountRefreshLeaseV4(
    params: Readonly<{
        token: string;
        lease: unknown;
    }>,
) {
    const lease =
        QualifiedConnectedAccountRefreshLeaseV4Schema.parse(params.lease);
    const response = await axios.post(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/credential/refresh-lease`,
        lease,
        {
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
        signal?: AbortSignal;
    }>,
) {
    const ref = QualifiedConnectedAccountRefSchema.parse(params.ref);
    const response = await axios.get(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/quotas?${qualifiedRefQuery(ref)}`,
        {
            headers: requestHeaders(params.token),
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
    }>,
) {
    const write = QualifiedProviderAccountUsageWriteV4Schema.parse(
        params.write,
    );
    const response = await axios.post(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/provider-account-usage`,
        write,
        {
            headers: requestHeaders(params.token),
            timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
    );
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
            headers: requestHeaders(params.token),
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
        signal?: AbortSignal;
    }>,
) {
    const query = QualifiedProviderAccountUsageRecordQueryV4Schema.parse({
        recordId: params.recordId,
    });
    const response = await axios.get(
        `${resolveServerHttpBaseUrl()}/v4/connect/qualified/provider-account-usage/record?${new URLSearchParams(query).toString()}`,
        {
            headers: requestHeaders(params.token),
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
