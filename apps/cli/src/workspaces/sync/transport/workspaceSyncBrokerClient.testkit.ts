import { randomUUID } from 'node:crypto';
import { type Socket } from 'node:net';

import {
  BrokerControlFrameDecoder,
  BrokerProtocolError,
  createBrokerHelloOkProof,
  createBrokerHelloProof,
  encodeBrokerControlFrame,
  isBrokerTerminalErrorCode,
  type BrokerControlV1,
  type MutagenControlCommandV1,
  OPEN_REMOTE_DEADLINE_MS,
} from './workspaceSyncBrokerProtocol';
import { createWorkspaceSyncBrokerEndpoint } from './workspaceSyncBroker';

export interface WorkspaceSyncBrokerClientConfig {
  endpointPath: string;
  brokerInstanceId: string;
  launchNonce: string;
  launchSecret: Uint8Array;
  sidecarPid: number;
}

export interface WorkspaceSyncBrokerClientStream {
  readonly streamId: string;
  readonly stream: Socket;
  readonly done: Promise<void>;
  closeWrite(): void;
  close(): Promise<void>;
  cancel(): Promise<void>;
}

export type WorkspaceSyncBrokerCommandHandler = (
  command: MutagenControlCommandV1,
  signal: AbortSignal,
) => Promise<unknown> | unknown;

/** Native Manager.List index boundary: zero reads, retained indices park, abort detaches. */
export function createMutagenChangeWaitBoundary() {
  let index = 1n;
  const waiters = new Set<() => void>();
  return {
    change() { index += 1n; for (const wake of [...waiters]) wake(); },
    async waitForChange(previousStateIndex: string, signal: AbortSignal): Promise<string> {
      signal.throwIfAborted();
      if (previousStateIndex !== String(index)) return String(index);
      return await new Promise<string>((resolve, reject) => {
        const cleanup = () => { waiters.delete(changed); signal.removeEventListener('abort', aborted); };
        const changed = () => { cleanup(); resolve(String(index)); };
        const aborted = () => { cleanup(); reject(Object.assign(new Error('Native wait cancelled'), { name: 'AbortError' })); };
        waiters.add(changed);
        signal.addEventListener('abort', aborted, { once: true });
      });
    },
  };
}

type FrameWaiter = {
  predicate: (frame: BrokerControlV1) => boolean;
  resolve: (frame: BrokerControlV1) => void;
  reject: (error: Error) => void;
};

function protocolError(frame: Extract<BrokerControlV1, { t: 'error' }>): BrokerProtocolError {
  return new BrokerProtocolError(
    isBrokerTerminalErrorCode(frame.code) ? frame.code : 'protocol_error',
    frame.message,
  );
}

export class WorkspaceSyncBrokerClient {
  readonly config: WorkspaceSyncBrokerClientConfig;
  lastHelloOkProof: string | undefined;

  private control: Socket | undefined;
  private readonly waiters = new Set<FrameWaiter>();
  private readonly commands = new Map<string, AbortController>();
  private commandHandler: WorkspaceSyncBrokerCommandHandler | undefined;
  private closed = false;

  constructor(config: WorkspaceSyncBrokerClientConfig) {
    if (config.launchSecret.byteLength !== 32 || !Number.isSafeInteger(config.sidecarPid) || config.sidecarPid < 1) {
      throw new Error('invalid workspace sync broker client configuration');
    }
    this.config = config;
  }

  async connectControl(): Promise<void> {
    if (this.control && !this.control.destroyed) return;
    if (this.closed) throw new BrokerProtocolError('agent_unavailable', 'broker client is closed');

    const endpoint = createWorkspaceSyncBrokerEndpoint({ endpointPath: this.config.endpointPath });
    const control = endpoint.connect();
    this.control = control;
    this.installControlReaders(control);
    await new Promise<void>((resolve, reject) => {
      control.once('connect', resolve);
      control.once('error', reject);
    });

    const hello = {
      t: 'hello',
      protocol: 1,
      brokerInstanceId: this.config.brokerInstanceId,
      launchNonce: this.config.launchNonce,
      sidecarPid: this.config.sidecarPid,
      proof: '',
    } as const;
    const authenticatedHello = { ...hello, proof: createBrokerHelloProof(this.config.launchSecret, hello) };
    const reply = await this.sendAndWait(
      authenticatedHello,
      (frame) => frame.t === 'hello_ok' || frame.t === 'error',
    );
    if (reply.t === 'error') throw protocolError(reply);
    if (reply.t !== 'hello_ok') throw new BrokerProtocolError('protocol_error', 'unexpected broker hello reply');
    const expectedProof = createBrokerHelloOkProof(this.config.launchSecret, hello);
    if (reply.brokerInstanceId !== this.config.brokerInstanceId || reply.proof !== expectedProof) {
      control.destroy();
      throw new BrokerProtocolError('unauthorized', 'broker hello reply authentication failed');
    }
    this.lastHelloOkProof = reply.proof;
  }

  onCommand(handler: WorkspaceSyncBrokerCommandHandler): () => void {
    this.commandHandler = handler;
    return () => {
      if (this.commandHandler === handler) this.commandHandler = undefined;
    };
  }

