import { createHash, randomUUID } from "node:crypto";

import {
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    PeerTcpTunnelRelayEnvelopeSchema,
    type PeerTcpTunnelRelayEnvelope,
} from "@happier-dev/protocol";
import type { Redis } from "ioredis";
import type { Server, Socket } from "socket.io";

import { getSocketRooms } from "@/app/api/socketRooms";

const ATTACH_EVENT = "happier:peer-tunnel:attach:v1";
const DETACH_EVENT = "happier:peer-tunnel:detach:v1";
const FRAME_EVENT = "happier:peer-tunnel:frame:v1";
const DISCONNECT_EVENT = "happier:peer-tunnel:disconnect:v1";
const REDIS_GRANT_KEY_PREFIX = "peer-tunnel-relay-grant:v1:";
const FETCH_SOCKETS_TIMEOUT_MS = 5_000;
const REDIS_GRANT_ADMISSION_TIMEOUT_MS = 2_000;

type AttachRequest = Readonly<{
    attachmentId: string;
    ownerRouteId: string;
    accountId: string;
    tunnelKey: string;
    machineId: string;
    machineSocketId: string;
    maxDurationMs: number;
}>;

type AttachResponse =
    | Readonly<{ status: "attached" }>
    | Readonly<{ status: "not_local" | "rejected" }>;

type DetachRequest = Readonly<{
    attachmentId: string;
    ownerRouteId: string;
}>;

type FrameMessage = Readonly<{
    attachmentId: string;
    ownerRouteId: string;
    machineSocketId: string;
    envelope: PeerTcpTunnelRelayEnvelope;
}>;

type DisconnectMessage = Readonly<{
    attachmentId: string;
    ownerRouteId: string;
}>;

type DisconnectResponse = Readonly<{
    status: "delivered" | "not_owner" | "rejected";
}>;

type OwnerAttachment = Readonly<{
    attachmentId: string;
    ownerRouteId: string;
    machineSocketId: string;
    local: boolean;
    onMachineEnvelope(envelope: PeerTcpTunnelRelayEnvelope, machineSocketId: string): void | Promise<void>;
    onMachineDisconnect(): void | Promise<void>;
}>;

type MachineAttachment = Readonly<{
    request: AttachRequest;
    socket: Socket;
    durationTimer: ReturnType<typeof setTimeout>;
}>;

type MachineSocketAttachmentMembership = Readonly<{
    attachmentIds: Set<string>;
    onDisconnect(): void;
}>;

export type PeerTcpTunnelRelayCoordinatorConfig =
    | Readonly<{ mode: "memory" }>
    | Readonly<{ mode: "redis"; redis: Pick<Redis, "duplicate"> }>;

export type PeerTcpTunnelRelayAdmissionResult =
    | Readonly<{ status: "attached" }>
    | Readonly<{
        status: "rejected";
        reason: "grant_already_consumed" | "machine_unavailable" | "cluster_unavailable";
    }>;

export type PeerTcpTunnelRelayMachineRouteResult =
    | "remote_forwarded"
    | "local_exact"
    | "rejected";

export type PeerTcpTunnelRelayCoordinator = Readonly<{
    admit(input: Readonly<{
        accountId: string;
        tunnelKey: string;
        grantId: string;
        grantExpiresAt: number;
        machineId: string;
        maxDurationMs: number;
        nowMs: number;
        onMachineEnvelope(envelope: PeerTcpTunnelRelayEnvelope, machineSocketId: string): void | Promise<void>;
        onMachineDisconnect(): void | Promise<void>;
    }>): Promise<PeerTcpTunnelRelayAdmissionResult>;
    routeMachineEnvelope(input: Readonly<{
        tunnelKey: string;
        machineSocketId: string;
        envelope: PeerTcpTunnelRelayEnvelope;
    }>): PeerTcpTunnelRelayMachineRouteResult;
    routeOwnerEnvelope(input: Readonly<{
        tunnelKey: string;
        envelope: PeerTcpTunnelRelayEnvelope;
    }>): boolean;
    release(tunnelKey: string): void;
    close(): Promise<void>;
}>;

