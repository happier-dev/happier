import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { connect as netConnect, createServer, type Server, type Socket } from 'node:net';
import { readWebLatencyTracePoint, timeWebLatencyPhase, withWebLatencyTrace, type WebLatencyTracePoint } from '@/daemon/externalActions/webLatencyTrace';

import {
  startProcessCustodySecurePipeRelay,
  type ProcessCustodySecurePipeRelay,
  type ProcessCustodySecurePipeRelayStart,
} from '@/subprocess/supervision/processCustodySecurePipeRelay';

import {
  BrokerControlFrameDecoder,
  BrokerProtocolError,
  createBrokerHelloOkProof,
  createBrokerHelloProof,
  deriveWorkspaceSyncEndpointId,
  encodeBrokerCommandFrame,
  encodeBrokerControlFrame,
  isBrokerTerminalErrorCode,
  MAX_CONCURRENT_DATA_STREAMS,
  OPEN_REMOTE_DEADLINE_MS,
  type BrokerControlV1,
  type BrokerTerminalErrorCode,
  type MutagenControlCommandV1,
  verifyBrokerProof,
  WORKSPACE_SYNC_BROKER_ATTACH_TTL_MS,
  WORKSPACE_SYNC_BROKER_MAX_MESSAGE_BYTES,
  WORKSPACE_SYNC_BROKER_MAX_REQUEST_FRAME_BYTES,
} from './workspaceSyncBrokerProtocol';

export interface WorkspaceSyncBrokerOpenContext {
  endpointId: string;
  requestId: string;
  expiresAtMs: number;
  signal: AbortSignal;
}

export interface WorkspaceSyncBrokerPeerIdentityContext {
  kind: 'control' | 'data';
  socket: Socket;
  sidecarPid?: number;
  witnessedPeerPid?: number;
}

export interface WorkspaceSyncBrokerConfig {
  socketPath: string;
  brokerInstanceId?: string;
  launchNonce?: string;
  launchSecret: Uint8Array;
  maxStreams?: number;
  /** Test/composition override; production is capped by the protocol constant. */
  maxPreauthenticatedControls?: number;
  /** Test/composition override for the bounded HELLO window. */
  handshakeDeadlineMs?: number;
  now?: () => number;
  validatePeerIdentity?: (context: WorkspaceSyncBrokerPeerIdentityContext) => boolean | Promise<boolean>;
  openExternalStream: (context: WorkspaceSyncBrokerOpenContext) => Promise<NodeJS.ReadWriteStream>;
  /** OS endpoint construction boundary; production uses the native endpoint owner. */
  createEndpoint?: (endpointPath: string) => WorkspaceSyncBrokerEndpoint;
}

export interface WorkspaceSyncBrokerEndpoint {
  readonly endpointPath: string;
  readonly kind: 'unix' | 'named_pipe';
  connect(path?: string): Socket;
  listen(server: Server, path?: string): Promise<void>;
  secure(path?: string): Promise<void>;
  remove(path?: string): Promise<void>;
  peerPid(socket: Socket): number | undefined;
}

export const WORKSPACE_SYNC_BROKER_HANDSHAKE_DEADLINE_MS = 15_000;
export const MAX_PREAUTHENTICATED_CONTROL_CONNECTIONS = 8;

