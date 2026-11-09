import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as netConnect, createServer, Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { listenWorkspaceSyncBroker, createWorkspaceSyncBrokerEndpoint, type WorkspaceSyncBroker } from './workspaceSyncBroker';
import { WorkspaceSyncBrokerClient } from './workspaceSyncBrokerClient.testkit';
import { logger } from '@/ui/logger';
import { withWebLatencyTrace } from '@/daemon/externalActions/webLatencyTrace';
import {
  BrokerControlFrameDecoder,
  BrokerProtocolError,
  createBrokerHelloProof,
  deriveWorkspaceSyncEndpointId,
  encodeBrokerControlFrame,
  OPEN_REMOTE_DEADLINE_MS,
  WORKSPACE_SYNC_BROKER_MAX_MESSAGE_BYTES,
  WORKSPACE_SYNC_BROKER_ATTACH_TTL_MS,
  type BrokerControlV1,
} from './workspaceSyncBrokerProtocol';

/**
 * Full-duplex stand-in for the authenticated peer carrier (Lane 06 owns the
 * real Iroh machine carrier). Read and write directions are independent so
 * half-close behavior is observable, exactly like a socket.
 */
class PeerStream extends Duplex {
  readonly received: Buffer[] = [];
  writeEnded = false;
  peerClosed = false;

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    this.received.push(chunk);
    cb();
  }

  override _read(): void {}

  override end(): this {
    this.writeEnded = true;
    return super.end();
  }

  /** Simulates the remote peer closing its write direction (our read side EOF). */
  closeFromPeer(): void {
    this.peerClosed = true;
    this.push(null);
  }

  /** Simulates the remote peer writing bytes toward the broker. */
  pushFromPeer(chunk: Buffer | string): boolean {
    return this.push(chunk);
  }
}

type BrokerFixture = Readonly<{
  directory: string;
  socketPath: string;
  secret: Buffer;
  broker: WorkspaceSyncBroker;
  cleanup: () => Promise<void>;
}>;

