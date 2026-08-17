import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";

import {
    isStoredContentKindAllowedForSessionByStoragePolicy,
    getSessionSystemRecordKindPolicy,
    getSessionSystemRecordPayloadSchema,
    SESSION_SYSTEM_RECORD_CATALOG,
    SESSION_SYSTEM_RECORD_NAMESPACES,
    PluginIdSchema,
    SessionSystemRecordAddressSchema,
    SessionSystemRecordDeleteRequestSchema,
    SessionSystemRecordContentSchema,
    SessionSystemRecordListQuerySchema,
    SessionSystemRecordReadRequestSchema,
    SessionSystemRecordRevisionSchema,
    SESSION_SYSTEM_RECORD_VERSION_MAX,
    LegacyHostSessionSystemRecordLatestQuerySchema,
    LegacyHostSessionSystemRecordListQuerySchema,
    LegacyHostSessionSystemRecordLookupQuerySchema,
    LegacyHostSessionSystemRecordUpsertRequestSchema,
    type SessionStoredContentKind,
    type SessionStoredMessageContent,
    type SessionSystemRecordKind,
    type SessionSystemRecordNamespace,
    type SessionSystemRecordAddress,
    type SessionSystemRecordContent,
    type SessionSystemRecordListQuery,
    type SessionSystemRecordRevision,
    type SessionSystemRecordKindPolicy,
    type SessionSystemRecordCatalog,
    type SessionSystemRecordStored,
    SESSION_PERMISSION_SYSTEM_RECORD_KINDS,
    SESSION_PERMISSION_SYSTEM_RECORD_NAMESPACE,
    deriveSessionPermissionMediationRecordLocatorV1,
    SessionPermissionMediationRecordIdentityV1Schema,
    SessionPermissionMediationRecordKindSchema,
    SessionPermissionMediationRecordListQuerySchema,
    SessionPermissionMediationRecordPruneRequestSchema,
    SessionPermissionMediationRecordWriteRequestSchema,
    type SessionPermissionMediationRecordIdentityV1,
    type SessionPermissionMediationRecordListQuery,
    type SessionPermissionMediationRecordPruneRequest,
    type SessionPermissionMediationRecordStored,
    type SessionPermissionMediationRecordWriteRequest,
} from "@happier-dev/protocol";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveEncryptionWriteRejectionCode, type EncryptionPolicyRejectionCode } from "@/app/session/encryptionRejectionCodes";
import {
    buildCurrentSessionParticipantWhere,
    checkSessionAccess,
    requireAccessLevel,
    type SessionAccess,
} from "@/app/share/accessControl";
import { inTx, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
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

type SessionSystemRecordV1ErrorCode =
    | "plugin_session_records_unavailable"
    | "plugin_session_record_invalid_query"
    | "plugin_session_record_address_collision"
    | "plugin_session_record_kind_conflict"
    | "plugin_session_record_revision_conflict"
    | "plugin_session_record_revision_exhausted"
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
}>;

export type ListSessionSystemRecordsParams = Readonly<{
    actorUserId: string;
    sessionId: string;
    namespace?: SessionSystemRecordNamespace;
    kind?: SessionSystemRecordKind;
    localId?: string;
    limit?: number;
    cursor?: string;
}>;

export type GetSessionSystemRecordParams = Readonly<{
    actorUserId: string;
    sessionId: string;
    namespace: SessionSystemRecordNamespace;
    localId: string;
}>;

