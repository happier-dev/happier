import {
    SESSION_DRAFT_SOCKET_EVENT,
    SessionDraftStoredContentEnvelopeV1Schema,
    canonicalSessionDraftAddressV1,
    pluginJsonValuesEqual,
    type SessionDraftAddressV1,
    type SessionDraftExpectedRevisionV1,
    type SessionDraftListResponseV1,
    type SessionDraftMutateResponseV1,
    type SessionDraftReadResponseV1,
    type SessionDraftRecordV1,
    type SessionDraftStoredContentEnvelopeV1,
    type AccountEncryptionMigrateSessionDraftsDirective,
} from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { eventRouter } from "@/app/events/eventRouter";
import { applyUserKvMutationsInTx } from "@/app/kv/kvMutate";
import { db } from "@/storage/db";
import { afterTx, inTx, type Tx } from "@/storage/inTx";

import {
    ACCOUNT_SESSION_DRAFT_KV_PREFIX,
    parseSessionDraftPhysicalKey,
    sessionDraftPhysicalKey,
} from "./sessionDraftPhysicalKey";

export type SessionDraftMutationServiceResult = SessionDraftMutateResponseV1
    | Readonly<{ status: "sessionUnavailable" }>
    | Readonly<{ status: "invalidContentMode" }>
    | Readonly<{ status: "invalidAddressBinding" }>;

export type SessionDraftAccountMigrationResult =
    | Readonly<{ status: "applied"; records: readonly SessionDraftRecordV1[] }>
    | Readonly<{
        status: "requires_upgrade" | "migration_incomplete" | "source_mismatch";
    }>;

export type SessionDraftAccountMigrationPostStateResult =
    | Readonly<{ status: "matched"; records: readonly SessionDraftRecordV1[] }>
    | Readonly<{ status: "requires_upgrade" | "mismatch" }>;

export const SESSION_DRAFT_ACCOUNT_CHANGE_ENTITY_PREFIX = "session-draft:";

const SESSION_DRAFT_ROW_SELECT = {
    key: true,
    value: true,
    version: true,
    createdAt: true,
    updatedAt: true,
} as const;

type SessionDraftKvRow = Readonly<{
    key: string;
    value: Uint8Array | null;
    version: number;
    createdAt: Date;
    updatedAt: Date;
}>;

export function encodeSessionDraftContentForKv(
    content: SessionDraftStoredContentEnvelopeV1 | null,
): string | null {
    return content === null
        ? null
        : privacyKit.encodeBase64(new TextEncoder().encode(JSON.stringify(content)));
}

export function decodeSessionDraftContentFromKv(
    value: Uint8Array | null,
): SessionDraftStoredContentEnvelopeV1 | null {
    if (value === null) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
    } catch {
        throw new Error("Stored session draft content is malformed");
    }
    const parsed = SessionDraftStoredContentEnvelopeV1Schema.safeParse(raw);
    if (!parsed.success) throw new Error("Stored session draft content is malformed");
    return parsed.data;
}

function mapRow(row: SessionDraftKvRow, address?: SessionDraftAddressV1): SessionDraftRecordV1 {
    const resolvedAddress = address ?? parseSessionDraftPhysicalKey(row.key);
    if (!resolvedAddress) throw new Error("Stored session draft key is malformed");
    return {
        address: resolvedAddress,
        revision: row.version,
        content: decodeSessionDraftContentFromKv(row.value),
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
    };
}

async function resolveAddressMode(
    tx: Tx,
    accountId: string,
    address: SessionDraftAddressV1,
): Promise<"plain" | "e2ee" | null> {
    if (address.kind === "newSession") {
        const account = await tx.account.findUnique({
            where: { id: accountId },
            select: { encryptionMode: true },
        });
        if (!account) return null;
        const resolved = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
        return resolved.status === "ready" ? resolved.mode : null;
    }
    const session = await tx.session.findFirst({
        where: {
            id: address.sessionId,
            OR: [
                { accountId },
                { shares: { some: { sharedWithUserId: accountId } } },
            ],
        },
        select: { encryptionMode: true },
    });
    if (!session) return null;
    return session.encryptionMode === "plain" ? "plain" : "e2ee";
}