async function startBroker(overrides: Partial<Parameters<typeof listenWorkspaceSyncBroker>[0]> = {}): Promise<BrokerFixture & { externalStreams: PeerStream[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'wsbroker-'));
  const socketPath = join(directory, 'b.sock');
  const secret = randomBytes(32);
  const externalStreams: PeerStream[] = [];
  const broker = await listenWorkspaceSyncBroker({
    socketPath,
    launchSecret: secret,
    ...overrides,
    openExternalStream: async (context) => {
      if (overrides.openExternalStream) return await overrides.openExternalStream(context);
      const stream = new PeerStream();
      externalStreams.push(stream);
      return stream;
    },
  });
  return {
    directory,
    socketPath,
    secret,
    broker,
    externalStreams,
    cleanup: async () => {
      await broker.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function connectClient(fixture: BrokerFixture, overrides: Partial<ConstructorParameters<typeof WorkspaceSyncBrokerClient>[0]> = {}): Promise<WorkspaceSyncBrokerClient> {
  const client = new WorkspaceSyncBrokerClient({
    endpointPath: fixture.socketPath,
    brokerInstanceId: fixture.broker.brokerInstanceId,
    launchNonce: fixture.broker.launchNonce,
    launchSecret: fixture.secret,
    sidecarPid: process.pid,
    ...overrides,
  });
  await client.connectControl();
  return client;
}

/** Raw wire-level control client used to exercise protocol rules directly. */
async function openRawControl(socketPath: string): Promise<Socket> {
  const socket = netConnect(socketPath);
  await once(socket, 'connect');
  return socket;
}

async function openAuthenticatedRawControl(fixture: BrokerFixture): Promise<Readonly<{
  socket: Socket;
  wire: ReturnType<typeof rawCollector>;
}>> {
  const socket = await openRawControl(fixture.socketPath);
  const wire = rawCollector(socket);
  const hello = {
    t: 'hello',
    protocol: 1,
    brokerInstanceId: fixture.broker.brokerInstanceId,
    launchNonce: fixture.broker.launchNonce,
    sidecarPid: process.pid,
    proof: '',
  } as const;
  socket.write(encodeBrokerControlFrame({
    ...hello,
    proof: createBrokerHelloProof(fixture.secret, hello),
  }));
  await wire.waitFor((frame) => frame.t === 'hello_ok', 'hello_ok');
  return { socket, wire };
}

function rawCollector(socket: Socket): { frames: BrokerControlV1[]; waitFor: (predicate: (frame: BrokerControlV1) => boolean, label: string) => Promise<BrokerControlV1> } {
  const decoder = new BrokerControlFrameDecoder();
  const frames: BrokerControlV1[] = [];
  let notify: (() => void) | null = null;
  socket.on('data', (chunk) => {
    frames.push(...decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    notify?.();
    notify = null;
  });
  return {
    frames,
    waitFor: async (predicate, label) => {
      for (let i = 0; i < 200; i += 1) {
        const found = frames.find(predicate);
        if (found) return found;
        await new Promise<void>((resolve) => { notify = resolve; });
      }
      throw new Error(`timed out waiting for control frame: ${label}`);
    },
  };
}

function concat(chunks: readonly Buffer[]): Buffer {
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const cleanupJobs: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanupJobs.length > 0) {
    const job = cleanupJobs.pop();
    if (job) await job();
  }
});

async function useFixture<T extends BrokerFixture>(fixture: T): Promise<T> {
  cleanupJobs.push(fixture.cleanup);
  return fixture;
}

describe('workspace sync broker moving bytes over real OS IPC', () => {
  it('authenticates HELLO and moves non-empty bytes in both directions through the raw data path', async () => {
    const fixture = await useFixture(await startBroker());
    await expect(readdir(fixture.directory)).resolves.toContain('b.sock');
    const client = await connectClient(fixture);

    const endpointId = deriveWorkspaceSyncEndpointId('rel-1', 'alpha');
    const handle = await client.openStream(endpointId);
    expect(handle.streamId).toBeTruthy();

    const engine = fixture.externalStreams[0];
    const fromEngine: Buffer[] = [];
    handle.stream.on('data', (chunk: Buffer) => fromEngine.push(chunk));

    // Client (sidecar) → engine direction through the raw data connection.
    const outbound = randomBytes(256 * 1024);
    handle.stream.write(outbound);
    await waitFor(() => concat(engine.received).byteLength === outbound.byteLength, 'outbound bytes at engine');
    expect(concat(engine.received).equals(outbound)).toBe(true);

    // Engine → client direction through the same raw data connection.
    const inbound = randomBytes(128 * 1024);
    engine.pushFromPeer(inbound);
    await waitFor(() => concat(fromEngine).byteLength === inbound.byteLength, 'inbound bytes at sidecar');
    expect(concat(fromEngine).equals(inbound)).toBe(true);

    await handle.close();
    await client.close();
  });

  it('propagates half-close in each direction independently', async () => {
    const fixture = await useFixture(await startBroker());
    const client = await connectClient(fixture);
    const handle = await client.openStream(deriveWorkspaceSyncEndpointId('rel-half', 'beta'));
    const engine = fixture.externalStreams[0];

    const engineReadEnd = new Promise<void>((resolve) => engine.once('finish', () => resolve()));
    // Sidecar closes its write direction; the engine read side must observe EOF.
    handle.closeWrite();
    await engineReadEnd;
    expect(engine.writeEnded).toBe(true);

    // The opposite direction must still carry bytes after the sidecar half-close.
    const received: Buffer[] = [];
    handle.stream.on('data', (chunk: Buffer) => received.push(chunk));
    const late = Buffer.from('still-flowing');
    engine.pushFromPeer(late);
    await waitFor(() => concat(received).includes('still-flowing'), 'post-half-close reverse bytes');
    expect(concat(received).toString()).toContain('still-flowing');

    // Engine closes its write direction; the sidecar read side must observe EOF.
    const clientReadEnd = new Promise<void>((resolve) => handle.stream.once('end', () => resolve()));
    engine.closeFromPeer();
    await clientReadEnd;

    await handle.close();
    await client.close();
  });

  it('cancels a stream once, destroys both handles, and releases the stream slot', async () => {
    const fixture = await useFixture(await startBroker());
    const client = await connectClient(fixture);
    const first = await client.openStream(deriveWorkspaceSyncEndpointId('rel-cancel', 'alpha'));
    await first.cancel();
    await expect(first.done).resolves.toBeUndefined();
    expect((first.stream as Socket).destroyed).toBe(true);

    // The request slot was released exactly once: a new stream opens cleanly.
    const second = await client.openStream(deriveWorkspaceSyncEndpointId('rel-cancel', 'alpha'));
    expect(fixture.externalStreams).toHaveLength(2);
    await second.close();
    await client.close();
  });
});

describe('workspace sync broker authentication and attach rules', () => {
  it('closes a control socket that does not authenticate within the handshake deadline', async () => {
    const fixture = await useFixture(await startBroker({ handshakeDeadlineMs: 20 }));
    const socket = await openRawControl(fixture.socketPath);

    await waitFor(() => socket.destroyed, 'unauthenticated control deadline');
  });

  it('bounds control sockets waiting for HELLO before allocating another decoder', async () => {
    const fixture = await useFixture(await startBroker({ maxPreauthenticatedControls: 1 }));
    const first = await openRawControl(fixture.socketPath);
    const second = await openRawControl(fixture.socketPath);

    await waitFor(() => second.destroyed, 'preauthenticated control capacity rejection');
    expect(first.destroyed).toBe(false);
    first.destroy();
  });

  it('rolls back the listener and endpoint when post-bind ACL hardening fails', async () => {
    if (process.platform === 'win32') return;
    // Match the regular fixture's short endpoint so Unix socket path limits do
    // not prevent the listener from reaching post-bind ACL hardening.
    const directory = await mkdtemp(join(tmpdir(), 'wsbroker-'));
    const socketPath = join(directory, 'b.sock');
    const native = createWorkspaceSyncBrokerEndpoint({ endpointPath: socketPath });
    const remove = vi.fn(async (path?: string) => await native.remove(path));

    await expect(listenWorkspaceSyncBroker({
      socketPath,
      launchSecret: randomBytes(32),
      openExternalStream: async () => new PeerStream(),
      createEndpoint: () => ({
        ...native,
        secure: async () => { throw new Error('ACL hardening failed'); },
        remove,
      }),
    })).rejects.toThrow('ACL hardening failed');

    expect(remove).toHaveBeenCalledOnce();
    await expect(stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(directory, { recursive: true, force: true });
  });

  it('does not remove a pre-existing endpoint before binding its owned listener', async () => {
    if (process.platform === 'win32') return;
    const directory = await mkdtemp(join(tmpdir(), 'wsbroker-owned-'));
    const socketPath = join(directory, 'existing.sock');
    await writeFile(socketPath, 'owned by another launch');

    await expect(listenWorkspaceSyncBroker({
      socketPath,
      launchSecret: randomBytes(32),
      openExternalStream: async () => new PeerStream(),
    })).rejects.toBeInstanceOf(Error);
    await expect(readFile(socketPath, 'utf8')).resolves.toBe('owned by another launch');
    await rm(directory, { recursive: true, force: true });
  });

  it('settles unauthenticated readiness when the broker closes', async () => {
    const fixture = await startBroker();
    const outcome = Promise.race([
      fixture.broker.whenReady.then(() => 'ready', (error: unknown) => error),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 100)),
    ]);
    await fixture.broker.close();
    await expect(outcome).resolves.toMatchObject({ code: 'agent_unavailable' });
    await rm(fixture.directory, { recursive: true, force: true });
  });

  it('closes terminally only after every pending stream endpoint removal settled, and aggregates the failures', async () => {
    // POSIX endpoints are filesystem entries; the Windows relay owns its own
    // named-pipe teardown and has no path to occupy.
    if (process.platform === 'win32') return;
    const fixture = await useFixture(await startBroker());
    const { socket, wire } = await openAuthenticatedRawControl(fixture);
    const openStream = async (requestId: string, relationshipId: string) => {
      socket.write(encodeBrokerControlFrame({
        t: 'open_data',
        requestId,
        endpointId: deriveWorkspaceSyncEndpointId(relationshipId, 'alpha'),
        expiresAtMs: Date.now() + OPEN_REMOTE_DEADLINE_MS,
      }));
      const frame = await wire.waitFor(
        (candidate) => candidate.t === 'data_ready' && candidate.requestId === requestId,
        `data_ready ${requestId}`,
      );
      if (frame.t !== 'data_ready') throw new Error('unreachable');
      return frame;
    };

    const blocked = await openStream('req-close-blocked', 'rel-close-blocked');
    const clean = await openStream('req-close-clean', 'rel-close-clean');

    // Occupy one stream's endpoint path with a non-empty directory so its
    // existing removal step really fails, while its sibling stays removable.
    await rm(blocked.dataEndpoint);
    await mkdir(blocked.dataEndpoint);
    await writeFile(join(blocked.dataEndpoint, 'occupied'), 'untouched');

    const firstClose = fixture.broker.close().then(() => null, (error: unknown) => error);
    const concurrentClose = fixture.broker.close().then(() => null, (error: unknown) => error);
    const [failure, concurrentFailure] = await Promise.all([firstClose, concurrentClose]);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(1);
    const streamCleanupFailure = (failure as AggregateError).errors[0];
    const streamCleanupCauses = streamCleanupFailure instanceof AggregateError
      ? streamCleanupFailure.errors
      : [streamCleanupFailure];
    expect(streamCleanupCauses).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ERR_FS_EISDIR' }),
    ]));
    // Every caller observes the same terminal cleanup result; a concurrent
    // close cannot return early merely because another close owns teardown.
    expect(concurrentFailure).toBeInstanceOf(AggregateError);
    expect((concurrentFailure as AggregateError).errors).toHaveLength(1);
    // Close is terminal: the sibling stream's endpoint is already gone when it settles.
    await expect(stat(clean.dataEndpoint)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(fixture.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(blocked.dataEndpoint)).resolves.toEqual(['occupied']);

    await rm(blocked.dataEndpoint, { recursive: true });
    await expect(fixture.broker.close()).resolves.toBeUndefined();
    await expect(stat(blocked.dataEndpoint)).rejects.toMatchObject({ code: 'ENOENT' });

    socket.destroy();
  });

  it('keeps in-flight data endpoint creation in terminal close custody', async () => {
    if (process.platform === 'win32') return;
    let releaseDataListen!: () => void;
    const dataListenBlocked = new Promise<void>((resolve) => { releaseDataListen = resolve; });
    const dataListen = vi.fn(async () => await dataListenBlocked);
    const fixture = await useFixture(await startBroker({
      createEndpoint: (endpointPath) => {
        const native = createWorkspaceSyncBrokerEndpoint({ endpointPath });
        if (!endpointPath.includes('/d-')) return native;
        return {
          ...native,
          listen: dataListen,
        };
      },
    }));
    const { socket } = await openAuthenticatedRawControl(fixture);
    socket.write(encodeBrokerControlFrame({
      t: 'open_data',
      requestId: 'req-creating-endpoint',
      endpointId: deriveWorkspaceSyncEndpointId('rel-creating-endpoint', 'alpha'),
      expiresAtMs: Date.now() + OPEN_REMOTE_DEADLINE_MS,
    }));
    await waitFor(() => dataListen.mock.calls.length === 1, 'data endpoint listen to begin');

    let closeSettled = false;
    const closing = fixture.broker.close().finally(() => { closeSettled = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(closeSettled).toBe(false);

    releaseDataListen();
    await closing;
    expect(dataListen).toHaveBeenCalledOnce();
    socket.destroy();
  });

  it.each([
    { failure: new Error('peer unavailable'), reason: 'peer unavailable' },
    { failure: new Error(`${'x'.repeat(WORKSPACE_SYNC_BROKER_MAX_MESSAGE_BYTES - 1)}é detail`),
      reason: 'x'.repeat(WORKSPACE_SYNC_BROKER_MAX_MESSAGE_BYTES - 1) },
    { failure: { transportState: 'unavailable' }, reason: 'external stream unavailable' },
  ])('settles setup custody and preserves the error reason when external stream creation fails before close (case %#)', async ({ failure, reason }) => {
    const fixture = await useFixture(await startBroker({
      openExternalStream: async () => {
        throw failure;
      },
    }));
    const { socket, wire } = await openAuthenticatedRawControl(fixture);
    socket.write(encodeBrokerControlFrame({
      t: 'open_data',
      requestId: 'req-open-failure',
      endpointId: deriveWorkspaceSyncEndpointId('rel-open-failure', 'alpha'),
      expiresAtMs: Date.now() + OPEN_REMOTE_DEADLINE_MS,
    }));
    await expect(wire.waitFor(
      (frame) => frame.t === 'error' && frame.requestId === 'req-open-failure',
      'external open failure',
    )).resolves.toMatchObject({ code: 'peer_unavailable', message: reason });

    await expect(fixture.broker.close()).resolves.toBeUndefined();
    socket.destroy();
  });

  it('owns an acquired external stream error while endpoint setup is pending and accepts the next request', async () => {
    let external!: PeerStream;
    let releaseFirstListen!: () => void;
    const firstListenBlocked = new Promise<void>((resolve) => { releaseFirstListen = resolve; });
    let resolveFirstRemoved!: () => void;
    const firstRemoved = new Promise<void>((resolve) => { resolveFirstRemoved = resolve; });
    let dataEndpointCount = 0;
    const fixture = await useFixture(await startBroker({
      openExternalStream: async () => {
        const stream = new PeerStream();
        if (!external) external = stream;
        return stream;
      },
      createEndpoint: (endpointPath) => {
        const native = createWorkspaceSyncBrokerEndpoint({ endpointPath });
        if (!endpointPath.includes('/d-')) return native;
        dataEndpointCount += 1;
        if (dataEndpointCount !== 1) return native;
        return {
          ...native,
          listen: async () => await firstListenBlocked,
          remove: async () => {
            await native.remove();
            resolveFirstRemoved();
          },
        };
      },
    }));
    const { socket, wire } = await openAuthenticatedRawControl(fixture);
    socket.write(encodeBrokerControlFrame({
      t: 'open_data',
      requestId: 'req-external-error-before-attach',
      endpointId: deriveWorkspaceSyncEndpointId('rel-external-error-before-attach', 'alpha'),
      expiresAtMs: Date.now() + OPEN_REMOTE_DEADLINE_MS,
    }));
    await waitFor(() => external !== undefined && dataEndpointCount === 1, 'external acquisition before endpoint setup');
    try {
      expect(external.listenerCount('error')).toBeGreaterThan(0);
      external.emit('error', new Error('peer failed during endpoint setup'));
      const terminal = await wire.waitFor(
        (frame) => frame.t === 'error' && frame.requestId === 'req-external-error-before-attach',
        'external error terminal response',
      );
      expect(terminal).toMatchObject({ code: 'peer_unavailable' });
      releaseFirstListen();
      await firstRemoved;
      expect(wire.frames.filter(
        (frame) => frame.t === 'error' && frame.requestId === 'req-external-error-before-attach',
      )).toHaveLength(1);

      socket.write(encodeBrokerControlFrame({
        t: 'open_data',
        requestId: 'req-after-external-error',
        endpointId: deriveWorkspaceSyncEndpointId('rel-after-external-error', 'beta'),
        expiresAtMs: Date.now() + OPEN_REMOTE_DEADLINE_MS,
      }));
      await expect(wire.waitFor(
        (frame) => frame.t === 'data_ready' && frame.requestId === 'req-after-external-error',
        'next request data readiness',
      )).resolves.toMatchObject({ t: 'data_ready' });
    } finally {
      releaseFirstListen();
      socket.destroy();
    }
  });

  it('refuses a peer retired before data attachment and admits its replacement stream', async () => {
    const fixture = await useFixture(await startBroker({ maxStreams: 1 }));
    const { socket, wire } = await openAuthenticatedRawControl(fixture);
    const endpointId = deriveWorkspaceSyncEndpointId('rel-peer-restart', 'beta');
    const open = async (requestId: string) => {
      socket.write(encodeBrokerControlFrame({
        t: 'open_data', requestId, endpointId, expiresAtMs: Date.now() + OPEN_REMOTE_DEADLINE_MS,
      }));
      const ready = await wire.waitFor(frame => frame.t === 'data_ready' && frame.requestId === requestId, 'peer data readiness');
      if (ready.t !== 'data_ready') throw new Error('unreachable');
      const data = createWorkspaceSyncBrokerEndpoint({ endpointPath: ready.dataEndpoint }).connect();
      await once(data, 'connect');
      return { ready, data };
    };
    const retired = await open('req-retired-peer');
    const peer = fixture.externalStreams[0]!;
    const closed = once(peer, 'close');
    peer.destroy();
    await closed;
    socket.write(encodeBrokerControlFrame({ t: 'attach_data', streamId: retired.ready.streamId, attachNonce: retired.ready.attachNonce }));
    const outcome = await wire.waitFor(frame => frame.t === 'error' && frame.requestId === 'req-retired-peer'
      || frame.t === 'data_ok' && frame.streamId === retired.ready.streamId, 'retired peer terminal response');
    expect(outcome).toMatchObject({ t: 'error', code: 'peer_unavailable' });
    await waitFor(() => retired.data.destroyed, 'retired peer data cleanup');

    const replacement = await open('req-replacement-peer');
    socket.write(encodeBrokerControlFrame({ t: 'attach_data', streamId: replacement.ready.streamId, attachNonce: replacement.ready.attachNonce }));
    await wire.waitFor(frame => frame.t === 'data_ok' && frame.streamId === replacement.ready.streamId, 'replacement data attachment');
    replacement.data.write('replacement bytes');
    await waitFor(() => concat(fixture.externalStreams[1]!.received).toString() === 'replacement bytes', 'replacement peer bytes');
    replacement.data.destroy();
    socket.destroy();
  });

  it('refuses an external stream that closed before its acquisition completed', async () => {
    const fixture = await useFixture(await startBroker({ openExternalStream: async () => {
      const peer = new PeerStream();
      const closed = once(peer, 'close');
      peer.destroy();
      await closed;
      return peer;
    } }));
    const client = await connectClient(fixture);
    try {
      await expect(client.openStream(deriveWorkspaceSyncEndpointId('rel-retired-during-open', 'beta')))
        .rejects.toMatchObject({ code: 'peer_unavailable' });
    } finally { await client.close(); }
  });

  it('closes an attached external stream without sending a second terminal control response', async () => {
    const fixture = await useFixture(await startBroker());
    const { socket, wire } = await openAuthenticatedRawControl(fixture);
    socket.write(encodeBrokerControlFrame({
      t: 'open_data', requestId: 'req-attached-error',
      endpointId: deriveWorkspaceSyncEndpointId('rel-attached-error', 'alpha'),
      expiresAtMs: Date.now() + OPEN_REMOTE_DEADLINE_MS,
    }));
    const ready = await wire.waitFor((frame) => frame.t === 'data_ready' && frame.requestId === 'req-attached-error', 'data_ready');
    if (ready.t !== 'data_ready') throw new Error('unreachable');
    const endpoint = createWorkspaceSyncBrokerEndpoint({ endpointPath: ready.dataEndpoint });
    const data = await endpoint.connect(ready.dataEndpoint);
    await once(data, 'connect');
    socket.write(encodeBrokerControlFrame({ t: 'attach_data', streamId: ready.streamId, attachNonce: ready.attachNonce }));
    await wire.waitFor((frame) => frame.t === 'data_ok' && frame.streamId === ready.streamId, 'data_ok');

    fixture.externalStreams[0]!.emit('error', new Error('attached peer failed'));
    await waitFor(() => data.destroyed, 'attached data stream cleanup');
    socket.write(encodeBrokerControlFrame({
      t: 'open_data', requestId: 'req-after-attached-error',
      endpointId: deriveWorkspaceSyncEndpointId('rel-after-attached-error', 'beta'),
      expiresAtMs: Date.now() + OPEN_REMOTE_DEADLINE_MS,
    }));
    await expect(wire.waitFor(
      (frame) => frame.t === 'data_ready' && frame.requestId === 'req-after-attached-error',
      'next data readiness',
    )).resolves.toMatchObject({ t: 'data_ready' });
    expect(wire.frames.some((frame) => frame.t === 'error' && frame.requestId === 'req-attached-error')).toBe(false);
    socket.destroy();
    data.destroy();
  });

  it('does not head-of-line block an independent open while another remote open is stalled', async () => {
    const stalledEndpoint = deriveWorkspaceSyncEndpointId('rel-stalled', 'alpha');
    const readyEndpoint = deriveWorkspaceSyncEndpointId('rel-ready', 'beta');
    let stalledDispatched = false;
    const fixture = await useFixture(await startBroker({
      openExternalStream: async ({ endpointId, signal }) => {
        if (endpointId === stalledEndpoint) {
          stalledDispatched = true;
          return await new Promise<PeerStream>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        return new PeerStream();
      },
    }));
    const client = await connectClient(fixture);

    const stalled = client.openStream(stalledEndpoint);
    await waitFor(() => stalledDispatched, 'stalled remote open dispatch');
    const independent = await client.openStream(readyEndpoint);
    expect(independent.streamId).toBeTruthy();

    await independent.close();
    await client.close();
    await expect(stalled).rejects.toMatchObject({ code: 'agent_unavailable' });
  });

  it('aborts a stalled remote open on CANCEL and emits exactly one terminal response', async () => {
    let openSignal: AbortSignal | undefined;
    const fixture = await useFixture(await startBroker({
      openExternalStream: async ({ signal }) => await new Promise<PeerStream>((_resolve, reject) => {
        openSignal = signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    }));
    const { socket, wire } = await openAuthenticatedRawControl(fixture);
    socket.write(encodeBrokerControlFrame({
      t: 'open_data',
      requestId: 'req-cancel-opening',
      endpointId: deriveWorkspaceSyncEndpointId('rel-cancel-opening', 'alpha'),
      expiresAtMs: Date.now() + OPEN_REMOTE_DEADLINE_MS,
    }));
    await waitFor(() => openSignal !== undefined, 'remote open signal');
    socket.write(encodeBrokerControlFrame({ t: 'cancel', requestId: 'req-cancel-opening' }));

    await wire.waitFor(
      (frame) => frame.t === 'error' && frame.requestId === 'req-cancel-opening',
      'cancel terminal response',
    );
    expect(openSignal?.aborted).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(wire.frames.filter(
      (frame) => frame.t === 'error' && frame.requestId === 'req-cancel-opening',
    )).toHaveLength(1);
    socket.destroy();
  });

  it('aborts a stalled remote open when its operational deadline expires', async () => {
    let openSignal: AbortSignal | undefined;
    const fixture = await useFixture(await startBroker({
      openExternalStream: async ({ signal }) => await new Promise<PeerStream>((_resolve, reject) => {
        openSignal = signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    }));
    const { socket, wire } = await openAuthenticatedRawControl(fixture);
    socket.write(encodeBrokerControlFrame({
      t: 'open_data',
      requestId: 'req-open-deadline',
      endpointId: deriveWorkspaceSyncEndpointId('rel-open-deadline', 'alpha'),
      expiresAtMs: Date.now() + 50,
    }));

    const terminal = await wire.waitFor(
      (frame) => frame.t === 'error' && frame.requestId === 'req-open-deadline',
      'open deadline terminal response',
    );
    expect(terminal).toMatchObject({ t: 'error', code: 'expired_request' });
    expect(openSignal?.aborted).toBe(true);
    socket.destroy();
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores a late remote open %s after cancellation without a second terminal response',
    async (settlement) => {
      let settle!: (settlement: 'resolve' | 'reject') => void;
      const fixture = await useFixture(await startBroker({
        openExternalStream: async () => await new Promise<PeerStream>((resolve, reject) => {
          settle = (kind) => {
            if (kind === 'resolve') resolve(new PeerStream());
            else reject(new Error('late remote rejection'));
          };
        }),
      }));
      const { socket, wire } = await openAuthenticatedRawControl(fixture);
      const requestId = `req-late-${settlement}`;
      socket.write(encodeBrokerControlFrame({
        t: 'open_data',
        requestId,
        endpointId: deriveWorkspaceSyncEndpointId(`rel-late-${settlement}`, 'alpha'),
        expiresAtMs: Date.now() + OPEN_REMOTE_DEADLINE_MS,
      }));
      await waitFor(() => settle !== undefined, 'remote open dispatch');
      socket.write(encodeBrokerControlFrame({ t: 'cancel', requestId }));
      await wire.waitFor(
        (frame) => frame.t === 'error' && frame.requestId === requestId,
        'cancel terminal response',
      );
      settle(settlement);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(wire.frames.filter(
        (frame) => frame.t === 'error' && frame.requestId === requestId,
      )).toHaveLength(1);
      expect(wire.frames.some(
        (frame) => frame.t === 'data_ready' && frame.requestId === requestId,
      )).toBe(false);
      socket.destroy();
    },
  );

  it('atomically reserves one raw data socket while peer validation is pending', async () => {
    let dataValidationCount = 0;
    let releaseValidation!: () => void;
    const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
    const fixture = await useFixture(await startBroker({
      validatePeerIdentity: async ({ kind }) => {
        if (kind === 'data') {
          dataValidationCount += 1;
          await validationGate;
        }
        return true;
      },
    }));
    const { socket, wire } = await openAuthenticatedRawControl(fixture);
    socket.write(encodeBrokerControlFrame({
      t: 'open_data',
      requestId: 'req-attach-race',
      endpointId: deriveWorkspaceSyncEndpointId('rel-attach-race', 'alpha'),
      expiresAtMs: Date.now() + OPEN_REMOTE_DEADLINE_MS,
    }));
    const ready = await wire.waitFor((frame) => frame.t === 'data_ready', 'data_ready');
    if (ready.t !== 'data_ready') throw new Error('unreachable');

    const endpoint = createWorkspaceSyncBrokerEndpoint({ endpointPath: ready.dataEndpoint });
    const first = endpoint.connect();
    const second = endpoint.connect();
    await Promise.all([once(first, 'connect'), once(second, 'connect')]);
    await waitFor(() => dataValidationCount >= 1, 'first data validation');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(dataValidationCount).toBe(1);
    await waitFor(() => first.destroyed || second.destroyed, 'duplicate raw data socket rejection');

    releaseValidation();
    socket.write(encodeBrokerControlFrame({
      t: 'attach_data', streamId: ready.streamId, attachNonce: ready.attachNonce,
    }));
    await wire.waitFor(
      (frame) => frame.t === 'data_ok' && frame.streamId === ready.streamId,
      'data_ok',
    );
    first.destroy();
    second.destroy();
    socket.destroy();
  });

  it('grants a fresh broker-owned attach window after a slow but successful external open', async () => {
    // Controlled clock: the remote carrier open consumes 10 of its 15
    // seconds and then succeeds. The sidecar must still receive a full
    // 30-second attach window counted from after the open, not the leftover
    // open budget.
    let nowMs = 1_000_000;
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const fixture = await useFixture(await startBroker({
      now: () => nowMs,
      openExternalStream: async () => {
        await openGate;
        nowMs += 10_000;
        return new PeerStream();
      },
    }));
    const { socket, wire } = await openAuthenticatedRawControl(fixture);
    const openStartedAtMs = nowMs;
    socket.write(encodeBrokerControlFrame({
      t: 'open_data',
      requestId: 'req-slow-open',
      endpointId: deriveWorkspaceSyncEndpointId('rel-slow-open', 'alpha'),
      expiresAtMs: openStartedAtMs + OPEN_REMOTE_DEADLINE_MS,
    }));
    releaseOpen();
    const ready = await wire.waitFor(
      (frame) => frame.t === 'data_ready' && frame.requestId === 'req-slow-open',
      'data_ready after the slow open',
    );
    if (ready.t !== 'data_ready') throw new Error('unreachable');
    expect(ready.expiresAtMs).toBe(nowMs + WORKSPACE_SYNC_BROKER_ATTACH_TTL_MS);

    // Attaching well past the original open deadline still succeeds.
    nowMs = openStartedAtMs + OPEN_REMOTE_DEADLINE_MS + 5_000;
    const data = createWorkspaceSyncBrokerEndpoint({ endpointPath: ready.dataEndpoint }).connect();
    await once(data, 'connect');
    socket.write(encodeBrokerControlFrame({
      t: 'attach_data', streamId: ready.streamId, attachNonce: ready.attachNonce,
    }));
    await wire.waitFor(
      (frame) => frame.t === 'data_ok' && frame.streamId === ready.streamId,
      'data_ok after the open deadline has elapsed',
    );
    data.destroy();
    socket.destroy();
  });

  it('derives the published and enforced attach expiry from one clock observation', async () => {
    let nowCalls = 0;
    const fixture = await useFixture(await startBroker({
      now: () => 1_000_000 + (nowCalls++ * 1_000),
    }));
    const { socket, wire } = await openAuthenticatedRawControl(fixture);
    socket.write(encodeBrokerControlFrame({
      t: 'open_data',
      requestId: 'req-one-attach-now',
      endpointId: deriveWorkspaceSyncEndpointId('rel-one-attach-now', 'alpha'),
      expiresAtMs: 1_000_000 + OPEN_REMOTE_DEADLINE_MS,
    }));
    const ready = await wire.waitFor((frame) => frame.t === 'data_ready', 'data_ready');
    if (ready.t !== 'data_ready') throw new Error('unreachable');

    expect(nowCalls).toBe(2);
    expect(ready.expiresAtMs).toBe(1_001_000 + WORKSPACE_SYNC_BROKER_ATTACH_TTL_MS);
    socket.destroy();
  });

  it('uses the protocol-owned attach deadline while the reserved data socket is being validated', async () => {
    let validationStarted = false;
    const fixture = await useFixture(await startBroker({
      validatePeerIdentity: async ({ kind }) => {
        if (kind === 'data') {
          validationStarted = true;
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        return true;
      },
    }));
    const { socket, wire } = await openAuthenticatedRawControl(fixture);
    const openSentAtMs = Date.now();
    socket.write(encodeBrokerControlFrame({
      t: 'open_data',
      requestId: 'req-attach-deadline',
      endpointId: deriveWorkspaceSyncEndpointId('rel-attach-deadline', 'alpha'),
      expiresAtMs: openSentAtMs + OPEN_REMOTE_DEADLINE_MS,
    }));
    const ready = await wire.waitFor((frame) => frame.t === 'data_ready', 'data_ready');
    if (ready.t !== 'data_ready') throw new Error('unreachable');
    // The attach deadline is broker-owned: the client-supplied open deadline
    // cannot shorten or extend it.
    expect(ready.expiresAtMs).toBeGreaterThanOrEqual(openSentAtMs + WORKSPACE_SYNC_BROKER_ATTACH_TTL_MS);

    const data = createWorkspaceSyncBrokerEndpoint({ endpointPath: ready.dataEndpoint }).connect();
    await once(data, 'connect');
    await waitFor(() => validationStarted, 'data validation');
    socket.write(encodeBrokerControlFrame({
      t: 'attach_data', streamId: ready.streamId, attachNonce: ready.attachNonce,
    }));
    await wire.waitFor(
      (frame) => frame.t === 'data_ok' && frame.streamId === ready.streamId,
      'data attachment',
    );
    socket.destroy();
  });

  it('creates private POSIX endpoints and delegates Windows listening to the secured native relay', async () => {
    const fixture = await useFixture(await startBroker());
    if (process.platform !== 'win32') {
      expect((await stat(fixture.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(fixture.socketPath)).mode & 0o777).toBe(0o600);
    }
    let relayConnection: ((socket: Socket, peerPid: number) => void) | undefined;
    const closeRelay = vi.fn(async () => {});
    const startWindowsRelay = vi.fn(async (input: Readonly<{
      pipeName: string;
      onConnection(socket: Socket, peerPid: number): void;
    }>) => {
      relayConnection = input.onConnection;
      return { close: closeRelay };
    });
    const windows = createWorkspaceSyncBrokerEndpoint({
      endpointPath: 'broker-id',
      platform: 'win32',
      startWindowsRelay,
    });
    expect(windows.kind).toBe('named_pipe');
    expect(windows.endpointPath).toMatch(/^\\\\\.\\pipe\\happier-workspace-sync-/u);

    const logicalServer = createServer();
    const accepted = new Promise<Socket>((resolve) => logicalServer.once('connection', resolve));
    await windows.listen(logicalServer);
    expect(startWindowsRelay).toHaveBeenCalledWith(expect.objectContaining({ pipeName: windows.endpointPath }));
    const relayedSocket = new Socket({ readable: false, writable: false });
    relayConnection?.(relayedSocket, 4242);
    await expect(accepted).resolves.toBe(relayedSocket);
    expect(windows.peerPid(relayedSocket)).toBe(4242);
    await windows.remove();
    expect(closeRelay).toHaveBeenCalledOnce();
  });

  it('admits one authenticated sidecar owner and applies peer identity checks to control and data sockets', async () => {
    const checked: Array<Readonly<{ kind: string; sidecarPid: number | undefined }>> = [];
    const fixture = await useFixture(await startBroker({
      validatePeerIdentity: async ({ kind, sidecarPid }) => {
        checked.push({ kind, sidecarPid });
        if (kind === 'data') await new Promise<void>((resolve) => setTimeout(resolve, 25));
        return true;
      },
    }));
    const owner = await connectClient(fixture);
    expect(fixture.broker.authenticatedSidecarPid).toBe(process.pid);
    await expect(connectClient(fixture)).rejects.toMatchObject({ code: 'unauthorized' });
    const stream = await owner.openStream(deriveWorkspaceSyncEndpointId('rel-peer', 'alpha'));
    expect(checked).toEqual([
      { kind: 'control', sidecarPid: process.pid },
      { kind: 'data', sidecarPid: process.pid },
    ]);
    await stream.close();
    await owner.close();
  });

  it('closes an external stream that resolves after its control owner disconnects', async () => {
    let resolveExternal!: (stream: PeerStream) => void;
    const fixture = await useFixture(await startBroker({
      openExternalStream: async () => await new Promise<PeerStream>((resolve) => { resolveExternal = resolve; }),
    }));
    const client = await connectClient(fixture);
    const opening = client.openStream(deriveWorkspaceSyncEndpointId('rel-race', 'alpha'));
    await waitFor(() => resolveExternal !== undefined, 'external open dispatch');
    await client.close();
    const external = new PeerStream();
    resolveExternal(external);
    await expect(opening).rejects.toMatchObject({ code: 'agent_unavailable' });
    await waitFor(() => external.destroyed, 'late external stream cleanup');
  });

  it('rejects a hello with the wrong launch secret and closes the connection', async () => {
    const fixture = await useFixture(await startBroker());
    const socket = await openRawControl(fixture.socketPath);
    const wire = rawCollector(socket);
    const hello = {
      t: 'hello',
      protocol: 1,
      brokerInstanceId: fixture.broker.brokerInstanceId,
      launchNonce: fixture.broker.launchNonce,
      sidecarPid: process.pid,
      proof: createBrokerHelloProof(randomBytes(32), { protocol: 1, brokerInstanceId: fixture.broker.brokerInstanceId, launchNonce: fixture.broker.launchNonce, sidecarPid: process.pid }),
    } as const;
    socket.write(encodeBrokerControlFrame(hello));
    const reply = await wire.waitFor((frame) => frame.t === 'error' || frame.t === 'hello_ok', 'auth reply');
    expect(reply).toMatchObject({ t: 'error', code: 'unauthorized' });
    await waitFor(() => socket.destroyed, 'socket close after unauthorized hello');
  });

  it('rejects a second hello on an authenticated connection with protocol_error', async () => {
    const fixture = await useFixture(await startBroker());
    const socket = await openRawControl(fixture.socketPath);
    const wire = rawCollector(socket);
    const hello = {
      t: 'hello',
      protocol: 1,
      brokerInstanceId: fixture.broker.brokerInstanceId,
      launchNonce: fixture.broker.launchNonce,
      sidecarPid: process.pid,
      proof: createBrokerHelloProof(fixture.secret, { protocol: 1, brokerInstanceId: fixture.broker.brokerInstanceId, launchNonce: fixture.broker.launchNonce, sidecarPid: process.pid }),
    } as const;
    socket.write(encodeBrokerControlFrame(hello));
    await wire.waitFor((frame) => frame.t === 'hello_ok', 'hello_ok');
    expect(fixture.broker.whenReady).toBeDefined();
    socket.write(encodeBrokerControlFrame(hello));
    const reply = await wire.waitFor((frame) => frame.t === 'error' && frame.code !== 'unauthorized', 'second hello reply');
    expect(reply).toMatchObject({ t: 'error', code: 'protocol_error' });
    socket.destroy();
  });

  it('accepts only one ATTACH_DATA per pending stream and rejects duplicates or stale attaches', async () => {
    const fixture = await useFixture(await startBroker());
    const socket = await openRawControl(fixture.socketPath);
    const wire = rawCollector(socket);
    const hello = {
      t: 'hello',
      protocol: 1,
      brokerInstanceId: fixture.broker.brokerInstanceId,
      launchNonce: fixture.broker.launchNonce,
      sidecarPid: process.pid,
      proof: createBrokerHelloProof(fixture.secret, { protocol: 1, brokerInstanceId: fixture.broker.brokerInstanceId, launchNonce: fixture.broker.launchNonce, sidecarPid: process.pid }),
    } as const;
    socket.write(encodeBrokerControlFrame(hello));
    await wire.waitFor((frame) => frame.t === 'hello_ok', 'hello_ok');

    socket.write(encodeBrokerControlFrame({ t: 'open_data', requestId: 'req-1', endpointId: deriveWorkspaceSyncEndpointId('rel-attach', 'alpha'), expiresAtMs: Date.now() + OPEN_REMOTE_DEADLINE_MS }));
    const ready = await wire.waitFor((frame) => frame.t === 'data_ready', 'data_ready');
    if (ready.t !== 'data_ready') throw new Error('unreachable');
    const endpoint = createWorkspaceSyncBrokerEndpoint({ endpointPath: ready.dataEndpoint });
    const data = await endpoint.connect(ready.dataEndpoint);
    await once(data, 'connect');
    await waitFor(() => fixture.externalStreams.length === 1, 'external stream open');

    socket.write(encodeBrokerControlFrame({ t: 'attach_data', streamId: ready.streamId, attachNonce: ready.attachNonce }));
    await wire.waitFor((frame) => frame.t === 'data_ok' && frame.streamId === ready.streamId, 'data_ok');

    // Duplicate attach for the same stream must fail closed without crashing.
    socket.write(encodeBrokerControlFrame({ t: 'attach_data', streamId: ready.streamId, attachNonce: ready.attachNonce }));
    const duplicate = await wire.waitFor((frame) => frame.t === 'error', 'duplicate attach reply');
    expect(duplicate).toMatchObject({ t: 'error', code: 'data_attach_failed' });

    // Wrong nonce on a live stream is rejected as well.
    socket.write(encodeBrokerControlFrame({ t: 'attach_data', streamId: ready.streamId, attachNonce: 'wrong-nonce' }));
    const wrongNonce = await wire.waitFor(
      (frame) => frame !== duplicate && frame.t === 'error' && frame.code === 'unauthorized',
      'wrong nonce reply',
    );
    expect(wrongNonce).toMatchObject({ t: 'error', code: 'unauthorized' });

    socket.destroy();
    data.destroy();
  });

  it('enforces the configured concurrent stream limit', async () => {
    const fixture = await useFixture(await startBroker({ maxStreams: 1 }));
    const client = await connectClient(fixture);
    const first = await client.openStream(deriveWorkspaceSyncEndpointId('rel-limit', 'alpha'));
    await expect(client.openStream(deriveWorkspaceSyncEndpointId('rel-limit', 'beta'))).rejects.toMatchObject({ code: 'stream_limit' });
    await first.close();
    const afterRelease = await client.openStream(deriveWorkspaceSyncEndpointId('rel-limit', 'beta'));
    await afterRelease.close();
    await client.close();
  });

  it('rejects expired open requests before opening any peer route', async () => {
    const fixture = await useFixture(await startBroker());
    const client = await connectClient(fixture);
    await expect(client.openStream(deriveWorkspaceSyncEndpointId('rel-expired', 'alpha'), { expiresAtMs: Date.now() - 1 })).rejects.toMatchObject({ code: 'expired_request' });
    expect(fixture.externalStreams).toHaveLength(0);
    await client.close();
  });

  it('forwards typed authorization failures from the endpoint mapping callback', async () => {
    const fixture = await useFixture(await startBroker({
      openExternalStream: async () => {
        throw new BrokerProtocolError('relationship_not_owned', 'unknown endpoint');
      },
    }));
    const client = await connectClient(fixture);
    await expect(client.openStream(deriveWorkspaceSyncEndpointId('rel-unknown', 'alpha'))).rejects.toMatchObject({ code: 'relationship_not_owned' });

    const fixture2 = await useFixture(await startBroker({
      openExternalStream: async () => {
        throw new BrokerProtocolError('root_mismatch', 'root changed');
      },
    }));
    const client2 = await connectClient(fixture2);
    await expect(client2.openStream(deriveWorkspaceSyncEndpointId('rel-root', 'alpha'))).rejects.toMatchObject({ code: 'root_mismatch' });
    await client.close();
    await client2.close();
  });

  it('relays bounded control commands to the authenticated sidecar and returns typed results', async () => {
    const fixture = await useFixture(await startBroker());
    const client = await connectClient(fixture);
    client.onCommand(async (command) => {
      if (command.t === 'get' && command.sessionIdentifier === 'mutagen-session-1') {
        return { sessionIdentifier: command.sessionIdentifier, state: 'watching' };
      }
      throw new BrokerProtocolError('relationship_not_owned', 'no such session');
    });

    await expect(fixture.broker.command({ t: 'get', requestId: 'cmd-1', sessionIdentifier: 'mutagen-session-1' })).resolves.toMatchObject({ sessionIdentifier: 'mutagen-session-1', state: 'watching' });
    await expect(fixture.broker.command({ t: 'get', requestId: 'cmd-2', sessionIdentifier: 'missing' })).rejects.toMatchObject({ code: 'relationship_not_owned' });

    // Cancellation before dispatch is definitive because the sidecar has not received anything.
    const preDispatchAbort = new AbortController();
    preDispatchAbort.abort();
    await expect(fixture.broker.command(
      { t: 'list', requestId: 'cmd-3', limit: 100 },
      { signal: preDispatchAbort.signal },
    )).rejects.toMatchObject({ code: 'cancelled' });

    // Cancellation after dispatch asks the sidecar to stop, but the Mutagen outcome is unknown.
    let commandDispatched = false;
    let cancellationDelivered = false;
    client.onCommand(async (_command, signal) => await new Promise<never>((_resolve, reject) => {
      commandDispatched = true;
      signal.addEventListener('abort', () => {
        cancellationDelivered = true;
        reject(new BrokerProtocolError('cancelled', 'command cancelled'));
      }, { once: true });
    }));
    const abort = new AbortController();
    const abortable = fixture.broker.command({ t: 'list', requestId: 'cmd-4', limit: 100 }, { signal: abort.signal });
    await waitFor(() => commandDispatched, 'sidecar command dispatch');
    abort.abort();
    await expect(abortable).rejects.toMatchObject({ code: 'indeterminate' });
    await waitFor(() => cancellationDelivered, 'sidecar command cancellation');

    // Commands before a sidecar authenticated fail closed.
    const fixture2 = await useFixture(await startBroker());
    await expect(fixture2.broker.command({ t: 'list', requestId: 'cmd-5', limit: 100 })).rejects.toMatchObject({ code: 'agent_unavailable' });

    await client.close();
  });

  it.each(['machine_carrier_unavailable', 'machine_carrier_route_mismatch', 'transport_identity_mismatch',
    'handshake_role_mismatch', 'grant_expired', 'proof_bad_signature'])(
    'preserves the carrier refusal code and reason over broker IPC (%s)', async code => {
      const failure = Object.assign(new Error('Carrier refused this authenticated route'), { code });
      const fixture = await useFixture(await startBroker({ openExternalStream: async () => { throw failure; } }));
      const client = await connectClient(fixture);
      try {
        await expect(client.openStream(deriveWorkspaceSyncEndpointId('carrier-operation', 'beta')))
          .rejects.toMatchObject({ code, message: failure.message });
      } finally { await client.close(); }
    },
  );

  it('recovers only the pending operation own refusal from the native .11 generic error', async () => {
    const fixture = await useFixture(await startBroker({ openExternalStream: async () => {
      throw Object.assign(new Error('Authenticated Iroh machine carrier is unavailable'), { code: 'machine_carrier_unavailable' });
    } }));
    const client = await connectClient(fixture);
    let refuse = true;
    let nativeCode: 'engine_unavailable' | 'git_selection_unavailable' = 'engine_unavailable';
    client.onCommand(async command => {
      if (command.t !== 'resume') throw new Error('Unexpected native command');
      if (refuse) {
        await client.openStream(deriveWorkspaceSyncEndpointId('carrier-operation', 'beta')).catch(() => undefined);
      }
      // broker_client.go at 0139d675 wraps the refusal as an ordinary Go
      // error; SendResult then returns this generic code at the OS boundary.
      throw new BrokerProtocolError(nativeCode, 'Native command failed');
    });
    try {
      await expect(fixture.broker.command({ t: 'resume', requestId: 'unrelated', sessionIdentifier: 'other-session' },
        { operationId: 'other-operation' })).rejects.toMatchObject({ code: 'engine_unavailable' });
      await expect(fixture.broker.command({ t: 'resume', requestId: 'matching', sessionIdentifier: 'session' },
        { operationId: 'carrier-operation' })).rejects.toMatchObject({ code: 'machine_carrier_unavailable',
        message: 'Authenticated Iroh machine carrier is unavailable' });
      nativeCode = 'git_selection_unavailable';
      await expect(fixture.broker.command({ t: 'resume', requestId: 'typed-native', sessionIdentifier: 'session' },
        { operationId: 'carrier-operation' })).rejects.toMatchObject({ code: 'git_selection_unavailable' });
      nativeCode = 'engine_unavailable';
      refuse = false;
      await expect(fixture.broker.command({ t: 'resume', requestId: 'retry', sessionIdentifier: 'session' },
        { operationId: 'carrier-operation' })).rejects.toMatchObject({ code: 'engine_unavailable' });
    } finally { await client.close(); }
  });

  it('joins native carrier opens to the pending command root across socket callbacks', async () => {
    vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
    const sink = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => undefined);
    const fixture = await useFixture(await startBroker());
    const client = await connectClient(fixture);
    const rootId = '23b2ed82-2ef7-4e4e-af0f-f64d599a08c6';
    client.onCommand(async () => {
      const carrier = await client.openStream(deriveWorkspaceSyncEndpointId('trace-operation', 'beta'));
      await carrier.close();
      return { flushed: true };
    });
    try {
      await expect(withWebLatencyTrace(rootId, () => fixture.broker.command({
        t: 'flush', requestId: 'trace-command', sessionIdentifier: 'trace-session',
      }, { operationId: 'trace-operation' }))).resolves.toEqual({ flushed: true });
      for (const phase of ['workspaceSync.broker.command.flush', 'workspaceSync.carrier.openExternalStream']) {
        expect(sink).toHaveBeenCalledWith('[web-latency]', expect.objectContaining({ phase, requestId: rootId, status: 'started' }));
        expect(sink).toHaveBeenCalledWith('[web-latency]', expect.objectContaining({ phase, requestId: rootId, status: 'completed' }));
      }
    } finally { await client.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); }
  });

  it('reports a dispatched command as indeterminate when the sidecar control connection drops', async () => {
    const fixture = await useFixture(await startBroker());
    const client = await connectClient(fixture);
    client.onCommand(async () => {
      await new Promise<void>(() => {});
    });
    const pending = fixture.broker.command({ t: 'flush', requestId: 'cmd-drop', sessionIdentifier: 'mutagen-session-1' });
    await waitFor(() => fixture.broker.hasInFlightCommands(), 'command dispatched to sidecar');
    await client.close();
    await expect(pending).rejects.toMatchObject({ code: 'indeterminate' });
  });

  it('does not impose a broker-wide deadline and leaves cancellation to the operation owner', async () => {
    const fixture = await useFixture(await startBroker());
    const client = await connectClient(fixture);
    let cancelled = false;
    client.onCommand(async (_command, signal) => await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        cancelled = true;
        reject(new BrokerProtocolError('cancelled', 'command cancelled'));
      }, { once: true });
    }));
    const abort = new AbortController();
    const command = fixture.broker.command(
      { t: 'list', requestId: 'cmd-timeout', limit: 100 },
      { signal: abort.signal, timeoutMs: 10 } as { signal: AbortSignal; timeoutMs: number },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(cancelled).toBe(false);
    abort.abort();
    await expect(command).rejects.toMatchObject({ code: 'indeterminate' });
    await waitFor(() => cancelled, 'sidecar command cancellation');
    await client.close();
  });

});