function machineRoom(accountId: string, machineId: string): string {
    const rooms = getSocketRooms({
        userId: accountId,
        clientType: "machine-scoped",
        machineId,
    });
    return rooms.find((room) => room.startsWith(`machine:${machineId}:`))
        ?? `machine:${machineId}:${accountId}`;
}

function consumedGrantKey(grantId: string): string {
    const digest = createHash("sha256").update(grantId, "utf8").digest("hex");
    return `${REDIS_GRANT_KEY_PREFIX}${digest}`;
}

function isExactMachineSocket(socket: Socket, request: AttachRequest): boolean {
    return socket.connected === true
        && socket.id === request.machineSocketId
        && socket.data.userId === request.accountId
        && socket.data.clientType === "machine-scoped"
        && socket.data.machineId === request.machineId
        && socket.rooms.has(machineRoom(request.accountId, request.machineId));
}

export function createPeerTcpTunnelRelayCoordinator(input: Readonly<{
    io: Server;
    config: PeerTcpTunnelRelayCoordinatorConfig;
}>): PeerTcpTunnelRelayCoordinator {
    const relayAdmissionRedis = input.config.mode === "redis"
        ? input.config.redis.duplicate({
            enableOfflineQueue: false,
            maxRetriesPerRequest: 0,
            // The parent Socket.IO client delays reconnects to outlive a stale
            // blocking-read socket timer. Admission never issues blocking reads,
            // so inheriting that closure can leave a fresh post-restart OPEN
            // fail-closed after the adapter itself is already healthy.
            retryStrategy: (attempt) => Math.min(attempt * 50, 2_000),
            socketTimeout: REDIS_GRANT_ADMISSION_TIMEOUT_MS,
        })
        : null;
    const ignoreHandledRedisAdmissionError = (): void => {
        // Admission commands surface their failure through `consumeGrant`; avoid
        // ioredis' duplicate "unhandled error event" diagnostic for this client.
    };
    relayAdmissionRedis?.on("error", ignoreHandledRedisAdmissionError);
    const ownerRouteId = randomUUID();
    const consumedGrantExpById = new Map<string, number>();
    const ownerAttachmentsByTunnelKey = new Map<string, OwnerAttachment>();
    const ownerAttachmentById = new Map<string, OwnerAttachment>();
    const machineAttachmentsById = new Map<string, MachineAttachment>();
    const machineAttachmentIdByTunnelAndSocket = new Map<string, string>();
    const machineSocketAttachmentMemberships = new Map<Socket, MachineSocketAttachmentMembership>();
    const pendingAdmissions = new Set<Promise<PeerTcpTunnelRelayAdmissionResult>>();
    let closed = false;
    let closePromise: Promise<void> | null = null;

    function machineAttachmentLookupKey(tunnelKey: string, socketId: string): string {
        return `${tunnelKey}\u0000${socketId}`;
    }

    function readRecord(value: unknown): Record<string, unknown> | null {
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? value as Record<string, unknown>
            : null;
    }

    function readBoundedString(value: unknown): string | null {
        return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
    }

    function parseAttachRequest(value: unknown): AttachRequest | null {
        const record = readRecord(value);
        if (!record) return null;
        const attachmentId = readBoundedString(record.attachmentId);
        const requestOwnerRouteId = readBoundedString(record.ownerRouteId);
        const accountId = readBoundedString(record.accountId);
        const tunnelKey = readBoundedString(record.tunnelKey);
        const machineId = readBoundedString(record.machineId);
        const machineSocketId = readBoundedString(record.machineSocketId);
        const maxDurationMs = record.maxDurationMs;
        if (
            !attachmentId
            || !requestOwnerRouteId
            || !accountId
            || !tunnelKey
            || !machineId
            || !machineSocketId
            || typeof maxDurationMs !== "number"
            || !Number.isSafeInteger(maxDurationMs)
            || maxDurationMs <= 0
        ) {
            return null;
        }
        return {
            attachmentId,
            ownerRouteId: requestOwnerRouteId,
            accountId,
            tunnelKey,
            machineId,
            machineSocketId,
            maxDurationMs,
        };
    }

    function parseDetachRequest(value: unknown): DetachRequest | null {
        const record = readRecord(value);
        if (!record) return null;
        const attachmentId = readBoundedString(record.attachmentId);
        const requestOwnerRouteId = readBoundedString(record.ownerRouteId);
        return attachmentId && requestOwnerRouteId
            ? { attachmentId, ownerRouteId: requestOwnerRouteId }
            : null;
    }

    function parseAttachResponse(value: unknown): AttachResponse | null {
        const record = readRecord(value);
        if (
            record?.status === "attached"
            || record?.status === "not_local"
            || record?.status === "rejected"
        ) {
            return { status: record.status };
        }
        return null;
    }

    function parseDisconnectResponse(value: unknown): DisconnectResponse | null {
        const record = readRecord(value);
        if (
            record?.status === "delivered"
            || record?.status === "not_owner"
            || record?.status === "rejected"
        ) {
            return { status: record.status };
        }
        return null;
    }

    function parseFrameMessage(value: unknown): FrameMessage | null {
        const record = readRecord(value);
        if (!record) return null;
        const attachmentId = readBoundedString(record.attachmentId);
        const messageOwnerRouteId = readBoundedString(record.ownerRouteId);
        const machineSocketId = readBoundedString(record.machineSocketId);
        const envelope = PeerTcpTunnelRelayEnvelopeSchema.safeParse(record.envelope);
        if (!attachmentId || !messageOwnerRouteId || !machineSocketId || !envelope.success) return null;
        return {
            attachmentId,
            ownerRouteId: messageOwnerRouteId,
            machineSocketId,
            envelope: envelope.data,
        };
    }

    function cleanupMemoryGrants(nowMs: number): void {
        for (const [grantId, expiresAt] of consumedGrantExpById) {
            if (expiresAt <= nowMs) consumedGrantExpById.delete(grantId);
        }
    }

    async function waitForRelayAdmissionRedisReady(): Promise<boolean> {
        if (!relayAdmissionRedis || closed || relayAdmissionRedis.status === "end") return false;
        if (relayAdmissionRedis.status === "ready") return true;

        return await new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (ready: boolean): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                relayAdmissionRedis.off("ready", onReady);
                relayAdmissionRedis.off("end", onEnd);
                resolve(ready);
            };
            const onReady = (): void => finish(true);
            const onEnd = (): void => finish(false);
            const timeout = setTimeout(
                () => finish(false),
                REDIS_GRANT_ADMISSION_TIMEOUT_MS,
            );
            timeout.unref();
            relayAdmissionRedis.once("ready", onReady);
            relayAdmissionRedis.once("end", onEnd);

            // Close the event-subscription race without queueing or retrying the
            // grant command itself.
            if (relayAdmissionRedis.status === "ready") finish(true);
            else if (closed || relayAdmissionRedis.status === "end") finish(false);
        });
    }

    async function consumeGrant(params: Readonly<{
        grantId: string;
        expiresAt: number;
        nowMs: number;
    }>): Promise<"consumed" | "duplicate" | "unavailable"> {
        if (closed || params.expiresAt <= params.nowMs) return "unavailable";
        if (input.config.mode === "memory") {
            cleanupMemoryGrants(params.nowMs);
            if (consumedGrantExpById.has(params.grantId)) return "duplicate";
            consumedGrantExpById.set(params.grantId, params.expiresAt);
            return "consumed";
        }
        try {
            if (!await waitForRelayAdmissionRedisReady()) return "unavailable";
            if (closed) return "unavailable";
            const readyAtMs = Date.now();
            if (params.expiresAt <= readyAtMs) return "unavailable";
            const ttlMs = Math.max(1, Math.floor(params.expiresAt - readyAtMs));
            const result = await relayAdmissionRedis!.set(
                consumedGrantKey(params.grantId),
                ownerRouteId,
                "PX",
                ttlMs,
                "NX",
            );
            return result === "OK" ? "consumed" : "duplicate";
        } catch {
            return "unavailable";
        }
    }

    function removeMachineAttachment(attachmentId: string): void {
        const current = machineAttachmentsById.get(attachmentId);
        if (!current) return;
        machineAttachmentsById.delete(attachmentId);
        machineAttachmentIdByTunnelAndSocket.delete(machineAttachmentLookupKey(
            current.request.tunnelKey,
            current.request.machineSocketId,
        ));
        clearTimeout(current.durationTimer);
        const membership = machineSocketAttachmentMemberships.get(current.socket);
        if (!membership) return;
        membership.attachmentIds.delete(attachmentId);
        if (membership.attachmentIds.size > 0) return;
        machineSocketAttachmentMemberships.delete(current.socket);
        current.socket.off("disconnect", membership.onDisconnect);
    }

    /**
     * The one owner-attachment teardown. Both an admission that loses the grant race and
     * an ordinary `release` unwind through here so a provisional attachment can never be
     * left half-registered on this replica or on the replica that owns the machine socket.
     */
    function detachOwnerAttachment(tunnelKey: string, attachmentId: string): void {
        const owner = ownerAttachmentById.get(attachmentId);
        if (ownerAttachmentsByTunnelKey.get(tunnelKey)?.attachmentId === attachmentId) {
            ownerAttachmentsByTunnelKey.delete(tunnelKey);
        }
        ownerAttachmentById.delete(attachmentId);
        if (owner?.local === true) {
            removeMachineAttachment(attachmentId);
            return;
        }
        input.io.serverSideEmit(DETACH_EVENT, {
            attachmentId,
            ownerRouteId: owner?.ownerRouteId ?? ownerRouteId,
        } satisfies DetachRequest);
    }

    function publishDisconnect(request: AttachRequest): void {
        if (request.ownerRouteId === ownerRouteId) {
            const owner = ownerAttachmentsByTunnelKey.get(request.tunnelKey);
            if (owner?.attachmentId === request.attachmentId) {
                void owner.onMachineDisconnect();
            }
            return;
        }
        input.io.serverSideEmit(DISCONNECT_EVENT, {
            attachmentId: request.attachmentId,
            ownerRouteId: request.ownerRouteId,
        } satisfies DisconnectMessage);
    }

    function installLocalAttachment(request: AttachRequest): AttachResponse {
        if (closed) return { status: "rejected" };
        const socket = input.io.sockets.sockets.get(request.machineSocketId);
        if (!socket) return { status: "not_local" };
        if (!isExactMachineSocket(socket, request)) return { status: "rejected" };

        const lookupKey = machineAttachmentLookupKey(request.tunnelKey, request.machineSocketId);
        const existingId = machineAttachmentIdByTunnelAndSocket.get(lookupKey);
        if (existingId) {
            const existing = machineAttachmentsById.get(existingId);
            return existing?.request.attachmentId === request.attachmentId
                ? { status: "attached" }
                : { status: "rejected" };
        }

        const durationTimer = setTimeout(() => {
            removeMachineAttachment(request.attachmentId);
        }, Math.max(1, request.maxDurationMs));
        durationTimer.unref?.();
        machineAttachmentsById.set(request.attachmentId, {
            request,
            socket,
            durationTimer,
        });
        machineAttachmentIdByTunnelAndSocket.set(lookupKey, request.attachmentId);
        let membership = machineSocketAttachmentMemberships.get(socket);
        if (!membership) {
            const attachmentIds = new Set<string>();
            const onDisconnect = (): void => {
                const attachments = [...attachmentIds]
                    .map((attachmentId) => machineAttachmentsById.get(attachmentId))
                    .filter((attachment): attachment is MachineAttachment => attachment !== undefined);
                for (const attachment of attachments) {
                    removeMachineAttachment(attachment.request.attachmentId);
                    publishDisconnect(attachment.request);
                }
            };
            membership = { attachmentIds, onDisconnect };
            machineSocketAttachmentMemberships.set(socket, membership);
            socket.once("disconnect", onDisconnect);
        }
        membership.attachmentIds.add(request.attachmentId);
        return { status: "attached" };
    }

    function handleAttach(value: unknown, acknowledge: (response: AttachResponse) => void): void {
        const request = parseAttachRequest(value);
        acknowledge(request ? installLocalAttachment(request) : { status: "rejected" });
    }

    function handleDetach(
        value: unknown,
        acknowledge?: (response: Readonly<{ status: "detached" | "not_local" | "rejected" }>) => void,
    ): void {
        const request = parseDetachRequest(value);
        if (!request) {
            acknowledge?.({ status: "rejected" });
            return;
        }
        const current = machineAttachmentsById.get(request.attachmentId);
        if (!current || current.request.ownerRouteId !== request.ownerRouteId) {
            acknowledge?.({ status: "not_local" });
            return;
        }
        removeMachineAttachment(request.attachmentId);
        acknowledge?.({ status: "detached" });
    }

    function handleFrame(value: unknown): void {
        const message = parseFrameMessage(value);
        if (!message) return;
        if (message.ownerRouteId !== ownerRouteId) return;
        const owner = ownerAttachmentById.get(message.attachmentId);
        if (!owner || owner.machineSocketId !== message.machineSocketId) return;
        void owner.onMachineEnvelope(message.envelope, message.machineSocketId);
    }

    async function handleDisconnect(
        value: unknown,
        acknowledge?: (response: DisconnectResponse) => void,
    ): Promise<void> {
        const message = parseDetachRequest(value);
        if (!message) {
            acknowledge?.({ status: "rejected" });
            return;
        }
        if (message.ownerRouteId !== ownerRouteId) {
            acknowledge?.({ status: "not_owner" });
            return;
        }
        const owner = ownerAttachmentById.get(message.attachmentId);
        if (!owner) {
            acknowledge?.({ status: "not_owner" });
            return;
        }
        try {
            await owner.onMachineDisconnect();
            acknowledge?.({ status: "delivered" });
        } catch {
            acknowledge?.({ status: "rejected" });
        }
    }

    input.io.on(ATTACH_EVENT, handleAttach);
    input.io.on(DETACH_EVENT, handleDetach);
    input.io.on(FRAME_EVENT, handleFrame);
    input.io.on(DISCONNECT_EVENT, handleDisconnect);

    async function attachExactMachine(request: AttachRequest): Promise<Readonly<{
        status: "attached";
        local: boolean;
    }> | Readonly<{ status: "rejected" | "unavailable" }>> {
        const local = installLocalAttachment(request);
        if (local.status === "attached") return { status: "attached", local: true };
        if (local.status === "rejected") return { status: "rejected" };
        if (input.config.mode !== "redis") return { status: "rejected" };
        try {
            const rawResponses = await input.io.serverSideEmitWithAck(ATTACH_EVENT, request) as unknown[];
            const responses = rawResponses.map(parseAttachResponse);
            if (responses.some((response) => response === null)) {
                input.io.serverSideEmit(DETACH_EVENT, {
                    attachmentId: request.attachmentId,
                    ownerRouteId: request.ownerRouteId,
                } satisfies DetachRequest);
                return { status: "rejected" };
            }
            const parsedResponses = responses.filter((response): response is AttachResponse => response !== null);
            const attached = parsedResponses.filter((response) => response.status === "attached");
            const rejected = parsedResponses.some((response) => response.status === "rejected");
            if (attached.length !== 1 || rejected) {
                input.io.serverSideEmit(DETACH_EVENT, {
                    attachmentId: request.attachmentId,
                    ownerRouteId: request.ownerRouteId,
                } satisfies DetachRequest);
                return { status: "rejected" };
            }
            return { status: "attached", local: false };
        } catch {
            input.io.serverSideEmit(DETACH_EVENT, {
                attachmentId: request.attachmentId,
                ownerRouteId: request.ownerRouteId,
            } satisfies DetachRequest);
            return { status: "unavailable" };
        }
    }

    /**
     * Admission resolves the exact machine and attaches PROVISIONALLY, then spends the
     * single-use grant immediately before the attachment becomes admitted.
     *
     * Spending first would burn the authorization on a machine that turned out to be
     * unreachable: the owner cannot retry with the same grant and every later attempt is
     * refused as `grant_already_consumed`. The grant is still spent exactly once — an
     * ambiguously successful Redis consumption is never rolled back; the loser instead
     * detaches its own provisional attachment synchronously.
     */
    async function performAdmission(params: Parameters<PeerTcpTunnelRelayCoordinator["admit"]>[0]) {
        if (closed) {
            return { status: "rejected", reason: "cluster_unavailable" } as const;
        }

        let exactMachineSocketId: string;
        try {
            const room = input.io.in(machineRoom(params.accountId, params.machineId));
            const localSockets = await room.local.fetchSockets();
            const localExactSockets = localSockets.filter((socket) =>
                socket.data.userId === params.accountId
                && socket.data.clientType === "machine-scoped"
                && socket.data.machineId === params.machineId,
            );
            if (localExactSockets.length > 1) {
                return { status: "rejected", reason: "machine_unavailable" } as const;
            }
            if (localExactSockets.length === 1) {
                exactMachineSocketId = localExactSockets[0]!.id;
            } else {
                const sockets = await room
                    .timeout(FETCH_SOCKETS_TIMEOUT_MS)
                    .fetchSockets();
                const exactSockets = sockets.filter((socket) =>
                    socket.data.userId === params.accountId
                    && socket.data.clientType === "machine-scoped"
                    && socket.data.machineId === params.machineId,
                );
                if (exactSockets.length !== 1) {
                    return { status: "rejected", reason: "machine_unavailable" } as const;
                }
                exactMachineSocketId = exactSockets[0]!.id;
            }
        } catch {
            return { status: "rejected", reason: "cluster_unavailable" } as const;
        }

        const attachmentId = randomUUID();
        const ownerAttachment: OwnerAttachment = {
            attachmentId,
            ownerRouteId,
            machineSocketId: exactMachineSocketId,
            local: false,
            onMachineEnvelope: params.onMachineEnvelope,
            onMachineDisconnect: params.onMachineDisconnect,
        };
        ownerAttachmentsByTunnelKey.set(params.tunnelKey, ownerAttachment);
        ownerAttachmentById.set(attachmentId, ownerAttachment);
        const attached = await attachExactMachine({
            attachmentId,
            ownerRouteId,
            accountId: params.accountId,
            tunnelKey: params.tunnelKey,
            machineId: params.machineId,
            machineSocketId: exactMachineSocketId,
            maxDurationMs: params.maxDurationMs,
        });
        if (attached.status !== "attached") {
            ownerAttachmentsByTunnelKey.delete(params.tunnelKey);
            ownerAttachmentById.delete(attachmentId);
            return {
                status: "rejected",
                reason: attached.status === "unavailable" ? "cluster_unavailable" : "machine_unavailable",
            } as const;
        }
        // Record the real locality before the grant step so every unwind path below —
        // and `close()` — tears the provisional attachment down through one owner.
        const attachedOwner = {
            ...ownerAttachment,
            local: attached.local,
        };
        ownerAttachmentsByTunnelKey.set(params.tunnelKey, attachedOwner);
        ownerAttachmentById.set(attachmentId, attachedOwner);

        const consumed = await consumeGrant({
            grantId: params.grantId,
            expiresAt: params.grantExpiresAt,
            nowMs: params.nowMs,
        });
        if (consumed !== "consumed") {
            detachOwnerAttachment(params.tunnelKey, attachmentId);
            return {
                status: "rejected",
                reason: consumed === "duplicate" ? "grant_already_consumed" : "cluster_unavailable",
            } as const;
        }
        if (closed) {
            // Shutdown raced an already-spent grant. `close()` joins pending admissions
            // before it drains the maps, so this attachment is torn down there.
            return {
                status: "rejected",
                reason: "cluster_unavailable",
            } as const;
        }
        return { status: "attached" } as const;
    }

    function admit(
        params: Parameters<PeerTcpTunnelRelayCoordinator["admit"]>[0],
    ): Promise<PeerTcpTunnelRelayAdmissionResult> {
        const admission = performAdmission(params);
        pendingAdmissions.add(admission);
        void admission.finally(() => {
            pendingAdmissions.delete(admission);
        });
        return admission;
    }

    function routeMachineEnvelope(
        params: Parameters<PeerTcpTunnelRelayCoordinator["routeMachineEnvelope"]>[0],
    ): PeerTcpTunnelRelayMachineRouteResult {
        const attachmentId = machineAttachmentIdByTunnelAndSocket.get(machineAttachmentLookupKey(
            params.tunnelKey,
            params.machineSocketId,
        ));
        if (!attachmentId) return "rejected";
        const machineAttachment = machineAttachmentsById.get(attachmentId);
        if (!machineAttachment) return "rejected";
        const owner = ownerAttachmentsByTunnelKey.get(params.tunnelKey);
        if (
            machineAttachment.request.ownerRouteId === ownerRouteId
            && owner?.attachmentId === attachmentId
        ) {
            return "local_exact";
        }
        input.io.serverSideEmit(FRAME_EVENT, {
            attachmentId,
            ownerRouteId: machineAttachment.request.ownerRouteId,
            machineSocketId: params.machineSocketId,
            envelope: params.envelope,
        } satisfies FrameMessage);
        return "remote_forwarded";
    }

    function routeOwnerEnvelope(
        params: Parameters<NonNullable<PeerTcpTunnelRelayCoordinator["routeOwnerEnvelope"]>>[0],
    ): boolean {
        const owner = ownerAttachmentsByTunnelKey.get(params.tunnelKey);
        if (!owner) return false;
        input.io.to(owner.machineSocketId).emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, params.envelope);
        return true;
    }

    function release(tunnelKey: string): void {
        const owner = ownerAttachmentsByTunnelKey.get(tunnelKey);
        if (!owner) return;
        detachOwnerAttachment(tunnelKey, owner.attachmentId);
    }

    function close(): Promise<void> {
        if (closePromise) return closePromise;
        closed = true;
        closePromise = (async () => {
            await Promise.allSettled([...pendingAdmissions]);
            const remoteOwnerDisconnectRequests: DisconnectMessage[] = [];
            for (const [attachmentId, attachment] of machineAttachmentsById) {
                removeMachineAttachment(attachmentId);
                if (attachment.request.ownerRouteId !== ownerRouteId) {
                    remoteOwnerDisconnectRequests.push({
                        attachmentId,
                        ownerRouteId: attachment.request.ownerRouteId,
                    });
                }
            }
            await Promise.all(remoteOwnerDisconnectRequests.map(async (request) => {
                try {
                    const rawResponses = await input.io.serverSideEmitWithAck(
                        DISCONNECT_EVENT,
                        request,
                    ) as unknown[];
                    const responses = rawResponses.map(parseDisconnectResponse);
                    if (
                        responses.some((response) => response === null)
                        || responses.filter((response) => response?.status === "delivered").length !== 1
                    ) {
                        return;
                    }
                } catch {
                    // The adapter's bounded acknowledgement timeout is the shutdown boundary.
                }
            }));
            const remoteDetachRequests: DetachRequest[] = [];
            for (const owner of ownerAttachmentsByTunnelKey.values()) {
                if (owner.local) {
                    removeMachineAttachment(owner.attachmentId);
                } else {
                    remoteDetachRequests.push({
                        attachmentId: owner.attachmentId,
                        ownerRouteId: owner.ownerRouteId,
                    });
                }
            }
            ownerAttachmentsByTunnelKey.clear();
            ownerAttachmentById.clear();
            await Promise.all(remoteDetachRequests.map(async (request) => {
                try {
                    await input.io.serverSideEmitWithAck(DETACH_EVENT, request);
                } catch {
                    // The adapter's bounded acknowledgement timeout is the shutdown boundary.
                }
            }));
            consumedGrantExpById.clear();
            input.io.off(ATTACH_EVENT, handleAttach);
            input.io.off(DETACH_EVENT, handleDetach);
            input.io.off(FRAME_EVENT, handleFrame);
            input.io.off(DISCONNECT_EVENT, handleDisconnect);
            relayAdmissionRedis?.off("error", ignoreHandledRedisAdmissionError);
            relayAdmissionRedis?.disconnect(false);
        })();
        return closePromise;
    }

    return {
        admit,
        routeMachineEnvelope,
        routeOwnerEnvelope,
        release,
        close,
    };
}