  async openStream(
    endpointId: string,
    options: Readonly<{ expiresAtMs?: number }> = {},
  ): Promise<WorkspaceSyncBrokerClientStream> {
    const requestId = randomUUID();
    const expiresAtMs = options.expiresAtMs ?? Date.now() + OPEN_REMOTE_DEADLINE_MS;
    const ready = await this.sendAndWait(
      { t: 'open_data', requestId, endpointId, expiresAtMs },
      (frame) => (frame.t === 'data_ready' && frame.requestId === requestId)
        || (frame.t === 'error' && frame.requestId === requestId),
    );
    if (ready.t === 'error') throw protocolError(ready);
    if (ready.t !== 'data_ready') throw new BrokerProtocolError('protocol_error', 'unexpected data ready reply');

    const endpoint = createWorkspaceSyncBrokerEndpoint({ endpointPath: ready.dataEndpoint });
    const stream = endpoint.connect();
    try {
      await new Promise<void>((resolve, reject) => {
        stream.once('connect', resolve);
        stream.once('error', reject);
      });
      const attached = await this.sendAndWait(
        { t: 'attach_data', streamId: ready.streamId, attachNonce: ready.attachNonce },
        (frame) => (frame.t === 'data_ok' && frame.streamId === ready.streamId)
          || (frame.t === 'error' && (frame.requestId === requestId || frame.requestId === undefined)),
      );
      if (attached.t === 'error') throw protocolError(attached);
    } catch (error) {
      stream.destroy();
      throw error;
    }

    let settled = false;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const settle = () => {
      if (settled) return;
      settled = true;
      resolveDone();
    };
    stream.once('close', settle);

    const finish = async (kind: 'close' | 'cancel'): Promise<void> => {
      if (settled) return;
      if (kind === 'cancel') {
        const reply = await this.sendAndWait(
          { t: 'cancel', requestId },
          (frame) => frame.t === 'error' && frame.requestId === requestId,
        ).catch(() => undefined);
        if (reply?.t === 'error' && reply.code !== 'cancelled') throw protocolError(reply);
      } else {
        await this.sendAndWait(
          { t: 'close', requestId, reason: 'client_close' },
          (frame) => frame.t === 'close_ok' && frame.requestId === requestId,
        ).catch(() => undefined);
      }
      stream.destroy();
      settle();
    };

    return {
      streamId: ready.streamId,
      stream,
      done,
      closeWrite: () => { if (!stream.destroyed) stream.end(); },
      close: () => finish('close'),
      cancel: () => finish('cancel'),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.commands.values()) controller.abort();
    this.commands.clear();
    this.control?.destroy();
    this.rejectWaiters(new BrokerProtocolError('agent_unavailable', 'broker control connection closed'));
  }

  private installControlReaders(control: Socket): void {
    const decoder = new BrokerControlFrameDecoder();
    control.on('data', (chunk) => {
      let frames: BrokerControlV1[];
      try {
        frames = decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      } catch (error) {
        control.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      for (const frame of frames) this.receive(frame);
    });
    const disconnected = () => {
      if (this.control !== control) return;
      this.control = undefined;
      this.rejectWaiters(new BrokerProtocolError('agent_unavailable', 'broker control connection closed'));
      for (const controller of this.commands.values()) controller.abort();
      this.commands.clear();
    };
    control.once('close', disconnected);
  }

  private receive(frame: BrokerControlV1): void {
    for (const waiter of this.waiters) {
      if (!waiter.predicate(frame)) continue;
      this.waiters.delete(waiter);
      waiter.resolve(frame);
      return;
    }
    if (frame.t === 'command') {
      void this.handleCommand(frame.requestId, frame.command as MutagenControlCommandV1);
    } else if (frame.t === 'cancel') {
      this.commands.get(frame.requestId)?.abort();
    }
  }

  private async handleCommand(requestId: string, command: MutagenControlCommandV1): Promise<void> {
    const control = this.control;
    if (!control || control.destroyed) return;
    if (!this.commandHandler) {
      this.send({ t: 'error', requestId, code: 'agent_unavailable', message: 'sidecar command handler unavailable' });
      return;
    }
    const controller = new AbortController();
    this.commands.set(requestId, controller);
    try {
      const result = await this.commandHandler(command, controller.signal);
      if (!controller.signal.aborted && this.control === control && !control.destroyed) {
        this.send({ t: 'result', requestId, result });
      }
    } catch (error) {
      if (this.control !== control || control.destroyed) return;
      if (error instanceof BrokerProtocolError) {
        this.send({ t: 'error', requestId, code: error.code, message: error.message });
      } else if (controller.signal.aborted) {
        this.send({ t: 'error', requestId, code: 'cancelled', message: 'command cancelled' });
      } else {
        this.send({ t: 'error', requestId, code: 'protocol_error', message: 'sidecar command failed' });
      }
    } finally {
      this.commands.delete(requestId);
    }
  }

  private send(frame: BrokerControlV1): void {
    const control = this.control;
    if (!control || control.destroyed) throw new BrokerProtocolError('agent_unavailable', 'broker control connection unavailable');
    control.write(encodeBrokerControlFrame(frame));
  }

  private sendAndWait(frame: BrokerControlV1, predicate: FrameWaiter['predicate']): Promise<BrokerControlV1> {
    return new Promise<BrokerControlV1>((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      this.waiters.add(waiter);
      try {
        this.send(frame);
      } catch (error) {
        this.waiters.delete(waiter);
        reject(error);
      }
    });
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
  }
}
