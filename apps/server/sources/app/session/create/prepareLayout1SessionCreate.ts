import {
    isSessionEncryptionModeAllowedByStoragePolicy,
    resolveEffectiveDefaultAccountEncryptionMode,
    SessionSharedMetadataV1Schema,
    validateSessionOwnerMetadataEnvelopeForAccountModeV1,
    type SessionOwnerMetadataEnvelopeV1,
    type SessionInitialAccessMaterializedV1,
    SessionCreateOriginFieldsV1Schema,
    type SessionCreateOriginFieldsV1,
    SessionReportsToV1Schema,
    type SessionReportsToV1,
    type SessionReportsToSetResultV1,
    SessionInitialTriggerAdmissionV1Schema,
    type SessionInitialTriggerAdmissionV1,
} from "@happier-dev/protocol";
import type { SessionAccessGrantErrorCode } from "@/app/session/access/sessionAccessGrantService";
import type { SessionTeamCredentialBindingIntentListV1 } from "@happier-dev/protocol/teams";
import type { SessionTeamCredentialBindingRejection } from "@/app/teams/credentials/sessionBinding";

import {
    resolveRequestedSessionModeRejectionCode,
    type EncryptionPolicyRejectionCode,
} from "@/app/session/encryptionRejectionCodes";

/**
 * Canonical Layout-1 Session creation preparation.
 *
 * This owner holds every pure Layout-1 admission decision shared by ordinary
 * create-or-rejoin and fresh bound creation: storage-policy admission, the
 * effective Session encryption mode, owner-envelope/Account-mode agreement,
 * strict plain stored content, and the fact that a plain Session never carries
 * a data key. Current database facts stay in the transaction entries, which
 * re-run `validateLayout1SessionStoredContentForMode` against the fenced
 * Account row before writing.
 */

/**
 * Mirrors the protocol's encryption vocabulary. The protocol package does not
 * re-export those type aliases from its root today, and widening its public
 * surface is not this owner's call.
 */
export type AccountEncryptionMode = "plain" | "e2ee";
export type EncryptionStoragePolicy = "optional" | "plaintext_only" | "required_e2ee";

export type SessionOrganizationPlacementInput = Readonly<{
    folderId: string | null;
    tagIds: readonly string[];
}>;

export type Layout1SessionCreateRejection =
    | Readonly<{ reason: "invalid-params" }>
    | Readonly<{ reason: "session-origin-forbidden" }>
    | Readonly<{ reason: "session-reports-to-invalid"; result: Extract<SessionReportsToSetResultV1, { ok: false }> }>
    | Readonly<{ reason: "account-disabled" }>
    | Readonly<{ reason: "encryption-mode-not-allowed"; code: EncryptionPolicyRejectionCode }>
    | Readonly<{ reason: "privacy-upgrade-required" }>
    | Readonly<{ reason: "invalid-organization-placement" }>
    | Readonly<{ reason: "session-initial-trigger-invalid"; code: "invalid_input" | "target_unavailable" | "feature_disabled" }>
    | Readonly<{
        reason: "session-initial-access-invalid";
        code: SessionAccessGrantErrorCode | "session_initial_access_creator_mismatch";
    }>
    | Readonly<{
        reason: "team-credential-binding-invalid";
        code: SessionTeamCredentialBindingRejection;
    }>;

/** Refusals only a reserved-identity creation can produce. */
export type FreshBoundLayout1SessionCreateRejection =
    | Layout1SessionCreateRejection
    | Readonly<{ reason: "session-id-taken" }>
    | Readonly<{ reason: "session-tag-taken" }>;