function contentMatchesAddress(
    content: SessionDraftStoredContentEnvelopeV1 | null,
    address: SessionDraftAddressV1,
): boolean {
    if (content === null || content.t === "encrypted") return true;
    return canonicalSessionDraftAddressV1(content.v.address)
        === canonicalSessionDraftAddressV1(address);
}

function contentMatchesMode(
    content: SessionDraftStoredContentEnvelopeV1 | null,
    mode: "plain" | "e2ee",
): boolean {
    return content === null || (mode === "plain" ? content.t === "plain" : content.t === "encrypted");
}

export async function publishDraftMutationInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        address: SessionDraftAddressV1;
        record: SessionDraftRecordV1;
    }>,
): Promise<void> {
    const status = params.record.content === null ? "deleted" as const : "present" as const;
    const hint = {
        v: 1 as const,
        sessionDraft: true as const,
        address: params.address,
        revision: params.record.revision,
        status,
    };
    await markAccountChanged(tx, {
        accountId: params.accountId,
        kind: "account",
        entityId: `${SESSION_DRAFT_ACCOUNT_CHANGE_ENTITY_PREFIX}${canonicalSessionDraftAddressV1(params.address)}`,
        hint,
    });
    afterTx(tx, () => {
        eventRouter.emitEphemeral({
            userId: params.accountId,
            payload: { type: SESSION_DRAFT_SOCKET_EVENT, ...hint },
            recipientFilter: { type: "user-scoped-only" },
        });
    });
}

async function readRowInTx(
    tx: Tx,
    accountId: string,
    key: string,
): Promise<SessionDraftKvRow | null> {
    return await tx.userKVStore.findUnique({
        where: { accountId_key: { accountId, key } },
        select: SESSION_DRAFT_ROW_SELECT,
    });
}

export async function tombstoneSessionDraftForLifecycleInTx(
    tx: Tx,
    params: Readonly<{ accountId: string; sessionId: string }>,
): Promise<boolean> {
    const address = { kind: "session" as const, sessionId: params.sessionId };
    const key = sessionDraftPhysicalKey(address);
    if (!key) return false;
    const current = await readRowInTx(tx, params.accountId, key);
    if (!current || current.value === null) return false;
    const application = await applyUserKvMutationsInTx(
        tx,
        { uid: params.accountId },
        [{ key, value: null, version: current.version }],
    );
    if (!application.success) {
        throw new Error("Session draft lifecycle tombstone lost its transactional revision");
    }
    const updated = await readRowInTx(tx, params.accountId, key);
    if (!updated) throw new Error("Session draft lifecycle tombstone row disappeared");
    await publishDraftMutationInTx(tx, {
        accountId: params.accountId,
        address,
        record: mapRow(updated, address),
    });
    return true;
}

/**
 * Rewrites only Account-owned new-session drafts in the incumbent atomic
 * Account migration transaction. Existing-session drafts remain Session-owned.
 */
