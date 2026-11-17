import { decodeSessionStoredContent, withSessionContentSelect } from '@/storage/sessionMachineStoredContent';
import { log } from "@/utils/logging/log";
import { recordEventFanoutDrop, recordEventFanoutEmit } from "@/app/monitoring/metrics/index";
import { readAccountStoredContentCompatibilityForSocket } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { getAccountStoredContentV3SocketRoom } from "@/app/api/socketRooms";
import {
    type ClientConnection,
    type RecipientFilter,
    type UpdatePayload,
    type EphemeralPayload,
} from "./eventPayloadTypes";
import {
    ACCOUNT_CHANGE_ROWS_DELIVERY_EVENT,
    CREDENTIAL_QUALIFIED_SESSION_DELIVERY_EVENT,
    parseAccountChangeRowsDelivery,
    parseCredentialQualifiedSessionDelivery,
    type AccountChangeRowsDeliveryV1,
    type CredentialQualifiedSessionDeliveryV1,
    type LocalSocketRoomEmitter,
    type SocketRoomBroadcastOperator,
    type SocketRoomEmitter,
    type SocketRoomEventName,
} from "./socketRoomEmitter";
import { buildSessionAccessProjectionSelect, resolveSessionAccessForOperation, type SessionDeliveryAccess, type SessionDeliveryAccessRow } from "@/app/session/access/sessionAccess";
import type { Socket } from "socket.io";
import type { Prisma } from "@prisma/client";
import { readSessionAccessAuthenticationFromSocket } from "@/app/session/access/sessionAccessAuthentication";
import { inReadSnapshot, inTx, type Tx } from "@/storage/inTx";
import { captureReadSnapshot } from "@/storage/captureReadSnapshot";
import type { SessionBroadcastContainer } from '@happier-dev/protocol/updates';
import type { VerifiedApiTokenPrincipal } from "@/app/auth/auth";
import type { forwardRpcCall, RpcForwardResult } from '@/app/api/socket/rpc/forwardRpcCall';
import { cancelRpcTarget } from '@/app/api/socket/rpc/cancelRpcTarget';
import { classifyLiveSessionDelivery, projectSessionDeliveryForSocket, socketConsumesSessionDelivery } from './sessionDeliveryProjection';
import { admitLiveSessionDelivery, withdrawSessionConsumption } from '@/app/api/socket/sessionConsumption';
import { MACHINE_ACCESS_LOSS_EVENT, type MachineAccessLoss } from './machineAccessLoss';
import { ACCOUNT_SIGN_IN_REVOKED_EVENT, SIGN_IN_POLICY_CHANGED_EVENT } from './signInPolicyChange';
import { PRESENCE_DEADLINE_EVENT, type PresenceDeadlineNotification } from '@/app/presence/presenceDeadlineNotification';
import { getDbProviderFromEnv } from '@/storage/db';
import {
    isAccountChangeRowVisibleToCompatibility, projectAccountChangesPage, readAccountChangeRowsPendingRunIds,
    readAccountChangeRowsSessionAccess, withAccountChangesReads, type AccountChangeRowFacts,
} from '@/app/changes/readAccountChangesPage';
import { ACCOUNT_CHANGES_PAGE_LIMIT_V1, type PushedAccountChangesPageV1 } from '@happier-dev/protocol/changes';

import {
    getAccountChangeRowsSocketRoom,
    getAccountRevocationSocketRoom,
    getApiTokenRevocationSocketRoom,
    getAccountSessionSocketRoom,
    getMachineBoundSessionSocketRoom,
    getMachineSocketRoom,
    getUserMachinesSocketRoom,
} from "@/app/api/socketRooms";

export type ServerOwnedRpcForwardRequest = Omit<Parameters<typeof forwardRpcCall>[0], 'io'>;
type ServerOwnedRpcForwarder = (request: ServerOwnedRpcForwardRequest) => Promise<RpcForwardResult>;

const MAX_EVENT_FANOUT_METRIC_LABEL_LENGTH = 80;
const SAFE_EVENT_FANOUT_METRIC_LABEL_PATTERN = /^[a-zA-Z0-9_.:-]+$/;
const EVENT_FANOUT_PAYLOAD_BYTES_SAMPLE_RATE = 0.01;

type SessionDeliverySocket = Pick<Socket, "id" | "data">;

function normalizeEventFanoutMetricLabel(value: unknown): string {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_EVENT_FANOUT_METRIC_LABEL_LENGTH) {
        return "other";
    }
    if (!SAFE_EVENT_FANOUT_METRIC_LABEL_PATTERN.test(value)) {
        return "other";
    }
    return value;
}

function resolveEventFanoutPayloadType(payload: any): string {
    return normalizeEventFanoutMetricLabel(payload?.body?.t ?? payload?.type);
}

function estimateEventFanoutPayloadBytes(payload: any): number {
    try {
        return Buffer.byteLength(JSON.stringify(payload));
    } catch {
        return 0;
    }
}

function shouldSampleEventFanoutPayloadBytes(): boolean {
    return Math.random() < EVENT_FANOUT_PAYLOAD_BYTES_SAMPLE_RATE;
}

/** A row-demand socket on this node and how to reach it. */
type AccountChangeRowsRecipient = Readonly<{ socket: Pick<Socket, 'data'>; clientType: unknown; emit: (payload: UpdatePayload) => void }>;

/** Row-demand sockets that see the same page: equal demand, compatibility and credential facts. */
type AccountChangeRowsGroup = {
    recipients: AccountChangeRowsRecipient[];
    socket: Pick<Socket, 'data'>;
    compatibility: ReturnType<typeof readAccountStoredContentCompatibilityForSocket>;
    visibleRows: AccountChangeRowFacts[];
};