export type Layout1SessionCreateRequest = Readonly<SessionCreateOriginFieldsV1 & {
    reportsTo?: SessionReportsToV1;
    accountId: string;
    tag: string;
    /** Shared metadata as stored: canonical JSON for plain, ciphertext for E2EE. */
    metadata: string;
    ownerMetadata: SessionOwnerMetadataEnvelopeV1;
    agentState: string | null;
    /** Base64 Session data key; only an E2EE Session may carry one. */
    dataEncryptionKey: string | null;
    requestedEncryptionMode: "e2ee" | "plain" | undefined;
    requestedStorageState: "machine_only" | undefined;
    organizationPlacement: SessionOrganizationPlacementInput | undefined;
    initialAccess?: SessionInitialAccessMaterializedV1;
    initialTriggers?: readonly SessionInitialTriggerAdmissionV1[];
    primaryTeamId?: string | null;
    teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
    accountEncryptionMode: AccountEncryptionMode;
    storagePolicy: EncryptionStoragePolicy;
    defaultAccountMode: AccountEncryptionMode;
}>;

export type PreparedLayout1SessionCreate = Readonly<SessionCreateOriginFieldsV1 & {
    reportsTo?: SessionReportsToV1;
    accountId: string;
    tag: string;
    metadata: string;
    ownerMetadata: SessionOwnerMetadataEnvelopeV1;
    agentState: string | null;
    dataEncryptionKey: Uint8Array<ArrayBuffer> | null;
    /** Resolved from the Account row observed before the fence; the transaction re-resolves it. */
    effectiveEncryptionMode: "e2ee" | "plain";
    requestedEncryptionMode: "e2ee" | "plain" | undefined;
    requestedStorageState: "machine_only" | undefined;
    organizationPlacement: SessionOrganizationPlacementInput | undefined;
    initialAccess?: SessionInitialAccessMaterializedV1;
    initialTriggers?: readonly SessionInitialTriggerAdmissionV1[];
    primaryTeamId?: string | null;
    teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
    storagePolicy: EncryptionStoragePolicy;
    defaultAccountMode: AccountEncryptionMode;
}>;

export type PrepareLayout1SessionCreateResult =
    | Readonly<{ ok: true; prepared: PreparedLayout1SessionCreate }>
    | Readonly<{ ok: false; rejection: Layout1SessionCreateRejection }>;

export function resolveEffectiveLayout1SessionEncryptionMode(params: Readonly<{
    storagePolicy: EncryptionStoragePolicy;
    defaultAccountMode: AccountEncryptionMode;
    requestedEncryptionMode: "e2ee" | "plain" | undefined;
    accountEncryptionMode: AccountEncryptionMode | null;
}>): "e2ee" | "plain" {
    if (params.storagePolicy === "required_e2ee") return "e2ee";
    if (params.storagePolicy === "plaintext_only") return "plain";
    return params.requestedEncryptionMode
        ?? params.accountEncryptionMode
        ?? resolveEffectiveDefaultAccountEncryptionMode(
            params.storagePolicy,
            params.defaultAccountMode,
        );
}

function isCanonicalPlainAgentState(agentState: string | null): boolean {
    if (agentState === null) return true;
    try {
        const parsed = JSON.parse(agentState);
        return typeof parsed === "object"
            && parsed !== null
            && !Array.isArray(parsed);
    } catch {
        return false;
    }
}

function isCanonicalPlainSharedMetadata(metadata: string): boolean {
    try {
        return SessionSharedMetadataV1Schema.safeParse(JSON.parse(metadata)).success;
    } catch {
        return false;
    }
}

/**
 * Owner-envelope/Account-mode agreement plus strict plain stored content.
 * Callers pass the Account mode they are authoritative for: the request-time
 * read before the transaction, and the fenced row inside it.
 */
export function validateLayout1SessionStoredContentForMode(params: Readonly<{
    accountEncryptionMode: AccountEncryptionMode;
    effectiveEncryptionMode: "e2ee" | "plain";
    ownerMetadata: SessionOwnerMetadataEnvelopeV1;
    metadata: string;
    agentState: string | null;
}>): boolean {
    if (!validateSessionOwnerMetadataEnvelopeForAccountModeV1({
        accountMode: params.accountEncryptionMode,
        envelope: params.ownerMetadata,
    }).ok) {
        return false;
    }
    if (params.effectiveEncryptionMode !== "plain") return true;
    return isCanonicalPlainSharedMetadata(params.metadata)
        && isCanonicalPlainAgentState(params.agentState);
}