export async function migrateNewSessionDraftsForAccountModeInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        toMode: "plain" | "e2ee";
        directive?: AccountEncryptionMigrateSessionDraftsDirective;
    }>,
): Promise<SessionDraftAccountMigrationResult> {
    const rows = await tx.userKVStore.findMany({
        where: {
            accountId: params.accountId,
            key: { startsWith: `${ACCOUNT_SESSION_DRAFT_KV_PREFIX}new-session/` },
            value: { not: null },
        },
        orderBy: { key: "asc" },
        select: SESSION_DRAFT_ROW_SELECT,
    });
    if (!params.directive) {
        return rows.length === 0
            ? { status: "applied", records: [] }
            : { status: "requires_upgrade" };
    }

    const incomingByKey = new Map<
        string,
        AccountEncryptionMigrateSessionDraftsDirective["items"][number]
    >();
    for (const item of params.directive.items) {
        const key = sessionDraftPhysicalKey(item.address);
        if (!key || incomingByKey.has(key)
            || !contentMatchesMode(item.content, params.toMode)
            || !contentMatchesAddress(item.content, item.address)) {
            return { status: "migration_incomplete" };
        }
        incomingByKey.set(key, item);
    }
    if (incomingByKey.size !== rows.length) return { status: "migration_incomplete" };
    for (const row of rows) {
        const item = incomingByKey.get(row.key);
        if (!item) return { status: "migration_incomplete" };
        if (item.expectedRevision !== row.version) return { status: "source_mismatch" };
    }
    if (rows.length === 0) return { status: "applied", records: [] };

    const application = await applyUserKvMutationsInTx(
        tx,
        { uid: params.accountId },
        rows.map((row) => {
            const item = incomingByKey.get(row.key);
            if (!item) throw new Error("Validated session draft migration became incomplete");
            return {
                key: row.key,
                value: encodeSessionDraftContentForKv(item.content),
                version: item.expectedRevision,
            };
        }),
    );
    if (!application.success) return { status: "source_mismatch" };

    const updatedRows = await tx.userKVStore.findMany({
        where: { accountId: params.accountId, key: { in: rows.map((row) => row.key) } },
        orderBy: { key: "asc" },
        select: SESSION_DRAFT_ROW_SELECT,
    });
    if (updatedRows.length !== rows.length) {
        throw new Error("Session draft migration rows disappeared after atomic CAS");
    }
    const records: SessionDraftRecordV1[] = [];
    for (const row of updatedRows) {
        const item = incomingByKey.get(row.key);
        if (!item) throw new Error("Validated session draft migration became incomplete");
        const record = mapRow(row, item.address);
        records.push(record);
        await publishDraftMutationInTx(tx, {
            accountId: params.accountId,
            address: item.address,
            record,
        });
    }
    return { status: "applied", records };
}

/** Read-only exact post-state matcher for incumbent Account-migration replay. */
export async function matchNewSessionDraftsAccountMigrationPostStateInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        toMode: "plain" | "e2ee";
        directive?: AccountEncryptionMigrateSessionDraftsDirective;
    }>,
): Promise<SessionDraftAccountMigrationPostStateResult> {
    const rows = await tx.userKVStore.findMany({
        where: {
            accountId: params.accountId,
            key: { startsWith: `${ACCOUNT_SESSION_DRAFT_KV_PREFIX}new-session/` },
            value: { not: null },
        },
        orderBy: { key: "asc" },
        select: SESSION_DRAFT_ROW_SELECT,
    });
    if (!params.directive) {
        return rows.length === 0
            ? { status: "matched", records: [] }
            : { status: "requires_upgrade" };
    }

    const incomingByKey = new Map<
        string,
        AccountEncryptionMigrateSessionDraftsDirective["items"][number]
    >();
    for (const item of params.directive.items) {
        const key = sessionDraftPhysicalKey(item.address);
        if (!key || incomingByKey.has(key)
            || !contentMatchesMode(item.content, params.toMode)
            || !contentMatchesAddress(item.content, item.address)) {
            return { status: "mismatch" };
        }
        incomingByKey.set(key, item);
    }
    if (incomingByKey.size !== rows.length) return { status: "mismatch" };

    const records: SessionDraftRecordV1[] = [];
    for (const row of rows) {
        const item = incomingByKey.get(row.key);
        if (!item || row.version !== item.expectedRevision + 1) {
            return { status: "mismatch" };
        }
        let record: SessionDraftRecordV1;
        try {
            record = mapRow(row, item.address);
        } catch {
            return { status: "mismatch" };
        }
        if (record.content === null
            || !pluginJsonValuesEqual(record.content, item.content)) {
            return { status: "mismatch" };
        }
        records.push(record);
    }
    return { status: "matched", records };
}

export async function readSessionDraft(params: Readonly<{
    accountId: string;
    address: SessionDraftAddressV1;
}>): Promise<SessionDraftReadResponseV1> {
    return await inTx(async (tx) => {
        const mode = await resolveAddressMode(tx, params.accountId, params.address);
        if (!mode) return { status: "absent" };
        const key = sessionDraftPhysicalKey(params.address);
        if (!key) return { status: "absent" };
        const row = await readRowInTx(tx, params.accountId, key);
        if (!row) return { status: "absent" };
        const record = mapRow(row, params.address);
        return record.content === null
            ? { status: "deleted", record }
            : { status: "present", record };
    });
}

