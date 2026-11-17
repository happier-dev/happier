import { decodeSessionStoredContent, withSessionContentSelect } from '@/storage/sessionMachineStoredContent';
import type { Prisma } from "@prisma/client";
import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod/mini";

import { isStoredContentKindAllowedForSessionByStoragePolicy, type SessionStoredContentKind } from '@happier-dev/protocol/encryption/storagePolicyDecisions';
import { getSessionSystemRecordKindPolicy, getSessionSystemRecordPayloadSchema, SESSION_SYSTEM_RECORD_CATALOG, type SessionSystemRecordKindPolicy, type SessionSystemRecordCatalog } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordCatalog';
import { SESSION_SYSTEM_RECORD_NAMESPACES, type SessionSystemRecordNamespace } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordNamespace';
import { USAGE_SESSION_WORK_FACTS_SYSTEM_RECORD_ADDRESS } from '@happier-dev/protocol/usage/usageTimingV1';
import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import { SessionSystemRecordAddressSchema, type SessionSystemRecordAddress } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordAddress';
import { SessionSystemRecordDeleteRequestSchema, SessionSystemRecordListQuerySchema, SessionSystemRecordReadRequestSchema, LegacyHostSessionSystemRecordLatestQuerySchema, LegacyHostSessionSystemRecordListQuerySchema, LegacyHostSessionSystemRecordLookupQuerySchema, LegacyHostSessionSystemRecordUpsertRequestSchema, type SessionSystemRecordListQuery, type SessionSystemRecordStored, SessionPermissionMediationRecordKindSchema, SessionPermissionMediationRecordListQuerySchema, SessionPermissionMediationRecordPruneRequestSchema, SessionPermissionMediationRecordWriteRequestSchema, type SessionPermissionMediationRecordListQuery, type SessionPermissionMediationRecordPruneRequest, type SessionPermissionMediationRecordStored, type SessionPermissionMediationRecordWriteRequest } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { SessionSystemRecordContentSchema, type SessionSystemRecordContent } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordContent';
import { SessionSystemRecordRevisionSchema, SESSION_SYSTEM_RECORD_VERSION_MAX, type SessionSystemRecordRevision } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRevision';
import { type SessionStoredMessageContent } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { type SessionSystemRecordKind } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordKind';
import { SESSION_PERMISSION_SYSTEM_RECORD_KINDS, SESSION_PERMISSION_SYSTEM_RECORD_NAMESPACE, deriveSessionPermissionMediationRecordLocatorV1, SessionPermissionMediationRecordIdentityV1Schema, type SessionPermissionMediationRecordIdentityV1 } from '@happier-dev/protocol/sessions/permissions/mediationRecordsV1';
import { SessionBoardItemRecordContentV1Schema, SessionBoardLayoutRecordContentV1Schema } from '@happier-dev/protocol/sessions/board/mutations';
import { buildSessionSystemRecordChangeV1 } from '@happier-dev/protocol/sessions/board/changeHint';
import { createStoredReadSchema } from "@happier-dev/protocol/json/storedReadSchema";
import { getSessionSystemRecordStoredPayloadSchema } from "@happier-dev/protocol/sessions/system/records/sessionSystemRecordCatalog";
import { isSessionSurfaceItemIdentityCorrespondingV1, type SessionSurfaceItemV1 } from "@happier-dev/protocol/sessions/board/item";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import { resolveEncryptionWriteRejectionCode, type EncryptionPolicyRejectionCode } from "@/app/session/encryptionRejectionCodes";
import {
    buildSessionAccessProjectionSelect,
    readSessionAccessProjectionContextInTx,
    resolveSessionAccessForRowsInTx,
    resolveEffectiveSessionAccess,
    SESSION_ACCESS_SESSION_BATCH_SIZE,
    type EffectiveSessionAccess,
    type SessionAccessProjectionContext,
} from "@/app/session/access/sessionAccess";
import { createSessionDataKeyEnvelopeViewerSelect } from '@/app/session/encryption/sessionDataKeyEnvelopePersistence';
import { buildSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { readCurrentSessionPublicationAudienceInTx } from '@/app/session/access/sessionRecipients';
import { projectSessionTranscriptPublicationChangeHint } from '@/app/session/sessionTranscriptPublicationPolicy';
import { markAccountsChanged } from '@/app/changes/markAccountChanged';
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { db } from "@/storage/db";
import { inReadSnapshot, inTx, type ResolvedTransactionResult, type Tx } from "@/storage/inTx";
import { captureReadSnapshot } from "@/storage/captureReadSnapshot";
import { isPrismaErrorCode } from "@/storage/prisma";
import { decodeStoredContent, encodeStoredContent, toPrismaStoredContent } from "@/storage/storedContent";
import { error as logError } from "@/utils/logging/log";
import {
    deriveSessionSystemRecordAddressKeys,
    sessionSystemRecordRawAddressEquals,
    type PersistedSessionSystemRecordAddress,
} from "./sessionSystemRecordAddressKeys";
import {
    encodeSessionSystemRecordRevision,
    parseSessionSystemRecordRevision,
} from "./sessionSystemRecordRevision";
import { isSessionSystemRecordsProtocolV1Active } from "./sessionSystemRecordProtocolContract";

const SESSION_SYSTEM_RECORD_CURSOR_PREFIX = "v1";
const SESSION_SYSTEM_RECORD_MAX_LIMIT = 500;
const SESSION_SYSTEM_RECORD_DEFAULT_LIMIT = 100;
const PLUGIN_SESSION_SYSTEM_RECORD_CURSOR_PREFIX = "ssrp1";

/** Publish actual host-row changes through the same catalog scope and current Session audience as reads. */
async function publishHostRecordChangeInTx(tx: Tx, params: Readonly<{
    sessionId: string;
    accountId: string;
    recordId: string;
    address: SessionSystemRecordAddress;
}>): Promise<void> {
    if (params.address.owner !== 'host') return;
    const policy = getSessionSystemRecordKindPolicy(params.address.namespace, params.address.kind);
    if (!policy || policy.read === 'unavailable') return;
    const change = buildSessionSystemRecordChangeV1(params.recordId, { sessionId: params.sessionId, address: params.address });
    // Actor-scoped memory is the actor's own projection, not shared transcript state.
    if (policy.accountScope === 'actor') {
        await markAccountsChanged(tx, { accountIds: [params.accountId], ...change });
        return;
    }
    const { publication, recipientAccountIds } = await readCurrentSessionPublicationAudienceInTx(tx, { sessionId: params.sessionId });
    await markAccountsChanged(tx, { ...change, accountIds: recipientAccountIds.filter(accountId =>
        projectSessionTranscriptPublicationChangeHint(change.hint, publication, accountId).kind === 'publish') });
}

function reportSystemRecordFailure(operation: string, error: unknown, reason: "exception" | "internal-result" = "exception"): void {
    // Exception messages, stacks and metadata may contain SQL, content or credentials.
    // Keep diagnostics to fixed categories and the documented Prisma code shape.
    const knownErrorNames = [
        "Error", "TypeError", "RangeError", "SyntaxError",
        "PrismaClientKnownRequestError", "PrismaClientUnknownRequestError",
        "PrismaClientInitializationError", "PrismaClientValidationError", "PrismaClientRustPanicError",
        "TransactionAcquisitionUnavailableError", "TransactionDeadlineExceededError",
        "TransactionReplayRequiredError", "TransactionConflictExhaustedError",
    ];
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    logError({
        module: "session-system-record-service",
        operation,
        reason,
        prismaCode: typeof code === "string" && /^P\d{4}$/.test(code) ? code : null,
        errorType: error === undefined ? null : error instanceof Error
            ? (knownErrorNames.includes(error.name) ? error.name : "Error")
            : typeof error,
    }, "Session system-record operation failed");
}

// Call only after the owning transaction/snapshot has settled, never in its callback.
function reportSystemRecordResult<T extends object>(operation: string, result: T): T {
    if ("ok" in result && result.ok === false && (
        ("error" in result && result.error === "internal")
        || ("code" in result && (
            result.code === "plugin_session_record_internal"
            || result.code === "permission_mediation_record_internal"
        ))
    )) {
        reportSystemRecordFailure(operation, undefined, "internal-result");
    }
    return result;
}

type SessionSystemRecordV1ErrorCode =
    | "plugin_session_records_unavailable"
    | "plugin_session_record_feature_disabled"
    | "plugin_session_record_invalid_query"
    | "plugin_session_record_address_collision"
    | "plugin_session_record_kind_conflict"
    | "plugin_session_record_revision_conflict"
    | "plugin_session_record_revision_exhausted"
    | "plugin_session_record_storage_mode_mismatch"
    | "plugin_session_record_forbidden"
    | "plugin_session_not_found"
    | "plugin_session_record_internal";

type SessionSystemRecordV1Result<T> =
    | Readonly<{ ok: true } & T>
    | SessionSystemRecordV1Failure;

type SessionSystemRecordV1Failure = Readonly<{
    ok: false;
    code: SessionSystemRecordV1ErrorCode;
    currentRevision?: SessionSystemRecordRevision;
}>;

type SessionSystemRecordV1BaseParams = Readonly<{
    actorUserId: string;
    sessionId: string;
    pluginId?: string;
    authentication: SessionAccessAuthentication;
}>;

export type PersistedSessionSystemRecordRow = Readonly<{
    id: string;
    accountId: string;
    sessionId: string;
    ownerKind: string | null;
    pluginId: string | null;
    namespace: string;
    kind: string;
    localId: string;
    permissionTurnId: string | null;
    permissionRequestId: string | null;
    content: unknown;
    contentBytes?: Uint8Array<ArrayBuffer> | null;
    namespaceAddressKey: Uint8Array | null;
    recordAddressKey: Uint8Array | null;
    version: number;
    createdAt: Date;
    updatedAt: Date;
}>;

export type SessionSystemRecordRow = Readonly<{
    id: string;
    sessionId: string;
    namespace: SessionSystemRecordNamespace;
    kind: SessionSystemRecordKind;
    localId: string;
    content: SessionStoredMessageContent;
    createdAt: Date;
    updatedAt: Date;
}>;

export type UpsertSessionSystemRecordParams = Readonly<{
    actorUserId: string;
    sessionId: string;
    namespace: SessionSystemRecordNamespace;
    kind: SessionSystemRecordKind;
    localId: string;
    content: SessionStoredMessageContent;
    authentication: SessionAccessAuthentication;
}>;

export type ListSessionSystemRecordsParams = Readonly<{
    actorUserId: string;
    sessionId: string;
    namespace?: SessionSystemRecordNamespace;
    kind?: SessionSystemRecordKind;
    localId?: string;
    limit?: number;
    cursor?: string;
    authentication: SessionAccessAuthentication;
}>;

export type GetSessionSystemRecordParams = Readonly<{
    actorUserId: string;
    sessionId: string;
    namespace: SessionSystemRecordNamespace;
    localId: string;
    authentication: SessionAccessAuthentication;
}>;

export type GetLatestSessionSystemRecordParams = Readonly<{
    actorUserId: string;
    sessionId: string;
    namespace: SessionSystemRecordNamespace;
    kind: SessionSystemRecordKind;
    authentication: SessionAccessAuthentication;
}>;

export type UpsertSessionSystemRecordResult =
    | { ok: true; didCreate: boolean; didUpdate: boolean; record: SessionSystemRecordRow }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "conflict" | "internal"; code?: EncryptionPolicyRejectionCode };

export type ListSessionSystemRecordsResult =
    | { ok: true; records: SessionSystemRecordRow[]; nextCursor: string | null }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "internal" };

export type GetSessionSystemRecordResult =
    | { ok: true; record: SessionSystemRecordRow | null }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "internal" };

export type GetLatestSessionSystemRecordResult =
    | { ok: true; record: SessionSystemRecordRow | null }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "internal" };

type SessionRecordAccountScope = Readonly<{ accountId: string }>;
type CurrentSessionRecordAccess = "visible" | "edit";

type HostRecordListScope = Readonly<{
    accountId: string;
    namespace: SessionSystemRecordNamespace;
    kinds: readonly SessionSystemRecordKind[];
    namespaceAddressKey: Uint8Array;
    recordAddressKey: Uint8Array | null;
}>;

const SESSION_SYSTEM_RECORD_SELECT = {
    id: true,
    accountId: true,
    sessionId: true,
    namespace: true,
    kind: true,
    localId: true,
    permissionTurnId: true,
    permissionRequestId: true,
    content: true,
    contentBytes: true,
    ownerKind: true,
    pluginId: true,
    namespaceAddressKey: true,
    recordAddressKey: true,
    version: true,
    createdAt: true,
    updatedAt: true,
} as const;

function systemRecordContentForStorage(content: object) {
    const stored = encodeStoredContent(content);
    return {
        ...stored,
        // Prisma's JSON input cannot express the runtime JsonNull sentinel.
        content: toPrismaStoredContent(stored.content) as Prisma.InputJsonValue,
    };
}