export function createWorkspaceSyncBrokerEndpoint(input: Readonly<{
  endpointPath: string;
  platform?: NodeJS.Platform;
  startWindowsRelay?: ProcessCustodySecurePipeRelayStart;
}>): WorkspaceSyncBrokerEndpoint {
  const isWindows = (input.platform ?? process.platform) === 'win32';
  const startWindowsRelay = input.startWindowsRelay ?? startProcessCustodySecurePipeRelay;
  const endpointPath = isWindows && !input.endpointPath.startsWith('\\\\.\\pipe\\')
    ? `\\\\.\\pipe\\happier-workspace-sync-${Buffer.from(input.endpointPath).toString('hex').slice(-48)}`
    : input.endpointPath;
  const peerPids = new WeakMap<Socket, number>();
  let windowsRelay: ProcessCustodySecurePipeRelay | undefined;
  return {
    endpointPath,
    kind: isWindows ? 'named_pipe' : 'unix',
    connect: (path = endpointPath) => netConnect(path),
    listen: async (server, path = endpointPath) => {
      if (isWindows) {
        if (windowsRelay) throw new Error('workspace-sync named-pipe relay is already listening');
        windowsRelay = await startWindowsRelay({
          pipeName: path,
          onConnection: (socket, peerPid) => {
            peerPids.set(socket, peerPid);
            server.emit('connection', socket);
          },
        });
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(path);
      });
    },
    secure: async (path = endpointPath) => {
      if (!isWindows) await chmod(path, 0o600);
    },
    remove: async (path = endpointPath) => {
      if (isWindows) {
        const relay = windowsRelay;
        windowsRelay = undefined;
        await relay?.close();
      } else {
        await rm(path, { force: true });
      }
    },
    peerPid: (socket) => peerPids.get(socket),
  };
}

type PendingStream = {
  requestId: string;
  streamId: string;
  attachNonce: string;
  /** Client-supplied remote-open deadline; never reused as the attach deadline. */
  expiresAtMs: number;
  /** Broker-owned attach window that starts once the external open succeeded. */
  attachExpiresAtMs?: number;
  control: Socket;
  data?: Socket;
  dataCandidate?: Socket;
  external?: NodeJS.ReadWriteStream;
  dataEndpoint?: WorkspaceSyncBrokerEndpoint;
  dataServer?: Server;
  openTimer?: NodeJS.Timeout;
  attachTimer?: NodeJS.Timeout;
  openController: AbortController;
  /**
   * Settles with the cleanup failures once this stream's data server and
   * endpoint removal have both finished.
   */
  cleanup?: Promise<void>;
  setupDone: Promise<void>;
  resolveSetupDone: () => void;
  dataReady: Promise<boolean>;
  resolveDataReady: (accepted: boolean) => void;
  attachRequested: boolean;
  attached: boolean;
  terminalSent: boolean;
  closed: boolean;
};

type PendingCommand = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  abortCleanup?: () => void;
  endpointIds?: readonly string[];
  openError?: BrokerProtocolError;
  trace?: WebLatencyTracePoint;
};

function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => server.close((error) => {
    if (error) reject(error);
    else resolve();
  }));
}

/**
 * Awaits every cleanup step even when one fails and returns the collected
 * failures. Cleanup is never abandoned because a sibling step rejected.
 */
async function settleCleanup(work: readonly (Promise<void> | undefined)[]): Promise<readonly unknown[]> {
  const results = await Promise.allSettled(work);
  return results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
}

function typedError(error: unknown, fallback: BrokerTerminalErrorCode, message: string): BrokerProtocolError {
  if (error instanceof BrokerProtocolError) return error;
  // Carrier/native and HTTP errors need not use broker codes. Keep their
  // reason without serializing the error object or its private boundary data.
  let reason = error instanceof Error && error.message ? error.message : message;
  if (Buffer.byteLength(reason, 'utf8') > WORKSPACE_SYNC_BROKER_MAX_MESSAGE_BYTES) {
    reason = new TextDecoder().decode(Buffer.from(reason, 'utf8').subarray(0, WORKSPACE_SYNC_BROKER_MAX_MESSAGE_BYTES), { stream: true });
  }
  if (typeof error === 'object' && error !== null && 'code' in error && isBrokerTerminalErrorCode(error.code)) {
    return new BrokerProtocolError(error.code, reason);
  }
  return new BrokerProtocolError(fallback, reason);
}

function errorFromFrame(frame: Extract<BrokerControlV1, { t: 'error' }>): BrokerProtocolError {
  return new BrokerProtocolError(
    isBrokerTerminalErrorCode(frame.code) ? frame.code : 'protocol_error',
    frame.message,
  );
}

export class WorkspaceSyncBroker {
  readonly brokerInstanceId: string;
  readonly socketPath: string;
  readonly whenReady: Promise<void>;

