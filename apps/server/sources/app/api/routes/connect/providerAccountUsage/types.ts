import type {
    ConnectedServiceQuotaSnapshotV1,
    ConnectedServiceUsageSourceV1,
    ProviderAccountUsageRecordId,
    ProviderAccountUsageRecordKeyV1,
    ProviderAccountUsageSnapshotV1,
    SealedConnectedServiceQuotaSnapshotV1,
    SealedProviderAccountUsageSnapshotV1,
} from "@happier-dev/protocol";

export type ProviderAccountUsagePayloadMode = "plain_json_v1" | "sealed_account_scoped_v1";
export type ProviderAccountUsageStatus = "ok" | "unavailable" | "estimated" | "error" | "refresh_requested";
export type LegacyQuotaCompatibilityProjection = Readonly<{
    source: Extract<
        ConnectedServiceUsageSourceV1,
        Readonly<{ bindingKind: "profile" }>
    >;
    providerAccountUsageFetchedAt: number;
    sealed: SealedConnectedServiceQuotaSnapshotV1;
}>;
export type ProviderAccountUsageRecordMetadata = Readonly<{
    materialFingerprint?: string;
    legacyQuotaCompatibilityProjections?: readonly LegacyQuotaCompatibilityProjection[];
}>;

export type UpsertProviderAccountUsageRecordParams = Readonly<{
    accountId: string;
    recordId: ProviderAccountUsageRecordId;
    recordKey: ProviderAccountUsageRecordKeyV1;
    payloadMode: ProviderAccountUsagePayloadMode;
    status: ProviderAccountUsageStatus;
    snapshot?: ProviderAccountUsageSnapshotV1;
    sealedPayload?: SealedProviderAccountUsageSnapshotV1;
    fetchedAt?: number;
    staleAfterMs?: number;
    refreshRequestedAt?: number;
    metadata?: ProviderAccountUsageRecordMetadata;
}>;

export type StoredProviderAccountUsageRecord = Readonly<{
    accountId: string;
    recordId: ProviderAccountUsageRecordId;
    recordKey: ProviderAccountUsageRecordKeyV1;
    payloadMode: ProviderAccountUsagePayloadMode;
    status: ProviderAccountUsageStatus;
    snapshot?: ProviderAccountUsageSnapshotV1;
    sealedPayload?: SealedProviderAccountUsageSnapshotV1;
    fetchedAt: number | null;
    staleAfterMs: number | null;
    refreshRequestedAt?: number;
    metadata?: ProviderAccountUsageRecordMetadata;
}>;

export type UpsertConnectedServiceUsageSourceParams = Readonly<{
    accountId: string;
    providerAccountUsageRecordId: ProviderAccountUsageRecordId;
}> & ConnectedServiceUsageSourceV1;

export type StoredConnectedServiceUsageSource = Readonly<{
    accountId: string;
    sourceKey: string;
    providerAccountUsageRecordId: ProviderAccountUsageRecordId;
}> & ConnectedServiceUsageSourceV1;

export type ProviderAccountUsageSourceLinkOutcome = Readonly<
    | { status: "linked" }
    | { status: "skipped"; reason: "binding_unavailable" | "ownership_unproven" }
>;

export type ProviderAccountUsageResponseMetadata = Readonly<{
    fetchedAt: number;
    staleAfterMs: number;
    status: Exclude<ProviderAccountUsageStatus, "refresh_requested">;
    refreshRequestedAt?: number;
}>;

export type ConnectedServiceQuotaView = Readonly<{
    recordId: ProviderAccountUsageRecordId;
    snapshot: ConnectedServiceQuotaSnapshotV1;
    metadata: ProviderAccountUsageResponseMetadata;
}>;

export class ProviderAccountUsagePayloadInvariantError extends Error {
    readonly code = "provider_account_usage_payload_invariant";

    constructor(message: string) {
        super(message);
        this.name = "ProviderAccountUsagePayloadInvariantError";
    }
}

export class ConnectedServiceUsageSourceOwnershipError extends Error {
    readonly code = "connected_service_usage_source_ownership";
    readonly kind: "mismatch" | "unproven";

    constructor(message: string, kind: "mismatch" | "unproven" = "mismatch") {
        super(message);
        this.name = "ConnectedServiceUsageSourceOwnershipError";
        this.kind = kind;
    }
}

export type ConnectedServiceUsageSourceBindingErrorKind = "invalid" | "unavailable";

export class ConnectedServiceUsageSourceBindingError extends Error {
    readonly code = "connected_service_usage_source_binding";
    readonly kind: ConnectedServiceUsageSourceBindingErrorKind;

    constructor(message: string, kind: ConnectedServiceUsageSourceBindingErrorKind = "invalid") {
        super(message);
        this.name = "ConnectedServiceUsageSourceBindingError";
        this.kind = kind;
    }
}