class EventRouter {
    private accountChangeRowsTails = new Map<string, Promise<void>>();
    private userConnections = new Map<string, Set<ClientConnection>>();
    private io: SocketRoomEmitter | null = null;
    private serverOwnedRpcForwarder: ServerOwnedRpcForwarder | null = null;
    private broadcastServerSideEvent: NonNullable<SocketRoomEmitter['serverSideEmit']> | null = null;
    private machineAccessLossListeners = new Set<(input: Readonly<{ accountId: string; machineId: string }>) => void>();
    private warnedNoIo = false;

    // === CONNECTION MANAGEMENT ===

    addConnection(userId: string, connection: ClientConnection): void {
        if (!this.userConnections.has(userId)) {
            this.userConnections.set(userId, new Set());
        }
        this.userConnections.get(userId)!.add(connection);
    }

    removeConnection(userId: string, connection: ClientConnection): void {
        const connections = this.userConnections.get(userId);
        if (connections) {
            connections.delete(connection);
            if (connections.size === 0) {
                this.userConnections.delete(userId);
            }
        }
    }

    getConnections(userId: string): Set<ClientConnection> | undefined {
        return this.userConnections.get(userId);
    }

    async hasFocusedComputerUi(userId: string): Promise<boolean> {
        const isFocused = (data: Record<string, unknown>) => {
            const focus = data.uiFocus;
            return data.clientType === 'user-scoped'
                && data.clientPurpose === 'sync'
                && typeof focus === 'object'
                && focus !== null
                && 'computer' in focus && focus.computer === true
                && 'focused' in focus && focus.focused === true;
        };
        if (this.io?.in) {
            try {
                const sockets = await this.io.in(`user-scoped:${userId}`).fetchSockets();
                return sockets.some((socket) => isFocused(socket.data));
            } catch (error) {
                // Unknown focus must preserve phone delivery rather than silently mute it.
                log({ module: 'ui-focus', error }, 'Unable to query focused computer UI; preserving push delivery');
                return false;
            }
        }
        return [...(this.userConnections.get(userId) ?? [])].some((connection) => (
            connection.connectionType === 'user-scoped'
            && connection.socket.connected === true
            && isFocused(connection.socket.data)
        ));
    }

    // === SOCKET.IO ADAPTER (ROOM-BASED FANOUT) ===

    setIo(io: SocketRoomEmitter, options: Readonly<{
        forwardRpc?: ServerOwnedRpcForwarder;
        broadcastServerSideEvent?: NonNullable<SocketRoomEmitter['serverSideEmit']>;
    }> = {}): void {
        this.io = io;
        this.serverOwnedRpcForwarder = options.forwardRpc ?? null;
        this.broadcastServerSideEvent = options.broadcastServerSideEvent ?? io.serverSideEmit?.bind(io) ?? null;
    }

    clearIo(): void {
        this.io = null;
        this.serverOwnedRpcForwarder = null;
        this.broadcastServerSideEvent = null;
    }

    /** Recovery enrolls peer deadlines without replaying content or heartbeat fanout. */
    broadcastPresenceDeadline(observation: PresenceDeadlineNotification): void {
        this.broadcastServerSideEvent?.(PRESENCE_DEADLINE_EVENT, observation);
    }

    /** The live Socket.IO adapter only; domain owners supply their currentness guard. */
    async forwardServerOwnedRpc(request: ServerOwnedRpcForwardRequest): Promise<RpcForwardResult | null> {
        return this.serverOwnedRpcForwarder ? this.serverOwnedRpcForwarder(request) : null;
    }

    cancelServerOwnedRpc(input: Readonly<{ targetSocketId: string; targetRequestId: string }>): void {
        if (this.io && this.serverOwnedRpcForwarder) cancelRpcTarget({ io: this.io, ...input });
    }

    onMachineAccessLoss(listener: (input: Readonly<{ accountId: string; machineId: string }>) => void): () => void {
        this.machineAccessLossListeners.add(listener);
        return () => { this.machineAccessLossListeners.delete(listener); };
    }

    receiveMachineAccessLoss(input: MachineAccessLoss): void {
        for (const listener of this.machineAccessLossListeners) listener(input);
    }

    private readonly signInPolicyChangeListeners = new Set<() => void>();

    onSignInPolicyChange(listener: () => void): () => void {
        this.signInPolicyChangeListeners.add(listener);
        return () => { this.signInPolicyChangeListeners.delete(listener); };
    }

    receiveSignInPolicyChange(): void {
        for (const listener of [...this.signInPolicyChangeListeners]) listener();
    }

    /** The Home sign-in policy changed: every node re-decides its connected Accounts. */
    announceSignInPolicyChange(): void {
        this.receiveSignInPolicyChange();
        this.broadcastServerSideEvent?.(SIGN_IN_POLICY_CHANGED_EVENT, { v: 1 });
    }

    private readonly accountSignInRevokedListeners = new Set<(accountId: string) => void>();

    onAccountSignInRevoked(listener: (accountId: string) => void): () => void {
        this.accountSignInRevokedListeners.add(listener);
        return () => { this.accountSignInRevokedListeners.delete(listener); };
    }

    receiveAccountSignInRevoked(accountId: string): void {
        for (const listener of [...this.accountSignInRevokedListeners]) listener(accountId);
    }

    /**
     * An offboarding verdict revoked this Account's sign-in: every node drops its cached sign-in
     * result for it (local listeners plus the cluster notice, sent before the disconnect so a
     * reconnect cannot reuse it), then its live sockets are disconnected cluster-wide.
     */
    revokeAccountSignIn(accountId: string): void {
        this.receiveAccountSignInRevoked(accountId);
        this.broadcastServerSideEvent?.(ACCOUNT_SIGN_IN_REVOKED_EVENT, { accountId });
        this.disconnectAccountSockets(accountId);
    }

    disconnectAccountSockets(accountId: string): void {
        if (this.io) {
            this.io.to([
                getAccountRevocationSocketRoom(accountId),
                `user:${accountId}`,
                getUserMachinesSocketRoom(accountId),
            ]).disconnectSockets(true);
            return;
        }
        for (const connection of this.userConnections.get(accountId) ?? []) {
            connection.socket.disconnect(true);
        }
    }