  private readonly launchNonceValue: string;
  private readonly launchSecret: Buffer;
  private readonly server: Server;
  private readonly endpoint: WorkspaceSyncBrokerEndpoint;
  private readonly config: WorkspaceSyncBrokerConfig & {
    now: () => number;
    maxStreams: number;
    maxPreauthenticatedControls: number;
    handshakeDeadlineMs: number;
  };
  private readonly pending = new Map<string, PendingStream>();
  private readonly attachRequestIds = new Map<string, string>();
  private readonly commands = new Map<string, PendingCommand>();
  private readonly controlSockets = new Set<Socket>();
  private readonly preauthenticatedControls = new Set<Socket>();
  private readonly streamsAwaitingCleanup = new Set<PendingStream>();
  private authenticatedControl: Socket | undefined;
  private authenticatedSidecarPidValue: number | undefined;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private closed = false;
  private closeTask: Promise<void> | undefined;

  private constructor(
    config: WorkspaceSyncBrokerConfig,
    endpoint: WorkspaceSyncBrokerEndpoint,
    server: Server,
    brokerInstanceId: string,
    launchNonce: string,
  ) {
    this.config = {
      ...config,
      now: config.now ?? Date.now,
      maxStreams: Math.min(config.maxStreams ?? MAX_CONCURRENT_DATA_STREAMS, MAX_CONCURRENT_DATA_STREAMS),
      maxPreauthenticatedControls: Math.min(
        config.maxPreauthenticatedControls ?? MAX_PREAUTHENTICATED_CONTROL_CONNECTIONS,
        MAX_PREAUTHENTICATED_CONTROL_CONNECTIONS,
      ),
      handshakeDeadlineMs: Math.min(
        config.handshakeDeadlineMs ?? WORKSPACE_SYNC_BROKER_HANDSHAKE_DEADLINE_MS,
        WORKSPACE_SYNC_BROKER_HANDSHAKE_DEADLINE_MS,
      ),
    };
    this.endpoint = endpoint;
    this.server = server;
    this.brokerInstanceId = brokerInstanceId;
    this.launchNonceValue = launchNonce;
    this.launchSecret = Buffer.from(config.launchSecret);
    this.socketPath = endpoint.endpointPath;
    this.whenReady = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    void this.whenReady.catch(() => undefined);
  }

  get launchNonce(): string { return this.launchNonceValue; }
  get authenticatedSidecarPid(): number | undefined { return this.authenticatedSidecarPidValue; }

  static async listen(config: WorkspaceSyncBrokerConfig): Promise<WorkspaceSyncBroker> {
    if (!config.socketPath || config.launchSecret.byteLength !== 32) throw new Error('invalid broker configuration');
    if (process.platform !== 'win32') {
      await mkdir(dirname(config.socketPath), { recursive: true, mode: 0o700 });
      await chmod(dirname(config.socketPath), 0o700);
    }
    const endpoint = config.createEndpoint?.(config.socketPath)
      ?? createWorkspaceSyncBrokerEndpoint({ endpointPath: config.socketPath });
    const server = createServer();
    const broker = new WorkspaceSyncBroker(
      config,
      endpoint,
      server,
      config.brokerInstanceId ?? randomUUID(),
      config.launchNonce ?? randomUUID(),
    );
    server.on('connection', (socket) => { void broker.handleControl(socket); });
    let listenerOwned = false;
    try {
      await endpoint.listen(server);
      listenerOwned = true;
      await endpoint.secure();
    } catch (error) {
      const cleanupFailures = await settleCleanup([
        closeServer(server),
        listenerOwned ? endpoint.remove() : undefined,
      ]);
      if (cleanupFailures.length === 0) throw error;
      throw new AggregateError([error, ...cleanupFailures], 'workspace sync broker listener setup failed');
    }
    return broker;
  }

  hasInFlightCommands(): boolean { return this.commands.size > 0; }