function parseRecordPayload(value: unknown): {
    namespace: SessionSystemRecordNamespace;
    kind: SessionSystemRecordKind;
    localId: string;
    content: SessionStoredMessageContent;
} | null {
    const parsed = LegacyHostSessionSystemRecordUpsertRequestSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function toSessionSystemRecordRow(row: {
    id: string;
    sessionId: string;
    namespace: unknown;
    kind: unknown;
    localId: string;
    content: unknown;
    contentBytes?: Uint8Array<ArrayBuffer> | null;
    createdAt: Date;
    updatedAt: Date;
}): SessionSystemRecordRow | null {
    const parsed = parseRecordPayload({
        namespace: row.namespace,
        kind: row.kind,
        localId: row.localId,
        content: decodeStoredContent(row),
    });
    if (!parsed) return null;
    return {
        id: row.id,
        sessionId: row.sessionId,
        namespace: parsed.namespace,
        kind: parsed.kind,
        localId: parsed.localId,
        content: parsed.content,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array): boolean {
    if (left === null || left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    return true;
}

function hostAddress(
    namespace: string,
    localId: string,
): PersistedSessionSystemRecordAddress {
    return {
        ownerKind: "host",
        pluginId: null,
        namespace,
        localId,
    };
}

function isCanonicalHostRowAtAddress(
    row: PersistedSessionSystemRecordRow,
    expected: PersistedSessionSystemRecordAddress,
): boolean {
    return row.ownerKind === "host"
        && row.pluginId === null
        && sessionSystemRecordRawAddressEquals({
            ownerKind: row.ownerKind,
            pluginId: row.pluginId,
            namespace: row.namespace,
            localId: row.localId,
        }, expected);
}

export async function findExactHostSessionSystemRecordInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        sessionId: string;
        namespace: string;
        localId: string;
    }>,
): Promise<
    | Readonly<{
        ok: true;
        keys: ReturnType<typeof deriveSessionSystemRecordAddressKeys>;
        row: PersistedSessionSystemRecordRow | null;
    }>
    | Readonly<{ ok: false }>
> {
    const expected = hostAddress(params.namespace, params.localId);
    const keys = deriveSessionSystemRecordAddressKeys(expected);
    const keyedRow = await tx.sessionSystemRecord.findFirst({
        where: {
            accountId: params.accountId,
            sessionId: params.sessionId,
            recordAddressKey: keys.recordAddressKey,
        },
        select: SESSION_SYSTEM_RECORD_SELECT,
    }) as PersistedSessionSystemRecordRow | null;
    if (keyedRow) {
        return isCanonicalHostRowAtAddress(keyedRow, expected)
            ? { ok: true, keys, row: keyedRow }
            : { ok: false };
    }
    return { ok: true, keys, row: null };
}

type WriteExternalSessionHistoricalImportRecordInTxResult =
    | Readonly<{ ok: true }>
    | Readonly<{
        ok: false;
        code: "address_collision" | "kind_conflict" | "create_race";
    }>;

/**
 * Persist an External Sessions historical-import authority record after its
 * orchestrator has performed domain authorization and currentness checks.
 * Keeping this narrow physical write here prevents the import workflow from
 * becoming a second SessionSystemRecord owner or exposing a generic write path.
 */
export async function writeExternalSessionHistoricalImportRecordInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        sessionId: string;
        kind: "historical_import" | "takeover_admission";
        localId: string;
        content: object;
    }>,
): Promise<WriteExternalSessionHistoricalImportRecordInTxResult> {
    const namespace = "external_sessions";
    // These two schema-owned records are JSON objects; Prisma's input type cannot
    // represent their readonly protocol fields and conditionally omitted members.
    const content = systemRecordContentForStorage(params.content);
    const lookup = await findExactHostSessionSystemRecordInTx(tx, { ...params, namespace });
    if (!lookup.ok) return { ok: false, code: "address_collision" };
    if (lookup.row) {
        if (lookup.row.kind !== params.kind) return { ok: false, code: "kind_conflict" };
        await tx.sessionSystemRecord.update({
            where: { id: lookup.row.id },
            data: {
                kind: params.kind,
                ...content,
                ownerKind: "host",
                pluginId: null,
                namespaceAddressKey: lookup.keys.namespaceAddressKey,
                recordAddressKey: lookup.keys.recordAddressKey,
                version: { increment: 1 },
            },
        });
        return { ok: true };
    }
    try {
        await tx.sessionSystemRecord.create({
            data: {
                accountId: params.accountId,
                sessionId: params.sessionId,
                namespace,
                kind: params.kind,
                localId: params.localId,
                ...content,
                ownerKind: "host",
                pluginId: null,
                namespaceAddressKey: lookup.keys.namespaceAddressKey,
                recordAddressKey: lookup.keys.recordAddressKey,
                version: 1,
            },
        });
        return { ok: true };
    } catch (error) {
        if (isPrismaErrorCode(error, "P2002")) return { ok: false, code: "create_race" };
        throw error;
    }
}

async function findHostRecordByAddress(
    tx: Tx,
    params: Readonly<{
        actorUserId: string;
        accountId: string;
        sessionId: string;
        requiredAccess: CurrentSessionRecordAccess;
        authentication: SessionAccessAuthentication;
        namespace: SessionSystemRecordNamespace;
        localId: string;
    }>,
): Promise<
    | Readonly<{
        ok: true;
        keys: ReturnType<typeof deriveSessionSystemRecordAddressKeys>;
        row: PersistedSessionSystemRecordRow | null;
    }>
    | Readonly<{ ok: false }>
> {
    const expected = hostAddress(params.namespace, params.localId);
    const keys = deriveSessionSystemRecordAddressKeys(expected);
    const row = await tx.sessionSystemRecord.findFirst({
        where: {
            accountId: params.accountId,
            sessionId: params.sessionId,
            recordAddressKey: keys.recordAddressKey,
            ...await currentSessionRecordWhere(tx, {
                actorUserId: params.actorUserId,
                sessionId: params.sessionId,
                requiredAccess: params.requiredAccess,
                authentication: params.authentication,
            }),
        },
        select: SESSION_SYSTEM_RECORD_SELECT,
    }) as PersistedSessionSystemRecordRow | null;
    if (row) {
        return isCanonicalHostRowAtAddress(row, expected)
            ? { ok: true, keys, row }
            : { ok: false };
    }
    return { ok: true, keys, row: null };
}