export type GetLatestSessionSystemRecordParams = Readonly<{
    actorUserId: string;
    sessionId: string;
    namespace: SessionSystemRecordNamespace;
    kind: SessionSystemRecordKind;
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
    ownerKind: true,
    pluginId: true,
    namespaceAddressKey: true,
    recordAddressKey: true,
    version: true,
    createdAt: true,
    updatedAt: true,
} as const;

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
    createdAt: Date;
    updatedAt: Date;
}): SessionSystemRecordRow | null {
    const parsed = parseRecordPayload({
        namespace: row.namespace,
        kind: row.kind,
        localId: row.localId,
        content: row.content,
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

async function findHostRecordByAddress(
    tx: Tx,
    params: Readonly<{
        actorUserId: string;
        accountId: string;
        sessionId: string;
        requiredAccess: CurrentSessionRecordAccess;
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
            ...currentSessionRecordWhere({
                actorUserId: params.actorUserId,
                sessionId: params.sessionId,
                requiredAccess: params.requiredAccess,
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

async function ensureSessionRecordAccess(params: Readonly<{ actorUserId: string; sessionId: string }>): Promise<
    | { ok: true; access: SessionAccess }
    | { ok: false; error: "invalid-params" | "session-not-found" }
> {
    if (!params.actorUserId || !params.sessionId) {
        return { ok: false, error: "invalid-params" };
    }
    const access = await checkSessionAccess(params.actorUserId, params.sessionId);
    if (!access) {
        return { ok: false, error: "session-not-found" };
    }
    return { ok: true, access };
}

function canMutateHostSystemRecord(params: Readonly<{
    access: SessionAccess;
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
    access: SessionAccess;
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
    const parsedContent = SessionSystemRecordContentSchema.safeParse(row.content);
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
    if (!hasValidRegisteredHostPlainContent({
        address: parsedAddress.data,
        content: parsedContent.data,
    })) {
        return { ok: false, code: "plugin_session_record_internal" };
    }
    return {
        ok: true,
        record: {
            id: row.id,
            address: parsedAddress.data,
            content: parsedContent.data,
            revision: encodeSessionSystemRecordRevision({ id: row.id, version: row.version }),
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        },
    };
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

function satisfiesSystemRecordPolicy(access: SessionAccess, requirement: SessionSystemRecordKindPolicy["read"]): boolean {
    if (requirement === "unavailable") return false;
    return requirement === "visible" || requireAccessLevel(access, "edit");
}

function currentSessionRecordAccessForRequirement(
    requirement: SessionSystemRecordKindPolicy["read"],
): CurrentSessionRecordAccess {
    return requirement === "edit" ? "edit" : "visible";
}

function currentSessionRecordWhere(params: Readonly<{
    actorUserId: string;
    sessionId: string;
    requiredAccess: CurrentSessionRecordAccess;
}>): Readonly<{ session: { is: ReturnType<typeof buildCurrentSessionParticipantWhere> } }> {
    return {
        session: {
            is: buildCurrentSessionParticipantWhere({
                userId: params.actorUserId,
                sessionId: params.sessionId,
                ...(params.requiredAccess === "edit" ? { minimumAccess: "edit" as const } : {}),
            }),
        },
    };
}

async function hasCurrentSessionRecordAccessInTx(
    tx: Pick<Tx, "session">,
    params: Readonly<{
        actorUserId: string;
        sessionId: string;
        requiredAccess: CurrentSessionRecordAccess;
    }>,
): Promise<boolean> {
    const session = await tx.session.findFirst({
        where: buildCurrentSessionParticipantWhere({
            userId: params.actorUserId,
            sessionId: params.sessionId,
            ...(params.requiredAccess === "edit" ? { minimumAccess: "edit" as const } : {}),
        }),
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

async function ensureV1RecordAccess(
    params: SessionSystemRecordV1BaseParams,
    target: Readonly<{
        owner: SessionSystemRecordAddress["owner"];
        namespace: string;
        kind?: string;
        operation: "read" | "write" | "delete";
    }>,
): Promise<
    SessionSystemRecordV1Result<{
        accountId: string;
        sessionEncryptionMode: "e2ee" | "plain";
        currentAccess: CurrentSessionRecordAccess;
    }>
> {
    if (!isSessionSystemRecordsProtocolV1Active()) {
        return { ok: false, code: "plugin_session_records_unavailable" };
    }
    if (
        !params.actorUserId
        || !params.sessionId
        || (target.owner === "plugin" && !PluginIdSchema.safeParse(params.pluginId).success)
    ) {
        return { ok: false, code: "plugin_session_record_invalid_query" };
    }
    const access = await ensureSessionRecordAccess(params);
    if (!access.ok) {
        return {
            ok: false,
            code: access.error === "session-not-found" ? "plugin_session_not_found" : "plugin_session_record_invalid_query",
        };
    }
    return await inTx(async (tx) => {
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
            ok: true,
            accountId: hostPolicy?.accountScope === "session-owner"
                ? session.accountId
                : params.actorUserId,
            sessionEncryptionMode: session.encryptionMode === "plain" ? "plain" as const : "e2ee" as const,
            currentAccess: hostPolicy
                ? currentSessionRecordAccessForRequirement(hostPolicy.requirement)
                : "visible",
        };
    });
}

type FoundV1Record = Readonly<{
    expected: PersistedSessionSystemRecordAddress;
    keys: ReturnType<typeof deriveSessionSystemRecordAddressKeys>;
    row: PersistedSessionSystemRecordRow | null;
}>;

async function findV1RecordByAddress(
    tx: Parameters<Parameters<typeof inTx>[0]>[0],
    params: SessionSystemRecordV1BaseParams & Readonly<{
        address: SessionSystemRecordAddress;
        accountId: string;
        requiredAccess: CurrentSessionRecordAccess;
    }>,
): Promise<FoundV1Record | null> {
    const expected = persistedV1Address(params.pluginId, params.address);
    if (!expected) return null;
    const keys = deriveSessionSystemRecordAddressKeys(expected);
    const row = await tx.sessionSystemRecord.findFirst({
        where: {
            accountId: params.accountId,
            sessionId: params.sessionId,
            recordAddressKey: keys.recordAddressKey,
            ...currentSessionRecordWhere({
                actorUserId: params.actorUserId,
                sessionId: params.sessionId,
                requiredAccess: params.requiredAccess,
            }),
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
        return await inTx(async (tx) => {
            const found = await findV1RecordByAddress(tx, { ...params, accountId, requiredAccess: currentAccess });
            if (!found) return { ok: false, code: "plugin_session_record_invalid_query" as const };
            if (!await hasCurrentSessionRecordAccessInTx(tx, {
                actorUserId: params.actorUserId,
                sessionId: params.sessionId,
                requiredAccess: currentAccess,
            })) {
                return { ok: false, code: "plugin_session_record_forbidden" as const };
            }
            return found;
        });
    } catch {
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
    if (!current.ok) return current;
    if (found.row.kind !== params.address.kind) {
        return { ok: false, code: "plugin_session_record_kind_conflict" };
    }
    if (isDeepStrictEqual(found.row.content, params.content)) return current;
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
    if (!current.ok) return current;
    if (found.row.kind !== params.address.kind) {
        return { ok: false, code: "plugin_session_record_kind_conflict" };
    }
    return {
        ok: false,
        code: "plugin_session_record_revision_conflict",
        currentRevision: current.record.revision,
    };
}

export async function readSessionSystemRecordV1(
    params: SessionSystemRecordV1BaseParams & Readonly<{ address: SessionSystemRecordAddress }>,
): Promise<SessionSystemRecordV1Result<{ record: SessionSystemRecordStored | null }>> {
    if (!SessionSystemRecordReadRequestSchema.safeParse({ address: params.address }).success) {
        return { ok: false, code: "plugin_session_record_invalid_query" };
    }
    const access = await ensureV1RecordAccess(params, { ...params.address, operation: "read" });
    if (!access.ok) return access;
    try {
        return await inTx(async (tx) => {
            const found = await findV1RecordByAddress(tx, {
                ...params,
                accountId: access.accountId,
                requiredAccess: "visible",
            });
            if (!found) return { ok: false, code: "plugin_session_record_invalid_query" as const };
            if (!found.row) {
                if (!await hasCurrentSessionRecordAccessInTx(tx, {
                    actorUserId: params.actorUserId,
                    sessionId: params.sessionId,
                    requiredAccess: "visible",
                })) {
                    return { ok: false, code: "plugin_session_record_forbidden" as const };
                }
                return { ok: true, record: null };
            }
            const projected = storedV1Record(found.row, found.expected);
            if (!projected.ok) return projected;
            if (found.row.kind !== params.address.kind) {
                return { ok: false, code: "plugin_session_record_kind_conflict" as const };
            }
            return projected;
        });
    } catch {
        return { ok: false, code: "plugin_session_record_internal" };
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
    const access = await ensureV1RecordAccess(params, {
        owner: parsed.data.owner,
        namespace: parsed.data.namespace,
        ...(parsed.data.kind ? { kind: parsed.data.kind } : {}),
        operation: "read",
    });
    if (!access.ok) return access;
    const exactLocalId = parsed.data.localId;
    const expectedAddress: PersistedSessionSystemRecordAddress = {
        ownerKind: parsed.data.owner,
        pluginId: parsed.data.owner === "plugin" ? params.pluginId ?? null : null,
        namespace: parsed.data.namespace,
        localId: exactLocalId ?? "",
    };
    const keys = deriveSessionSystemRecordAddressKeys(expectedAddress);
    try {
        return await inTx(async (tx) => {
            const rows = await tx.sessionSystemRecord.findMany({
                where: {
                    accountId: access.accountId,
                    sessionId: params.sessionId,
                    ...currentSessionRecordWhere({
                        actorUserId: params.actorUserId,
                        sessionId: params.sessionId,
                        requiredAccess: "visible",
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
            })) {
                return { ok: false, code: "plugin_session_record_forbidden" as const };
            }
            const projectedRows: SessionSystemRecordStored[] = [];
            for (const row of rows) {
                const projected = storedV1Record(row, {
                    ...expectedAddress,
                    localId: exactLocalId ?? row.localId,
                });
                if (!projected.ok) return projected;
                projectedRows.push(projected.record);
            }
            const pageRows = rows.slice(0, parsed.data.limit);
            const records = projectedRows.slice(0, parsed.data.limit);
            const hasNext = rows.length > parsed.data.limit;
            const last = pageRows.at(-1);
            return {
                ok: true,
                page: {
                    records,
                    nextCursor: hasNext && last ? encodeSessionSystemRecordV1Cursor(last) : null,
                    hasNext,
                },
            };
        });
    } catch {
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
    if (!raced.row) return { ok: false, code: "plugin_session_record_internal" };
    const replay = storedV1Record(raced.row, raced.expected);
    if (!replay.ok) return replay;
    if (raced.row.kind !== params.address.kind) {
        return { ok: false, code: "plugin_session_record_kind_conflict" };
    }
    if (isDeepStrictEqual(raced.row.content, params.content)) return replay;
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
    accountId: string,
    currentAccess: CurrentSessionRecordAccess,
): Promise<SessionSystemRecordV1Result<{ record: SessionSystemRecordStored }>> {
    const raced = await refetchV1RecordAfterMutation(params, accountId, currentAccess);
    if (isV1RecordRefetchFailure(raced)) return raced;
    const currentRow = raced.row;
    if (!currentRow) return { ok: false, code: "plugin_session_record_internal" };
    const current = storedV1Record(currentRow, raced.expected);
    if (!current.ok) return current;
    if (currentRow.kind !== params.address.kind) {
        return { ok: false, code: "plugin_session_record_kind_conflict" };
    }
    if (isDeepStrictEqual(currentRow.content, params.content)) return current;
    if (currentRow.version >= SESSION_SYSTEM_RECORD_VERSION_MAX) {
        return { ok: false, code: "plugin_session_record_revision_exhausted" };
    }
    try {
        return await inTx(async (tx) => {
            const updated = await tx.sessionSystemRecord.updateMany({
                where: {
                    accountId,
                    sessionId: params.sessionId,
                    recordAddressKey: raced.keys.recordAddressKey,
                    id: currentRow.id,
                    ...currentSessionRecordWhere({
                        actorUserId: params.actorUserId,
                        sessionId: params.sessionId,
                        requiredAccess: currentAccess,
                    }),
                },
                data: { content: params.content, version: { increment: 1 } },
            });
            if (updated.count !== 1) {
                if (!await hasCurrentSessionRecordAccessInTx(tx, {
                    actorUserId: params.actorUserId,
                    sessionId: params.sessionId,
                    requiredAccess: currentAccess,
                })) {
                    return { ok: false, code: "plugin_session_record_forbidden" as const };
                }
                return { ok: false, code: "plugin_session_record_internal" as const };
            }
            const next = await tx.sessionSystemRecord.findFirst({
                where: {
                    accountId,
                    sessionId: params.sessionId,
                    recordAddressKey: raced.keys.recordAddressKey,
                    ...currentSessionRecordWhere({
                        actorUserId: params.actorUserId,
                        sessionId: params.sessionId,
                        requiredAccess: "visible",
                    }),
                },
                select: SESSION_SYSTEM_RECORD_SELECT,
            }) as PersistedSessionSystemRecordRow | null;
            return next
                ? storedV1Record(next, raced.expected)
                : { ok: false, code: "plugin_session_record_internal" as const };
        });
    } catch {
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
        outcome = await inTx(async (tx) => {
            const found = await findV1RecordByAddress(tx, {
                ...params,
                accountId: access.accountId,
                requiredAccess: access.currentAccess,
            });
            if (!found) return { ok: false, code: "plugin_session_record_invalid_query" as const };
            const current = found.row;
            if (current) {
                const projected = storedV1Record(current, found.expected);
                if (!projected.ok) return projected;
                if (current.kind !== params.address.kind) {
                    return { ok: false, code: "plugin_session_record_kind_conflict" as const };
                }
                const sameEnvelope = isDeepStrictEqual(current.content, params.content);
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
                        sessionId: params.sessionId,
                        recordAddressKey: found.keys.recordAddressKey,
                        id: current.id,
                        ...(params.expectedRevision === undefined ? {} : { version: current.version }),
                        ...currentSessionRecordWhere({
                            actorUserId: params.actorUserId,
                            sessionId: params.sessionId,
                            requiredAccess: access.currentAccess,
                        }),
                    },
                    data: { content: params.content, version: { increment: 1 } },
                });
                if (updated.count !== 1) {
                    if (!await hasCurrentSessionRecordAccessInTx(tx, {
                        actorUserId: params.actorUserId,
                        sessionId: params.sessionId,
                        requiredAccess: access.currentAccess,
                    })) {
                        return { ok: false, code: "plugin_session_record_forbidden" as const };
                    }
                    return {
                        kind: params.expectedRevision === undefined
                            ? "retry-unconditional-upsert" as const
                            : "refetch-conditional-upsert-conflict" as const,
                    };
                }
                const next = await tx.sessionSystemRecord.findFirst({
                    where: {
                        accountId: access.accountId,
                        sessionId: params.sessionId,
                        recordAddressKey: found.keys.recordAddressKey,
                        ...currentSessionRecordWhere({
                            actorUserId: params.actorUserId,
                            sessionId: params.sessionId,
                            requiredAccess: "visible",
                        }),
                    },
                    select: SESSION_SYSTEM_RECORD_SELECT,
                }) as PersistedSessionSystemRecordRow | null;
                return next ? storedV1Record(next, found.expected) : { ok: false, code: "plugin_session_record_internal" as const };
            }

            if (params.expectedRevision !== undefined && params.expectedRevision !== null) {
                return { ok: false, code: "plugin_session_record_revision_conflict" };
            }
            if (!await hasCurrentSessionRecordAccessInTx(tx, {
                actorUserId: params.actorUserId,
                sessionId: params.sessionId,
                requiredAccess: access.currentAccess,
            })) {
                return { ok: false, code: "plugin_session_record_forbidden" };
            }
            const created = await tx.sessionSystemRecord.create({
                data: {
                    accountId: access.accountId,
                    sessionId: params.sessionId,
                    ownerKind: found.expected.ownerKind,
                    pluginId: found.expected.pluginId,
                    namespace: params.address.namespace,
                    kind: params.address.kind,
                    localId: params.address.localId,
                    content: params.content,
                    namespaceAddressKey: found.keys.namespaceAddressKey,
                    recordAddressKey: found.keys.recordAddressKey,
                    version: 1,
                },
                select: SESSION_SYSTEM_RECORD_SELECT,
            }) as PersistedSessionSystemRecordRow;
            return storedV1Record(created, found.expected);
        });
    } catch (error) {
        if (!isPrismaErrorCode(error, "P2002")) {
            return { ok: false, code: "plugin_session_record_internal" };
        }
        if (params.expectedRevision === undefined) {
            return retryUnconditionalSettlement
                ? await upsertSessionSystemRecordV1Attempt(params, false)
                : await settleV1UnconditionalCreateRace(params, access.accountId, access.currentAccess);
        }
        return await settleV1CreateRace(params, access.accountId, access.currentAccess);
    }
    if (!isV1UpsertMutationRace(outcome)) return outcome;
    if (outcome.kind === "retry-unconditional-upsert") {
        if (retryUnconditionalSettlement) {
            return await upsertSessionSystemRecordV1Attempt(params, false);
        }
        return { ok: false, code: "plugin_session_record_internal" };
    }
    return await resolveV1ConditionalUpsertMiss(params, access.accountId, access.currentAccess);
}

async function settleV1UnconditionalDeleteMiss(
    params: SessionSystemRecordV1BaseParams & Readonly<{
        address: SessionSystemRecordAddress;
    }>,
    accountId: string,
    currentAccess: CurrentSessionRecordAccess,
): Promise<SessionSystemRecordV1Result<Record<never, never>>> {
    const found = await refetchV1RecordAfterMutation(params, accountId, currentAccess);
    if (isV1RecordRefetchFailure(found)) return found;
    if (!found.row) return { ok: true };
    const current = storedV1Record(found.row, found.expected);
    if (!current.ok) return current;
    if (found.row.kind !== params.address.kind) {
        return { ok: false, code: "plugin_session_record_kind_conflict" };
    }
    try {
        return await inTx(async (tx) => {
            const deleted = await tx.sessionSystemRecord.deleteMany({
                where: {
                    accountId,
                    sessionId: params.sessionId,
                    recordAddressKey: found.keys.recordAddressKey,
                    id: found.row!.id,
                    ...currentSessionRecordWhere({
                        actorUserId: params.actorUserId,
                        sessionId: params.sessionId,
                        requiredAccess: currentAccess,
                    }),
                },
            });
            if (deleted.count === 1) return { ok: true };
            if (!await hasCurrentSessionRecordAccessInTx(tx, {
                actorUserId: params.actorUserId,
                sessionId: params.sessionId,
                requiredAccess: currentAccess,
            })) {
                return { ok: false, code: "plugin_session_record_forbidden" as const };
            }
            return { ok: false, code: "plugin_session_record_internal" as const };
        });
    } catch {
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
        outcome = await inTx(async (tx) => {
            const found = await findV1RecordByAddress(tx, {
                ...params,
                accountId: access.accountId,
                requiredAccess: access.currentAccess,
            });
            if (!found) return { ok: false, code: "plugin_session_record_invalid_query" as const };
            if (!found.row) {
                if (!await hasCurrentSessionRecordAccessInTx(tx, {
                    actorUserId: params.actorUserId,
                    sessionId: params.sessionId,
                    requiredAccess: access.currentAccess,
                })) {
                    return { ok: false, code: "plugin_session_record_forbidden" as const };
                }
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
                    sessionId: params.sessionId,
                    recordAddressKey: found.keys.recordAddressKey,
                    id: found.row.id,
                    ...(revision ? { version: revision.version } : {}),
                    ...currentSessionRecordWhere({
                        actorUserId: params.actorUserId,
                        sessionId: params.sessionId,
                        requiredAccess: access.currentAccess,
                    }),
                },
            });
            if (deleted.count === 1) return { ok: true };
            if (!await hasCurrentSessionRecordAccessInTx(tx, {
                actorUserId: params.actorUserId,
                sessionId: params.sessionId,
                requiredAccess: access.currentAccess,
            })) {
                return { ok: false, code: "plugin_session_record_forbidden" as const };
            }
            return {
                kind: params.expectedRevision === undefined
                    ? "settle-unconditional-delete" as const
                    : "refetch-conditional-delete-conflict" as const,
            };
        });
    } catch {
        return { ok: false, code: "plugin_session_record_internal" };
    }
    if (!isV1DeleteMutationRace(outcome)) return outcome;
    if (outcome.kind === "settle-unconditional-delete") {
        return await settleV1UnconditionalDeleteMiss(params, access.accountId, access.currentAccess);
    }
    return await resolveV1ConditionalDeleteMiss(params, access.accountId, access.currentAccess);
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
    const content = SessionSystemRecordContentSchema.safeParse(row.content);
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
    const content = SessionSystemRecordContentSchema.safeParse(row.content);
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
    const access = await ensureSessionRecordAccess(params);
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
    if (!access.access.isOwner) {
        return { ok: false, code: "permission_mediation_record_forbidden" };
    }
    return await inTx(async (tx) => {
        const session = await tx.session.findUnique({
            where: { id: params.sessionId },
            select: { accountId: true, encryptionMode: true },
        });
        if (!session) return { ok: false, code: "permission_mediation_session_not_found" as const };
        return {
            ok: true,
            accountId: session.accountId,
            sessionEncryptionMode: session.encryptionMode === "plain" ? "plain" as const : "e2ee" as const,
        };
    });
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
        return await inTx(async (tx) => {
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
        });
    } catch {
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

export async function readPermissionMediationRecord(
    params: ReadPermissionMediationRecordParams,
): Promise<PermissionMediationRecordResult<{ record: SessionPermissionMediationRecordStored | null }>> {
    if (
        !SessionPermissionMediationRecordIdentityV1Schema.safeParse(params.identity).success
        || params.identity.sessionId !== params.sessionId
    ) {
        return { ok: false, code: "permission_mediation_record_invalid" };
    }
    const access = await ensurePermissionMediationRecordAccess(params);
    if (!access.ok) return access;
    try {
        return await inTx(async (tx) => {
            const found = await findPermissionMediationRecord(tx, {
                accountId: access.accountId,
                identity: params.identity,
            });
            if (!found.row) return { ok: true, record: null };
            const stored = storedPermissionMediationRecord(found.row, params.identity);
            return stored.ok ? { ok: true, record: stored.record } : stored;
        });
    } catch {
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
                if (isDeepStrictEqual(found.row.content, params.request.content)) {
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
                    data: { content: params.request.content, version: { increment: 1 } },
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
                    content: params.request.content,
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
        return { ok: false, code: "permission_mediation_record_internal" };
    }
    if (!isPermissionMediationMutationMiss(outcome)) return outcome;
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
    } catch {
        return { ok: false, code: "permission_mediation_record_internal" };
    }
    if (!isPermissionMediationMutationMiss(outcome)) return outcome;
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
    const access = await ensurePermissionMediationRecordAccess(params);
    if (!access.ok) return access;
    const namespaceKeys = deriveSessionSystemRecordAddressKeys(
        permissionMediationNamespaceAddress(),
    );
    try {
        return await inTx(async (tx) => {
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
        });
    } catch {
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
        return await inTx(async (tx) => {
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
                })) {
                    return { ok: false, error: "forbidden" };
                }

                const updated = await tx.sessionSystemRecord.updateMany({
                    where: {
                        id: existing.id,
                        sessionId: params.sessionId,
                        ...currentSessionRecordWhere({
                            actorUserId: params.actorUserId,
                            sessionId: params.sessionId,
                            requiredAccess: currentAccess,
                        }),
                    },
                    data: {
                        content: params.content,
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
                    })) {
                        return { ok: false, error: "forbidden" };
                    }
                    return { ok: false, error: "internal" };
                }
                const updatedLookup = await findHostRecordByAddress(tx, {
                    actorUserId: params.actorUserId,
                    accountId: recordScope.accountId,
                    sessionId: params.sessionId,
                    requiredAccess: currentAccess,
                    namespace: params.namespace,
                    localId: params.localId,
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
                    content: params.content,
                    ownerKind: "host",
                    pluginId: null,
                    namespaceAddressKey: addressKeys.namespaceAddressKey,
                    recordAddressKey: addressKeys.recordAddressKey,
                    version: 1,
                },
                select: SESSION_SYSTEM_RECORD_SELECT,
            });
            const createdRecord = toSessionSystemRecordRow(created);
            if (!createdRecord) return { ok: false, error: "internal" };
            return { ok: true, didCreate: true, didUpdate: false, record: createdRecord };
        });
    } catch (error) {
        if (retryCreateRace && isPrismaErrorCode(error, "P2002")) {
            return await upsertSessionSystemRecordWithCreateRaceRetry(params, false);
        }
        return { ok: false, error: "internal" };
    }
}

export async function listSessionSystemRecords(
    params: ListSessionSystemRecordsParams,
): Promise<ListSessionSystemRecordsResult> {
    if (!validateListParams(params)) return { ok: false, error: "invalid-params" };

    const access = await ensureSessionRecordAccess(params);
    if (!access.ok) return access;
    if (!canReadHostSystemRecords({
        access: access.access,
        ...(params.namespace ? { namespace: params.namespace } : {}),
        ...(params.kind ? { kind: params.kind } : {}),
    })) return { ok: false, error: "forbidden" };

    const limit = normalizeLimit(params.limit);
    const cursor = decodeCursor(params.cursor);

    try {
        return await inTx(async (tx) => {
            const session = await tx.session.findUnique({
                where: { id: params.sessionId },
                select: { accountId: true, encryptionMode: true },
            });
            if (!session) return { ok: false, error: "session-not-found" };
            const sessionAccountId = typeof session.accountId === "string"
                ? session.accountId
                : undefined;
            const publicRecordScopes = SESSION_SYSTEM_RECORD_NAMESPACES.flatMap((namespace) => {
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
                    ...currentSessionRecordWhere({
                        actorUserId: params.actorUserId,
                        sessionId: params.sessionId,
                        requiredAccess: "visible",
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
            })) {
                return { ok: false, error: "forbidden" as const };
            }
            if (persistedRows.some((row) => !isHostRowInListScope({
                row,
                scopes: publicRecordScopes,
                localId: params.localId,
            }))) {
                return { ok: false, error: "internal" };
            }
            const pageRows = persistedRows.slice(0, limit);
            const records = pageRows.map(toSessionSystemRecordRow);
            if (records.some((record) => record === null)) return { ok: false, error: "internal" };
            const last = pageRows.at(-1);
            return {
                ok: true,
                records: records as SessionSystemRecordRow[],
                nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export async function getSessionSystemRecord(
    params: GetSessionSystemRecordParams,
): Promise<GetSessionSystemRecordResult> {
    if (!validateLookupParams(params)) return { ok: false, error: "invalid-params" };

    const access = await ensureSessionRecordAccess(params);
    if (!access.ok) return access;
    if (!canReadHostSystemRecords({ access: access.access, namespace: params.namespace })) {
        return { ok: false, error: "forbidden" };
    }

    try {
        return await inTx(async (tx) => {
            const session = await tx.session.findUnique({
                where: { id: params.sessionId },
                select: { accountId: true, encryptionMode: true },
            });
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
            });
            if (!lookup.ok) return { ok: false, error: "internal" };
            const row = lookup.row;
            if (!row) {
                if (!await hasCurrentSessionRecordAccessInTx(tx, {
                    actorUserId: params.actorUserId,
                    sessionId: params.sessionId,
                    requiredAccess: "visible",
                })) {
                    return { ok: false, error: "forbidden" };
                }
                return { ok: true, record: null };
            }
            const record = toSessionSystemRecordRow(row);
            if (!record) return { ok: false, error: "internal" };
            return { ok: true, record };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export async function getLatestSessionSystemRecord(
    params: GetLatestSessionSystemRecordParams,
): Promise<GetLatestSessionSystemRecordResult> {
    if (!validateLatestParams(params)) return { ok: false, error: "invalid-params" };

    const access = await ensureSessionRecordAccess(params);
    if (!access.ok) return access;
    if (!canReadHostSystemRecords({
        access: access.access,
        namespace: params.namespace,
        kind: params.kind,
    })) return { ok: false, error: "forbidden" };

    try {
        return await inTx(async (tx) => {
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
            const expectedNamespace = hostAddress(params.namespace, "");
            const addressKeys = deriveSessionSystemRecordAddressKeys(expectedNamespace);

            const row = await tx.sessionSystemRecord.findFirst({
                where: {
                    accountId: recordScope.accountId,
                    sessionId: params.sessionId,
                    kind: params.kind,
                    namespaceAddressKey: addressKeys.namespaceAddressKey,
                    ...currentSessionRecordWhere({
                        actorUserId: params.actorUserId,
                        sessionId: params.sessionId,
                        requiredAccess: "visible",
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
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}