/**
 * Storage-policy admission for an explicitly requested Session mode. Session
 * creation applies it to every request shape, including released layouts that
 * carry no owner envelope, before any Account read.
 */
export function admitRequestedSessionEncryptionMode(params: Readonly<{
    storagePolicy: EncryptionStoragePolicy;
    requestedEncryptionMode: "e2ee" | "plain" | undefined;
}>): Layout1SessionCreateRejection | null {
    if (
        (params.requestedEncryptionMode === "plain"
            || params.requestedEncryptionMode === "e2ee")
        && !isSessionEncryptionModeAllowedByStoragePolicy(
            params.storagePolicy,
            params.requestedEncryptionMode,
        )
    ) {
        return {
            reason: "encryption-mode-not-allowed",
            code: resolveRequestedSessionModeRejectionCode({
                storagePolicy: params.storagePolicy,
            }),
        };
    }
    return null;
}

export function prepareLayout1SessionCreate(
    request: Layout1SessionCreateRequest,
): PrepareLayout1SessionCreateResult {
    const origin = SessionCreateOriginFieldsV1Schema.safeParse({
        originKind: request.originKind,
        originSessionId: request.originSessionId,
        originRunId: request.originRunId,
        workDepth: request.workDepth,
    });
    if (!origin.success) return { ok: false, rejection: { reason: "invalid-params" } };
    const reportsTo = SessionReportsToV1Schema.optional().safeParse(request.reportsTo);
    if (!reportsTo.success) return { ok: false, rejection: { reason: "invalid-params" } };
    const initialTriggers = SessionInitialTriggerAdmissionV1Schema.array().optional().safeParse(request.initialTriggers);
    if (!initialTriggers.success) {
        return { ok: false, rejection: { reason: "session-initial-trigger-invalid", code: "invalid_input" } };
    }
    const modeRejection = admitRequestedSessionEncryptionMode({
        storagePolicy: request.storagePolicy,
        requestedEncryptionMode: request.requestedEncryptionMode,
    });
    if (modeRejection) {
        return { ok: false, rejection: modeRejection };
    }

    const effectiveEncryptionMode = resolveEffectiveLayout1SessionEncryptionMode({
        storagePolicy: request.storagePolicy,
        defaultAccountMode: request.defaultAccountMode,
        requestedEncryptionMode: request.requestedEncryptionMode,
        accountEncryptionMode: request.accountEncryptionMode,
    });

    if (!validateLayout1SessionStoredContentForMode({
        accountEncryptionMode: request.accountEncryptionMode,
        effectiveEncryptionMode,
        ownerMetadata: request.ownerMetadata,
        metadata: request.metadata,
        agentState: request.agentState ?? null,
    })) {
        return { ok: false, rejection: { reason: "invalid-params" } };
    }

    if (effectiveEncryptionMode === "plain" && request.dataEncryptionKey != null) {
        return { ok: false, rejection: { reason: "invalid-params" } };
    }

    return {
        ok: true,
        prepared: {
            ...origin.data,
            ...(reportsTo.data ? { reportsTo: reportsTo.data } : {}),
            accountId: request.accountId,
            tag: request.tag,
            metadata: request.metadata,
            ownerMetadata: request.ownerMetadata,
            agentState: request.agentState ?? null,
            dataEncryptionKey: request.dataEncryptionKey
                ? new Uint8Array(Buffer.from(request.dataEncryptionKey, "base64"))
                : null,
            effectiveEncryptionMode,
            requestedEncryptionMode: request.requestedEncryptionMode,
            requestedStorageState: request.requestedStorageState,
            organizationPlacement: request.organizationPlacement,
            initialAccess: request.initialAccess,
            ...(initialTriggers.data !== undefined ? { initialTriggers: initialTriggers.data } : {}),
            primaryTeamId: request.primaryTeamId,
            ...(request.teamCredentialBindings !== undefined ? { teamCredentialBindings: request.teamCredentialBindings } : {}),
            storagePolicy: request.storagePolicy,
            defaultAccountMode: request.defaultAccountMode,
        },
    };
}
