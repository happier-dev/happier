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
