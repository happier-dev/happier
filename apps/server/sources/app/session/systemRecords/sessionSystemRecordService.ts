import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";

import {
    isStoredContentKindAllowedForSessionByStoragePolicy,
    SESSION_SYSTEM_RECORD_CATALOG,
    SESSION_SYSTEM_RECORD_NAMESPACES,
    SessionSystemRecordLatestQuerySchema,
    SessionSystemRecordListQuerySchema,
    SessionSystemRecordLookupQuerySchema,
    SessionSystemRecordUpsertRequestSchema,
    type SessionStoredContentKind,
    type SessionStoredMessageContent,
    type SessionSystemRecordKind,
    type SessionSystemRecordNamespace,
} from "@happier-dev/protocol";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveEncryptionWriteRejectionCode, type EncryptionPolicyRejectionCode } from "@/app/session/encryptionRejectionCodes";
import { checkSessionAccess } from "@/app/share/accessControl";
import { inTx } from "@/storage/inTx";

const SESSION_SYSTEM_RECORD_CURSOR_PREFIX = "v1";
const SESSION_SYSTEM_RECORD_MAX_LIMIT = 500;
const SESSION_SYSTEM_RECORD_DEFAULT_LIMIT = 100;

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

const SESSION_SYSTEM_RECORD_SELECT = {
    id: true,
    accountId: true,
    sessionId: true,
    namespace: true,
    kind: true,
    localId: true,
    content: true,
    createdAt: true,
    updatedAt: true,
} as const;