    disconnectApiTokenSockets(tokenIds: readonly string[]): void {
        if (tokenIds.length === 0) return;
        if (this.io) {
            this.io.to(tokenIds.map(getApiTokenRevocationSocketRoom)).disconnectSockets(true);
            return;
        }
        for (const connections of this.userConnections.values()) {
            for (const connection of connections) {
                const principal: VerifiedApiTokenPrincipal | undefined = connection.socket.data.apiTokenPrincipal;
                if (principal && (tokenIds.includes(principal.credentialId)
                    || (principal.parentTokenId !== null && tokenIds.includes(principal.parentTokenId)))) connection.socket.disconnect(true);
            }
        }
    }

    /** Presentation changes wake only this token and its children, after commit. */
    emitApiTokenEmbedConfigChanged(params: Readonly<{ accountId: string; tokenId: string }>): void {
        const payload = { type: 'api-token-embed-config-changed' } as const;
        if (this.io) {
            this.io.to(getApiTokenRevocationSocketRoom(params.tokenId)).emit('ephemeral', payload);
            return;
        }
        for (const connection of this.userConnections.get(params.accountId) ?? []) {
            const principal: VerifiedApiTokenPrincipal | undefined = connection.socket.data.apiTokenPrincipal;
            if (principal && (principal.credentialId === params.tokenId || principal.parentTokenId === params.tokenId)) {
                connection.socket.emit('ephemeral', payload);
            }
        }
    }

    /** Disconnects the Session-scoped sockets bound to these exact Machine/Session tuples, cluster-wide. */
    disconnectSessionBoundSockets(bindings: readonly Readonly<{ accountId: string; machineId: string; sessionId: string }>[]): void {
        if (bindings.length === 0) return;
        if (this.io) {
            this.io.to([...new Set(bindings.map(binding => getMachineBoundSessionSocketRoom(
                binding.accountId, binding.sessionId, binding.machineId)))]).disconnectSockets(true);
            return;
        }
        for (const binding of bindings) {
            for (const connection of this.userConnections.get(binding.accountId) ?? []) {
                if (connection.connectionType === "session-scoped" && connection.sessionId === binding.sessionId
                    && connection.machineId === binding.machineId) connection.socket.disconnect(true);
            }
        }
    }

    /** Disconnects exact-resource sockets through the configured cross-node adapter. */
    disconnectMachineAndSessionSockets(params: Readonly<{
        accountId: string;
        machineId: string;
        sessionBindings: readonly Readonly<{ accountId: string; sessionId: string }>[];
    }>): void {
        const accessLoss = { accountId: params.accountId, machineId: params.machineId };
        this.receiveMachineAccessLoss(accessLoss);
        // RU2-SEC C2: clustered Homes must sweep previews on the node holding the in-flight mint or viewer.
        this.broadcastServerSideEvent?.(MACHINE_ACCESS_LOSS_EVENT, accessLoss);
        if (this.io) {
            this.io.to([...new Set([
                getMachineSocketRoom(params.accountId, params.machineId),
                ...params.sessionBindings.map((binding) => getMachineBoundSessionSocketRoom(
                    binding.accountId,
                    binding.sessionId,
                    params.machineId,
                )),
            ])]).disconnectSockets(true);
            return;
        }
        const sessionsByAccount = new Map<string, Set<string>>();
        for (const binding of params.sessionBindings) {
            const sessions = sessionsByAccount.get(binding.accountId) ?? new Set<string>();
            sessions.add(binding.sessionId);
            sessionsByAccount.set(binding.accountId, sessions);
        }
        for (const accountId of new Set([params.accountId, ...sessionsByAccount.keys()])) {
            for (const connection of this.userConnections.get(accountId) ?? []) {
                if (
                    (accountId === params.accountId && connection.connectionType === "machine-scoped" && connection.machineId === params.machineId)
                    || (
                        connection.connectionType === "session-scoped"
                        && connection.machineId === params.machineId
                        && sessionsByAccount.get(accountId)?.has(connection.sessionId)
                    )
                ) {
                    connection.socket.disconnect(true);
                }
            }
        }
    }

    // === EVENT EMISSION METHODS ===

    emitUpdate(params: {
        userId: string;
        payload: UpdatePayload;
        recipientFilter?: RecipientFilter;
        skipSenderConnection?: ClientConnection;
        /** An Account wake: the first cursor its transaction committed (row-demand sockets get their page). */
        accountChangeFromCursor?: number;
        /** The rows that transaction stored for the Account; row-demand sockets receive them authorized. */
        accountChangeRows?: readonly AccountChangeRowFacts[];
        /** A Session write's committed access facts by recipient: this node's sockets are decided from them. */
        deliveryAccess?: SessionDeliveryAccess;
    }): void | Promise<void> {
        if (params.accountChangeFromCursor !== undefined && params.recipientFilter?.type === 'account-stored-content-v3') {
            return this.emitAccountChangeWake({ userId: params.userId, fromCursor: params.accountChangeFromCursor,
                rows: params.accountChangeRows, payload: params.payload, recipientFilter: params.recipientFilter });
        }
        return this.emit({
            userId: params.userId,
            eventName: 'update',
            payload: params.payload,
            recipientFilter: params.recipientFilter || { type: 'all-user-authenticated-connections' },
            skipSenderConnection: params.skipSenderConnection,
            committedAccess: params.deliveryAccess?.get(params.userId),
        });
    }

    emitEphemeral(params: {
        userId: string;
        payload: EphemeralPayload;
        recipientFilter?: RecipientFilter;
        skipSenderConnection?: ClientConnection;
    }): void | Promise<void> {
        return this.emit({
            userId: params.userId,
            eventName: 'ephemeral',
            payload: params.payload,
            recipientFilter: params.recipientFilter || { type: 'all-user-authenticated-connections' },
            skipSenderConnection: params.skipSenderConnection
        });
    }