function normalizeLimit(limit: number | undefined): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) return SESSION_SYSTEM_RECORD_DEFAULT_LIMIT;
    return Math.min(SESSION_SYSTEM_RECORD_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function encodeCursor(row: Pick<SessionSystemRecordRow, "updatedAt" | "id">): string {
    return Buffer.from(`${SESSION_SYSTEM_RECORD_CURSOR_PREFIX}:${row.updatedAt.getTime()}:${row.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): { updatedAt: Date; id: string } | null {
    if (!cursor) return null;
    try {
        const decoded = Buffer.from(cursor, "base64url").toString("utf8");
        const [version, updatedAtMsRaw, id] = decoded.split(":");
        const updatedAtMs = Number(updatedAtMsRaw);
        if (version !== SESSION_SYSTEM_RECORD_CURSOR_PREFIX || !Number.isFinite(updatedAtMs) || !id) return null;
        return { updatedAt: new Date(updatedAtMs), id };
    } catch {
        return null;
    }
}

async function ensureSessionRecordAccess(params: Readonly<{ actorUserId: string; sessionId: string; authentication: SessionAccessAuthentication }>, reader: Tx = db): Promise<
    | { ok: true; access: EffectiveSessionAccess }
    | { ok: false; error: "invalid-params" | "session-not-found" }
> {
    if (!params.actorUserId || !params.sessionId) {
        return { ok: false, error: "invalid-params" };
    }
    const access = await resolveEffectiveSessionAccess(reader, { accountId: params.actorUserId, sessionId: params.sessionId, authentication: params.authentication });
    if (!access) {
        return { ok: false, error: "session-not-found" };
    }
    return { ok: true, access };
}

/** Standalone mutations admit the same Session owner used by composed writers. */
async function inSessionSystemRecordMutation<T>(
    params: Readonly<{ actorUserId: string; sessionId: string }>,
    mutate: (tx: Tx) => Promise<T>,
): Promise<ResolvedTransactionResult<T>> {
    return await inTx(async tx => {
        await acquireSessionAccountCursorLocksInTx(tx, [params.sessionId], [params.actorUserId]);
        return await mutate(tx);
    }, { isolationLevel: "ReadCommitted" });
}

function canMutateHostSystemRecord(params: Readonly<{
    access: EffectiveSessionAccess;
    namespace: SessionSystemRecordNamespace;
    kind: SessionSystemRecordKind;
}>): boolean {
    const policy = resolveV1HostPolicy({
        namespace: params.namespace,
        kind: params.kind,
        operation: "write",
    });
    return policy !== null && satisfiesSystemRecordPolicy(params.access, policy.requirement);
}

function canReadHostSystemRecords(params: Readonly<{
    access: EffectiveSessionAccess;
    namespace?: SessionSystemRecordNamespace;
    kind?: SessionSystemRecordKind;
}>): boolean {
    if (params.namespace) {
        const policy = resolveV1HostPolicy({
            namespace: params.namespace,
            ...(params.kind ? { kind: params.kind } : {}),
            operation: "read",
        });
        return policy !== null && satisfiesSystemRecordPolicy(params.access, policy.requirement);
    }

    return SESSION_SYSTEM_RECORD_NAMESPACES.some((namespace) => {
        const registeredKinds = Object.keys(
            SESSION_SYSTEM_RECORD_CATALOG[namespace].kinds,
        ) as SessionSystemRecordKind[];
        const candidateKinds = params.kind === undefined
            ? registeredKinds
            : registeredKinds.includes(params.kind)
                ? [params.kind]
                : [];
        return candidateKinds.some((kind) => {
            const policy = resolveV1HostPolicy({ namespace, kind, operation: "read" });
            return policy !== null && satisfiesSystemRecordPolicy(params.access, policy.requirement);
        });
    });
}

function validateUpsertParams(params: UpsertSessionSystemRecordParams): boolean {
    if (!params.actorUserId || !params.sessionId) return false;
    return LegacyHostSessionSystemRecordUpsertRequestSchema.safeParse({
        namespace: params.namespace,
        kind: params.kind,
        localId: params.localId,
        content: params.content,
    }).success;
}

function validateListParams(params: ListSessionSystemRecordsParams): boolean {
    if (!params.actorUserId || !params.sessionId) return false;
    if (!LegacyHostSessionSystemRecordListQuerySchema.safeParse({
        namespace: params.namespace,
        kind: params.kind,
        localId: params.localId,
        limit: params.limit,
        cursor: params.cursor,
    }).success) return false;
    return params.cursor === undefined || params.cursor === null || decodeCursor(params.cursor) !== null;
}

function validateLookupParams(params: GetSessionSystemRecordParams): boolean {
    if (!params.actorUserId || !params.sessionId) return false;
    return LegacyHostSessionSystemRecordLookupQuerySchema.safeParse({
        namespace: params.namespace,
        localId: params.localId,
    }).success;
}

function validateLatestParams(params: GetLatestSessionSystemRecordParams): boolean {
    if (!params.actorUserId || !params.sessionId) return false;
    return LegacyHostSessionSystemRecordLatestQuerySchema.safeParse({
        namespace: params.namespace,
        kind: params.kind,
    }).success;
}

function buildStorageModeRejection(params: Readonly<{
    storagePolicy: ReturnType<typeof readEncryptionFeatureEnv>["storagePolicy"];
    sessionEncryptionMode: "e2ee" | "plain";
    content: SessionStoredMessageContent;
}>): { ok: true } | { ok: false; code: EncryptionPolicyRejectionCode } {
    const writeKind: SessionStoredContentKind = params.content.t === "plain" ? "plain" : "encrypted";
    if (isStoredContentKindAllowedForSessionByStoragePolicy(params.storagePolicy, params.sessionEncryptionMode, writeKind)) {
        return { ok: true };
    }
    return {
        ok: false,
        code: resolveEncryptionWriteRejectionCode({
            storagePolicy: params.storagePolicy,
            sessionEncryptionMode: params.sessionEncryptionMode,
            writeKind,
        }),
    };
}

function resolveSystemRecordAccountScope(params: Readonly<{
    namespace: SessionSystemRecordNamespace;
    kind?: SessionSystemRecordKind;
    actorUserId: string;
    sessionAccountId: string | undefined;
}>): SessionRecordAccountScope {
    const policy = resolveV1HostPolicy({
        namespace: params.namespace,
        ...(params.kind ? { kind: params.kind } : {}),
        operation: "read",
    });
    return {
        accountId: policy?.accountScope === "session-owner"
            ? (params.sessionAccountId ?? params.actorUserId)
            : params.actorUserId,
    };
}

function createHostRecordListScope(params: Readonly<{
    accountId: string;
    namespace: SessionSystemRecordNamespace;
    kinds: readonly SessionSystemRecordKind[];
    localId: string | undefined;
}>): HostRecordListScope {
    const keys = deriveSessionSystemRecordAddressKeys(hostAddress(
        params.namespace,
        params.localId ?? "",
    ));
    return {
        accountId: params.accountId,
        namespace: params.namespace,
        kinds: params.kinds,
        namespaceAddressKey: keys.namespaceAddressKey,
        recordAddressKey: params.localId === undefined ? null : keys.recordAddressKey,
    };
}

function hostRecordListWhere(
    scope: HostRecordListScope,
    localId: string | undefined,
): Record<string, unknown> {
    const kinds = { in: scope.kinds };
    if (localId !== undefined && scope.recordAddressKey) {
        return {
            accountId: scope.accountId,
            recordAddressKey: scope.recordAddressKey,
            kind: kinds,
        };
    }
    return {
        accountId: scope.accountId,
        namespaceAddressKey: scope.namespaceAddressKey,
        kind: kinds,
    };
}

function isHostRowInListScope(params: Readonly<{
    row: PersistedSessionSystemRecordRow;
    scopes: readonly HostRecordListScope[];
    localId: string | undefined;
}>): boolean {
    return params.scopes.some((scope) => {
        if (params.row.accountId !== scope.accountId || !scope.kinds.includes(params.row.kind as SessionSystemRecordKind)) {
            return false;
        }
        const expected = hostAddress(scope.namespace, params.localId ?? params.row.localId);
        if (params.localId !== undefined) {
            return scope.recordAddressKey !== null
                && params.row.recordAddressKey !== null
                && bytesEqual(params.row.recordAddressKey, scope.recordAddressKey)
                && isCanonicalHostRowAtAddress(params.row, expected);
        }
        return params.row.namespaceAddressKey !== null
            && bytesEqual(params.row.namespaceAddressKey, scope.namespaceAddressKey)
            && isCanonicalHostRowAtAddress(params.row, expected);
    });
}

function persistedV1Address(pluginId: string | undefined, address: SessionSystemRecordAddress): PersistedSessionSystemRecordAddress | null {
    if (address.owner === "plugin" && !pluginId) return null;
    return {
        ownerKind: address.owner,
        pluginId: address.owner === "plugin" ? pluginId ?? null : null,
        namespace: address.namespace,
        localId: address.localId,
    };
}

// Read-only compatibility for attribution wrappers written by earlier 0.3
// development code. New writes use the canonical plain/encrypted envelope.
const StoredSessionSurfaceRecordV1Schema = createStoredReadSchema(z.strictObject({
    t: z.literal("session_surface_record_v1"),
    content: SessionSystemRecordContentSchema,
}));
const StoredSessionSystemRecordContentSchema = createStoredReadSchema(SessionSystemRecordContentSchema);

function isSurfaceItemAddress(address: Readonly<{ ownerKind: string; namespace: string }>, kind: string): boolean {
    return address.ownerKind === "host" && address.namespace === "surface" && kind === "item.v1";
}

function storedV1Record(
    row: PersistedSessionSystemRecordRow,
    expected: PersistedSessionSystemRecordAddress,
): SessionSystemRecordV1Result<{ record: SessionSystemRecordStored }> {
    const rawAddress: PersistedSessionSystemRecordAddress | null = row.ownerKind === "host" || row.ownerKind === "plugin"
        ? {
            ownerKind: row.ownerKind,
            pluginId: row.pluginId,
            namespace: row.namespace,
            localId: row.localId,
        }
        : null;
    if (!rawAddress || !sessionSystemRecordRawAddressEquals(rawAddress, expected)) {
        return { ok: false, code: "plugin_session_record_address_collision" };
    }
    const isSurfaceItem = isSurfaceItemAddress(expected, row.kind);
    const storedContent = decodeStoredContent(row);
    const wrapper = isSurfaceItem ? StoredSessionSurfaceRecordV1Schema.safeParse(storedContent) : null;
    const parsedContent = StoredSessionSystemRecordContentSchema.safeParse(wrapper?.success ? wrapper.data.content : storedContent);
    if (!parsedContent.success || !Number.isInteger(row.version) || row.version < 1 || row.version > SESSION_SYSTEM_RECORD_VERSION_MAX) {
        return { ok: false, code: "plugin_session_record_internal" };
    }
    const parsedAddress = SessionSystemRecordAddressSchema.safeParse({
        owner: expected.ownerKind,
        namespace: row.namespace,
        kind: row.kind,
        localId: row.localId,
    });
    if (!parsedAddress.success) {
        return { ok: false, code: "plugin_session_record_internal" };
    }
    let content = parsedContent.data;
    if (parsedAddress.data.owner === "host" && content.t === "plain") {
        const payload = getSessionSystemRecordStoredPayloadSchema(parsedAddress.data.namespace, parsedAddress.data.kind)?.safeParse(content.v);
        if (!payload?.success || (isSurfaceItem
            && !isSessionSurfaceItemIdentityCorrespondingV1(row.localId, payload.data as SessionSurfaceItemV1))) {
            return { ok: false, code: "plugin_session_record_internal" };
        }
        // The catalog owns payload projection; the envelope owns its JSON value contract.
        const projected = SessionSystemRecordContentSchema.safeParse({ t: "plain", v: payload.data });
        if (!projected.success) return { ok: false, code: "plugin_session_record_internal" };
        content = projected.data;
    }
    return {
        ok: true,
        record: {
            id: row.id,
            address: parsedAddress.data,
            content,
            revision: encodeSessionSystemRecordRevision({ id: row.id, version: row.version }),
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        },
    };
}

function storedV1RecordForSessionMode(
    row: PersistedSessionSystemRecordRow,
    expected: PersistedSessionSystemRecordAddress,
    sessionEncryptionMode: "e2ee" | "plain",
): SessionSystemRecordV1Result<{ record: SessionSystemRecordStored }> {
    const projected = storedV1Record(row, expected);
    if (!projected.ok) return projected;
    if ((sessionEncryptionMode === "plain") !== (projected.record.content.t === "plain")) {
        return { ok: false, code: "plugin_session_record_storage_mode_mismatch" };
    }
    return projected;
}

/** Caller must first admit the exact published message's server-stamped reference. */
export async function readPublishedSessionSurfaceItemInTx(tx: Tx, input: Readonly<{
    accountId: string;
    sessionId: string;
    itemId: string;
    encryptionMode: 'plain' | 'e2ee';
}>): Promise<SessionSystemRecordStored | null> {
    const found = await findExactHostSessionSystemRecordInTx(tx, {
        accountId: input.accountId, sessionId: input.sessionId, namespace: 'surface', localId: input.itemId,
    });
    if (!found.ok || !found.row || found.row.kind !== 'item.v1') return null;
    const projected = storedV1RecordForSessionMode(found.row, hostAddress('surface', input.itemId), input.encryptionMode);
    return projected.ok ? projected.record : null;
}

function encodeSessionSystemRecordV1Cursor(row: Pick<PersistedSessionSystemRecordRow, "updatedAt" | "id">): string {
    return Buffer.from(JSON.stringify([PLUGIN_SESSION_SYSTEM_RECORD_CURSOR_PREFIX, row.updatedAt.toISOString(), row.id]), "utf8").toString("base64url");
}

function decodeSessionSystemRecordV1Cursor(cursor: string | null | undefined): Readonly<{ updatedAt: Date; id: string }> | null {
    if (cursor === null || cursor === undefined) return null;
    try {
        const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!Array.isArray(value) || value.length !== 3 || value[0] !== PLUGIN_SESSION_SYSTEM_RECORD_CURSOR_PREFIX) return null;
        if (typeof value[1] !== "string" || typeof value[2] !== "string" || value[2].length === 0) return null;
        const updatedAt = new Date(value[1]);
        if (!Number.isFinite(updatedAt.getTime()) || updatedAt.toISOString() !== value[1]) return null;
        return { updatedAt, id: value[2] };
    } catch {
        return null;
    }
}

function satisfiesSystemRecordPolicy(access: EffectiveSessionAccess, requirement: SessionSystemRecordKindPolicy["read"]): boolean {
    if (requirement === "unavailable") return false;
    return requirement === "visible" || access.capabilities.editSessionRecords;
}

function currentSessionRecordAccessForRequirement(
    requirement: SessionSystemRecordKindPolicy["read"],
): CurrentSessionRecordAccess {
    return requirement === "edit" ? "edit" : "visible";
}

async function currentSessionRecordWhere(tx: Tx, params: Readonly<{
    actorUserId: string;
    sessionId: string;
    requiredAccess: CurrentSessionRecordAccess;
    authentication: SessionAccessAuthentication;
}>): Promise<Readonly<{ session: { is: Prisma.SessionWhereInput } }>> {
    return {
        session: {
            is: { AND: [{ id: params.sessionId }, await buildSessionAccessWhere({
                tx,
                accountId: params.actorUserId,
                capability: params.requiredAccess === "edit" ? "editSessionRecords" : "readTranscript",
                mode: "effective_access_v1",
                authentication: params.authentication,
            })] },
        },
    };
}

async function hasCurrentSessionRecordAccessInTx(
    tx: Tx,
    params: Readonly<{
        actorUserId: string;
        sessionId: string;
        requiredAccess: CurrentSessionRecordAccess;
    authentication: SessionAccessAuthentication;
    }>,
): Promise<boolean> {
    const session = await tx.session.findFirst({
        where: { AND: [{ id: params.sessionId }, await buildSessionAccessWhere({
            tx,
            accountId: params.actorUserId,
            capability: params.requiredAccess === "edit" ? "editSessionRecords" : "readTranscript",
            mode: "effective_access_v1",
            authentication: params.authentication,
        })] },
        select: { id: true },
    });
    return session !== null;
}

function hasValidRegisteredHostPlainContent(params: Readonly<{
    address: Pick<SessionSystemRecordAddress, "owner" | "namespace" | "kind">;
    content: SessionSystemRecordContent;
}>): boolean {
    if (params.address.owner !== "host" || params.content.t !== "plain") return true;
    const payloadSchema = getSessionSystemRecordPayloadSchema(params.address.namespace, params.address.kind);
    return payloadSchema?.safeParse(params.content.v).success === true;
}

function resolveV1HostPolicy(params: Readonly<{
    namespace: string;
    kind?: string;
    operation: "read" | "write" | "delete";
}>): Readonly<{ accountScope: SessionSystemRecordKindPolicy["accountScope"]; requirement: SessionSystemRecordKindPolicy["read"] }> | null {
    const catalog: SessionSystemRecordCatalog = SESSION_SYSTEM_RECORD_CATALOG;
    const definition = catalog[params.namespace];
    const policies = params.kind
        ? [getSessionSystemRecordKindPolicy(params.namespace, params.kind)]
        : Object.values(definition?.kinds ?? {}).map((kind) => kind.policy);
    if (policies.length === 0 || policies.some((policy) => policy === null)) return null;
    const concrete = policies.filter((policy): policy is SessionSystemRecordKindPolicy => policy !== null);
    const accountScope = concrete[0]?.accountScope;
    if (!accountScope || concrete.some((policy) => policy.accountScope !== accountScope)) return null;
    const requirements = concrete.map((policy) => policy[params.operation]);
    const requirement = requirements.includes("unavailable")
        ? "unavailable"
        : requirements.includes("edit") ? "edit" : "visible";
    return { accountScope, requirement };
}

type SessionSystemRecordV1Target = Readonly<{
    owner: SessionSystemRecordAddress['owner'];
    namespace: string;
    kind?: string;
    operation: 'read' | 'write' | 'delete';
}>;

async function admitV1RecordTarget(
    params: Pick<SessionSystemRecordV1BaseParams, 'actorUserId' | 'pluginId'>,
    target: SessionSystemRecordV1Target,
    reader?: Tx,
): Promise<SessionSystemRecordV1Result<object>> {
    if (!isSessionSystemRecordsProtocolV1Active()) {
        return { ok: false, code: "plugin_session_records_unavailable" };
    }
    if (
        !params.actorUserId
        || (target.owner === "plugin" && !PluginIdSchema.safeParse(params.pluginId).success)
    ) {
        return { ok: false, code: "plugin_session_record_invalid_query" };
    }
    // Layout and unqualified surface inventory belong to Board admission;
    // item existence/content belongs to the Session even when Board is off.
    // Keep the decision here for HTTP, Action and direct service readers; the
    // active protocol and canonical catalog still own access to every record.
    if (
        target.owner === "host"
        && target.namespace === "surface"
        && target.operation === "read"
        && target.kind !== "item.v1"
        && !await isServerFeatureEnabledForHome("sessions.board", { tx: reader })
    ) {
        return { ok: false, code: "plugin_session_record_feature_disabled" };
    }
    return { ok: true };
}

async function ensureV1RecordAccess(
    params: SessionSystemRecordV1BaseParams,
    target: SessionSystemRecordV1Target,
    reader?: Tx,
): Promise<SessionSystemRecordV1Result<{
    accountId: string;
    sessionId: string;
    sessionEncryptionMode: 'e2ee' | 'plain';
    currentAccess: CurrentSessionRecordAccess;
}>> {
    const targetAdmission = await admitV1RecordTarget(params, target, reader);
    if (!targetAdmission.ok) return targetAdmission;
    if (!params.sessionId) return { ok: false, code: 'plugin_session_record_invalid_query' };
    const access = await ensureSessionRecordAccess(params, reader);
    if (!access.ok) {
        return {
            ok: false,
            code: access.error === "session-not-found" ? "plugin_session_not_found" : "plugin_session_record_invalid_query",
        };
    }
    const readAdmission = async (tx: Tx): ReturnType<typeof ensureV1RecordAccess> => {
        const session = await tx.session.findUnique({
            where: { id: params.sessionId },
            select: { encryptionMode: true, accountId: true },
        });
        if (!session) return { ok: false, code: "plugin_session_not_found" as const };
        const hostPolicy = target.owner === "host"
            ? resolveV1HostPolicy(target)
            : null;
        if (target.owner === "host" && !hostPolicy) {
            return { ok: false, code: "plugin_session_record_invalid_query" as const };
        }
        if (hostPolicy && !satisfiesSystemRecordPolicy(access.access, hostPolicy.requirement)) {
            return { ok: false, code: "plugin_session_record_forbidden" as const };
        }
        return {
            ok: true as const,
            sessionId: params.sessionId,
            accountId: hostPolicy?.accountScope === "session-owner"
                ? session.accountId
                : params.actorUserId,
            sessionEncryptionMode: session.encryptionMode === "plain" ? "plain" as const : "e2ee" as const,
            currentAccess: hostPolicy
                ? currentSessionRecordAccessForRequirement(hostPolicy.requirement)
                : "visible" as const,
        };
    };
    return reader ? await readAdmission(reader) : await inTx(readAdmission);
}

async function ensureV1RecordWriteAccessInTx(tx: Tx, params: SessionSystemRecordV1BaseParams & Readonly<{
    address: SessionSystemRecordAddress;
    content: SessionSystemRecordContent;
}>) {
    const access = await ensureV1RecordAccess(params, { ...params.address, operation: "write" }, tx);
    if (!access.ok) return access;
    const storage = buildStorageModeRejection({
        storagePolicy: readEncryptionFeatureEnv(process.env).storagePolicy,
        sessionEncryptionMode: access.sessionEncryptionMode,
        content: params.content,
    });
    return storage.ok ? access : { ok: false as const, code: "plugin_session_record_invalid_query" as const };
}

type FoundV1Record = Readonly<{
    expected: PersistedSessionSystemRecordAddress;
    keys: ReturnType<typeof deriveSessionSystemRecordAddressKeys>;
    row: PersistedSessionSystemRecordRow | null;
}>;

/** Exact row scope established by admission in the consuming transaction. */
type SessionSystemRecordScopeInTx = Readonly<{ accountId: string; sessionId: string }>;

async function findV1RecordByAddress(
    tx: Tx,
    params: Pick<SessionSystemRecordV1BaseParams, "pluginId"> & Readonly<{
        address: SessionSystemRecordAddress;
    }>,
    scope: SessionSystemRecordScopeInTx,
): Promise<FoundV1Record | null> {
    const expected = persistedV1Address(params.pluginId, params.address);
    if (!expected) return null;
    const keys = deriveSessionSystemRecordAddressKeys(expected);
    const row = await tx.sessionSystemRecord.findFirst({
        where: {
            accountId: scope.accountId,
            sessionId: scope.sessionId,
            recordAddressKey: keys.recordAddressKey,
        },
        select: SESSION_SYSTEM_RECORD_SELECT,
    }) as PersistedSessionSystemRecordRow | null;
    return { expected, keys, row };
}

async function refetchV1RecordAfterMutation(
    params: SessionSystemRecordV1BaseParams & Readonly<{ address: SessionSystemRecordAddress }>,
    accountId: string,
    currentAccess: CurrentSessionRecordAccess,
): Promise<FoundV1Record | SessionSystemRecordV1Failure> {
    try {
        return reportSystemRecordResult("v1-refetch", await inReadSnapshot(async (tx) => {
            if (!await hasCurrentSessionRecordAccessInTx(tx, {
                actorUserId: params.actorUserId,
                sessionId: params.sessionId,
                requiredAccess: currentAccess,
                authentication: params.authentication,
            })) {
                return { ok: false, code: "plugin_session_record_forbidden" as const };
            }
            const found = await findV1RecordByAddress(tx, params, { accountId, sessionId: params.sessionId });
            if (!found) return { ok: false, code: "plugin_session_record_invalid_query" as const };
            return found;
        }));
    } catch (error) {
        reportSystemRecordFailure("v1-refetch", error);
        return { ok: false, code: "plugin_session_record_internal" };
    }
}

function isV1RecordRefetchFailure(
    value: FoundV1Record | SessionSystemRecordV1Failure,
): value is SessionSystemRecordV1Failure {
    return "ok" in value && value.ok === false;
}

async function resolveV1ConditionalUpsertMiss(
    params: SessionSystemRecordV1BaseParams & Readonly<{
        address: SessionSystemRecordAddress;
        content: SessionSystemRecordContent;
    }>,
    accountId: string,
    currentAccess: CurrentSessionRecordAccess,
): Promise<SessionSystemRecordV1Result<{ record: SessionSystemRecordStored }>> {
    const found = await refetchV1RecordAfterMutation(params, accountId, currentAccess);
    if (isV1RecordRefetchFailure(found)) return found;
    if (!found.row) return { ok: false, code: "plugin_session_record_revision_conflict" };
    const current = storedV1Record(found.row, found.expected);
    if (!current.ok) return reportSystemRecordResult("v1-upsert-settlement", current);
    if (found.row.kind !== params.address.kind) {
        return { ok: false, code: "plugin_session_record_kind_conflict" };
    }
    if (isDeepStrictEqual(current.record.content, params.content)) return current;
    return {
        ok: false,
        code: "plugin_session_record_revision_conflict",
        currentRevision: current.record.revision,
    };
}

async function resolveV1ConditionalDeleteMiss(
    params: SessionSystemRecordV1BaseParams & Readonly<{ address: SessionSystemRecordAddress }>,
    accountId: string,
    currentAccess: CurrentSessionRecordAccess,
): Promise<SessionSystemRecordV1Result<Record<never, never>>> {
    const found = await refetchV1RecordAfterMutation(params, accountId, currentAccess);
    if (isV1RecordRefetchFailure(found)) return found;
    if (!found.row) return { ok: true };
    const current = storedV1Record(found.row, found.expected);
    if (!current.ok) return reportSystemRecordResult("v1-delete-settlement", current);
    if (found.row.kind !== params.address.kind) {
        return { ok: false, code: "plugin_session_record_kind_conflict" };
    }
    return {
        ok: false,
        code: "plugin_session_record_revision_conflict",
        currentRevision: current.record.revision,
    };
}

async function readV1Snapshot<T>(
    params: SessionSystemRecordV1BaseParams,
    target: Parameters<typeof ensureV1RecordAccess>[1],
    read: (tx: Tx, access: Extract<Awaited<ReturnType<typeof ensureV1RecordAccess>>, { ok: true }>) => Promise<SessionSystemRecordV1Result<T>>,
): Promise<SessionSystemRecordV1Result<T>> {
    return await captureReadSnapshot<SessionSystemRecordV1Result<T>>(async tx => {
        const access = await ensureV1RecordAccess(params, target, tx);
        if (!access.ok) return access;
        return await read(tx, access);
    });
}

export async function readSessionSystemRecordV1(
    params: SessionSystemRecordV1BaseParams & Readonly<{ address: SessionSystemRecordAddress }>,
): Promise<SessionSystemRecordV1Result<{ record: SessionSystemRecordStored | null }>> {
    if (!SessionSystemRecordReadRequestSchema.safeParse({ address: params.address }).success) {
        return { ok: false, code: "plugin_session_record_invalid_query" };
    }
    try {
        return reportSystemRecordResult("v1-read", await readV1Snapshot(params, { ...params.address, operation: "read" }, async (tx, access): ReturnType<typeof readSessionSystemRecordV1> => {
            const found = await findV1RecordByAddress(tx, params, access);
            if (!found) return { ok: false, code: "plugin_session_record_invalid_query" as const };
            if (!found.row) {
                return { ok: true, record: null };
            }
            const projected = storedV1RecordForSessionMode(found.row, found.expected, access.sessionEncryptionMode);
            if (!projected.ok) return projected;
            if (found.row.kind !== params.address.kind) {
                return { ok: false, code: "plugin_session_record_kind_conflict" as const };
            }
            return projected;
        }));
    } catch (error) {
        reportSystemRecordFailure("v1-read", error);
        return { ok: false, code: "plugin_session_record_internal" };
    }
}

function actorRecordSessionSelect(actorUserId: string, context: SessionAccessProjectionContext) {
    return {
        ...buildSessionAccessProjectionSelect(actorUserId, context),
        ...createSessionDataKeyEnvelopeViewerSelect({ viewerAccountId: actorUserId }),
        createdAt: true,
        updatedAt: true,
        active: true,
        metadataVersion: true,
        agentStateVersion: true,
        metadataLayoutVersion: true,
    } as const satisfies Prisma.SessionSelect;
}

type ActorRecordSession = Omit<Prisma.SessionGetPayload<{ select: ReturnType<typeof actorRecordSessionSelect> }>, 'encryptionMode'>
    & Readonly<{ encryptionMode: 'plain' | 'e2ee' }>;
type ActorSessionSystemRecordRead = SessionSystemRecordV1Result<{
    session: ActorRecordSession;
    access: EffectiveSessionAccess;
    records: readonly Readonly<{ address: SessionSystemRecordAddress; record: SessionSystemRecordStored | null }>[];
}> & Readonly<{ cause?: unknown }>;

/** Actor records share address admission, batched Session access and mode parsing with scalar reads. */
export async function readActorSessionSystemRecordsV1(
    params: Omit<SessionSystemRecordV1BaseParams, 'sessionId'> & Readonly<{
        sessionIds: readonly string[];
        addresses: readonly SessionSystemRecordAddress[];
    }>,
): Promise<ReadonlyMap<string, ActorSessionSystemRecordRead>> {
    const ids = [...new Set(params.sessionIds)];
    const failed = (failure: SessionSystemRecordV1Failure & Readonly<{ cause?: unknown }>) => new Map<string, ActorSessionSystemRecordRead>(ids.map(id => [id, failure]));
    if (!ids.length) return new Map();
    if (params.addresses.some(address => !SessionSystemRecordReadRequestSchema.safeParse({ address }).success) || ids.some(id => !id)) {
        return failed({ ok: false, code: 'plugin_session_record_invalid_query' });
    }
    try {
        const targets: Array<Readonly<{
            address: SessionSystemRecordAddress;
            policy: ReturnType<typeof resolveV1HostPolicy>;
            expected: PersistedSessionSystemRecordAddress;
            keys: ReturnType<typeof deriveSessionSystemRecordAddressKeys>;
            key: string;
        }>> = [];
        for (const address of params.addresses) {
            const policy = address.owner === 'host' ? resolveV1HostPolicy({ ...address, operation: 'read' }) : null;
            // This set read serves actor-owned projections; owner-scoped records retain their existing reader.
            if (address.owner === 'host' && (!policy || policy.accountScope !== 'actor')) {
                return failed({ ok: false, code: 'plugin_session_record_invalid_query' });
            }
            const admission = await admitV1RecordTarget(params, { ...address, operation: 'read' });
            if (!admission.ok) return failed(admission);
            const expected = persistedV1Address(params.pluginId, address);
            if (!expected) return failed({ ok: false, code: 'plugin_session_record_invalid_query' });
            const keys = deriveSessionSystemRecordAddressKeys(expected);
            targets.push({ address, policy, expected, keys, key: Buffer.from(keys.recordAddressKey).toString('hex') });
        }
        const results = new Map<string, ActorSessionSystemRecordRead>();
        for (let offset = 0; offset < ids.length; offset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
            const batch = ids.slice(offset, offset + SESSION_ACCESS_SESSION_BATCH_SIZE);
            try {
                const { admitted, records } = await captureReadSnapshot(async tx => {
                    const sessions = await tx.session.findMany({ where: { id: { in: batch } }, select: withSessionContentSelect(actorRecordSessionSelect(params.actorUserId,
                        await readSessionAccessProjectionContextInTx(tx, [params.actorUserId]))) }).then(decodeSessionStoredContent);
                    const decisions = await resolveSessionAccessForRowsInTx(tx, { accountId: params.actorUserId,
                        authentication: params.authentication, capability: 'readTranscript' }, sessions);
                    for (const id of batch) results.set(id, { ok: false, code: 'plugin_session_not_found' });
                    const admitted = sessions.flatMap(session => {
                        const decision = decisions.get(session.id);
                        if (decision?.status !== 'allowed') return [];
                        if (targets.some(({ policy }) => policy && !satisfiesSystemRecordPolicy(decision.access, policy.requirement))) {
                            results.set(session.id, { ok: false, code: 'plugin_session_record_forbidden' });
                            return [];
                        }
                        return [{ session, access: decision.access }];
                    });
                    const records = admitted.length && targets.length ? await tx.sessionSystemRecord.findMany({ where: {
                        accountId: params.actorUserId, sessionId: { in: admitted.map(row => row.session.id) },
                        recordAddressKey: { in: targets.map(target => target.keys.recordAddressKey) },
                    }, select: SESSION_SYSTEM_RECORD_SELECT }) : [];
                    return { admitted, records };
                });
                const bySession = new Map<string, Map<string, typeof records[number]>>();
                for (const row of records) {
                    const rows = bySession.get(row.sessionId) ?? new Map<string, typeof row>();
                    rows.set(Buffer.from(row.recordAddressKey).toString('hex'), row);
                    bySession.set(row.sessionId, rows);
                }
                for (const { session, access } of admitted) {
                    if (session.encryptionMode !== 'plain' && session.encryptionMode !== 'e2ee') {
                        results.set(session.id, { ok: false, code: 'plugin_session_record_storage_mode_mismatch' });
                        continue;
                    }
                    const projectedRecords: Array<Readonly<{ address: SessionSystemRecordAddress; record: SessionSystemRecordStored | null }>> = [];
                    let failure: SessionSystemRecordV1Failure | undefined;
                    for (const target of targets) {
                        const row = bySession.get(session.id)?.get(target.key);
                        const projected = row ? storedV1RecordForSessionMode(row, target.expected, session.encryptionMode) : { ok: true as const, record: null };
                        if (!projected.ok) { failure = projected; break; }
                        if (row && row.kind !== target.address.kind) {
                            failure = { ok: false, code: 'plugin_session_record_kind_conflict' };
                            break;
                        }
                        projectedRecords.push({ address: target.address, record: projected.record });
                    }
                    results.set(session.id, failure ?? { ok: true,
                        session: { ...session, encryptionMode: session.encryptionMode }, access, records: projectedRecords });
                }
            } catch (error) {
                reportSystemRecordFailure('v1-batch-read', error);
                for (const id of batch) results.set(id, { ok: false, code: 'plugin_session_record_internal', cause: error });
            }
        }
        return results;
    } catch (error) {
        reportSystemRecordFailure('v1-batch-read', error);
        return failed({ ok: false, code: 'plugin_session_record_internal', cause: error });
    }
}

/** Count the stored item population without opening content or materializing rows. */
export async function countSessionBoardItemsV1(
    params: SessionSystemRecordV1BaseParams,
): Promise<SessionSystemRecordV1Result<{ count: number }>> {
    const keys = deriveSessionSystemRecordAddressKeys(hostAddress('surface', ''));
    try {
        return reportSystemRecordResult('v1-count', await readV1Snapshot<{ count: number }>(params, {
            owner: 'host', namespace: 'surface', kind: 'item.v1', operation: 'read',
        }, async (tx, access) => {
            const count = await tx.sessionSystemRecord.count({ where: {
                accountId: access.accountId,
                sessionId: params.sessionId,
                ownerKind: 'host', pluginId: null, namespace: 'surface', kind: 'item.v1',
                namespaceAddressKey: keys.namespaceAddressKey,
                ...await currentSessionRecordWhere(tx, {
                    actorUserId: params.actorUserId, sessionId: params.sessionId,
                    requiredAccess: 'visible', authentication: params.authentication,
                }),
            } });
            if (count === 0 && !await hasCurrentSessionRecordAccessInTx(tx, {
                actorUserId: params.actorUserId, sessionId: params.sessionId,
                requiredAccess: 'visible', authentication: params.authentication,
            })) return { ok: false as const, code: 'plugin_session_record_forbidden' as const };
            return { ok: true as const, count };
        }));
    } catch (error) {
        reportSystemRecordFailure('v1-count', error);
        return { ok: false, code: 'plugin_session_record_internal' };
    }
}

export async function listSessionSystemRecordsV1(
    params: SessionSystemRecordV1BaseParams & Readonly<{ query: SessionSystemRecordListQuery }>,
): Promise<SessionSystemRecordV1Result<{ page: Readonly<{
    records: readonly SessionSystemRecordStored[];
    nextCursor: string | null;
    hasNext: boolean;
}> }>> {
    const parsed = SessionSystemRecordListQuerySchema.safeParse(params.query);
    if (!parsed.success) {
        return { ok: false, code: "plugin_session_record_invalid_query" };
    }
    const cursor = decodeSessionSystemRecordV1Cursor(parsed.data.cursor);
    if (parsed.data.cursor !== null && parsed.data.cursor !== undefined && !cursor) {
        return { ok: false, code: "plugin_session_record_invalid_query" };
    }
    const exactLocalId = parsed.data.localId;
    const expectedAddress: PersistedSessionSystemRecordAddress = {
        ownerKind: parsed.data.owner,
        pluginId: parsed.data.owner === "plugin" ? params.pluginId ?? null : null,
        namespace: parsed.data.namespace,
        localId: exactLocalId ?? "",
    };
    const keys = deriveSessionSystemRecordAddressKeys(expectedAddress);
    try {
        return reportSystemRecordResult("v1-list", await readV1Snapshot(params, {
                owner: parsed.data.owner,
                namespace: parsed.data.namespace,
                ...(parsed.data.kind ? { kind: parsed.data.kind } : {}),
                operation: "read",
            }, async (tx, access): ReturnType<typeof listSessionSystemRecordsV1> => {
            const rows = await tx.sessionSystemRecord.findMany({
                where: {
                    accountId: access.accountId,
                    sessionId: params.sessionId,
                    ...await currentSessionRecordWhere(tx, {
                        actorUserId: params.actorUserId,
                        sessionId: params.sessionId,
                        requiredAccess: "visible",
                        authentication: params.authentication,
                    }),
                    ...(exactLocalId !== undefined
                        ? { recordAddressKey: keys.recordAddressKey }
                        : { namespaceAddressKey: keys.namespaceAddressKey }),
                    ...(parsed.data.kind ? { kind: parsed.data.kind } : {}),
                    ...(cursor ? {
                        OR: [
                            { updatedAt: { lt: cursor.updatedAt } },
                            { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
                        ],
                    } : {}),
                },
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
                take: parsed.data.limit + 1,
                select: SESSION_SYSTEM_RECORD_SELECT,
            }) as PersistedSessionSystemRecordRow[];
            if (rows.length === 0 && !await hasCurrentSessionRecordAccessInTx(tx, {
                actorUserId: params.actorUserId,
                sessionId: params.sessionId,
                requiredAccess: "visible",
                authentication: params.authentication,
            })) {
                return { ok: false, code: "plugin_session_record_forbidden" as const };
            }
            const pageRows = rows.slice(0, parsed.data.limit);
            const projectedRows: SessionSystemRecordStored[] = [];
            // The extra row is only a continuation witness. Validating it as
            // part of this page would let a corrupt next-page row suppress
            // otherwise valid records the caller actually requested.
            for (const row of pageRows) {
                const projected = storedV1RecordForSessionMode(row, {
                    ...expectedAddress,
                    localId: exactLocalId ?? row.localId,
                }, access.sessionEncryptionMode);
                if (!projected.ok) return projected;
                projectedRows.push(projected.record);
            }
            const hasNext = rows.length > parsed.data.limit;
            const last = pageRows.at(-1);
            return {
                ok: true,
                page: {
                    records: projectedRows,
                    nextCursor: hasNext && last ? encodeSessionSystemRecordV1Cursor(last) : null,
                    hasNext,
                },
            };
        }));
    } catch (error) {
        reportSystemRecordFailure("v1-list", error);
        return { ok: false, code: "plugin_session_record_internal" };
    }
}

async function settleV1CreateRace(
    params: SessionSystemRecordV1BaseParams & Readonly<{
        address: SessionSystemRecordAddress;
        content: SessionSystemRecordContent;
    }>,
    accountId: string,
    currentAccess: CurrentSessionRecordAccess,
): Promise<SessionSystemRecordV1Result<{ record: SessionSystemRecordStored }>> {
    const raced = await refetchV1RecordAfterMutation(params, accountId, currentAccess);
    if (isV1RecordRefetchFailure(raced)) return raced;
    if (!raced.row) return reportSystemRecordResult("v1-upsert-settlement", { ok: false, code: "plugin_session_record_internal" });
    const replay = storedV1Record(raced.row, raced.expected);
    if (!replay.ok) return reportSystemRecordResult("v1-upsert-settlement", replay);
    if (raced.row.kind !== params.address.kind) {
        return { ok: false, code: "plugin_session_record_kind_conflict" };
    }
    if (isDeepStrictEqual(replay.record.content, params.content)) return replay;
    return {
        ok: false,
        code: "plugin_session_record_revision_conflict",
        currentRevision: replay.record.revision,
    };
}

async function settleV1UnconditionalCreateRace(
    params: SessionSystemRecordV1BaseParams & Readonly<{
        address: SessionSystemRecordAddress;
        content: SessionSystemRecordContent;
    }>,
): Promise<SessionSystemRecordV1Result<{ record: SessionSystemRecordStored }>> {
    try {
        return reportSystemRecordResult("v1-upsert-settlement", await inSessionSystemRecordMutation(params, async (tx) => {
            const access = await ensureV1RecordWriteAccessInTx(tx, params);
            if (!access.ok) return access;
            const { accountId, currentAccess } = access;
            const raced = await findV1RecordByAddress(tx, params, access);
            if (!raced) return { ok: false, code: "plugin_session_record_invalid_query" as const };
            const currentRow = raced.row;
            if (!currentRow) return { ok: false, code: "plugin_session_record_internal" as const };
            const current = storedV1Record(currentRow, raced.expected);
            if (!current.ok) return current;
            if (currentRow.kind !== params.address.kind) return { ok: false, code: "plugin_session_record_kind_conflict" as const };
            if (isDeepStrictEqual(current.record.content, params.content)) return current;
            if (currentRow.version >= SESSION_SYSTEM_RECORD_VERSION_MAX) return { ok: false, code: "plugin_session_record_revision_exhausted" as const };
            const updated = await tx.sessionSystemRecord.updateMany({
                where: {
                    accountId,
                    sessionId: params.sessionId,
                    recordAddressKey: raced.keys.recordAddressKey,
                    id: currentRow.id,
                    ...await currentSessionRecordWhere(tx, {
                        actorUserId: params.actorUserId,
                        sessionId: params.sessionId,
                        requiredAccess: currentAccess,
                        authentication: params.authentication,
                    }),
                },
                data: { ...systemRecordContentForStorage(params.content), version: { increment: 1 } },
            });
            if (updated.count !== 1) {
                if (!await hasCurrentSessionRecordAccessInTx(tx, {
                    actorUserId: params.actorUserId,
                    sessionId: params.sessionId,
                    requiredAccess: currentAccess,
                    authentication: params.authentication,
                })) {
                    return { ok: false, code: "plugin_session_record_forbidden" as const };
                }
                return { ok: false, code: "plugin_session_record_internal" as const };
            }
            await publishHostRecordChangeInTx(tx, { ...params, accountId, recordId: currentRow.id });
            const next = await tx.sessionSystemRecord.findFirst({
                where: {
                    accountId,
                    sessionId: params.sessionId,
                    recordAddressKey: raced.keys.recordAddressKey,
                    ...await currentSessionRecordWhere(tx, {
                        actorUserId: params.actorUserId,
                        sessionId: params.sessionId,
                        requiredAccess: "visible",
                        authentication: params.authentication,
                    }),
                },
                select: SESSION_SYSTEM_RECORD_SELECT,
            }) as PersistedSessionSystemRecordRow | null;
            return next
                ? storedV1Record(next, raced.expected)
                : { ok: false, code: "plugin_session_record_internal" as const };
        }));
    } catch (error) {
        reportSystemRecordFailure("v1-upsert-settlement", error);
        return { ok: false, code: "plugin_session_record_internal" };
    }
}

type V1UpsertMutationRace = Readonly<{
    kind: "retry-unconditional-upsert" | "refetch-conditional-upsert-conflict";
}>;

function isV1UpsertMutationRace(
    value: SessionSystemRecordV1Result<{ record: SessionSystemRecordStored }> | V1UpsertMutationRace,
): value is V1UpsertMutationRace {
    return "kind" in value
        && (value.kind === "retry-unconditional-upsert" || value.kind === "refetch-conditional-upsert-conflict");
}

export async function upsertSessionSystemRecordV1(
    params: SessionSystemRecordV1BaseParams & Readonly<{
        address: SessionSystemRecordAddress;
        content: SessionSystemRecordContent;
        expectedRevision?: SessionSystemRecordRevision | null;
    }>,
): Promise<SessionSystemRecordV1Result<{ record: SessionSystemRecordStored }>> {
    return await upsertSessionSystemRecordV1Attempt(params, true);
}

async function upsertSessionSystemRecordV1InTx(
    tx: Tx,
    params: SessionSystemRecordV1BaseParams & Readonly<{ address: SessionSystemRecordAddress; content: SessionSystemRecordContent; expectedRevision?: SessionSystemRecordRevision | null }>,
    access: SessionSystemRecordScopeInTx,
): Promise<SessionSystemRecordV1Result<{ record: SessionSystemRecordStored }> | V1UpsertMutationRace> {
    const found = await findV1RecordByAddress(tx, params, access);
    if (!found) return { ok: false, code: "plugin_session_record_invalid_query" as const };
    const current = found.row;
    if (current) {
        const projected = storedV1Record(current, found.expected);
        if (!projected.ok) return projected;
        if (current.kind !== params.address.kind) {
            return { ok: false, code: "plugin_session_record_kind_conflict" as const };
        }
        let sameEnvelope = isDeepStrictEqual(projected.record.content, params.content);
        if (params.address.owner === "host" && projected.record.content.t === "plain" && params.content.t === "plain") {
            // Stored payload projection may supply canonical defaults. Compare
            // both sides through that same codec, without changing write bytes.
            const codec = getSessionSystemRecordStoredPayloadSchema(params.address.namespace, params.address.kind);
            const currentPayload = codec?.safeParse(projected.record.content.v);
            const requestedPayload = codec?.safeParse(params.content.v);
            sameEnvelope = currentPayload?.success === true && requestedPayload?.success === true
                && isDeepStrictEqual(currentPayload.data, requestedPayload.data);
        }
        const expected = params.expectedRevision === undefined || params.expectedRevision === null
            ? null
            : parseSessionSystemRecordRevision(params.expectedRevision);
        if (params.expectedRevision === null) {
            if (sameEnvelope) return projected;
            return { ok: false, code: "plugin_session_record_revision_conflict" as const, currentRevision: projected.record.revision };
        }
        if (expected && (expected.id !== current.id || expected.version !== current.version)) {
            if (sameEnvelope) return projected;
            return { ok: false, code: "plugin_session_record_revision_conflict" as const, currentRevision: projected.record.revision };
        }
        if (sameEnvelope) return projected;
        if (current.version >= SESSION_SYSTEM_RECORD_VERSION_MAX) {
            return { ok: false, code: "plugin_session_record_revision_exhausted" as const };
        }
        const updated = await tx.sessionSystemRecord.updateMany({
            where: {
                accountId: access.accountId,
                sessionId: access.sessionId,
                recordAddressKey: found.keys.recordAddressKey,
                id: current.id,
                ...(params.expectedRevision === undefined ? {} : { version: current.version }),
            },
            data: { ...systemRecordContentForStorage(params.content), version: { increment: 1 } },
        });
        if (updated.count !== 1) {
            return {
                kind: params.expectedRevision === undefined
                    ? "retry-unconditional-upsert" as const
                    : "refetch-conditional-upsert-conflict" as const,
            };
        }
        await publishHostRecordChangeInTx(tx, { ...params, ...access, recordId: current.id });
        const next = await tx.sessionSystemRecord.findFirst({
            where: {
                accountId: access.accountId,
                sessionId: access.sessionId,
                recordAddressKey: found.keys.recordAddressKey,
            },
            select: SESSION_SYSTEM_RECORD_SELECT,
        }) as PersistedSessionSystemRecordRow | null;
        return next ? storedV1Record(next, found.expected) : { ok: false, code: "plugin_session_record_internal" as const };
    }

    if (params.expectedRevision !== undefined && params.expectedRevision !== null) {
        return { ok: false, code: "plugin_session_record_revision_conflict" };
    }
    const created = await tx.sessionSystemRecord.create({
        data: {
            accountId: access.accountId,
            sessionId: access.sessionId,
            ownerKind: found.expected.ownerKind,
            pluginId: found.expected.pluginId,
            namespace: params.address.namespace,
            kind: params.address.kind,
            localId: params.address.localId,
            ...systemRecordContentForStorage(params.content),
            namespaceAddressKey: found.keys.namespaceAddressKey,
            recordAddressKey: found.keys.recordAddressKey,
            version: 1,
        },
        select: SESSION_SYSTEM_RECORD_SELECT,
    }) as PersistedSessionSystemRecordRow;
    await publishHostRecordChangeInTx(tx, { ...params, ...access, recordId: created.id });
    return storedV1Record(created, found.expected);
}

async function upsertSessionSystemRecordV1Attempt(
    params: SessionSystemRecordV1BaseParams & Readonly<{
        address: SessionSystemRecordAddress;
        content: SessionSystemRecordContent;
        expectedRevision?: SessionSystemRecordRevision | null;
    }>,
    retryUnconditionalSettlement: boolean,
): Promise<SessionSystemRecordV1Result<{ record: SessionSystemRecordStored }>> {
    if (
        !SessionSystemRecordAddressSchema.safeParse(params.address).success
        || !SessionSystemRecordContentSchema.safeParse(params.content).success
        || (params.expectedRevision !== undefined && params.expectedRevision !== null
            && !SessionSystemRecordRevisionSchema.safeParse(params.expectedRevision).success)
    ) {
        return { ok: false, code: "plugin_session_record_invalid_query" };
    }
    if (!hasValidRegisteredHostPlainContent({
        address: params.address,
        content: params.content,
    })) {
        return { ok: false, code: "plugin_session_record_invalid_query" };
    }
    const access = await ensureV1RecordAccess(params, { ...params.address, operation: "write" });
    if (!access.ok) return access;
    const storageMode = buildStorageModeRejection({
        storagePolicy: readEncryptionFeatureEnv(process.env).storagePolicy,
        sessionEncryptionMode: access.sessionEncryptionMode,
        content: params.content,
    });
    if (!storageMode.ok) return { ok: false, code: "plugin_session_record_invalid_query" };

    let outcome: SessionSystemRecordV1Result<{ record: SessionSystemRecordStored }> | V1UpsertMutationRace;
    try {
        outcome = await inSessionSystemRecordMutation(params, async tx => {
            const admitted = await ensureV1RecordWriteAccessInTx(tx, params);
            return admitted.ok ? await upsertSessionSystemRecordV1InTx(tx, params, admitted) : admitted;
        });
    } catch (error) {
        if (!isPrismaErrorCode(error, "P2002")) {
            reportSystemRecordFailure("v1-upsert", error);
            return { ok: false, code: "plugin_session_record_internal" };
        }
        if (params.expectedRevision === undefined) {
            return retryUnconditionalSettlement
                ? await upsertSessionSystemRecordV1Attempt(params, false)
                : await settleV1UnconditionalCreateRace(params);
        }
        return await settleV1CreateRace(params, access.accountId, access.currentAccess);
    }
    if (!isV1UpsertMutationRace(outcome)) return reportSystemRecordResult("v1-upsert", outcome);
    if (outcome.kind === "retry-unconditional-upsert") {
        if (retryUnconditionalSettlement) {
            return await upsertSessionSystemRecordV1Attempt(params, false);
        }
        return reportSystemRecordResult("v1-upsert-settlement", { ok: false, code: "plugin_session_record_internal" });
    }
    return await resolveV1ConditionalUpsertMiss(params, access.accountId, access.currentAccess);
}

async function settleV1UnconditionalDeleteMiss(
    params: SessionSystemRecordV1BaseParams & Readonly<{
        address: SessionSystemRecordAddress;
    }>,
): Promise<SessionSystemRecordV1Result<Record<never, never>>> {
    try {
        return reportSystemRecordResult("v1-delete-settlement", await inSessionSystemRecordMutation(params, async (tx) => {
            const access = await ensureV1RecordAccess(params, { ...params.address, operation: "delete" }, tx);
            if (!access.ok) return access;
            const { accountId, currentAccess } = access;
            const found = await findV1RecordByAddress(tx, params, access);
            if (!found) return { ok: false, code: "plugin_session_record_invalid_query" as const };
            if (!found.row) return { ok: true };
            const current = storedV1Record(found.row, found.expected);
            if (!current.ok) return current;
            if (found.row.kind !== params.address.kind) return { ok: false, code: "plugin_session_record_kind_conflict" as const };
            const deleted = await tx.sessionSystemRecord.deleteMany({
                where: {
                    accountId,
                    sessionId: params.sessionId,
                    recordAddressKey: found.keys.recordAddressKey,
                    id: found.row!.id,
                    ...await currentSessionRecordWhere(tx, {
                        actorUserId: params.actorUserId,
                        sessionId: params.sessionId,
                        requiredAccess: currentAccess,
                        authentication: params.authentication,
                    }),
                },
            });
            if (deleted.count === 1) {
                await publishHostRecordChangeInTx(tx, { ...params, accountId, recordId: found.row.id });
                return { ok: true };
            }
            if (!await hasCurrentSessionRecordAccessInTx(tx, {
                actorUserId: params.actorUserId,
                sessionId: params.sessionId,
                requiredAccess: currentAccess,
                authentication: params.authentication,
            })) {
                return { ok: false, code: "plugin_session_record_forbidden" as const };
            }
            return { ok: false, code: "plugin_session_record_internal" as const };
        }));
    } catch (error) {
        reportSystemRecordFailure("v1-delete-settlement", error);
        return { ok: false, code: "plugin_session_record_internal" };
    }
}

type V1DeleteMutationRace = Readonly<{
    kind: "settle-unconditional-delete" | "refetch-conditional-delete-conflict";
}>;

function isV1DeleteMutationRace(
    value: SessionSystemRecordV1Result<Record<never, never>> | V1DeleteMutationRace,
): value is V1DeleteMutationRace {
    return "kind" in value
        && (value.kind === "settle-unconditional-delete" || value.kind === "refetch-conditional-delete-conflict");
}

async function deleteSessionSystemRecordV1InTx(
    tx: Tx,
    params: SessionSystemRecordV1BaseParams & Readonly<{ address: SessionSystemRecordAddress; expectedRevision?: SessionSystemRecordRevision; }>,
    access: SessionSystemRecordScopeInTx,
): Promise<SessionSystemRecordV1Result<Record<never, never>> | V1DeleteMutationRace> {
    const found = await findV1RecordByAddress(tx, params, access);
    if (!found) return { ok: false, code: "plugin_session_record_invalid_query" as const };
    if (!found.row) {
        return { ok: true };
    }
    const projected = storedV1Record(found.row, found.expected);
    if (!projected.ok) return projected;
    if (found.row.kind !== params.address.kind) {
        return { ok: false, code: "plugin_session_record_kind_conflict" as const };
    }
    const revision = params.expectedRevision ? parseSessionSystemRecordRevision(params.expectedRevision) : null;
    if (params.expectedRevision && (!revision || revision.id !== found.row.id || revision.version !== found.row.version)) {
        return { ok: false, code: "plugin_session_record_revision_conflict" as const, currentRevision: projected.record.revision };
    }
    const deleted = await tx.sessionSystemRecord.deleteMany({
        where: {
            accountId: access.accountId,
            sessionId: access.sessionId,
            recordAddressKey: found.keys.recordAddressKey,
            id: found.row.id,
            ...(revision ? { version: revision.version } : {}),
        },
    });
    if (deleted.count === 1) {
        await publishHostRecordChangeInTx(tx, { ...params, ...access, recordId: found.row.id });
        return { ok: true };
    }
    return {
        kind: params.expectedRevision === undefined
            ? "settle-unconditional-delete" as const
            : "refetch-conditional-delete-conflict" as const,
    };
}

export async function deleteSessionSystemRecordV1(
    params: SessionSystemRecordV1BaseParams & Readonly<{
        address: SessionSystemRecordAddress;
        expectedRevision?: SessionSystemRecordRevision;
    }>,
): Promise<SessionSystemRecordV1Result<Record<never, never>>> {
    if (!SessionSystemRecordDeleteRequestSchema.safeParse({
        address: params.address,
        expectedRevision: params.expectedRevision,
    }).success) {
        return { ok: false, code: "plugin_session_record_invalid_query" };
    }
    const access = await ensureV1RecordAccess(params, { ...params.address, operation: "delete" });
    if (!access.ok) return access;
    let outcome: SessionSystemRecordV1Result<Record<never, never>> | V1DeleteMutationRace;
    try {
        outcome = await inSessionSystemRecordMutation(params, async tx => {
            const admitted = await ensureV1RecordAccess(params, { ...params.address, operation: "delete" }, tx);
            return admitted.ok ? await deleteSessionSystemRecordV1InTx(tx, params, admitted) : admitted;
        });
    } catch (error) {
        reportSystemRecordFailure("v1-delete", error);
        return { ok: false, code: "plugin_session_record_internal" };
    }
    if (!isV1DeleteMutationRace(outcome)) return reportSystemRecordResult("v1-delete", outcome);
    if (outcome.kind === "settle-unconditional-delete") {
        return await settleV1UnconditionalDeleteMiss(params);
    }
    return await resolveV1ConditionalDeleteMiss(params, access.accountId, access.currentAccess);
}

type SessionBoardRecordReadResult = SessionSystemRecordV1Result<{ record: SessionSystemRecordStored | null }>
    | Readonly<{ ok: false; code: "session_system_record_storage_mode_mismatch" }>;

interface SessionBoardRecordScopeInTx {
    /** null identifies the fixed layout; a string identifies an item. */
    validateContent(localId: string | null, content: SessionSystemRecordContent): "invalid" | "storage_mode_mismatch" | null;
    read(localId: string | null): Promise<SessionBoardRecordReadResult>;
    upsert(localId: string | null, content: SessionSystemRecordContent, expectedRevision: SessionSystemRecordRevision | null): ReturnType<typeof upsertSessionSystemRecordV1InTx>;
    remove(localId: string, expectedRevision: SessionSystemRecordRevision): ReturnType<typeof deleteSessionSystemRecordV1InTx>;
}

type SessionBoardRecordScopeResult =
    | (Readonly<{ ok: true }> & SessionBoardRecordScopeInTx)
    | Readonly<{ ok: false; code: "plugin_session_record_feature_disabled" | "plugin_session_record_forbidden" }>;

/**
 * Mint the typed Board's exact-Session record scope inside its transaction.
 * Generic CRUD never receives this scope: its catalog policy remains unavailable.
 * Both callers use the same conditional row operations above.
 */
export async function resolveSessionBoardRecordsInTx(tx: Tx, params: Readonly<{ actorUserId: string; sessionId: string; authentication: SessionAccessAuthentication; requiresLayout: boolean }>): Promise<SessionBoardRecordScopeResult> {
    if (!isSessionSystemRecordsProtocolV1Active() || (params.requiresLayout && !await isServerFeatureEnabledForHome("sessions.board", { tx }))) {
        return { ok: false, code: "plugin_session_record_feature_disabled" };
    }
    const authority = await resolveEffectiveSessionAccess(tx, { accountId: params.actorUserId, sessionId: params.sessionId, authentication: params.authentication });
    if (!authority?.capabilities.editSessionRecords) return { ok: false, code: "plugin_session_record_forbidden" };
    const session = await tx.session.findUnique({ where: { id: params.sessionId }, select: { accountId: true, encryptionMode: true } });
    if (!session) return { ok: false, code: "plugin_session_record_forbidden" };
    const access = { accountId: session.accountId, sessionId: params.sessionId };
    const matchesPersistedMode = (content: SessionSystemRecordContent) =>
        (session.encryptionMode === "plain") === (content.t === "plain");
    const address = (localId: string | null): SessionSystemRecordAddress => ({
        owner: "host", namespace: "surface", kind: localId === null ? "layout.v1" : "item.v1", localId: localId ?? "layout",
    });
    return {
        ok: true,
        validateContent(localId: string | null, content: SessionSystemRecordContent): "invalid" | "storage_mode_mismatch" | null {
            const boardContentSchema = localId === null
                ? SessionBoardLayoutRecordContentV1Schema
                : SessionBoardItemRecordContentV1Schema;
            if (!boardContentSchema.safeParse(content).success) return "invalid";
            if (!matchesPersistedMode(content)) return "storage_mode_mismatch";
            const storage = buildStorageModeRejection({ storagePolicy: readEncryptionFeatureEnv(process.env).storagePolicy,
                sessionEncryptionMode: session.encryptionMode === "plain" ? "plain" : "e2ee", content });
            if (!storage.ok) return "storage_mode_mismatch";
            return hasValidRegisteredHostPlainContent({ address: address(localId), content }) ? null : "invalid";
        },
        async read(localId: string | null): Promise<SessionBoardRecordReadResult> {
            const found = await findV1RecordByAddress(tx, { ...params, address: address(localId) }, access);
            if (!found) return { ok: false, code: "plugin_session_record_invalid_query" };
            if (!found.row) return { ok: true, record: null };
            if (found.row.kind !== address(localId).kind) return { ok: false, code: "plugin_session_record_kind_conflict" };
            const projected = storedV1Record(found.row, found.expected);
            if (projected.ok && !matchesPersistedMode(projected.record.content)) {
                return { ok: false, code: "session_system_record_storage_mode_mismatch" };
            }
            return projected;
        },
        async upsert(localId: string | null, content: SessionSystemRecordContent, expectedRevision: SessionSystemRecordRevision | null) {
            return await upsertSessionSystemRecordV1InTx(tx, { ...params, address: address(localId), content, expectedRevision }, access);
        },
        async remove(localId: string, expectedRevision: SessionSystemRecordRevision) {
            return await deleteSessionSystemRecordV1InTx(tx, { ...params, address: address(localId), expectedRevision }, access);
        },
    };
}

/**
 * Permission mediation is the one approved host-owned consumer of the
 * system-record address contract.  These helpers deliberately keep the
 * namespace, owner and supported kinds private: account authentication is not
 * plugin identity authentication, so the generic plugin CRUD path must never
 * be used for these records.
 */
type PermissionMediationRecordErrorCode =
    | "permission_mediation_records_unavailable"
    | "permission_mediation_record_invalid"
    | "permission_mediation_record_forbidden"
    | "permission_mediation_session_not_found"
    | "permission_mediation_record_conflict"
    | "permission_mediation_record_internal";

type PermissionMediationRecordResult<T> =
    | Readonly<{ ok: true } & T>
    | PermissionMediationRecordFailure;

type PermissionMediationRecordFailure = Readonly<{
    ok: false;
    code: PermissionMediationRecordErrorCode;
    currentRevision?: SessionSystemRecordRevision;
}>;

export type PermissionMediationRecordAccessParams = Readonly<{
    actorUserId: string;
    sessionId: string;
    authentication: SessionAccessAuthentication;
}>;

export type ReadPermissionMediationRecordParams = PermissionMediationRecordAccessParams & Readonly<{
    identity: SessionPermissionMediationRecordIdentityV1;
}>;

export type WritePermissionMediationRecordParams = PermissionMediationRecordAccessParams & Readonly<{
    identity: SessionPermissionMediationRecordIdentityV1;
    request: SessionPermissionMediationRecordWriteRequest;
}>;

export type PrunePermissionMediationRecordParams = PermissionMediationRecordAccessParams & Readonly<{
    identity: SessionPermissionMediationRecordIdentityV1;
    request: SessionPermissionMediationRecordPruneRequest;
}>;

export type ListPermissionMediationRecordsParams = PermissionMediationRecordAccessParams & Readonly<{
    query: SessionPermissionMediationRecordListQuery;
}>;

type PermissionMediationRecordPage = Readonly<{
    records: readonly SessionPermissionMediationRecordStored[];
    nextCursor: string | null;
    hasNext: boolean;
}>;

const PERMISSION_MEDIATION_RECORD_CURSOR_PREFIX = "pmr1";
function permissionMediationLocalId(
    identity: SessionPermissionMediationRecordIdentityV1,
): string {
    return deriveSessionPermissionMediationRecordLocatorV1(identity);
}

function permissionMediationAddress(
    identity: SessionPermissionMediationRecordIdentityV1,
): PersistedSessionSystemRecordAddress {
    // Session scope is enforced by the route and the table's session partition;
    // the bounded locator keys the exact causal tuple persisted on this row.
    return hostAddress(
        SESSION_PERMISSION_SYSTEM_RECORD_NAMESPACE,
        permissionMediationLocalId(identity),
    );
}

function permissionMediationNamespaceAddress(): PersistedSessionSystemRecordAddress {
    return hostAddress(SESSION_PERMISSION_SYSTEM_RECORD_NAMESPACE, "pmr1.namespace");
}

function encodePermissionMediationRecordCursor(
    row: Pick<PersistedSessionSystemRecordRow, "updatedAt" | "id">,
): string {
    return Buffer.from(
        JSON.stringify([PERMISSION_MEDIATION_RECORD_CURSOR_PREFIX, row.updatedAt.toISOString(), row.id]),
        "utf8",
    ).toString("base64url");
}

function decodePermissionMediationRecordCursor(
    cursor: string | null | undefined,
): Readonly<{ updatedAt: Date; id: string }> | null {
    if (cursor === null || cursor === undefined) return null;
    try {
        const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (
            !Array.isArray(value)
            || value.length !== 3
            || value[0] !== PERMISSION_MEDIATION_RECORD_CURSOR_PREFIX
            || typeof value[1] !== "string"
            || typeof value[2] !== "string"
            || value[2].length === 0
        ) {
            return null;
        }
        const updatedAt = new Date(value[1]);
        if (!Number.isFinite(updatedAt.getTime()) || updatedAt.toISOString() !== value[1]) return null;
        return { updatedAt, id: value[2] };
    } catch {
        return null;
    }
}

function storedPermissionMediationRecord(
    row: PersistedSessionSystemRecordRow,
    identity: SessionPermissionMediationRecordIdentityV1,
): PermissionMediationRecordResult<{ record: SessionPermissionMediationRecordStored }> {
    const expected = permissionMediationAddress(identity);
    if (
        row.sessionId !== identity.sessionId
        || !isCanonicalHostRowAtAddress(row, expected)
        || row.localId !== expected.localId
        || row.permissionTurnId !== identity.turnId
        || row.permissionRequestId !== identity.requestId
    ) {
        return { ok: false, code: "permission_mediation_record_internal" };
    }
    const kind = SessionPermissionMediationRecordKindSchema.safeParse(row.kind);
    const content = SessionSystemRecordContentSchema.safeParse(decodeStoredContent(row));
    if (
        !kind.success
        || !content.success
        || !Number.isInteger(row.version)
        || row.version < 1
        || row.version > SESSION_SYSTEM_RECORD_VERSION_MAX
    ) {
        return { ok: false, code: "permission_mediation_record_internal" };
    }
    return {
        ok: true,
        record: {
            ...identity,
            kind: kind.data,
            content: content.data,
            revision: encodeSessionSystemRecordRevision({ id: row.id, version: row.version }),
        },
    };
}

function listedPermissionMediationRecord(
    row: PersistedSessionSystemRecordRow,
    sessionId: string,
): PermissionMediationRecordResult<{ record: SessionPermissionMediationRecordStored }> {
    const identity = SessionPermissionMediationRecordIdentityV1Schema.safeParse({
        sessionId,
        turnId: row.permissionTurnId,
        requestId: row.permissionRequestId,
    });
    if (!identity.success) {
        return { ok: false, code: "permission_mediation_record_internal" };
    }
    const expected = permissionMediationAddress(identity.data);
    if (
        row.sessionId !== sessionId
        || !isCanonicalHostRowAtAddress(row, expected)
    ) {
        return { ok: false, code: "permission_mediation_record_internal" };
    }
    const kind = SessionPermissionMediationRecordKindSchema.safeParse(row.kind);
    const content = SessionSystemRecordContentSchema.safeParse(decodeStoredContent(row));
    if (
        !kind.success
        || !content.success
        || !Number.isInteger(row.version)
        || row.version < 1
        || row.version > SESSION_SYSTEM_RECORD_VERSION_MAX
    ) {
        return { ok: false, code: "permission_mediation_record_internal" };
    }
    return {
        ok: true,
        record: {
            ...identity.data,
            kind: kind.data,
            content: content.data,
            revision: encodeSessionSystemRecordRevision({ id: row.id, version: row.version }),
        },
    };
}

async function ensurePermissionMediationRecordAccess(
    params: PermissionMediationRecordAccessParams,
    reader?: Tx,
): Promise<PermissionMediationRecordResult<{
    accountId: string;
    sessionEncryptionMode: "e2ee" | "plain";
}>> {
    if (!isSessionSystemRecordsProtocolV1Active()) {
        return { ok: false, code: "permission_mediation_records_unavailable" };
    }
    if (!params.actorUserId || !params.sessionId) {
        return { ok: false, code: "permission_mediation_record_invalid" };
    }
    const access = await ensureSessionRecordAccess(params, reader);
    if (!access.ok) {
        return {
            ok: false,
            code: access.error === "session-not-found"
                ? "permission_mediation_session_not_found"
                : "permission_mediation_record_invalid",
        };
    }
    // Permission mediation payloads are owner-private. A shared participant
    // may have edit or even approval authority without being able to inspect,
    // mutate, or prune this encrypted ledger.
    if (access.access.level !== "owner") {
        return { ok: false, code: "permission_mediation_record_forbidden" };
    }
    const readAdmission = async (tx: Tx): ReturnType<typeof ensurePermissionMediationRecordAccess> => {
        const session = await tx.session.findUnique({
            where: { id: params.sessionId },
            select: { accountId: true, encryptionMode: true },
        });
        if (!session) return { ok: false, code: "permission_mediation_session_not_found" as const };
        return {
            ok: true as const,
            accountId: session.accountId,
            sessionEncryptionMode: session.encryptionMode === "plain" ? "plain" as const : "e2ee" as const,
        };
    };
    return reader ? await readAdmission(reader) : await inTx(readAdmission);
}

async function findPermissionMediationRecord(
    tx: Parameters<Parameters<typeof inTx>[0]>[0],
    params: Readonly<{
        accountId: string;
        identity: SessionPermissionMediationRecordIdentityV1;
    }>,
): Promise<Readonly<{
    keys: ReturnType<typeof deriveSessionSystemRecordAddressKeys>;
    row: PersistedSessionSystemRecordRow | null;
}>> {
    const keys = deriveSessionSystemRecordAddressKeys(permissionMediationAddress(params.identity));
    const row = await tx.sessionSystemRecord.findFirst({
        where: {
            accountId: params.accountId,
            sessionId: params.identity.sessionId,
            recordAddressKey: keys.recordAddressKey,
        },
        select: SESSION_SYSTEM_RECORD_SELECT,
    }) as PersistedSessionSystemRecordRow | null;
    return { keys, row };
}

async function resolvePermissionMediationConflictAfterMutation(
    params: Readonly<{
        accountId: string;
        identity: SessionPermissionMediationRecordIdentityV1;
    }>,
): Promise<PermissionMediationRecordFailure> {
    try {
        return reportSystemRecordResult("permission-settlement", await inTx(async (tx) => {
            const found = await findPermissionMediationRecord(tx, params);
            if (!found.row) {
                return { ok: false, code: "permission_mediation_record_conflict" as const };
            }
            const current = storedPermissionMediationRecord(found.row, params.identity);
            if (!current.ok) return current;
            return {
                ok: false,
                code: "permission_mediation_record_conflict" as const,
                currentRevision: current.record.revision,
            };
        }));
    } catch (error) {
        reportSystemRecordFailure("permission-settlement", error);
        return { ok: false, code: "permission_mediation_record_internal" };
    }
}

type PermissionMediationMutationMiss = Readonly<{
    kind: "refetch-permission-mediation-conflict";
}>;

function isPermissionMediationMutationMiss(
    value: PermissionMediationRecordResult<unknown> | PermissionMediationMutationMiss,
): value is PermissionMediationMutationMiss {
    return "kind" in value && value.kind === "refetch-permission-mediation-conflict";
}

async function readPermissionSnapshot<T>(
    params: PermissionMediationRecordAccessParams,
    read: (tx: Tx, access: Extract<Awaited<ReturnType<typeof ensurePermissionMediationRecordAccess>>, { ok: true }>) => Promise<PermissionMediationRecordResult<T>>,
): Promise<PermissionMediationRecordResult<T>> {
    return await captureReadSnapshot<PermissionMediationRecordResult<T>>(async tx => {
        const access = await ensurePermissionMediationRecordAccess(params, tx);
        if (!access.ok) return access;
        return await read(tx, access);
    });
}

export async function readPermissionMediationRecord(
    params: ReadPermissionMediationRecordParams,
): Promise<PermissionMediationRecordResult<{ record: SessionPermissionMediationRecordStored | null }>> {
    if (
        !SessionPermissionMediationRecordIdentityV1Schema.safeParse(params.identity).success
        || params.identity.sessionId !== params.sessionId
    ) {
        return { ok: false, code: "permission_mediation_record_invalid" };
    }
    try {
        return reportSystemRecordResult("permission-read", await readPermissionSnapshot(params, async (tx, access): ReturnType<typeof readPermissionMediationRecord> => {
            const found = await findPermissionMediationRecord(tx, {
                accountId: access.accountId,
                identity: params.identity,
            });
            if (!found.row) return { ok: true, record: null };
            const stored = storedPermissionMediationRecord(found.row, params.identity);
            return stored.ok ? { ok: true, record: stored.record } : stored;
        }));
    } catch (error) {
        reportSystemRecordFailure("permission-read", error);
        return { ok: false, code: "permission_mediation_record_internal" };
    }
}

export async function writePermissionMediationRecord(
    params: WritePermissionMediationRecordParams,
): Promise<PermissionMediationRecordResult<{ record: SessionPermissionMediationRecordStored }>> {
    if (
        !SessionPermissionMediationRecordIdentityV1Schema.safeParse(params.identity).success
        || params.identity.sessionId !== params.sessionId
        || !SessionPermissionMediationRecordWriteRequestSchema.safeParse(params.request).success
    ) {
        return { ok: false, code: "permission_mediation_record_invalid" };
    }
    const access = await ensurePermissionMediationRecordAccess(params);
    if (!access.ok) return access;
    const storageMode = buildStorageModeRejection({
        storagePolicy: readEncryptionFeatureEnv(process.env).storagePolicy,
        sessionEncryptionMode: access.sessionEncryptionMode,
        content: params.request.content,
    });
    if (!storageMode.ok) return { ok: false, code: "permission_mediation_record_invalid" };

    let outcome: PermissionMediationRecordResult<{ record: SessionPermissionMediationRecordStored }>
        | PermissionMediationMutationMiss;
    try {
        outcome = await inTx(async (tx) => {
            const found = await findPermissionMediationRecord(tx, {
                accountId: access.accountId,
                identity: params.identity,
            });
            if (found.row) {
                const current = storedPermissionMediationRecord(found.row, params.identity);
                if (!current.ok) return current;
                if (found.row.kind !== params.request.kind) {
                    return {
                        ok: false,
                        code: "permission_mediation_record_conflict" as const,
                        currentRevision: current.record.revision,
                    };
                }
                if (params.request.expectedRevision === null) {
                    return {
                        ok: false,
                        code: "permission_mediation_record_conflict" as const,
                        currentRevision: current.record.revision,
                    };
                }
                const expected = parseSessionSystemRecordRevision(params.request.expectedRevision);
                if (!expected || expected.id !== found.row.id || expected.version !== found.row.version) {
                    return {
                        ok: false,
                        code: "permission_mediation_record_conflict" as const,
                        currentRevision: current.record.revision,
                    };
                }
                if (isDeepStrictEqual(current.record.content, params.request.content)) {
                    return { ok: true, record: current.record };
                }
                if (found.row.version >= SESSION_SYSTEM_RECORD_VERSION_MAX) {
                    return { ok: false, code: "permission_mediation_record_conflict" as const, currentRevision: current.record.revision };
                }
                const updated = await tx.sessionSystemRecord.updateMany({
                    where: {
                        accountId: access.accountId,
                        sessionId: params.sessionId,
                        recordAddressKey: found.keys.recordAddressKey,
                        id: found.row.id,
                        version: found.row.version,
                    },
                    data: { ...systemRecordContentForStorage(params.request.content), version: { increment: 1 } },
                });
                if (updated.count !== 1) {
                    return { kind: "refetch-permission-mediation-conflict" as const };
                }
                const next = await findPermissionMediationRecord(tx, {
                    accountId: access.accountId,
                    identity: params.identity,
                });
                return next.row
                    ? storedPermissionMediationRecord(next.row, params.identity)
                    : { ok: false, code: "permission_mediation_record_internal" as const };
            }

            if (params.request.expectedRevision !== null) {
                return { ok: false, code: "permission_mediation_record_conflict" as const };
            }
            const address = permissionMediationAddress(params.identity);
            const created = await tx.sessionSystemRecord.create({
                data: {
                    accountId: access.accountId,
                    sessionId: params.sessionId,
                    ownerKind: address.ownerKind,
                    pluginId: null,
                    namespace: SESSION_PERMISSION_SYSTEM_RECORD_NAMESPACE,
                    kind: params.request.kind,
                    localId: address.localId,
                    permissionTurnId: params.identity.turnId,
                    permissionRequestId: params.identity.requestId,
                    ...systemRecordContentForStorage(params.request.content),
                    namespaceAddressKey: found.keys.namespaceAddressKey,
                    recordAddressKey: found.keys.recordAddressKey,
                    version: 1,
                },
                select: SESSION_SYSTEM_RECORD_SELECT,
            }) as PersistedSessionSystemRecordRow;
            return storedPermissionMediationRecord(created, params.identity);
        });
    } catch (error) {
        if (isPrismaErrorCode(error, "P2002")) {
            return await resolvePermissionMediationConflictAfterMutation({
                accountId: access.accountId,
                identity: params.identity,
            });
        }
        reportSystemRecordFailure("permission-write", error);
        return { ok: false, code: "permission_mediation_record_internal" };
    }
    if (!isPermissionMediationMutationMiss(outcome)) return reportSystemRecordResult("permission-write", outcome);
    return await resolvePermissionMediationConflictAfterMutation({
        accountId: access.accountId,
        identity: params.identity,
    });
}

/**
 * Removes one already-opened inactive ledger row during bounded retention.
 *
 * The Permission owner is the only component that can decrypt and classify a
 * row as inactive. This persistence owner therefore accepts only its fixed
 * address plus an exact row revision; it never exposes a generic host-record
 * delete operation or lets a caller choose a namespace/kind.
 */
export async function prunePermissionMediationRecord(
    params: PrunePermissionMediationRecordParams,
): Promise<PermissionMediationRecordResult<{}>> {
    if (
        !SessionPermissionMediationRecordIdentityV1Schema.safeParse(params.identity).success
        || params.identity.sessionId !== params.sessionId
        || !SessionPermissionMediationRecordPruneRequestSchema.safeParse(params.request).success
    ) {
        return { ok: false, code: "permission_mediation_record_invalid" };
    }
    const access = await ensurePermissionMediationRecordAccess(params);
    if (!access.ok) return access;
    let outcome: PermissionMediationRecordResult<{}> | PermissionMediationMutationMiss;
    try {
        outcome = await inTx(async (tx) => {
            const found = await findPermissionMediationRecord(tx, {
                accountId: access.accountId,
                identity: params.identity,
            });
            if (!found.row) {
                return { ok: false, code: "permission_mediation_record_conflict" as const };
            }
            const current = storedPermissionMediationRecord(found.row, params.identity);
            if (!current.ok) return current;
            const expected = parseSessionSystemRecordRevision(params.request.expectedRevision);
            if (!expected || expected.id !== found.row.id || expected.version !== found.row.version) {
                return {
                    ok: false,
                    code: "permission_mediation_record_conflict" as const,
                    currentRevision: current.record.revision,
                };
            }
            const deleted = await tx.sessionSystemRecord.deleteMany({
                where: {
                    accountId: access.accountId,
                    sessionId: params.sessionId,
                    recordAddressKey: found.keys.recordAddressKey,
                    id: found.row.id,
                    version: found.row.version,
                },
            });
            return deleted.count === 1
                ? { ok: true }
                : { kind: "refetch-permission-mediation-conflict" as const };
        });
    } catch (error) {
        reportSystemRecordFailure("permission-prune", error);
        return { ok: false, code: "permission_mediation_record_internal" };
    }
    if (!isPermissionMediationMutationMiss(outcome)) return reportSystemRecordResult("permission-prune", outcome);
    return await resolvePermissionMediationConflictAfterMutation({
        accountId: access.accountId,
        identity: params.identity,
    });
}

export async function listPermissionMediationRecords(
    params: ListPermissionMediationRecordsParams,
): Promise<PermissionMediationRecordResult<{ page: PermissionMediationRecordPage }>> {
    const parsed = SessionPermissionMediationRecordListQuerySchema.safeParse(params.query);
    if (!parsed.success) return { ok: false, code: "permission_mediation_record_invalid" };
    const cursor = decodePermissionMediationRecordCursor(parsed.data.cursor);
    if (parsed.data.cursor !== null && parsed.data.cursor !== undefined && !cursor) {
        return { ok: false, code: "permission_mediation_record_invalid" };
    }
    const namespaceKeys = deriveSessionSystemRecordAddressKeys(
        permissionMediationNamespaceAddress(),
    );
    try {
        return reportSystemRecordResult("permission-list", await readPermissionSnapshot(params, async (tx, access): ReturnType<typeof listPermissionMediationRecords> => {
            const rows = await tx.sessionSystemRecord.findMany({
                where: {
                    accountId: access.accountId,
                    sessionId: params.sessionId,
                    namespaceAddressKey: namespaceKeys.namespaceAddressKey,
                    kind: { in: [...SESSION_PERMISSION_SYSTEM_RECORD_KINDS] },
                    ...(cursor ? {
                        OR: [
                            { updatedAt: { lt: cursor.updatedAt } },
                            { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
                        ],
                    } : {}),
                },
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
                take: parsed.data.limit + 1,
                select: SESSION_SYSTEM_RECORD_SELECT,
            }) as PersistedSessionSystemRecordRow[];
            const pageRows = rows.slice(0, parsed.data.limit);
            const records: SessionPermissionMediationRecordStored[] = [];
            for (const row of pageRows) {
                const stored = listedPermissionMediationRecord(row, params.sessionId);
                if (!stored.ok) return stored;
                records.push(stored.record);
            }
            const hasNext = rows.length > parsed.data.limit;
            const last = pageRows.at(-1);
            return {
                ok: true,
                page: {
                    records,
                    nextCursor: hasNext && last ? encodePermissionMediationRecordCursor(last) : null,
                    hasNext,
                },
            };
        }));
    } catch (error) {
        reportSystemRecordFailure("permission-list", error);
        return { ok: false, code: "permission_mediation_record_internal" };
    }
}

export async function upsertSessionSystemRecord(
    params: UpsertSessionSystemRecordParams,
): Promise<UpsertSessionSystemRecordResult> {
    return await upsertSessionSystemRecordWithCreateRaceRetry(params, true);
}

async function upsertSessionSystemRecordWithCreateRaceRetry(
    params: UpsertSessionSystemRecordParams,
    retryCreateRace: boolean,
): Promise<UpsertSessionSystemRecordResult> {
    if (!validateUpsertParams(params)) return { ok: false, error: "invalid-params" };

    const access = await ensureSessionRecordAccess(params);
    if (!access.ok) return access;
    if (!canMutateHostSystemRecord({
        access: access.access,
        namespace: params.namespace,
        kind: params.kind,
    })) {
        return { ok: false, error: "forbidden" };
    }
    const mutationPolicy = resolveV1HostPolicy({
        namespace: params.namespace,
        kind: params.kind,
        operation: "write",
    });
    if (!mutationPolicy) return { ok: false, error: "invalid-params" };
    const currentAccess = currentSessionRecordAccessForRequirement(mutationPolicy.requirement);

    try {
        return reportSystemRecordResult("upsert", await inSessionSystemRecordMutation(params, async (tx) => {
            const session = await tx.session.findUnique({
                where: { id: params.sessionId },
                select: { accountId: true, encryptionMode: true },
            });
            if (!session) return { ok: false, error: "session-not-found" };
            const recordScope = resolveSystemRecordAccountScope({
                namespace: params.namespace,
                kind: params.kind,
                actorUserId: params.actorUserId,
                sessionAccountId: typeof session.accountId === "string" ? session.accountId : undefined,
            });
            const addressKeys = deriveSessionSystemRecordAddressKeys({
                ownerKind: "host",
                pluginId: null,
                namespace: params.namespace,
                localId: params.localId,
            });

            const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
            const storageMode = buildStorageModeRejection({
                storagePolicy: readEncryptionFeatureEnv(process.env).storagePolicy,
                sessionEncryptionMode,
                content: params.content,
            });
            if (!storageMode.ok) {
                return { ok: false, error: "invalid-params", code: storageMode.code };
            }

            const lookup = await findHostRecordByAddress(tx, {
                actorUserId: params.actorUserId,
                accountId: recordScope.accountId,
                sessionId: params.sessionId,
                requiredAccess: currentAccess,
                namespace: params.namespace,
                localId: params.localId,
                authentication: params.authentication,
            });
            if (!lookup.ok) return { ok: false, error: "internal" };
            const existing = lookup.row;

            if (existing) {
                if (existing.kind !== params.kind) return { ok: false, error: "conflict" };
                const existingRecord = toSessionSystemRecordRow(existing);
                if (!existingRecord) return { ok: false, error: "internal" };
                if (isDeepStrictEqual(existingRecord.content, params.content)) {
                    return { ok: true, didCreate: false, didUpdate: false, record: existingRecord };
                }
                if (!await hasCurrentSessionRecordAccessInTx(tx, {
                    actorUserId: params.actorUserId,
                    sessionId: params.sessionId,
                    requiredAccess: currentAccess,
                    authentication: params.authentication,
                })) {
                    return { ok: false, error: "forbidden" };
                }

                const updated = await tx.sessionSystemRecord.updateMany({
                    where: {
                        id: existing.id,
                        sessionId: params.sessionId,
                        ...await currentSessionRecordWhere(tx, {
                            actorUserId: params.actorUserId,
                            sessionId: params.sessionId,
                            requiredAccess: currentAccess,
                            authentication: params.authentication,
                        }),
                    },
                    data: {
                        ...systemRecordContentForStorage(params.content),
                        ownerKind: "host",
                        pluginId: null,
                        namespaceAddressKey: addressKeys.namespaceAddressKey,
                        recordAddressKey: addressKeys.recordAddressKey,
                        version: { increment: 1 },
                    },
                });
                if (updated.count !== 1) {
                    if (!await hasCurrentSessionRecordAccessInTx(tx, {
                        actorUserId: params.actorUserId,
                        sessionId: params.sessionId,
                        requiredAccess: currentAccess,
                        authentication: params.authentication,
                    })) {
                        return { ok: false, error: "forbidden" };
                    }
                    return { ok: false, error: "internal" };
                }
                await publishHostRecordChangeInTx(tx, { sessionId: params.sessionId, accountId: recordScope.accountId, recordId: existing.id,
                    address: { owner: 'host', namespace: params.namespace, kind: params.kind, localId: params.localId } });
                const updatedLookup = await findHostRecordByAddress(tx, {
                    actorUserId: params.actorUserId,
                    accountId: recordScope.accountId,
                    sessionId: params.sessionId,
                    requiredAccess: currentAccess,
                    namespace: params.namespace,
                    localId: params.localId,
                    authentication: params.authentication,
                });
                if (!updatedLookup.ok || !updatedLookup.row) return { ok: false, error: "internal" };
                const updatedRecord = toSessionSystemRecordRow(updatedLookup.row);
                if (!updatedRecord) return { ok: false, error: "internal" };
                return { ok: true, didCreate: false, didUpdate: true, record: updatedRecord };
            }

            if (!await hasCurrentSessionRecordAccessInTx(tx, {
                actorUserId: params.actorUserId,
                sessionId: params.sessionId,
                requiredAccess: currentAccess,
                authentication: params.authentication,
            })) {
                return { ok: false, error: "forbidden" };
            }

            const created = await tx.sessionSystemRecord.create({
                data: {
                    accountId: recordScope.accountId,
                    sessionId: params.sessionId,
                    namespace: params.namespace,
                    kind: params.kind,
                    localId: params.localId,
                    ...systemRecordContentForStorage(params.content),
                    ownerKind: "host",
                    pluginId: null,
                    namespaceAddressKey: addressKeys.namespaceAddressKey,
                    recordAddressKey: addressKeys.recordAddressKey,
                    version: 1,
                },
                select: SESSION_SYSTEM_RECORD_SELECT,
            });
            await publishHostRecordChangeInTx(tx, { sessionId: params.sessionId, accountId: recordScope.accountId, recordId: created.id,
                address: { owner: 'host', namespace: params.namespace, kind: params.kind, localId: params.localId } });
            const createdRecord = toSessionSystemRecordRow(created);
            if (!createdRecord) return { ok: false, error: "internal" };
            return { ok: true, didCreate: true, didUpdate: false, record: createdRecord };
        }));
    } catch (error) {
        if (retryCreateRace && isPrismaErrorCode(error, "P2002")) {
            return await upsertSessionSystemRecordWithCreateRaceRetry(params, false);
        }
        reportSystemRecordFailure("upsert", error);
        return { ok: false, error: "internal" };
    }
}

async function readLegacyHostSnapshot<T extends ListSessionSystemRecordsResult | GetSessionSystemRecordResult | GetLatestSessionSystemRecordResult>(
    params: Readonly<{ actorUserId: string; sessionId: string; authentication: SessionAccessAuthentication;
        namespace?: SessionSystemRecordNamespace; kind?: SessionSystemRecordKind }>,
    read: (tx: Tx, session: Readonly<{ accountId: string; encryptionMode: string }> | null) => Promise<T>,
): Promise<T | Readonly<{ ok: false; error: "session-not-found" | "invalid-params" | "forbidden" }>> {
    return await captureReadSnapshot<T | Readonly<{ ok: false; error: "session-not-found" | "invalid-params" | "forbidden" }>>(async tx => {
        const capturedSession = await tx.session.findUnique({ where: { id: params.sessionId }, select: { accountId: true, encryptionMode: true } });
        return await read(tx, capturedSession);
    });
}

export async function listSessionSystemRecords(
    params: ListSessionSystemRecordsParams,
): Promise<ListSessionSystemRecordsResult> {
    if (!validateListParams(params)) return { ok: false, error: "invalid-params" };

    const limit = normalizeLimit(params.limit);
    const cursor = decodeCursor(params.cursor);

    try {
        return reportSystemRecordResult("list", await readLegacyHostSnapshot(params, async (tx, session): Promise<ListSessionSystemRecordsResult> => {
            const access = await ensureSessionRecordAccess(params, tx);
            if (!access.ok) return access;
            if (!canReadHostSystemRecords({
                access: access.access,
                ...(params.namespace ? { namespace: params.namespace } : {}),
                ...(params.kind ? { kind: params.kind } : {}),
            })) return { ok: false, error: "forbidden" };
            if (!session) return { ok: false, error: "session-not-found" };
            const sessionAccountId = typeof session.accountId === "string"
                ? session.accountId
                : undefined;
            const publicRecordScopes = SESSION_SYSTEM_RECORD_NAMESPACES.flatMap((namespace) => {
                if (namespace === "surface") return [];
                // Released unscoped readers have closed namespace/kind enums.
                if (params.namespace === undefined && namespace === USAGE_SESSION_WORK_FACTS_SYSTEM_RECORD_ADDRESS.namespace) return [];
                if (params.namespace !== undefined && params.namespace !== namespace) return [];
                const registeredKinds = Object.keys(
                    SESSION_SYSTEM_RECORD_CATALOG[namespace].kinds,
                ) as SessionSystemRecordKind[];
                const requestedKinds = params.kind === undefined
                    ? registeredKinds
                    : registeredKinds.includes(params.kind)
                        ? [params.kind]
                        : [];
                const admittedKinds = requestedKinds.filter((kind) => {
                    const policy = resolveV1HostPolicy({ namespace, kind, operation: "read" });
                    return policy !== null && satisfiesSystemRecordPolicy(access.access, policy.requirement);
                });
                if (admittedKinds.length === 0) return [];
                return [createHostRecordListScope({
                    accountId: resolveSystemRecordAccountScope({
                        namespace,
                        actorUserId: params.actorUserId,
                        sessionAccountId,
                    }).accountId,
                    namespace,
                    kinds: admittedKinds,
                    localId: params.localId,
                })];
            });
            if (publicRecordScopes.length === 0) {
                return { ok: true, records: [], nextCursor: null };
            }

            const rows = await tx.sessionSystemRecord.findMany({
                where: {
                    sessionId: params.sessionId,
                    ...await currentSessionRecordWhere(tx, {
                        actorUserId: params.actorUserId,
                        sessionId: params.sessionId,
                        requiredAccess: "visible",
                        authentication: params.authentication,
                    }),
                    ...(cursor
                        ? {
                            AND: [
                                {
                                    OR: publicRecordScopes.map((scope) => (
                                        hostRecordListWhere(scope, params.localId)
                                    )),
                                },
                                {
                                    OR: [
                                        { updatedAt: { lt: cursor.updatedAt } },
                                        { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
                                    ],
                                },
                            ],
                        }
                        : {
                            OR: publicRecordScopes.map((scope) => (
                                hostRecordListWhere(scope, params.localId)
                            )),
                        }),
                },
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
                take: limit + 1,
                select: SESSION_SYSTEM_RECORD_SELECT,
            });
            const persistedRows = rows as PersistedSessionSystemRecordRow[];
            if (persistedRows.length === 0 && !await hasCurrentSessionRecordAccessInTx(tx, {
                actorUserId: params.actorUserId,
                sessionId: params.sessionId,
                requiredAccess: "visible",
                authentication: params.authentication,
            })) {
                return { ok: false, error: "forbidden" as const };
            }
            const pageRows = persistedRows.slice(0, limit);
            if (pageRows.some((row) => !isHostRowInListScope({
                row,
                scopes: publicRecordScopes,
                localId: params.localId,
            }))) {
                return { ok: false, error: "internal" };
            }
            const records = pageRows.map(toSessionSystemRecordRow);
            if (records.some((record) => record === null)) return { ok: false, error: "internal" };
            const last = pageRows.at(-1);
            return {
                ok: true,
                records: records as SessionSystemRecordRow[],
                nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
            };
        }));
    } catch (error) {
        reportSystemRecordFailure("list", error);
        return { ok: false, error: "internal" };
    }
}

export async function getSessionSystemRecord(
    params: GetSessionSystemRecordParams,
): Promise<GetSessionSystemRecordResult> {
    if (!validateLookupParams(params)) return { ok: false, error: "invalid-params" };

    try {
        return reportSystemRecordResult("get", await readLegacyHostSnapshot(params, async (tx, session): Promise<GetSessionSystemRecordResult> => {
            const access = await ensureSessionRecordAccess(params, tx);
            if (!access.ok) return access;
            if (!canReadHostSystemRecords({ access: access.access, namespace: params.namespace })) {
                return { ok: false, error: "forbidden" };
            }
            if (!session) return { ok: false, error: "session-not-found" };
            const recordScope = resolveSystemRecordAccountScope({
                namespace: params.namespace,
                actorUserId: params.actorUserId,
                sessionAccountId: typeof session.accountId === "string" ? session.accountId : undefined,
            });

            const lookup = await findHostRecordByAddress(tx, {
                actorUserId: params.actorUserId,
                accountId: recordScope.accountId,
                sessionId: params.sessionId,
                requiredAccess: "visible",
                namespace: params.namespace,
                localId: params.localId,
                authentication: params.authentication,
            });
            if (!lookup.ok) return { ok: false, error: "internal" };
            const row = lookup.row;
            if (!row) {
                if (!await hasCurrentSessionRecordAccessInTx(tx, {
                    actorUserId: params.actorUserId,
                    sessionId: params.sessionId,
                    requiredAccess: "visible",
                    authentication: params.authentication,
                })) {
                    return { ok: false, error: "forbidden" };
                }
                return { ok: true, record: null };
            }
            const record = toSessionSystemRecordRow(row);
            if (!record) return { ok: false, error: "internal" };
            return { ok: true, record };
        }));
    } catch (error) {
        reportSystemRecordFailure("get", error);
        return { ok: false, error: "internal" };
    }
}

export async function getLatestSessionSystemRecord(
    params: GetLatestSessionSystemRecordParams,
): Promise<GetLatestSessionSystemRecordResult> {
    if (!validateLatestParams(params)) return { ok: false, error: "invalid-params" };

    try {
        return reportSystemRecordResult("latest", await readLegacyHostSnapshot(params, async (tx, session): Promise<GetLatestSessionSystemRecordResult> => {
            const access = await ensureSessionRecordAccess(params, tx);
            if (!access.ok) return access;
            if (!canReadHostSystemRecords({
                access: access.access,
                namespace: params.namespace,
                kind: params.kind,
            })) return { ok: false, error: "forbidden" };
            if (!session) return { ok: false, error: "session-not-found" };
            const recordScope = resolveSystemRecordAccountScope({
                namespace: params.namespace,
                kind: params.kind,
                actorUserId: params.actorUserId,
                sessionAccountId: typeof session.accountId === "string" ? session.accountId : undefined,
            });
            const expectedNamespace = hostAddress(params.namespace, "");
            const addressKeys = deriveSessionSystemRecordAddressKeys(expectedNamespace);

            const row = await tx.sessionSystemRecord.findFirst({
                where: {
                    accountId: recordScope.accountId,
                    sessionId: params.sessionId,
                    kind: params.kind,
                    namespaceAddressKey: addressKeys.namespaceAddressKey,
                    ...await currentSessionRecordWhere(tx, {
                        actorUserId: params.actorUserId,
                        sessionId: params.sessionId,
                        requiredAccess: "visible",
                        authentication: params.authentication,
                    }),
                },
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
                select: SESSION_SYSTEM_RECORD_SELECT,
            });
            if (!row) {
                if (!await hasCurrentSessionRecordAccessInTx(tx, {
                    actorUserId: params.actorUserId,
                    sessionId: params.sessionId,
                    requiredAccess: "visible",
                    authentication: params.authentication,
                })) {
                    return { ok: false, error: "forbidden" };
                }
                return { ok: true, record: null };
            }
            const persistedRow = row as PersistedSessionSystemRecordRow;
            const expected = hostAddress(params.namespace, persistedRow.localId);
            const isCanonical = bytesEqual(persistedRow.namespaceAddressKey, addressKeys.namespaceAddressKey)
                && isCanonicalHostRowAtAddress(persistedRow, expected);
            if (!isCanonical || persistedRow.kind !== params.kind) {
                return { ok: false, error: "internal" };
            }
            const record = toSessionSystemRecordRow(row);
            if (!record) return { ok: false, error: "internal" };
            return { ok: true, record };
        }));
    } catch (error) {
        reportSystemRecordFailure("latest", error);
        return { ok: false, error: "internal" };
    }
}
