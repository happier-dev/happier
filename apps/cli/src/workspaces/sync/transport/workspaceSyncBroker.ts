import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  BrokerControlFrameDecoder,
  BrokerRequestStateMachine,
  createBrokerHelloOkProof,
  createBrokerHelloProof,
  encodeBrokerControlFrame,
  verifyBrokerProof,
  type BrokerControlV1,
  WORKSPACE_SYNC_BROKER_ATTACH_TTL_MS,
  OPEN_REMOTE_DEADLINE_MS,
} from './workspaceSyncBrokerProtocol';

export interface WorkspaceSyncBrokerOpenContext {
  endpointId: string;
  requestId: string;
  expiresAtMs: number;
}

export interface WorkspaceSyncBrokerConfig {
  socketPath: string;
  brokerInstanceId?: string;
  launchNonce?: string;
  launchSecret: Uint8Array;
  sidecarPid?: number;
  maxStreams?: number;
  now?: () => number;
  openExternalStream: (context: WorkspaceSyncBrokerOpenContext) => Promise<NodeJS.ReadWriteStream>;
}

type PendingStream = {
  requestId: string;
  streamId: string;
  attachNonce: string;
  expiresAtMs: number;
  peer?: Socket;
  data?: Socket;
  external?: NodeJS.ReadWriteStream;
  dataPath?: string;
  dataServer?: Server;
  state: BrokerRequestStateMachine;
};

export class WorkspaceSyncBroker {
  readonly brokerInstanceId: string;
  readonly launchNonce: string;
  readonly socketPath: string;
  private readonly server: Server;
  private readonly config: Required<Pick<WorkspaceSyncBrokerConfig, 'now' | 'maxStreams'>> & WorkspaceSyncBrokerConfig;
  private readonly pending = new Map<string, PendingStream>();
  private readonly activeRequestIds = new Set<string>();
  private closed = false;

  private constructor(config: WorkspaceSyncBrokerConfig, server: Server, brokerInstanceId: string, launchNonce: string) {
    this.config = { ...config, now: config.now ?? Date.now, maxStreams: config.maxStreams ?? 8 };
    this.server = server; this.brokerInstanceId = brokerInstanceId; this.launchNonce = launchNonce; this.socketPath = config.socketPath;
  }