    emitSessionBroadcast(params: {
        userId: string;
        sessionId: string;
        payload: SessionBroadcastContainer;
    }): void | Promise<void> {
        return this.emit({
            userId: params.userId,
            eventName: "session",
            payload: params.payload,
            recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
        });
    }

    // === PRIVATE ROUTING LOGIC ===

    private shouldSendToConnection(
        connection: ClientConnection,
        filter: RecipientFilter
    ): boolean {
        switch (filter.type) {
            case 'all-interested-in-session':
                // Send to session-scoped with matching session + all user-scoped
                if (connection.connectionType === 'session-scoped') {
                    if (connection.sessionId !== filter.sessionId) {
                        return false;  // Wrong session
                    }
                } else if (connection.connectionType === 'machine-scoped') {
                    return false;  // Machines don't need session updates
                }
                // user-scoped always gets it
                return true;

            case 'user-scoped-only':
                return connection.connectionType === 'user-scoped';

            case 'machine-scoped-only':
                // Send to user-scoped (mobile/web needs all machine updates) + only the specific machine
                if (connection.connectionType === 'user-scoped') {
                    return true;
                }
                if (connection.connectionType === 'machine-scoped') {
                    return connection.machineId === filter.machineId;
                }
                return false;  // session-scoped doesn't need machine updates

            case 'machine-only':
                return connection.connectionType === 'machine-scoped' && connection.machineId === filter.machineId;

            case 'user-machine-scoped-only':
                return connection.connectionType === 'machine-scoped';

            case 'account-stored-content-v3':
                return readAccountStoredContentCompatibilityForSocket(connection.socket).supportsPluginDataProtocol
                    && (!filter.exceptSessionCurrentView || !this.shouldSendToConnection(connection,
                        { type: 'all-interested-in-session', sessionId: filter.exceptSessionCurrentView }));

            case 'all-user-authenticated-connections':
                // Send to all connection types (default behavior)
                return true;

            default:
                return false;
        }
    }

    private emit(params: {
        userId: string;
        eventName: SocketRoomEventName;
        payload: any;
        recipientFilter: RecipientFilter;
        skipSenderConnection?: ClientConnection;
        /** Row-demand sockets receive their own authorized page from `emitAccountChangeWake`. */
        exceptAccountChangeRowsSockets?: boolean;
        committedAccess?: SessionDeliveryAccessRow;
    }): void | Promise<void> {
        if (params.recipientFilter.type === "all-interested-in-session") {
            return this.emitToCredentialQualifiedSessionConnections({
                ...params,
                sessionId: params.recipientFilter.sessionId,
            });
        }
        const payloadType = resolveEventFanoutPayloadType(params.payload);
        const shouldSamplePayloadBytes = shouldSampleEventFanoutPayloadBytes();
        const payloadBytes = shouldSamplePayloadBytes ? estimateEventFanoutPayloadBytes(params.payload) : undefined;

        if (this.io) {
            const skipSocketId = params.skipSenderConnection?.socket?.id;
            const target = this.getEmitterTargetForFilter(params.userId, params.recipientFilter);
            let emitter = this.getEmitterForFilter(params.userId, params.recipientFilter);
            if (params.recipientFilter.type === 'account-stored-content-v3' && params.recipientFilter.exceptSessionCurrentView) {
                // Use the very same audience as the current-view publication.
                // Machines and other Session sockets retain their Account wake.
                const coveredRooms = this.getEmitterTargetForFilter(params.userId,
                    { type: 'all-interested-in-session', sessionId: params.recipientFilter.exceptSessionCurrentView });
                for (const room of Array.isArray(coveredRooms) ? coveredRooms : [coveredRooms]) {
                    if (emitter.except) emitter = emitter.except(room);
                }
            }
            if (params.exceptAccountChangeRowsSockets && emitter.except) {
                emitter = emitter.except(getAccountChangeRowsSocketRoom(params.userId));
            }
            if (skipSocketId && typeof (emitter as any).except === "function") {
                (emitter as any).except(skipSocketId).emit(params.eventName, params.payload);
            } else {
                emitter.emit(params.eventName, params.payload);
            }
            recordEventFanoutEmit({
                eventName: params.eventName,
                filterType: params.recipientFilter.type,
                dispatchMode: "room",
                targetKind: "room",
                targetCount: Array.isArray(target) ? target.length : 1,
                payloadType,
                ...(payloadBytes !== undefined ? { payloadBytes } : {}),
            });
            return;
        }

        if (process.env.HAPPY_SOCKET_ROOMS_ONLY === "1") {
            recordEventFanoutDrop({
                eventName: params.eventName,
                reason: "io_unavailable",
            });
            throw new Error("EventRouter: Socket.IO server (io) is not initialized (HAPPY_SOCKET_ROOMS_ONLY=1)");
        }
        if (!this.warnedNoIo) {
            this.warnedNoIo = true;
            log({ module: 'websocket', level: 'warn' }, "EventRouter: io not initialized; falling back to in-memory routing (single-process only)");
        }

        const connections = this.userConnections.get(params.userId);
        if (!connections) {
            recordEventFanoutDrop({
                eventName: params.eventName,
                reason: "no_connections",
            });
            log({ module: 'websocket', level: 'warn' }, `No connections found for user ${params.userId}`);
            return;
        }

        let deliveredCount = 0;
        for (const connection of connections) {
            // Skip message echo
            if (params.skipSenderConnection && connection === params.skipSenderConnection) {
                continue;
            }

            // Apply recipient filter
            if (!this.shouldSendToConnection(connection, params.recipientFilter)) {
                continue;
            }
            if (params.exceptAccountChangeRowsSockets && connection.socket.data?.accountChangeRows) {
                continue;
            }

            connection.socket.emit(params.eventName, params.payload);
            deliveredCount += 1;
        }

        if (deliveredCount === 0) {
            recordEventFanoutDrop({
                eventName: params.eventName,
                reason: "no_matching_connections",
            });
        }
        recordEventFanoutEmit({
            eventName: params.eventName,
            filterType: params.recipientFilter.type,
            dispatchMode: "local",
            targetKind: "connection",
            targetCount: deliveredCount,
            payloadType,
            ...(payloadBytes !== undefined ? { payloadBytes } : {}),
        });
    }

