import {
    SESSION_DRAFT_SOCKET_EVENT,
    SESSION_DRAFT_V2_SOCKET_EVENT,
    SessionDraftStoredContentEnvelopeV2StoredSchema,
    canonicalSessionDraftAddressV1,
    canonicalSessionDraftAddressV2,
    isSessionDraftAddressV1,
    isSessionDraftContentV1,
    isAccountOwnedDraftAddressV2,
    pluginJsonValuesEqual,
    type SessionDraftAddressKindV2,
    type SessionDraftAddressV2,
    type SessionDraftExpectedRevisionV1,
    type SessionDraftListResponseV2,
    type SessionDraftMutateResponseV2,
    type SessionDraftReadResponseV2,
    type SessionDraftRecordV2,
    type SessionDraftStoredContentEnvelopeV2,
    type AccountEncryptionMigrateSessionDraftsDirective,
    type AccountOwnedDraftAddressV2,
} from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";

import { closeDraftEphemeralRunnerActivationsInTx } from "@/app/ephemeralRunner/activationLifecycle";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { eventRouter } from "@/app/events/eventRouter";
import { applyUserKvMutationsInTx } from "@/app/kv/kvMutate";
import { buildSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { db } from "@/storage/db";
import { afterTx, inTx, type Tx } from "@/storage/inTx";

import {
    ACCOUNT_SESSION_DRAFT_KV_PREFIX,
    parseSessionDraftPhysicalKey,
    sessionDraftPhysicalKey,
    sessionDraftPhysicalKeySessionPrefix,
} from "./sessionDraftPhysicalKey";

export type SessionDraftAddressEpoch = "v1" | "v2";

export type SessionDraftMutationServiceResult = SessionDraftMutateResponseV2
    | Readonly<{ status: "epochUnavailable" }>
    | Readonly<{ status: "sessionUnavailable" }>
    | Readonly<{ status: "invalidContentMode" }>
    | Readonly<{ status: "invalidAddressBinding" }>;

export type SessionDraftReadServiceResult = SessionDraftReadResponseV2
    | Readonly<{ status: "epochUnavailable" }>;

export type SessionDraftAccountMigrationResult =
    | Readonly<{ status: "applied"; records: readonly SessionDraftRecordV2[] }>
    | Readonly<{
        status: "requires_upgrade" | "migration_incomplete";
    }>
    | Readonly<{
        status: "source_mismatch";
        address?: AccountOwnedDraftAddressV2;
        currentRevision?: number;
    }>;

export type SessionDraftAccountMigrationPostStateResult =
    | Readonly<{ status: "matched"; records: readonly SessionDraftRecordV2[] }>
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
    content: SessionDraftStoredContentEnvelopeV2 | null,
): string | null {
    return content === null
        ? null
        : privacyKit.encodeBase64(new TextEncoder().encode(JSON.stringify(content)));
}

export function decodeSessionDraftContentFromKv(
    value: Uint8Array | null,
): SessionDraftStoredContentEnvelopeV2 | null {
    if (value === null) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
    } catch {
        throw new Error("Stored session draft content is malformed");
    }
    const parsed = SessionDraftStoredContentEnvelopeV2StoredSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Stored session draft content is malformed");
    return parsed.data;
}

function mapRow(row: SessionDraftKvRow, address?: SessionDraftAddressV2): SessionDraftRecordV2 {
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

/**
 * Account-owned drafts follow Account mode. Session-bound drafts consume the
 * canonical readable-Session decision and retain Account-private visibility.
 */
async function resolveAddressMode(
    tx: Tx,
    accountId: string,
    address: SessionDraftAddressV2,
    authentication: SessionAccessAuthentication,
): Promise<"plain" | "e2ee" | null> {
    if (isAccountOwnedDraftAddressV2(address)) {
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
            AND: [
                { id: address.sessionId },
                await buildSessionAccessWhere({
                    tx,
                    accountId,
                    capability: "readTranscript",
                    mode: "effective_access_v1",
                    authentication,
                }),
            ],
        },
        select: { encryptionMode: true },
    });
    if (!session) return null;
    return session.encryptionMode === "plain" ? "plain" : "e2ee";
}

function contentMatchesAddress(
    content: SessionDraftStoredContentEnvelopeV2 | null,
    address: SessionDraftAddressV2,
): boolean {
    if (content === null || content.t === "encrypted") return true;
    return canonicalSessionDraftAddressV2(content.v.address)
        === canonicalSessionDraftAddressV2(address);
}