function parseRecordPayload(value: unknown): {
    namespace: SessionSystemRecordNamespace;
    kind: SessionSystemRecordKind;
    localId: string;
    content: SessionStoredMessageContent;
} | null {
    const parsed = SessionSystemRecordUpsertRequestSchema.safeParse(value);
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
    | { ok: true }
    | { ok: false; error: "invalid-params" | "session-not-found" }
> {
    if (!params.actorUserId || !params.sessionId) {
        return { ok: false, error: "invalid-params" };
    }
    const access = await checkSessionAccess(params.actorUserId, params.sessionId);
    if (!access) {
        return { ok: false, error: "session-not-found" };
    }
    return { ok: true };
}

function validateUpsertParams(params: UpsertSessionSystemRecordParams): boolean {
    if (!params.actorUserId || !params.sessionId) return false;
    return SessionSystemRecordUpsertRequestSchema.safeParse({
        namespace: params.namespace,
        kind: params.kind,
        localId: params.localId,
        content: params.content,
    }).success;
}

function validateListParams(params: ListSessionSystemRecordsParams): boolean {
    if (!params.actorUserId || !params.sessionId) return false;
    if (!SessionSystemRecordListQuerySchema.safeParse({
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
    return SessionSystemRecordLookupQuerySchema.safeParse({
        namespace: params.namespace,
        localId: params.localId,
    }).success;
}

function validateLatestParams(params: GetLatestSessionSystemRecordParams): boolean {
    if (!params.actorUserId || !params.sessionId) return false;
    return SessionSystemRecordLatestQuerySchema.safeParse({
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
    actorUserId: string;
    sessionAccountId: string | undefined;
}>): SessionRecordAccountScope {
    // Memory records are actor-private. Activity workflow records are session-scoped projections
    // referenced by session metadata, so every participant must read the same owner-owned row.
    return {
        accountId: params.namespace === "activity"
            ? (params.sessionAccountId ?? params.actorUserId)
            : params.actorUserId,
    };
}

export async function upsertSessionSystemRecord(
    params: UpsertSessionSystemRecordParams,
): Promise<UpsertSessionSystemRecordResult> {
    if (!validateUpsertParams(params)) return { ok: false, error: "invalid-params" };

    const access = await ensureSessionRecordAccess(params);
    if (!access.ok) return access;

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

            const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
            const storageMode = buildStorageModeRejection({
                storagePolicy: readEncryptionFeatureEnv(process.env).storagePolicy,
                sessionEncryptionMode,
                content: params.content,
            });
            if (!storageMode.ok) {
                return { ok: false, error: "invalid-params", code: storageMode.code };
            }

            const existing = await tx.sessionSystemRecord.findUnique({
                where: {
                    accountId_sessionId_namespace_localId: {
                        accountId: recordScope.accountId,
                        sessionId: params.sessionId,
                        namespace: params.namespace,
                        localId: params.localId,
                    },
                },
                select: SESSION_SYSTEM_RECORD_SELECT,
            });

            if (existing) {
                if (existing.kind !== params.kind) return { ok: false, error: "conflict" };
                const existingRecord = toSessionSystemRecordRow(existing);
                if (!existingRecord) return { ok: false, error: "internal" };
                if (isDeepStrictEqual(existingRecord.content, params.content)) {
                    return { ok: true, didCreate: false, didUpdate: false, record: existingRecord };
                }

                const updated = await tx.sessionSystemRecord.update({
                    where: { id: existing.id },
                    data: { content: params.content },
                    select: SESSION_SYSTEM_RECORD_SELECT,
                });
                const updatedRecord = toSessionSystemRecordRow(updated);
                if (!updatedRecord) return { ok: false, error: "internal" };
                return { ok: true, didCreate: false, didUpdate: true, record: updatedRecord };
            }

            const created = await tx.sessionSystemRecord.create({
                data: {
                    accountId: recordScope.accountId,
                    sessionId: params.sessionId,
                    namespace: params.namespace,
                    kind: params.kind,
                    localId: params.localId,
                    content: params.content,
                },
                select: SESSION_SYSTEM_RECORD_SELECT,
            });
            const createdRecord = toSessionSystemRecordRow(created);
            if (!createdRecord) return { ok: false, error: "internal" };
            return { ok: true, didCreate: true, didUpdate: false, record: createdRecord };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export async function listSessionSystemRecords(
    params: ListSessionSystemRecordsParams,
): Promise<ListSessionSystemRecordsResult> {
    if (!validateListParams(params)) return { ok: false, error: "invalid-params" };

    const access = await ensureSessionRecordAccess(params);
    if (!access.ok) return access;

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
                );
                const admittedKinds = params.kind === undefined
                    ? registeredKinds
                    : registeredKinds.includes(params.kind)
                        ? [params.kind]
                        : [];
                if (admittedKinds.length === 0) return [];
                return [{
                    ...resolveSystemRecordAccountScope({
                        namespace,
                        actorUserId: params.actorUserId,
                        sessionAccountId,
                    }),
                    namespace,
                    kind: { in: admittedKinds },
                }];
            });
            if (publicRecordScopes.length === 0) {
                return { ok: true, records: [], nextCursor: null };
            }

            const rows = await tx.sessionSystemRecord.findMany({
                where: {
                    sessionId: params.sessionId,
                    ...(params.localId ? { localId: params.localId } : {}),
                    ...(cursor
                        ? {
                            AND: [
                                { OR: publicRecordScopes },
                                {
                                    OR: [
                                        { updatedAt: { lt: cursor.updatedAt } },
                                        { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
                                    ],
                                },
                            ],
                        }
                        : { OR: publicRecordScopes }),
                },
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
                take: limit + 1,
                select: SESSION_SYSTEM_RECORD_SELECT,
            });
            const pageRows = rows.slice(0, limit);
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

            const row = await tx.sessionSystemRecord.findUnique({
                where: {
                    accountId_sessionId_namespace_localId: {
                        accountId: recordScope.accountId,
                        sessionId: params.sessionId,
                        namespace: params.namespace,
                        localId: params.localId,
                    },
                },
                select: SESSION_SYSTEM_RECORD_SELECT,
            });
            if (!row) return { ok: true, record: null };
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

            const row = await tx.sessionSystemRecord.findFirst({
                where: {
                    accountId: recordScope.accountId,
                    sessionId: params.sessionId,
                    namespace: params.namespace,
                    kind: params.kind,
                },
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
                select: SESSION_SYSTEM_RECORD_SELECT,
            });
            if (!row) return { ok: true, record: null };
            const record = toSessionSystemRecordRow(row);
            if (!record) return { ok: false, error: "internal" };
            return { ok: true, record };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}