    /**
     * The committed Account wake. The server is the authority for what each recipient may see, so a
     * socket that declared change-row demand receives the rows this wake's transaction stored,
     * authorized for that socket's own credential here at fan-out; every other socket keeps the bare
     * wake. The rows come from the write itself: nothing re-reads the feed per wake.
     */
    private emitAccountChangeWake(params: {
        userId: string;
        /** First cursor the wake's transaction committed. */
        fromCursor: number;
        rows: readonly AccountChangeRowFacts[] | undefined;
        payload: UpdatePayload;
        recipientFilter: Extract<RecipientFilter, { type: 'account-stored-content-v3' }>;
    }): void {
        this.emit({ userId: params.userId, eventName: 'update', payload: params.payload,
            recipientFilter: params.recipientFilter, exceptAccountChangeRowsSockets: true });
        const delivery: AccountChangeRowsDeliveryV1 = {
            v: 1, accountId: params.userId, fromCursor: params.fromCursor, toCursor: params.payload.seq,
            ...(params.rows ? { rows: params.rows.map(row => ({ ...row, changedAt: row.changedAt.getTime() })) } : {}),
            payload: params.payload,
            recipientFilter: params.recipientFilter as AccountChangeRowsDeliveryV1['recipientFilter'],
        };
        if (this.io?.sessionDeliveryMode === "forward_only") {
            // A headless publisher holds no sockets: every API node delivers to its own.
            void Promise.resolve(this.broadcastServerSideEvent?.(ACCOUNT_CHANGE_ROWS_DELIVERY_EVENT, delivery)).catch((error: unknown) => {
                log({ module: "websocket", level: "warn", error }, "Account change-row forwarding unavailable");
            });
            return;
        }
        if (this.io?.in) {
            const localIo = this.io.local ?? { in: this.io.in.bind(this.io), to: this.io.to.bind(this.io) };
            try {
                this.broadcastServerSideEvent?.(ACCOUNT_CHANGE_ROWS_DELIVERY_EVENT, delivery);
            } finally {
                void this.receiveAccountChangeRowsDelivery(localIo, delivery);
            }
            return;
        }
        void this.enqueueAccountChangeRowsDelivery(delivery, async () => [...this.userConnections.get(params.userId) ?? []]
            .filter(connection => connection.socket.data?.accountChangeRows)
            .map(connection => ({ socket: connection.socket, clientType: connection.connectionType,
                emit: (payload: UpdatePayload) => { connection.socket.emit('update', payload); } })));
    }

    /** Each receiving node authorizes the wake's rows for its own row-demand sockets. */
    async receiveAccountChangeRowsDelivery(localIo: LocalSocketRoomEmitter, rawDelivery: unknown): Promise<void> {
        const delivery = parseAccountChangeRowsDelivery(rawDelivery);
        if (!delivery) {
            recordEventFanoutDrop({ eventName: "update", reason: "no_matching_connections" });
            return;
        }
        await this.enqueueAccountChangeRowsDelivery(delivery, async () => {
            const sockets = await localIo.in(getAccountChangeRowsSocketRoom(delivery.accountId)).fetchSockets();
            return sockets.filter(socket => socket.data.userId === delivery.accountId && socket.data.accountChangeRows)
                .map(socket => ({ socket, clientType: socket.data.clientType,
                    emit: (payload: UpdatePayload) => { localIo.to(socket.id).emit('update', payload); } }));
        });
    }

    /**
     * Per Account on this node, wakes are delivered in arrival order, recipients resolved in turn,
     * so each socket's pages stay contiguous.
     */
    private enqueueAccountChangeRowsDelivery(delivery: AccountChangeRowsDeliveryV1,
        resolveRecipients: () => Promise<readonly AccountChangeRowsRecipient[]>): Promise<void> {
        const previous = this.accountChangeRowsTails.get(delivery.accountId) ?? Promise.resolve();
        const tail = previous.then(async () => this.deliverAccountChangeRows(delivery, await resolveRecipients())).catch((error: unknown) => {
            recordEventFanoutDrop({ eventName: "update", reason: "no_matching_connections" });
            log({ module: "websocket", level: "warn", error }, "Account change-row delivery failed");
        });
        this.accountChangeRowsTails.set(delivery.accountId, tail);
        void tail.then(() => {
            if (this.accountChangeRowsTails.get(delivery.accountId) === tail) this.accountChangeRowsTails.delete(delivery.accountId);
        });
        return tail;
    }