function contentMatchesMode(
    content: SessionDraftStoredContentEnvelopeV2 | null,
    mode: "plain" | "e2ee",
): boolean {
    return content === null || (mode === "plain" ? content.t === "plain" : content.t === "encrypted");
}

/**
 * V1 addresses keep their exact released hint/event shape. V2-only addresses
 * publish a version-specific hint and socket event whose discriminators the
 * strict V1 parsers reject, so a released client ignores them instead of
 * feeding an unknown address into its V1 draft handler.
 */
export async function publishDraftMutationInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        address: SessionDraftAddressV2;
        record: SessionDraftRecordV2;
    }>,
): Promise<void> {
    const status = params.record.content === null ? "deleted" as const : "present" as const;
    const addressV1 = isSessionDraftAddressV1(params.address) && isSessionDraftContentV1(params.record.content)
        ? params.address
        : null;
    const hint = addressV1
        ? {
            v: 1 as const,
            sessionDraft: true as const,
            address: addressV1,
            revision: params.record.revision,
            status,
        }
        : {
            v: 2 as const,
            sessionDraftV2: true as const,
            address: params.address,
            revision: params.record.revision,
            status,
        };
    await markAccountChanged(tx, {
        accountId: params.accountId,
        kind: "account",
        entityId: `${SESSION_DRAFT_ACCOUNT_CHANGE_ENTITY_PREFIX}${canonicalSessionDraftAddressV2(params.address)}`,
        hint,
    });
    afterTx(tx, () => {
        eventRouter.emitEphemeral({
            userId: params.accountId,
            payload: {
                type: addressV1 ? SESSION_DRAFT_SOCKET_EVENT : SESSION_DRAFT_V2_SOCKET_EVENT,
                ...hint,
            },
            recipientFilter: isAccountOwnedDraftAddressV2(params.address)
                ? { type: "user-scoped-only" }
                : { type: "all-interested-in-session", sessionId: params.address.sessionId },
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

/**
 * Tombstones every draft address bound to the Session — the main composer draft
 * plus its Run, discussion and new-discussion drafts — in one lifecycle
 * transaction. Parsed canonical addresses and the encoded segment prefix keep
 * one Session from matching a sibling whose id shares its leading characters.
 */
export async function tombstoneSessionDraftForLifecycleInTx(
    tx: Tx,
    params: Readonly<{ accountId: string; sessionId: string }>,
): Promise<boolean> {
    const mainAddress = { kind: "session" as const, sessionId: params.sessionId };
    const mainKey = sessionDraftPhysicalKey(mainAddress);
    const rows = await tx.userKVStore.findMany({
        where: {
            accountId: params.accountId,
            value: { not: null },
            OR: [
                ...(mainKey ? [{ key: mainKey }] : []),
                { key: { startsWith: sessionDraftPhysicalKeySessionPrefix(params.sessionId) } },
            ],
        },
        orderBy: { key: "asc" },
        select: SESSION_DRAFT_ROW_SELECT,
    });
    const targets: Array<{ row: SessionDraftKvRow; address: SessionDraftAddressV2 }> = [];
    for (const row of rows) {
        const address = parseSessionDraftPhysicalKey(row.key);
        if (!address || isAccountOwnedDraftAddressV2(address) || address.sessionId !== params.sessionId) continue;
        targets.push({ row, address });
    }
    if (targets.length === 0) return false;
    const application = await applyUserKvMutationsInTx(
        tx,
        { uid: params.accountId },
        targets.map(({ row }) => ({ key: row.key, value: null, version: row.version })),
    );
    if (!application.success) {
        throw new Error("Session draft lifecycle tombstone lost its transactional revision");
    }
    for (const { row, address } of targets) {
        const updated = await readRowInTx(tx, params.accountId, row.key);
        if (!updated) throw new Error("Session draft lifecycle tombstone row disappeared");
        await publishDraftMutationInTx(tx, {
            accountId: params.accountId,
            address,
            record: mapRow(updated, address),
        });
    }
    return true;
}

/** Conversion and exact replay consume the same Account-owned draft census. */
async function readAccountOwnedDraftRowsInTx(tx: Tx, accountId: string): Promise<SessionDraftKvRow[]> {
    return await tx.userKVStore.findMany({
        where: {
            accountId,
            OR: [
                { key: { startsWith: `${ACCOUNT_SESSION_DRAFT_KV_PREFIX}new-session/` } },
                { key: { startsWith: `${ACCOUNT_SESSION_DRAFT_KV_PREFIX}project-open/` } },
            ],
            value: { not: null },
        },
        orderBy: { key: "asc" },
        select: SESSION_DRAFT_ROW_SELECT,
    });
}

function hasSuccessorDraftRows(rows: readonly SessionDraftKvRow[]): boolean {
    return rows.some((row) => {
        const address = parseSessionDraftPhysicalKey(row.key);
        return !address || !isSessionDraftAddressV1(address)
            || !isSessionDraftContentV1(decodeSessionDraftContentFromKv(row.value));
    });
}

/**
 * Rewrites Account-owned new-session and project-open drafts in the incumbent
 * atomic Account migration transaction. Session-bound drafts keep their owner.
 */
export async function migrateNewSessionDraftsForAccountModeInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        toMode: "plain" | "e2ee";
        directive?: AccountEncryptionMigrateSessionDraftsDirective;
    }>,
): Promise<SessionDraftAccountMigrationResult> {
    const rows = await readAccountOwnedDraftRowsInTx(tx, params.accountId);
    // Only the explicitly capable directive may replace successor content;
    // the unversioned writer cannot safely preserve its authoring intent.
    if (!(params.directive && "v" in params.directive && params.directive.v === 2)
        && hasSuccessorDraftRows(rows)) {
        return { status: "requires_upgrade" };
    }
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
        if (item.expectedRevision !== row.version) return {
            status: "source_mismatch", address: item.address, currentRevision: row.version,
        };
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
    const records: SessionDraftRecordV2[] = [];
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
    const rows = await readAccountOwnedDraftRowsInTx(tx, params.accountId);
    // Replay must honor the same content epoch as the original transition.
    if (!(params.directive && "v" in params.directive && params.directive.v === 2)
        && hasSuccessorDraftRows(rows)) {
        return { status: "requires_upgrade" };
    }
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

    const records: SessionDraftRecordV2[] = [];
    for (const row of rows) {
        const item = incomingByKey.get(row.key);
        if (!item || row.version !== item.expectedRevision + 1) {
            return { status: "mismatch" };
        }
        let record: SessionDraftRecordV2;
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

export async function readSessionDraftInTx(tx: Tx, params: Readonly<{
    accountId: string;
    address: SessionDraftAddressV2;
    epoch?: SessionDraftAddressEpoch;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionDraftReadServiceResult> {
    if (params.epoch === "v1" && !isSessionDraftAddressV1(params.address)) return { status: "epochUnavailable" };
    const mode = await resolveAddressMode(tx, params.accountId, params.address, params.authentication);
    if (!mode) return { status: "absent" };
    const key = sessionDraftPhysicalKey(params.address);
    if (!key) return { status: "absent" };
    const row = await readRowInTx(tx, params.accountId, key);
    if (!row) return { status: "absent" };
    const record = mapRow(row, params.address);
    if (params.epoch === "v1" && !isSessionDraftContentV1(record.content)) return { status: "epochUnavailable" };
    return record.content === null
        ? { status: "deleted", record }
        : { status: "present", record };
}

export async function readSessionDraft(params: Readonly<{
    accountId: string;
    address: SessionDraftAddressV2;
    epoch?: SessionDraftAddressEpoch;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionDraftReadServiceResult> {
    return await inTx((tx) => readSessionDraftInTx(tx, params));
}

/**
 * One paged reader over the shared reserved KV prefix. The V1 epoch filters
 * V2-only rows out before pagination, so its page size, `nextAfter` cursor and
 * item shape stay exactly what a released V1 client expects even when V2 rows
 * sort between V1 rows.
 */
export async function listSessionDrafts(params: Readonly<{
    accountId: string;
    after?: string;
    limit?: number;
    epoch?: SessionDraftAddressEpoch;
    addressKinds?: readonly SessionDraftAddressKindV2[];
    authentication: SessionAccessAuthentication;
}>): Promise<SessionDraftListResponseV2> {
    const epoch = params.epoch ?? "v1";
    const selectedKinds = epoch === "v2" && params.addressKinds
        ? new Set<SessionDraftAddressKindV2>(params.addressKinds)
        : null;
    const limit = params.limit ?? 50;
    const collected: SessionDraftRecordV2[] = [];
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
            address: SessionDraftAddressV2;
        }> = [];
        for (const row of rows) {
            const address = parseSessionDraftPhysicalKey(row.key);
            if (!address) continue;
            if (epoch === "v1" && !isSessionDraftAddressV1(address)) continue;
            if (selectedKinds && !selectedKinds.has(address.kind)) continue;
            candidates.push({ row, address });
        }
        const sessionIds = candidates.flatMap(({ address }) => (
            isAccountOwnedDraftAddressV2(address) ? [] : [address.sessionId]
        ));
        const reachableSessions = new Set(sessionIds.length === 0 ? [] : (await inTx(async (tx) => {
            const accessWhere = await buildSessionAccessWhere({
                tx,
                accountId: params.accountId,
                capability: "readTranscript",
                mode: "effective_access_v1",
                authentication: params.authentication,
            });
            return await tx.session.findMany({
                where: { AND: [{ id: { in: sessionIds } }, accessWhere] },
                select: { id: true },
            });
        })).map((session) => session.id));
        for (const { row, address } of candidates) {
            if (!isAccountOwnedDraftAddressV2(address) && !reachableSessions.has(address.sessionId)) continue;
            const record = mapRow(row, address);
            if (epoch === "v1" && !isSessionDraftContentV1(record.content)) continue;
            collected.push(record);
            if (collected.length > limit) break;
        }
        if (collected.length > limit || rows.length < 100) break;
    }
    const items = collected.slice(0, limit);
    const last = collected.length > limit && items.length > 0 ? items[items.length - 1]!.address : null;
    const nextAfter = last === null
        ? undefined
        : epoch === "v1" && isSessionDraftAddressV1(last)
            ? canonicalSessionDraftAddressV1(last)
            : canonicalSessionDraftAddressV2(last);
    return { items, ...(nextAfter ? { nextAfter } : {}) };
}

export async function mutateSessionDraft(params: Readonly<{
    accountId: string;
    address: SessionDraftAddressV2;
    expectedRevision: SessionDraftExpectedRevisionV1;
    content: SessionDraftStoredContentEnvelopeV2 | null;
    epoch?: SessionDraftAddressEpoch;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionDraftMutationServiceResult> {
    return await inTx(async (tx) => {
        if (params.epoch === "v1" && (!isSessionDraftAddressV1(params.address) || !isSessionDraftContentV1(params.content))) {
            return { status: "epochUnavailable" };
        }
        if (isAccountOwnedDraftAddressV2(params.address)) {
            const account = await tx.account.findUnique({ where: { id: params.accountId }, select: { id: true } });
            if (!account) return { status: "sessionUnavailable" };
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, params.accountId);
        }
        const mode = await resolveAddressMode(tx, params.accountId, params.address, params.authentication);
        if (!mode) return { status: "sessionUnavailable" };
        if (!contentMatchesMode(params.content, mode)) return { status: "invalidContentMode" };
        if (!contentMatchesAddress(params.content, params.address)) return { status: "invalidAddressBinding" };
        const key = sessionDraftPhysicalKey(params.address);
        if (!key) return { status: "sessionUnavailable" };
        if (params.epoch === "v1") {
            const current = await readRowInTx(tx, params.accountId, key);
            if (current && !isSessionDraftContentV1(decodeSessionDraftContentFromKv(current.value))) {
                // An explicit exact-revision tombstone retains the shared activation
                // cancellation contract. A rewrite or stale delete cannot expose or
                // discard successor fields through a V1 success/conflict response.
                if (params.content !== null || params.expectedRevision !== current.version) {
                    return { status: "epochUnavailable" };
                }
            }
        }
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
            if (params.epoch === "v1" && current && !isSessionDraftContentV1(decodeSessionDraftContentFromKv(current.value))) {
                return { status: "epochUnavailable" };
            }
            return {
                status: "conflict",
                current: current ? mapRow(current, params.address) : { status: "absent" },
            };
        }
        const updated = await readRowInTx(tx, params.accountId, key);
        if (!updated) throw new Error("Session draft mutation row disappeared");
        const record = mapRow(updated, params.address);
        if (params.address.kind === "newSession" && params.content === null) {
            await closeDraftEphemeralRunnerActivationsInTx(tx, { creatorAccountId: params.accountId, draftId: params.address.draftId });
        }
        await publishDraftMutationInTx(tx, {
            accountId: params.accountId,
            address: params.address,
            record,
        });
        return { status: "updated", record };
    });
}