export async function listSessionDrafts(params: Readonly<{
    accountId: string;
    after?: string;
    limit?: number;
}>): Promise<SessionDraftListResponseV1> {
    const limit = params.limit ?? 50;
    const collected: SessionDraftRecordV1[] = [];
    let afterPhysicalKey = params.after
        ? `${ACCOUNT_SESSION_DRAFT_KV_PREFIX}${params.after}`
        : undefined;
    while (collected.length <= limit) {
        const rows = await db.userKVStore.findMany({
            where: {
                accountId: params.accountId,
                key: {
                    startsWith: ACCOUNT_SESSION_DRAFT_KV_PREFIX,
                    ...(afterPhysicalKey ? { gt: afterPhysicalKey } : {}),
                },
                value: { not: null },
            },
            orderBy: { key: "asc" },
            take: 100,
            select: SESSION_DRAFT_ROW_SELECT,
        });
        if (rows.length === 0) break;
        afterPhysicalKey = rows[rows.length - 1]!.key;
        const candidates: Array<{
            row: SessionDraftKvRow;
            address: SessionDraftAddressV1;
        }> = [];
        for (const row of rows) {
            const address = parseSessionDraftPhysicalKey(row.key);
            if (address) candidates.push({ row, address });
        }
        const sessionIds = candidates.flatMap(({ address }) => (
            address.kind === "session" ? [address.sessionId] : []
        ));
        const reachableSessions = new Set(sessionIds.length === 0 ? [] : (await db.session.findMany({
            where: {
                id: { in: sessionIds },
                OR: [
                    { accountId: params.accountId },
                    { shares: { some: { sharedWithUserId: params.accountId } } },
                ],
            },
            select: { id: true },
        })).map((session) => session.id));
        for (const { row, address } of candidates) {
            if (address.kind === "session" && !reachableSessions.has(address.sessionId)) continue;
            collected.push(mapRow(row, address));
            if (collected.length > limit) break;
        }
        if (collected.length > limit || rows.length < 100) break;
    }
    const items = collected.slice(0, limit);
    const nextAfter = collected.length > limit && items.length > 0
        ? canonicalSessionDraftAddressV1(items[items.length - 1]!.address)
        : undefined;
    return { items, ...(nextAfter ? { nextAfter } : {}) };
}

export async function mutateSessionDraft(params: Readonly<{
    accountId: string;
    address: SessionDraftAddressV1;
    expectedRevision: SessionDraftExpectedRevisionV1;
    content: SessionDraftStoredContentEnvelopeV1 | null;
}>): Promise<SessionDraftMutationServiceResult> {
    return await inTx(async (tx) => {
        const mode = await resolveAddressMode(tx, params.accountId, params.address);
        if (!mode) return { status: "sessionUnavailable" };
        if (!contentMatchesMode(params.content, mode)) return { status: "invalidContentMode" };
        if (!contentMatchesAddress(params.content, params.address)) return { status: "invalidAddressBinding" };
        const key = sessionDraftPhysicalKey(params.address);
        if (!key) return { status: "sessionUnavailable" };
        const application = await applyUserKvMutationsInTx(
            tx,
            { uid: params.accountId },
            [{
                key,
                value: encodeSessionDraftContentForKv(params.content),
                version: params.expectedRevision === "absent" ? -1 : params.expectedRevision,
            }],
        );
        if (!application.success) {
            const current = await readRowInTx(tx, params.accountId, key);
            return {
                status: "conflict",
                current: current ? mapRow(current, params.address) : { status: "absent" },
            };
        }
        const updated = await readRowInTx(tx, params.accountId, key);
        if (!updated) throw new Error("Session draft mutation row disappeared");
        const record = mapRow(updated, params.address);
        await publishDraftMutationInTx(tx, {
            accountId: params.accountId,
            address: params.address,
            record,
        });
        return { status: "updated", record };
    });
}
