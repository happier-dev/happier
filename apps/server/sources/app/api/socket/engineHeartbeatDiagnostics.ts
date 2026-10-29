import type { Server, Socket } from 'socket.io';

export interface EngineHeartbeatDiagnostic {
    event: 'engine_connected' | 'namespace_connected' | 'upgrading' | 'upgrade' | 'ping_created' | 'ping_flushed' | 'pong_received' | 'transport_drained' | 'closed';
    at: number;
    engineId: string;
    transport: string;
    transportWritable: boolean;
    writeBufferPackets: number;
    transportBufferedBytes: number | null;
    pingPending: boolean;
    socketId?: string;
    purpose?: 'scoped-rpc' | 'other';
    closeReason?: 'ping timeout' | 'transport close' | 'transport error' | 'forced close' | 'server close' | 'other';
}

export function registerEngineHeartbeatDiagnostics(
    io: Server,
    env: Record<string, string | undefined>,
    write: (record: EngineHeartbeatDiagnostic) => void,
): void {
    // Temporary incident observation, explicitly off by default. Do not enable
    // engine:* debug instead: that upstream logger includes application packets.
    if (env.HAPPIER_SOCKET_HEARTBEAT_DIAGNOSTICS !== '1') return;

    type RecordEvent = (event: EngineHeartbeatDiagnostic['event'], details?: Pick<EngineHeartbeatDiagnostic, 'socketId' | 'purpose' | 'closeReason'>) => void;
    const connections = new WeakMap<Socket['conn'], RecordEvent>();
    io.engine.on('connection', (connection: Socket['conn']) => {
        // Engine.IO 6.6.11 exposes these fields at runtime but marks them private
        // in declarations. Read-only diagnostic boundary; never change its timers.
        const state = connection as unknown as { readonly id: string; readonly writeBuffer: readonly unknown[] };
        let pingPending = false;
        let awaitingPingDrain = false;
        const record: RecordEvent = (event, namespace) => {
            const transport = connection.transport;
            const websocket = 'socket' in transport ? transport.socket : null;
            const bufferedAmount = websocket && typeof websocket === 'object' && 'bufferedAmount' in websocket
                ? websocket.bufferedAmount : null;
            write({
                event, at: Date.now(), engineId: state.id, transport: transport.name,
                transportWritable: transport.writable, writeBufferPackets: state.writeBuffer.length,
                transportBufferedBytes: typeof bufferedAmount === 'number' ? bufferedAmount : null,
                pingPending, ...namespace,
            });
        };
        connections.set(connection, record);
        record('engine_connected');
        const packetType = (packet: unknown) => packet && typeof packet === 'object' && 'type' in packet ? packet.type : null;
        const onCreated = (packet: unknown) => {
            if (packetType(packet) !== 'ping') return;
            pingPending = true;
            record('ping_created');
        };
        const onPacket = (packet: unknown) => {
            if (packetType(packet) !== 'pong') return;
            pingPending = false;
            record('pong_received');
        };
        const onFlush = (packets: readonly unknown[]) => {
            if (!packets.some(packet => packetType(packet) === 'ping')) return;
            awaitingPingDrain = true;
            record('ping_flushed');
        };
        const onDrain = () => {
            if (!awaitingPingDrain) return;
            awaitingPingDrain = false;
            record('transport_drained');
        };
        let observedTransport = connection.transport;
        observedTransport.on('drain', onDrain);
        const onUpgrade = () => {
            observedTransport.off('drain', onDrain);
            // A discarded polling batch cannot be credited to a later WS write.
            awaitingPingDrain = false;
            observedTransport = connection.transport;
            observedTransport.on('drain', onDrain);
            record('upgrade');
        };
        connection.on('packetCreate', onCreated);
        connection.on('packet', onPacket);
        connection.on('flush', onFlush);
        const onUpgrading = () => record('upgrading');
        connection.on('upgrading', onUpgrading);
        connection.on('upgrade', onUpgrade);
        connection.once('close', (reason: unknown) => {
            const closeReason = reason === 'ping timeout' || reason === 'transport close' || reason === 'transport error'
                || reason === 'forced close' || reason === 'server close' ? reason : 'other';
            record('closed', { closeReason });
            observedTransport.off('drain', onDrain);
            connection.off('packetCreate', onCreated);
            connection.off('packet', onPacket);
            connection.off('flush', onFlush);
            connection.off('upgrading', onUpgrading);
            connection.off('upgrade', onUpgrade);
            connections.delete(connection);
        });
    });
    io.on('connection', (socket: Socket) => {
        connections.get(socket.conn)?.('namespace_connected', {
            socketId: socket.id,
            purpose: socket.handshake.auth.clientPurpose === 'scoped-rpc' ? 'scoped-rpc' : 'other',
        });
    });
}