  command(
    command: MutagenControlCommandV1,
    options: Readonly<{ signal?: AbortSignal; operationId?: string }> = {},
  ): Promise<unknown> {
    return timeWebLatencyPhase(`workspaceSync.broker.command.${command.t}`, () => {
      const control = this.authenticatedControl;
      if (!control || control.destroyed) {
        return Promise.reject(new BrokerProtocolError('agent_unavailable', 'workspace sync sidecar unavailable'));
      }
      if (this.commands.has(command.requestId)) {
        return Promise.reject(new BrokerProtocolError('protocol_error', 'duplicate command request id'));
      }
      if (options.signal?.aborted) {
        return Promise.reject(new BrokerProtocolError('cancelled', 'command cancelled'));
      }
      return new Promise<unknown>((resolve, reject) => {
        let dispatched = false;
        const fail = (error: Error, sendCancel: boolean) => {
          const pending = this.commands.get(command.requestId);
          if (!pending) return;
          this.commands.delete(command.requestId);
          pending.abortCleanup?.();
          if (sendCancel && this.authenticatedControl === control && !control.destroyed) {
            this.send(control, { t: 'cancel', requestId: command.requestId });
          }
          reject(error);
        };
        const abort = () => fail(
          new BrokerProtocolError(
            dispatched ? 'indeterminate' : 'cancelled',
            dispatched ? 'sidecar command outcome is unknown after cancellation' : 'command cancelled',
          ),
          dispatched,
        );
        const abortCleanup = options.signal ? () => options.signal?.removeEventListener('abort', abort) : undefined;
        options.signal?.addEventListener('abort', abort, { once: true });
        this.commands.set(command.requestId, { resolve, reject, abortCleanup,
          trace: readWebLatencyTracePoint(),
          ...(options.operationId ? { endpointIds: [
            deriveWorkspaceSyncEndpointId(options.operationId, 'alpha'),
            deriveWorkspaceSyncEndpointId(options.operationId, 'beta'),
          ] } : {}),
        });
        try {
          control.write(encodeBrokerCommandFrame(command));
          dispatched = true;
        } catch (error) {
          fail(typedError(error, 'agent_unavailable', 'workspace sync sidecar unavailable'), false);
        }
      });
    });
  }

  async close(): Promise<void> {
    if (!this.closeTask) {
      this.closed = true;
      const closeTask = this.closeTerminally();
      this.closeTask = closeTask;
      void closeTask.catch(() => {
        if (this.closeTask === closeTask) this.closeTask = undefined;
      });
    }
    await this.closeTask;
  }