    /**
     * One wake for this node's row-demand sockets. The Account-wide facts of the rows (queued run ids)
     * are read once per wake, and each distinct credential's Session access once per wake, through
     * the feed's own owner; sockets sharing a credential share its page. A page covers exactly its
     * wake, `(fromCursor - 1, toCursor]`, so it never claims rows it does not carry (a wake the socket
     * was excluded from, a settings-only allocation): a consumer behind it reads that gap. A failed
     * authorization sends the bare wake: the consumer reads the feed, whose own refusal stays the feed's.
     */
    private async deliverAccountChangeRows(
        delivery: AccountChangeRowsDeliveryV1, recipients: readonly AccountChangeRowsRecipient[],
    ): Promise<void> {
        const included: AccountChangeRowsRecipient[] = [];
        // A socket the bare wake skips because that Session's current view reaches it still needs this
        // wake's page, or its cursor gaps and it re-reads the feed; the page says the facts were pushed.
        const coveredByView = new Set<AccountChangeRowsRecipient>();
        const viewedSessionId = delivery.recipientFilter.exceptSessionCurrentView;
        for (const recipient of recipients) {
            const state = recipient.socket.data.accountChangeRows;
            if (!state) continue;
            // The canonical recipient filter decides exclusions; it reads only these connection facts.
            const connection = { connectionType: recipient.clientType, machineId: recipient.socket.data.machineId,
                sessionId: recipient.socket.data.sessionId, socket: recipient.socket } as unknown as ClientConnection;
            if (this.shouldSendToConnection(connection, delivery.recipientFilter as RecipientFilter)) included.push(recipient);
            else if (viewedSessionId && this.shouldSendToConnection(connection,
                { ...delivery.recipientFilter, exceptSessionCurrentView: undefined } as RecipientFilter)) {
                included.push(recipient);
                coveredByView.add(recipient);
            }
        }
        if (included.length === 0) return;
        const payload = delivery.payload as UpdatePayload;
        // A socket covered by the current view needs no bare wake: its consumer would only re-read.
        const sendBare = (targets: readonly AccountChangeRowsRecipient[]) => {
            for (const target of targets) if (!coveredByView.has(target)) target.emit(payload);
        };
        if (!delivery.rows) return sendBare(included);

        // The feed's order and page bound: more rows than a page carries is a full page (read on).
        const sorted = delivery.rows.map(row => ({ ...row, changedAt: new Date(row.changedAt) }))
            .sort((left, right) => left.cursor - right.cursor || (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0)
                || (left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0));
        const full = sorted.length > ACCOUNT_CHANGES_PAGE_LIMIT_V1;
        const rows = full ? sorted.slice(0, ACCOUNT_CHANGES_PAGE_LIMIT_V1) : sorted;
        const nextCursor = full ? rows[rows.length - 1]!.cursor : delivery.toCursor;

        const groups = new Map<string, AccountChangeRowsGroup>();
        for (const recipient of included) {
            const compatibility = readAccountStoredContentCompatibilityForSocket(recipient.socket);
            const { env: _env, ...credential } = readSessionAccessAuthenticationFromSocket(recipient.socket);
            const kinds = recipient.socket.data.accountChangeRows!.kinds;
            // Equal facts decide equal pages; a key miss only costs one more read, never a wrong page.
            const key = JSON.stringify([[...kinds].sort(), compatibility, credential]);
            const group = groups.get(key);
            if (group) group.recipients.push(recipient);
            else groups.set(key, { recipients: [recipient], compatibility, socket: recipient.socket,
                visibleRows: rows.filter(row => (kinds as readonly string[]).includes(row.kind) && isAccountChangeRowVisibleToCompatibility(row, compatibility)) });
        }
        const needsReads = [...groups.values()].some(group => group.visibleRows.some(row => row.kind === 'session'));
        const pages = new Map<AccountChangeRowsGroup, ReturnType<typeof projectAccountChangesPage>>();
        try {
            const project = async (read?: <R>(operation: (tx: Tx) => Promise<R>, singleStatement?: boolean) => Promise<R>) => {
                const pendingRunIdsBySessionId = read
                    ? await read(tx => readAccountChangeRowsPendingRunIds(tx, delivery.accountId,
                        [...groups.values()].flatMap(group => group.visibleRows)), true)
                    : new Map<string, string[]>();
                for (const group of groups.values()) {
                    const sessionAccessResolutions = !group.compatibility.supportsSessionAccessWitnessProtocol ? undefined
                        : read && group.visibleRows.some(row => row.kind === 'session')
                            ? await read(tx => readAccountChangeRowsSessionAccess(tx, delivery.accountId, group.visibleRows,
                                () => readSessionAccessAuthenticationFromSocket(group.socket)))
                            : [];
                    pages.set(group, projectAccountChangesPage({ visibleRows: group.visibleRows, nextCursor, full,
                        pendingRunIdsBySessionId, sessionAccessResolutions }));
                }
            };
            if (needsReads) await withAccountChangesReads(project);
            else await project();
        } catch (error) {
            log({ module: "websocket", level: "warn", error }, "Account change-row authorization failed; sending the bare wake");
            return sendBare(included);
        }
        for (const [group, page] of pages) {
            if (page.status !== 'ok') {
                sendBare(group.recipients);
                continue;
            }
            const pushed: PushedAccountChangesPageV1 = { v: 1, after: delivery.fromCursor - 1, page: page.page };
            for (const recipient of group.recipients) recipient.emit({ ...payload, body: { ...payload.body, rows: pushed,
                ...(coveredByView.has(recipient) ? { rowFactsPushedSessionId: viewedSessionId } : {}) } });
        }
    }