  static async listen(config: WorkspaceSyncBrokerConfig): Promise<WorkspaceSyncBroker> {
    if (!config.socketPath || config.launchSecret.byteLength !== 32) throw new Error('invalid broker configuration');
    await mkdir(dirname(config.socketPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(config.socketPath), 0o700);
    await rm(config.socketPath, { force: true });
    const instance = config.brokerInstanceId ?? randomUUID();
    const nonce = config.launchNonce ?? randomUUID();
    const server = createServer();
    const broker = new WorkspaceSyncBroker(config, server, instance, nonce);
    server.on('connection', socket => broker.handleControl(socket));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.socketPath, () => { server.removeListener('error', reject); resolve(); }); });
    await chmod(config.socketPath, 0o600);
    return broker;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const stream of this.pending.values()) this.closePending(stream);
    this.pending.clear();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    await rm(this.socketPath, { force: true });
  }

  private send(socket: Socket, message: BrokerControlV1): void { socket.write(encodeBrokerControlFrame(message)); }

  private handleControl(socket: Socket): void {
    socket.setNoDelay(true);
    const decoder = new BrokerControlFrameDecoder();
    let authenticated = false;
    let hello: Extract<BrokerControlV1, { t: 'hello' }> | undefined;
    const terminate = () => { for (const stream of this.pending.values()) if (stream.peer === socket) this.closePending(stream); socket.destroy(); };
    socket.on('error', terminate); socket.on('close', terminate);
    socket.on('data', chunk => {
      let messages: BrokerControlV1[];
      try { messages = decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk); } catch { this.sendError(socket, undefined, 'malformed_control', 'invalid control frame'); terminate(); return; }
      for (const message of messages) {
        if (!authenticated) {
          if (message.t !== 'hello' || message.brokerInstanceId !== this.brokerInstanceId || message.launchNonce !== this.launchNonce || !verifyBrokerProof(createBrokerHelloProof(this.config.launchSecret, message), message.proof)) { this.sendError(socket, undefined, 'unauthorized', 'hello authentication failed'); terminate(); return; }
          hello = message; authenticated = true;
          this.send(socket, { t: 'hello_ok', protocol: 1, brokerInstanceId: this.brokerInstanceId, proof: createBrokerHelloOkProof(this.config.launchSecret, message) });
          continue;
        }
        this.handleMessage(socket, message, hello!);
      }
    });
  }

  private handleMessage(socket: Socket, message: BrokerControlV1, _hello: Extract<BrokerControlV1, { t: 'hello' }>): void {
    if (message.t === 'open_data') { void this.openData(socket, message); return; }
    if (message.t === 'attach_data') { this.attachData(socket, message); return; }
    if (message.t === 'cancel') { const stream = [...this.pending.values()].find(item => item.requestId === message.requestId && item.peer === socket); if (stream) { this.send(socket, { t: 'error', requestId: message.requestId, code: 'cancelled', message: 'request cancelled' }); this.closePending(stream); } return; }
    if (message.t === 'close') { const stream = [...this.pending.values()].find(item => item.requestId === message.requestId && item.peer === socket); if (stream) this.closePending(stream); this.send(socket, { t: 'close_ok', requestId: message.requestId }); return; }
    this.sendError(socket, 'requestId' in message ? message.requestId : undefined, 'protocol_error', 'unexpected control message');
  }

  private async openData(socket: Socket, message: Extract<BrokerControlV1, { t: 'open_data' }>): Promise<void> {
    if (this.activeRequestIds.size >= this.config.maxStreams) { this.sendError(socket, message.requestId, 'stream_limit', 'stream limit reached'); return; }
    if (this.activeRequestIds.has(message.requestId) || message.expiresAtMs <= this.config.now()) { this.sendError(socket, message.requestId, message.expiresAtMs <= this.config.now() ? 'expired_request' : 'protocol_error', 'invalid or duplicate request'); return; }
    this.activeRequestIds.add(message.requestId);
    const stream: PendingStream = { requestId: message.requestId, streamId: randomUUID(), attachNonce: randomBytes(24).toString('base64url'), expiresAtMs: Math.min(message.expiresAtMs, this.config.now() + OPEN_REMOTE_DEADLINE_MS, this.config.now() + WORKSPACE_SYNC_BROKER_ATTACH_TTL_MS), peer: socket, state: new BrokerRequestStateMachine() };
    try { stream.state.transition('CONTROL_AUTHENTICATING'); stream.state.transition('CONTROL_READY'); stream.state.transition('OPEN_VALIDATING'); stream.state.transition('REMOTE_OPENING'); stream.external = await this.config.openExternalStream(message); stream.state.transition('DATA_ATTACH_PENDING'); this.pending.set(stream.streamId, stream); const dataPath = `${this.socketPath}.${stream.streamId}`; const dataServer = createServer(data => { stream.data = data; data.on('error', () => this.closePending(stream)); dataServer.close(); }); stream.dataPath = dataPath; stream.dataServer = dataServer; dataServer.listen(dataPath, () => { void chmod(dataPath, 0o600); this.send(socket, { t: 'data_ready', requestId: message.requestId, streamId: stream.streamId, dataEndpoint: dataPath, attachNonce: stream.attachNonce, expiresAtMs: stream.expiresAtMs }); });
      setTimeout(() => { if (stream.state.state === 'DATA_ATTACH_PENDING' && this.config.now() >= stream.expiresAtMs) { this.sendError(socket, message.requestId, 'expired_request', 'data attachment expired'); this.closePending(stream); dataServer.close(); } }, WORKSPACE_SYNC_BROKER_ATTACH_TTL_MS).unref();
    } catch { stream.state.fail(); this.activeRequestIds.delete(message.requestId); this.sendError(socket, message.requestId, 'peer_unavailable', 'external stream unavailable'); }
  }

  private attachData(socket: Socket, message: Extract<BrokerControlV1, { t: 'attach_data' }>): void {
    const stream = this.pending.get(message.streamId);
    if (!stream || stream.peer !== socket || stream.attachNonce !== message.attachNonce || stream.expiresAtMs <= this.config.now()) { this.sendError(socket, undefined, 'unauthorized', 'invalid data attachment'); return; }
    if (!stream.data) { this.sendError(socket, stream.requestId, 'protocol_error', 'data connection not established'); return; }
    stream.state.transition('STREAMING'); this.pipe(stream); this.send(socket, { t: 'data_ok', streamId: stream.streamId });
  }

  private pipe(stream: PendingStream): void {
    const data = stream.data; const external = stream.external;
    if (!data || !external) return;
    // Keep both directions independent. A half-close in one direction is propagated
    // once, while the opposite direction may continue until it closes naturally.
    data.pipe(external, { end: false });
    external.pipe(data, { end: false });
    data.once('end', () => { if (typeof external.end === 'function') external.end(); });
    external.once('end', () => { if (!data.destroyed) data.end(); });
    data.on('close', () => this.closePending(stream));
    external.on('error', () => this.closePending(stream));
  }
  private sendError(socket: Socket, requestId: string | undefined, code: string, message: string): void { this.send(socket, requestId === undefined ? { t: 'error', code, message } : { t: 'error', requestId, code, message }); }
  private closePending(stream: PendingStream): void { if (stream.state.state !== 'CLOSED') { if (stream.state.state !== 'CLOSING') stream.state.transition('CLOSING'); stream.state.transition('CLOSED'); } stream.dataServer?.close(); stream.data?.destroy(); if (stream.external && 'destroy' in stream.external && typeof stream.external.destroy === 'function') stream.external.destroy(); if (stream.peer && !stream.peer.destroyed) stream.peer.destroy(); if (stream.dataPath) void rm(stream.dataPath, { force: true }); this.pending.delete(stream.streamId); this.activeRequestIds.delete(stream.requestId); }
}

export function listenWorkspaceSyncBroker(config: WorkspaceSyncBrokerConfig): Promise<WorkspaceSyncBroker> { return WorkspaceSyncBroker.listen(config); }