  private async closeTerminally(): Promise<void> {
    this.readyReject(new BrokerProtocolError('agent_unavailable', 'workspace sync broker closed before sidecar authentication'));
    for (const socket of this.controlSockets) socket.destroy();
    // Close is terminal only once every pending stream's data server and
    // endpoint removal has settled; each stream is attempted even if one fails.
    for (const stream of [...this.pending.values()]) this.closePending(stream);
    this.failCommands(new BrokerProtocolError('indeterminate', 'sidecar command outcome is unknown after broker close'));
    const failures: unknown[] = [];
    const streamResults = await Promise.allSettled(
      [...this.streamsAwaitingCleanup].map((stream) => this.closePending(stream)),
    );
    failures.push(...streamResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason));
    failures.push(...await settleCleanup([closeServer(this.server)]));
    // Endpoint removal remains ordered after listener close, but is attempted
    // even when that close reported a failure.
    failures.push(...await settleCleanup([this.endpoint.remove()]));
    if (failures.length > 0) {
      throw new AggregateError(failures, 'workspace sync broker stream cleanup failed');
    }
  }

  private async validatePeer(
    kind: 'control' | 'data',
    socket: Socket,
    sidecarPid?: number,
    endpoint: WorkspaceSyncBrokerEndpoint = this.endpoint,
  ): Promise<boolean> {
    try {
      return await (this.config.validatePeerIdentity?.({
        kind,
        socket,
        sidecarPid,
        witnessedPeerPid: endpoint.peerPid(socket),
      }) ?? true);
    } catch {
      return false;
    }
  }

  private send(socket: Socket, message: BrokerControlV1): void {
    socket.write(encodeBrokerControlFrame(message));
  }

  private async handleControl(socket: Socket): Promise<void> {
    if (this.closed || this.preauthenticatedControls.size >= this.config.maxPreauthenticatedControls) {
      socket.destroy();
      return;
    }
    this.preauthenticatedControls.add(socket);
    this.controlSockets.add(socket);
    socket.setNoDelay(true);
    // The sidecar sends manager command envelopes, whose protocol-owned
    // request budget is larger than ordinary control/response frames.
    const decoder = new BrokerControlFrameDecoder({ maxFrameBytes: WORKSPACE_SYNC_BROKER_MAX_REQUEST_FRAME_BYTES });
    let authenticated = false;
    let processing = Promise.resolve();
    let terminating = false;
    const handshakeTimer = setTimeout(() => {
      if (!authenticated) terminate();
    }, Math.max(1, this.config.handshakeDeadlineMs));
    handshakeTimer.unref();
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      clearTimeout(handshakeTimer);
      this.preauthenticatedControls.delete(socket);
      for (const stream of [...this.pending.values()]) if (stream.control === socket) void this.closePending(stream);
      if (this.authenticatedControl === socket) {
        this.authenticatedControl = undefined;
        this.authenticatedSidecarPidValue = undefined;
        this.failCommands(new BrokerProtocolError('indeterminate', 'sidecar command outcome is unknown after disconnect'));
      }
      this.controlSockets.delete(socket);
      if (!socket.destroyed) socket.destroy();
    };
    socket.once('error', terminate);
    socket.once('close', terminate);
    socket.on('data', (chunk) => {
      let messages: BrokerControlV1[];
      try {
        messages = decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      } catch {
        this.sendError(socket, undefined, 'malformed_control', 'invalid control frame');
        terminate();
        return;
      }
      for (const message of messages) {
        processing = processing.then(async () => {
          if (terminating) return;
          if (!authenticated) {
            if (message.t !== 'hello'
              || this.closed
              || this.authenticatedControl !== undefined
              || message.brokerInstanceId !== this.brokerInstanceId
              || message.launchNonce !== this.launchNonceValue
              || !await this.validatePeer('control', socket, message.sidecarPid)
              || !verifyBrokerProof(createBrokerHelloProof(this.launchSecret, message), message.proof)) {
              this.sendError(socket, undefined, 'unauthorized', 'hello authentication failed');
              terminate();
              return;
            }
            authenticated = true;
            clearTimeout(handshakeTimer);
            this.preauthenticatedControls.delete(socket);
            this.authenticatedControl = socket;
            this.authenticatedSidecarPidValue = message.sidecarPid;
            this.send(socket, {
              t: 'hello_ok', protocol: 1, brokerInstanceId: this.brokerInstanceId,
              proof: createBrokerHelloOkProof(this.launchSecret, message),
            });
            this.readyResolve();
            return;
          }
          this.handleMessage(socket, message);
        }).catch(() => terminate());
      }
    });
  }

  private handleMessage(socket: Socket, message: BrokerControlV1): void {
    switch (message.t) {
      case 'open_data': this.openData(socket, message); return;
      case 'attach_data': this.attachData(socket, message); return;
      case 'cancel': {
        const stream = this.pending.get(message.requestId);
        if (stream) {
          if (stream.control !== socket) return;
          stream.openController.abort(new BrokerProtocolError('cancelled', 'request cancelled'));
          this.failPending(stream, 'cancelled', 'request cancelled');
        }
        return;
      }
      case 'close': {
        const stream = this.pending.get(message.requestId);
        if (stream?.control === socket) void this.closePending(stream);
        this.send(socket, { t: 'close_ok', requestId: message.requestId });
        return;
      }
      case 'result': this.settleCommand(message.requestId, message.result); return;
      case 'error':
        if (message.requestId && this.commands.has(message.requestId)) {
          this.settleCommand(message.requestId, undefined, errorFromFrame(message));
          return;
        }
        break;
      default: break;
    }
    this.sendError(socket, 'requestId' in message ? message.requestId : undefined, 'protocol_error', 'unexpected control message');
  }

  private openData(socket: Socket, message: Extract<BrokerControlV1, { t: 'open_data' }>): void {
    const now = this.config.now();
    if (this.pending.size >= this.config.maxStreams) {
      this.sendError(socket, message.requestId, 'stream_limit', 'stream limit reached'); return;
    }
    if (this.pending.has(message.requestId)) {
      this.sendError(socket, message.requestId, 'protocol_error', 'duplicate request id'); return;
    }
    if (message.expiresAtMs <= now || message.expiresAtMs > now + OPEN_REMOTE_DEADLINE_MS) {
      this.sendError(socket, message.requestId, 'expired_request', 'invalid request deadline'); return;
    }
    if (!/^ws1_[a-z2-7]{32}$/u.test(message.endpointId)) {
      this.sendError(socket, message.requestId, 'relationship_not_owned', 'unknown opaque endpoint'); return;
    }
    let resolveDataReady!: (accepted: boolean) => void;
    const dataReady = new Promise<boolean>((resolve) => { resolveDataReady = resolve; });
    let resolveSetupDone!: () => void;
    const setupDone = new Promise<void>((resolve) => { resolveSetupDone = resolve; });
    const stream: PendingStream = {
      requestId: message.requestId,
      streamId: randomUUID(),
      attachNonce: randomBytes(24).toString('base64url'),
      // The client-supplied expiry bounds only the remote open; the attach
      // window is granted fresh once the open succeeds.
      expiresAtMs: message.expiresAtMs,
      control: socket,
      dataReady,
      resolveDataReady,
      setupDone,
      resolveSetupDone,
      openController: new AbortController(),
      attachRequested: false,
      attached: false,
      terminalSent: false,
      closed: false,
    };
    this.pending.set(stream.requestId, stream);
    this.attachRequestIds.set(stream.streamId, stream.requestId);
    stream.openTimer = setTimeout(() => {
      if (stream.closed) return;
      const error = new BrokerProtocolError('expired_request', 'external stream open timed out');
      stream.openController.abort(error);
      this.failPending(stream, error.code, error.message);
    }, Math.max(1, message.expiresAtMs - now));
    stream.openTimer.unref();
    void this.completeOpenData(stream, message).then(stream.resolveSetupDone, stream.resolveSetupDone);
  }

  private async completeOpenData(
    stream: PendingStream,
    message: Extract<BrokerControlV1, { t: 'open_data' }>,
  ): Promise<void> {
    const socket = stream.control;
    const failExternal = (failure: BrokerProtocolError): void => {
      if (stream.closed) return;
      if (stream.attached) {
        void this.closePending(stream);
        return;
      }
      // Native .11 drops broker refusal codes in brokerResponseError and sends
      // engine_unavailable from Resume. Retain only this pending operation's
      // own refusal; no prose parsing or error history survives settlement.
      // Remove this recovery once supported engines preserve broker codes.
      for (const command of this.commands.values()) {
        if (command.endpointIds?.includes(message.endpointId)) command.openError ??= failure;
      }
      this.failPending(stream, failure.code, failure.message);
    };
    try {
      // Native OPEN_DATA arrives on an existing socket, outside the Action's
      // async context. The pending command already owns exact endpoint ids.
      const traces = [...this.commands.values()].filter(command => command.endpointIds?.includes(message.endpointId))
        .flatMap(command => command.trace ? [command.trace] : []);
      const source = traces.length === 1 ? traces[0] : undefined;
      const external = await withWebLatencyTrace(source?.requestId ?? message.requestId,
        () => timeWebLatencyPhase('workspaceSync.carrier.openExternalStream', () => this.config.openExternalStream({
        endpointId: message.endpointId,
        requestId: message.requestId,
        expiresAtMs: message.expiresAtMs,
        signal: stream.openController.signal,
      }), source));
      clearTimeout(stream.openTimer);
      if (stream.closed) {
        if ('destroy' in external && typeof external.destroy === 'function') external.destroy();
        return;
      }
      stream.external = external;
      external.once('error', (error: unknown) => {
        failExternal(typedError(error, 'peer_unavailable', 'external stream failed'));
      });
      // A peer may retire after acquisition but before the sidecar attaches.
      // Own close from acquisition onward so that attach cannot acknowledge a
      // destroyed carrier whose terminal event has already been consumed.
      const externalClosed = () => failExternal(new BrokerProtocolError('peer_unavailable', 'external stream closed'));
      external.once('close', externalClosed);
      if ('destroyed' in external && external.destroyed === true) {
        externalClosed();
        return;
      }
      // Darwin's sockaddr_un path ceiling is only 104 bytes and its temporary
      // directory prefix is long. The stream UUID is broker-generated, so a
      // 64-bit filename token remains ample for the bounded active-stream set
      // while leaving the endpoint inside the broker's private directory.
      const dataEndpointToken = stream.streamId.replaceAll('-', '').slice(0, 16);
      const dataPath = process.platform === 'win32'
        ? `${this.socketPath}-data-${stream.streamId}`
        : join(dirname(this.socketPath), `d-${dataEndpointToken}.sock`);
      const dataEndpoint = this.config.createEndpoint?.(dataPath)
        ?? createWorkspaceSyncBrokerEndpoint({ endpointPath: dataPath });
      stream.dataEndpoint = dataEndpoint;
      if (stream.closed) return;
      const dataServer = createServer({ allowHalfOpen: true }, (data) => { void this.acceptData(stream, data); });
      stream.dataServer = dataServer;
      await dataEndpoint.listen(dataServer);
      await dataEndpoint.secure();
      if (stream.closed) {
        await closeServer(dataServer);
        await dataEndpoint.remove();
        return;
      }
      const attachNowMs = this.config.now();
      const attachExpiresAtMs = attachNowMs + WORKSPACE_SYNC_BROKER_ATTACH_TTL_MS;
      this.send(socket, {
        t: 'data_ready', requestId: message.requestId, streamId: stream.streamId,
        dataEndpoint: dataEndpoint.endpointPath, attachNonce: stream.attachNonce,
        // Fresh broker-owned attach window counted from after the successful
        // external open — never the leftover open budget (§6.4).
        expiresAtMs: attachExpiresAtMs,
      });
      stream.attachExpiresAtMs = attachExpiresAtMs;
      stream.attachTimer = setTimeout(() => {
        if (!stream.attached && !stream.closed) {
          this.failPending(stream, 'data_attach_failed', 'data attachment expired');
        }
      }, WORKSPACE_SYNC_BROKER_ATTACH_TTL_MS);
      stream.attachTimer.unref();
    } catch (error) {
      clearTimeout(stream.openTimer);
      failExternal(typedError(error, 'peer_unavailable', 'external stream unavailable'));
    }
  }

  private async acceptData(stream: PendingStream, data: Socket): Promise<void> {
    if (stream.closed || stream.data || stream.dataCandidate) {
      data.destroy();
      return;
    }
    stream.dataCandidate = data;
    const valid = await this.validatePeer('data', data, this.authenticatedSidecarPidValue, stream.dataEndpoint);
    if (stream.closed || stream.dataCandidate !== data || !valid) {
      if (stream.dataCandidate === data) stream.dataCandidate = undefined;
      data.destroy();
      if (!stream.closed && !valid) stream.resolveDataReady(false);
      return;
    }
    stream.dataCandidate = undefined;
    stream.data = data;
    data.setNoDelay(true);
    data.once('error', () => { void this.closePending(stream); });
    stream.resolveDataReady(true);
    await closeServer(stream.dataServer);
  }

  private attachData(socket: Socket, message: Extract<BrokerControlV1, { t: 'attach_data' }>): void {
    const requestId = this.attachRequestIds.get(message.streamId);
    const stream = requestId === undefined ? undefined : this.pending.get(requestId);
    if (!stream || stream.control !== socket || stream.attachNonce !== message.attachNonce) {
      this.sendError(socket, undefined, 'unauthorized', 'invalid data attachment'); return;
    }
    if (stream.attachRequested) {
      this.sendError(socket, stream.requestId, 'data_attach_failed', 'data attachment already consumed'); return;
    }
    stream.attachRequested = true;
    void this.completeAttachData(stream);
  }

  private async completeAttachData(stream: PendingStream): Promise<void> {
    const socket = stream.control;
    const dataAccepted = await stream.dataReady;
    if (stream.closed) return;
    const attachExpired = stream.attachExpiresAtMs === undefined
      || stream.attachExpiresAtMs <= this.config.now();
    if (!dataAccepted || attachExpired || !stream.data) {
      this.failPending(stream, 'data_attach_failed', 'data attachment unavailable');
      return;
    }
    stream.attached = true;
    clearTimeout(stream.attachTimer);
    this.pipe(stream);
    this.send(socket, { t: 'data_ok', streamId: stream.streamId });
  }

  private pipe(stream: PendingStream): void {
    const { data, external } = stream;
    if (!data || !external) return;
    data.pipe(external, { end: false });
    external.pipe(data, { end: false });
    data.once('end', () => { if (typeof external.end === 'function') external.end(); });
    external.once('end', () => { if (!data.destroyed) data.end(); });
    data.once('close', () => { void this.closePending(stream); });
  }

  private sendError(socket: Socket, requestId: string | undefined, code: string, message: string): void {
    if (socket.destroyed) return;
    this.send(socket, requestId === undefined ? { t: 'error', code, message } : { t: 'error', requestId, code, message });
  }

  private failPending(stream: PendingStream, code: BrokerTerminalErrorCode, message: string): void {
    if (stream.closed || stream.terminalSent) return;
    stream.terminalSent = true;
    this.sendError(stream.control, stream.requestId, code, message);
    void this.closePending(stream);
  }

  /**
   * Tears a stream down exactly once and returns when its data server and
   * endpoint removal have settled, so a terminal `close()` can await the same
   * work the fire-and-forget callers (socket errors, CANCEL, disconnect) start.
   */
  private closePending(stream: PendingStream): Promise<void> {
    if (!stream.closed) {
      stream.closed = true;
      this.beginPendingTeardown(stream);
      this.streamsAwaitingCleanup.add(stream);
    }
    if (stream.cleanup) return stream.cleanup;
    const cleanup = this.finishPendingCleanup(stream);
    stream.cleanup = cleanup;
    void cleanup.then(
      () => {
        this.streamsAwaitingCleanup.delete(stream);
        if (stream.cleanup === cleanup) stream.cleanup = undefined;
      },
      () => {
        if (stream.cleanup === cleanup) stream.cleanup = undefined;
      },
    );
    return cleanup;
  }

  private beginPendingTeardown(stream: PendingStream): void {
    if (!stream.openController.signal.aborted) {
      stream.openController.abort(new BrokerProtocolError('cancelled', 'request closed'));
    }
    stream.resolveDataReady(false);
    clearTimeout(stream.openTimer);
    clearTimeout(stream.attachTimer);
    stream.dataCandidate?.destroy();
    stream.data?.destroy();
    if (stream.external && 'destroy' in stream.external && typeof stream.external.destroy === 'function') {
      stream.external.destroy();
    }
    this.pending.delete(stream.requestId);
    this.attachRequestIds.delete(stream.streamId);
  }

  private async finishPendingCleanup(stream: PendingStream): Promise<void> {
    await stream.setupDone;
    const failures = await settleCleanup([closeServer(stream.dataServer), stream.dataEndpoint?.remove()]);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'workspace sync broker stream cleanup failed');
    }
  }

  private settleCommand(requestId: string, result: unknown, error?: Error): void {
    const command = this.commands.get(requestId);
    if (!command) return;
    this.commands.delete(requestId);
    command.abortCleanup?.();
    if (error) {
      command.reject(error instanceof BrokerProtocolError && error.code === 'engine_unavailable'
        ? command.openError ?? error : error);
    } else command.resolve(result);
  }

  private failCommands(error: Error): void {
    for (const [requestId, command] of this.commands) {
      this.commands.delete(requestId);
      command.abortCleanup?.();
      command.reject(error);
    }
  }
}

export function listenWorkspaceSyncBroker(config: WorkspaceSyncBrokerConfig): Promise<WorkspaceSyncBroker> {
  return WorkspaceSyncBroker.listen(config);
}