    /**
     * Session content/effects are authorized per admitted socket credential. Account rooms are
     * deliberately not an authorization boundary: one Account may hold two differently-qualified
     * credentials. The Lane 03 owner re-evaluates current provider/link/connection state here.
     */
    private async emitToCredentialQualifiedSessionConnections(params: {
        userId: string;
        sessionId: string;
        eventName: SocketRoomEventName;
        payload: unknown;
        skipSenderConnection?: ClientConnection;
        /** The write's committed access row for this Account; only this node's own sockets use it. */
        committedAccess?: SessionDeliveryAccessRow;
    }): Promise<void> {
        const payloadType = resolveEventFanoutPayloadType(params.payload);
        const payloadBytes = shouldSampleEventFanoutPayloadBytes()
            ? estimateEventFanoutPayloadBytes(params.payload)
            : undefined;
        const skipSocketId = params.skipSenderConnection?.socket.id;
        try {
            if (this.io?.sessionDeliveryMode === "forward_only") {
                // Receiving nodes qualify against their own current snapshot. A headless
                // publisher still requires a live Session before forwarding routing intent.
                const exists = await inTx(tx => tx.session.findUnique({
                    where: { id: params.sessionId }, select: { id: true },
                }), { readOnly: true, singleStatementRead: true });
                if (!exists) return;
                if (!this.broadcastServerSideEvent) {
                    throw new Error("Protected Session forwarding is unavailable");
                }
                await this.broadcastServerSideEvent(CREDENTIAL_QUALIFIED_SESSION_DELIVERY_EVENT, {
                    v: 1,
                    accountId: params.userId,
                    sessionId: params.sessionId,
                    eventName: params.eventName,
                    payload: params.payload,
                    ...(skipSocketId ? { skipSocketId } : {}),
                });
                return;
            }
            if (this.io?.in) {
                const delivery: CredentialQualifiedSessionDeliveryV1 = {
                    v: 1,
                    accountId: params.userId,
                    sessionId: params.sessionId,
                    eventName: params.eventName,
                    payload: params.payload,
                    ...(skipSocketId ? { skipSocketId } : {}),
                };
                // Peer publication has no acknowledgement/census. Each API node
                // qualifies only its own sockets, including this publishing node.
                const localIo = this.io.local ?? {
                    in: this.io.in.bind(this.io),
                    to: this.io.to.bind(this.io),
                };
                try {
                    this.broadcastServerSideEvent?.(CREDENTIAL_QUALIFIED_SESSION_DELIVERY_EVENT, delivery);
                } finally {
                    await this.receiveCredentialQualifiedSessionDelivery(localIo, delivery, params.committedAccess);
                }
                return;
            }

            const deliveredCount = await this.emitToQualifiedSessionSockets({
                accountId: params.userId,
                sessionId: params.sessionId,
                committedAccess: params.committedAccess,
                live: classifyLiveSessionDelivery(params.eventName, params.payload),
                sockets: [...this.userConnections.get(params.userId) ?? []]
                    .filter(connection => connection !== params.skipSenderConnection && this.shouldSendToConnection(connection, {
                        type: "all-interested-in-session", sessionId: params.sessionId,
                    }) && socketConsumesSessionDelivery(connection.socket.data, params.eventName, params.payload))
                    .map(connection => connection.socket),
                emit: (socket, isSessionOwner, metadataLayoutVersion) => {
                    const payload = projectSessionDeliveryForSocket(socket.data, params.sessionId, params.eventName, params.payload, isSessionOwner, metadataLayoutVersion);
                    if (payload === null) return false;
                    socket.emit(params.eventName, payload);
                    return true;
                },
            });
            recordEventFanoutEmit({
                eventName: params.eventName,
                filterType: "all-interested-in-session",
                dispatchMode: "local",
                targetKind: "connection",
                targetCount: deliveredCount,
                payloadType,
                ...(payloadBytes !== undefined ? { payloadBytes } : {}),
            });
        } catch (error) {
            recordEventFanoutDrop({ eventName: params.eventName, reason: "no_matching_connections" });
            log({ module: "websocket", level: "warn", sessionId: params.sessionId, error }, "Credential-qualified Session event delivery unavailable");
        }
    }

    /**
     * Re-enters the canonical per-socket access decision on one receiving API node.
     * The forwarded envelope carries routing intent only; socket authentication data
     * and current Session authority are read locally and cannot be supplied by a worker.
     */
    async receiveCredentialQualifiedSessionDelivery(
        localIo: LocalSocketRoomEmitter,
        rawDelivery: unknown,
        /** Publishing node only: its own write's committed access row (never part of the envelope). */
        committedAccess?: SessionDeliveryAccessRow,
    ): Promise<void> {
        const delivery = parseCredentialQualifiedSessionDelivery(rawDelivery);
        if (!delivery) {
            recordEventFanoutDrop({ eventName: "update", reason: "no_matching_connections" });
            return;
        }
        try {
            await this.emitToQualifiedSocketsOnReceivingNode(localIo, delivery, committedAccess);
        } catch (error) {
            recordEventFanoutDrop({ eventName: delivery.eventName, reason: "no_matching_connections" });
            log(
                { module: "websocket", level: "warn", sessionId: delivery.sessionId, error },
                "Receiving-node credential-qualified Session delivery unavailable",
            );
        }
    }

    private async emitToQualifiedSocketsOnReceivingNode(
        localIo: LocalSocketRoomEmitter,
        delivery: CredentialQualifiedSessionDeliveryV1,
        committedAccess?: SessionDeliveryAccessRow,
    ): Promise<void> {
        const sockets = await localIo.in([
            `session:${delivery.sessionId}:${delivery.accountId}`,
            `user-scoped:${delivery.accountId}`,
        ]).fetchSockets();
        const live = classifyLiveSessionDelivery(delivery.eventName, delivery.payload);
        // Socket.IO encodes once per emit, so sockets sharing a projected payload share one emit.
        // Live events keep their per-socket emit, in admission order.
        const socketIdsByPayload = new Map<unknown, string[]>();
        const deliveredCount = await this.emitToQualifiedSessionSockets({
            accountId: delivery.accountId,
            sessionId: delivery.sessionId,
            committedAccess,
            live,
            sockets: sockets.filter(socket => socket.id !== delivery.skipSocketId
                && socket.data.userId === delivery.accountId
                && socket.data.clientType !== "machine-scoped"
                && (socket.data.clientType !== "session-scoped"
                    || socket.data.sessionId === delivery.sessionId
                    || socket.data.sessionScopedBinding?.sessionId === delivery.sessionId)
                && socketConsumesSessionDelivery(socket.data, delivery.eventName, delivery.payload)),
            emit: (socket, isSessionOwner, metadataLayoutVersion) => {
                try {
                    const payload = projectSessionDeliveryForSocket(socket.data, delivery.sessionId, delivery.eventName, delivery.payload, isSessionOwner, metadataLayoutVersion);
                    if (payload === null) return false;
                    if (live) {
                        localIo.to(socket.id).emit(delivery.eventName, payload);
                        return true;
                    }
                    const socketIds = socketIdsByPayload.get(payload);
                    if (socketIds) socketIds.push(socket.id);
                    else socketIdsByPayload.set(payload, [socket.id]);
                    return true;
                } catch {
                    return false;
                }
            },
        });
        for (const [payload, socketIds] of socketIdsByPayload) {
            localIo.to(socketIds).emit(delivery.eventName, payload);
        }
        recordEventFanoutEmit({
            eventName: delivery.eventName,
            filterType: "all-interested-in-session",
            dispatchMode: "room",
            targetKind: "connection",
            targetCount: deliveredCount,
            payloadType: resolveEventFanoutPayloadType(delivery.payload),
        });
    }

