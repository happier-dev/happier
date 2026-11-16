export type SocketRoomEventName = "update" | "ephemeral" | "session";

export const CREDENTIAL_QUALIFIED_SESSION_DELIVERY_EVENT =
    "happier:credential-qualified-session-delivery:v1";

export type CredentialQualifiedSessionDeliveryV1 = Readonly<{
    v: 1;
    accountId: string;
    sessionId: string;
    eventName: SocketRoomEventName;
    payload: unknown;
    skipSocketId?: string;
}>;

export type SocketRoomBroadcastOperator = Readonly<{
    emit: (eventName: SocketRoomEventName, payload: unknown) => void;
    disconnectSockets: (close: boolean) => void;
    except?: (room: string) => SocketRoomBroadcastOperator;
}>;

export type SocketRoomEmitter = Readonly<{
    serverSideEmit?: (eventName: string, payload: unknown) => unknown;
    to: (room: string | string[]) => SocketRoomBroadcastOperator;
    /** Native API servers expose the local-only operator for receiving-node qualification. */
    local?: LocalSocketRoomEmitter;
    /** Headless Redis publishers defer protected delivery to each receiving socket-server node. */
    sessionDeliveryMode?: "forward_only";
    in?: (room: string | string[]) => Readonly<{
        fetchSockets: () => Promise<readonly Readonly<{
            id: string;
            data: import("socket.io").Socket["data"];
        }>[]>;
    }>;
}>;

export type LocalSocketRoomEmitter = Readonly<{
    to: SocketRoomEmitter["to"];
    in: NonNullable<SocketRoomEmitter["in"]>;
}>;

export function parseCredentialQualifiedSessionDelivery(
    value: unknown,
): CredentialQualifiedSessionDeliveryV1 | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Readonly<Record<string, unknown>>;
    const allowedKeys = new Set(["v", "accountId", "sessionId", "eventName", "payload", "skipSocketId"]);
    if (Object.keys(record).some((key) => !allowedKeys.has(key))) return null;
    if (record.v !== 1) return null;
    if (typeof record.accountId !== "string" || record.accountId.length === 0) return null;
    if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return null;
    if (record.eventName !== "update" && record.eventName !== "ephemeral" && record.eventName !== "session") return null;
    if (!Object.prototype.hasOwnProperty.call(record, "payload")) return null;
    if (record.skipSocketId !== undefined
        && (typeof record.skipSocketId !== "string" || record.skipSocketId.length === 0)) return null;
    return {
        v: 1,
        accountId: record.accountId,
        sessionId: record.sessionId,
        eventName: record.eventName,
        payload: record.payload,
        ...(record.skipSocketId === undefined ? {} : { skipSocketId: record.skipSocketId }),
    };
}

export const ACCOUNT_CHANGE_ROWS_DELIVERY_EVENT =
    "happier:account-change-rows-delivery:v1";

/** One committed AccountChange row as the writing transaction stored it (`changedAt` in epoch ms). */
export type AccountChangeRowsDeliveryRowV1 = Readonly<{ cursor: number; kind: string; entityId: string; changedAt: number; hint: unknown }>;

/**
 * One committed Account wake for the row-demand sockets of each node. It carries the rows the
 * writing transaction stored for the Account, unprojected: each receiving node authorizes them for
 * its own sockets through the feed's access owner. It carries no credential or access decision, and
 * no recipient's projected page (any `rows` on the wake payload is dropped).
 */
export type AccountChangeRowsDeliveryV1 = Readonly<{
    v: 1;
    accountId: string;
    /** First cursor this wake committed. */
    fromCursor: number;
    /** Last cursor this wake committed: a pushed page covers `(fromCursor - 1, toCursor]`. */
    toCursor: number;
    /** Absent when the write's rows are unknown: row-demand sockets then receive the bare wake. */
    rows?: readonly AccountChangeRowsDeliveryRowV1[];
    payload: Readonly<{ id: string; seq: number; body: Readonly<Record<string, unknown>>; createdAt: number }>;
    /** The wake's `account-stored-content-v3` filter; its exclusions apply to row-demand sockets too. */
    recipientFilter: Readonly<{ type: "account-stored-content-v3" } & Record<string, string>>;
}>;

function parseDeliveryRows(value: unknown, fromCursor: number, toCursor: number): AccountChangeRowsDeliveryRowV1[] | null {
    if (!Array.isArray(value)) return null;
    const rows: AccountChangeRowsDeliveryRowV1[] = [];
    for (const entry of value) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
        const row = entry as Readonly<Record<string, unknown>>;
        if (Object.keys(row).some((key) => !["cursor", "kind", "entityId", "changedAt", "hint"].includes(key))) return null;
        if (typeof row.cursor !== "number" || !Number.isSafeInteger(row.cursor) || row.cursor < fromCursor || row.cursor > toCursor
            || typeof row.kind !== "string" || row.kind.length === 0
            || typeof row.entityId !== "string" || row.entityId.length === 0
            || typeof row.changedAt !== "number" || !Number.isSafeInteger(row.changedAt)) return null;
        rows.push({ cursor: row.cursor, kind: row.kind, entityId: row.entityId, changedAt: row.changedAt, hint: row.hint ?? null });
    }
    return rows;
}

export function parseAccountChangeRowsDelivery(value: unknown): AccountChangeRowsDeliveryV1 | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Readonly<Record<string, unknown>>;
    const allowedKeys = new Set(["v", "accountId", "fromCursor", "toCursor", "rows", "payload", "recipientFilter"]);
    if (Object.keys(record).some((key) => !allowedKeys.has(key))) return null;
    if (record.v !== 1) return null;
    if (typeof record.accountId !== "string" || record.accountId.length === 0) return null;
    if (typeof record.fromCursor !== "number" || !Number.isSafeInteger(record.fromCursor) || record.fromCursor < 1) return null;
    if (typeof record.toCursor !== "number" || !Number.isSafeInteger(record.toCursor) || record.toCursor < record.fromCursor) return null;
    const rows = record.rows === undefined ? undefined : parseDeliveryRows(record.rows, record.fromCursor, record.toCursor);
    if (rows === null) return null;
    const payload = record.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
    const update = payload as Readonly<Record<string, unknown>>;
    if (typeof update.id !== "string" || typeof update.seq !== "number" || !Number.isSafeInteger(update.seq)
        || typeof update.createdAt !== "number" || typeof update.body !== "object" || update.body === null
        || (update.body as Readonly<Record<string, unknown>>).t !== "account-change") return null;
    const filter = record.recipientFilter;
    if (typeof filter !== "object" || filter === null || Array.isArray(filter)
        || (filter as Readonly<Record<string, unknown>>).type !== "account-stored-content-v3"
        || Object.values(filter).some((entry) => typeof entry !== "string" || entry.length === 0)) return null;
    return {
        v: 1,
        accountId: record.accountId,
        fromCursor: record.fromCursor,
        toCursor: record.toCursor,
        ...(rows ? { rows } : {}),
        // Each socket's page is projected by the receiving node, never carried on the payload.
        payload: { id: update.id, seq: update.seq, createdAt: update.createdAt,
            body: Object.fromEntries(Object.entries(update.body as Readonly<Record<string, unknown>>).filter(([key]) => key !== "rows")) },
        recipientFilter: filter as AccountChangeRowsDeliveryV1["recipientFilter"],
    };
}