    /**
     * One delivery snapshot shares structural facts, never a credential's access decision.
     * A publisher's live event is admitted by the consumption owner, which holds each
     * socket's answer until the Session access-change push retires it, so only durable
     * deliveries are decided here, and a refusal here withdraws that socket's live delivery
     * too. The publisher's held audience names the Accounts. A write that hands over its committed
     * access row (`SessionDeliveryAccess`) is decided from that row, with no Session read here.
     */
    private async emitToQualifiedSessionSockets<S extends SessionDeliverySocket>(params: Readonly<{
        accountId: string;
        sessionId: string;
        committedAccess?: SessionDeliveryAccessRow;
        live: ReturnType<typeof classifyLiveSessionDelivery>;
        sockets: readonly S[];
        emit: (socket: S, isSessionOwner: boolean, metadataLayoutVersion: number) => boolean;
    }>): Promise<number> {
        if (params.live) {
            let deliveredCount = 0;
            for (const socket of params.sockets) {
                if (await admitLiveSessionDelivery(socket, params.accountId, params.sessionId, params.live) && params.emit(socket, false, 0)) {
                    deliveredCount += 1;
                }
            }
            return deliveredCount;
        }
        if (params.sockets.length === 0) return 0;
        const select = { ...buildSessionAccessProjectionSelect(params.accountId), metadataLayoutVersion: true } as const;
        const decide = async (reader: Tx, row: Prisma.SessionGetPayload<{ select: typeof select }> | null) => {
            const qualified: { socket: S; isSessionOwner: boolean; metadataLayoutVersion: number }[] = [];
            const refused: S[] = [];
            if (!row) return { qualified, refused };
            for (const socket of params.sockets) {
                let decision: Awaited<ReturnType<typeof resolveSessionAccessForOperation>>;
                try {
                    decision = await resolveSessionAccessForOperation(reader, {
                        accountId: params.accountId,
                        sessionId: params.sessionId,
                        authentication: readSessionAccessAuthenticationFromSocket(socket),
                        row,
                    });
                } catch {
                    // One malformed or stale credential cannot suppress another socket's delivery.
                    continue;
                }
                if (decision.status !== "allowed" || !decision.access.capabilities.readTranscript) {
                    refused.push(socket);
                    continue;
                }
                qualified.push({ socket, isSessionOwner: decision.access.level === "owner", metadataLayoutVersion: row.metadataLayoutVersion });
            }
            return { qualified, refused };
        };
        // Most deliveries are decided from the Session row alone, and one statement is its own
        // snapshot: no transaction frame. A decision that reads anything more (a runtime principal,
        // Team qualification, content disclosure) discards this pass, even if its reader swallowed
        // the refusal, and the whole delivery is decided again inside one read snapshot.
        let readBeyondRow = false;
        const rowOnlyReader = new Proxy({}, { get() {
            readBeyondRow = true;
            throw new Error("Session delivery decision needs a read snapshot");
        } }) as Tx;
        const rowOnly = await decide(rowOnlyReader, params.committedAccess ?? await inReadSnapshot(tx => tx.session.findUnique({
            where: { id: params.sessionId }, select: withSessionContentSelect(select),
        }).then(decodeSessionStoredContent), {
            // The access row loads relations: one joined statement where Prisma's relationJoins exist,
            // separate queries on SQLite, which keeps their shared snapshot.
            singleStatementRead: getDbProviderFromEnv(process.env, "postgres") !== "sqlite",
        }));
        const decided = !readBeyondRow ? rowOnly : await captureReadSnapshot(async tx => decide(tx,
            await tx.session.findUnique({ where: { id: params.sessionId }, select: withSessionContentSelect(select) }).then(decodeSessionStoredContent)));
        for (const socket of decided.refused) withdrawSessionConsumption(socket, params.sessionId);
        return decided.qualified.filter(({ socket, isSessionOwner, metadataLayoutVersion }) =>
            params.emit(socket, isSessionOwner, metadataLayoutVersion)).length;
    }

    private getEmitterTargetForFilter(userId: string, filter: RecipientFilter): string | string[] {
        switch (filter.type) {
            case "all-interested-in-session":
                return [`session:${filter.sessionId}:${userId}`, `user-scoped:${userId}`];
            case "user-scoped-only":
                return `user-scoped:${userId}`;
            case "machine-scoped-only":
                return [`machine:${filter.machineId}:${userId}`, `user-scoped:${userId}`];
            case "machine-only":
                return `machine:${filter.machineId}:${userId}`;
            case "user-machine-scoped-only":
                return getUserMachinesSocketRoom(userId);
            case "account-stored-content-v3":
                return getAccountStoredContentV3SocketRoom(userId);
            case "all-user-authenticated-connections":
            default:
                return `user:${userId}`;
        }
    }

    private getEmitterForFilter(userId: string, filter: RecipientFilter): SocketRoomBroadcastOperator {
        if (!this.io) {
            throw new Error("EventRouter.getEmitterForFilter called without io");
        }
        return this.io.to(this.getEmitterTargetForFilter(userId, filter));
    }
}

export const eventRouter = new EventRouter();
