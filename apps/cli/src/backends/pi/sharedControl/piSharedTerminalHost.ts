import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';

import { createAgentLocalControlState } from '@/agent/localControl/createAgentLocalControlState';
import type { RunnerTerminationEvent } from '@/agent/runtime/runnerTerminationOutcome';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { buildPiBridgeExtensionSource } from '@/backends/pi/bridgeExtension/piBridgeExtensionSource';
import { attachPiRpcJsonlLineReader } from '@/backends/pi/rpc/attachPiRpcJsonlLineReader';
import {
  PiSharedTerminalSessionMismatchError,
  PiSharedTerminalUnavailableError,
  type PiRpcChannel,
  type PiRpcChannelClosure,
  type PiRpcChannelHost,
  type PiRpcChannelListener,
  type PiRpcChannelOpenOptions,
  type PiRpcChannelOpenSpec,
} from '@/backends/pi/rpc/piRpcChannel';
import { launchOwnedTerminalProcess, type OwnedTerminalProcess } from '@/terminal/runtime/ownedTerminalProcess';
import { prepareOwnedTerminalSpawn } from '@/terminal/runtime/terminalLaunchSpec';
import { logger } from '@/ui/logger';
import { materializeProtectedTempTextArtifact } from '@/utils/fs/protectedTempTextArtifact';

import {
  PI_SHARED_CONTROL_ADMISSION_FRAME,
  PI_SHARED_CONTROL_BRIDGE_UNAVAILABLE_ERROR,
  PI_SHARED_CONTROL_HELLO_MAX_BYTES,
  PI_SHARED_CONTROL_TOKEN_BYTES,
  PiSharedControlBridgeFrameSchema,
  PiSharedControlHelloSchema,
  type PiSharedControlConfig,
  type PiSharedControlHello,
  type PiSharedControlShutdownReason,
} from './piSharedControlProtocol';

/** The interactive Pi process: launched once into this terminal and owned by the runner. */
export type PiSharedTerminalProcess = Pick<OwnedTerminalProcess, 'whenExited' | 'terminate'>;

export type PiSharedTerminalSession = Pick<ApiSessionClient,
  'sendAgentMessage' | 'subscribeToSessionConnectionState' | 'updateAgentState'>;

export type PiSharedTerminalHost = Readonly<{
  /** Attached transport for `PiRpcBackend`: launches Pi on the first open, re-attaches afterwards. */
  channelHost: PiRpcChannelHost;
  /** Starts the loopback listener once; its endpoint and token go into the protected bridge config. */
  ensureListening: () => Promise<PiSharedControlConfig>;
  /**
   * Path of this launch's own bridge extension (a protected copy kept until Pi exits). The live
   * TUI re-reads its `--extension` path on `/reload`; the shared asset path can be rewritten by
   * another Happier version meanwhile, so the TUI never loads it.
   */
  ensureBridgeExtension: () => Promise<string>;
  /** Publishes this runner's local-control state to the current Happier session. */
  publishLocalControl: (session: PiSharedTerminalSession) => void;
  /** Stops the listener, ends the interactive Pi, and releases its launch artifacts. */
  dispose: () => Promise<void>;
}>;

type BridgeConnection = {
  readonly socket: Socket;
  readonly hello: PiSharedControlHello;
  bye: PiSharedControlShutdownReason | null;
  closed: boolean;
};

type AttachedChannelEvent =
  | Readonly<{ kind: 'out' | 'err'; line: string }>
  | Readonly<{ kind: 'closed'; closure: PiRpcChannelClosure }>;

type AttachedChannelBinding = Readonly<{
  connection: BridgeConnection;
  channel: PiRpcChannel;
  deliver: (event: AttachedChannelEvent) => void;
}>;

type HelloWaiter = Readonly<{
  /** Runs synchronously inside the hello's read, before any frame that followed it. */
  admit: (connection: BridgeConnection) => void;
  reject: (error: Error) => void;
}>;

const SESSION_FENCE_NOTICE =
  'The Pi terminal switched to a different session. Messages from Happier are paused for this session until the terminal returns to it.';

function digestToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function bridgeUnavailable(): PiSharedTerminalUnavailableError {
  return new PiSharedTerminalUnavailableError(PI_SHARED_CONTROL_BRIDGE_UNAVAILABLE_ERROR);
}

function attachCancelled(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Pi shared terminal attach was cancelled');
}

async function launchPiInThisTerminal(spec: PiRpcChannelOpenSpec): Promise<PiSharedTerminalProcess> {
  // Binary-safe owned launcher: managed JS runtime, inherited stdio, and a private IPC channel
  // that ends Pi if this runner dies.
  const prepared = await prepareOwnedTerminalSpawn({
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    env: spec.env,
  });
  return await launchOwnedTerminalProcess({ spawn: prepared, cwd: spec.cwd });
}

function createAttachedChannel(connection: BridgeConnection, onRelease: () => void): AttachedChannelBinding {
  let listener: PiRpcChannelListener | null = null;
  let released = false;
  const earlyEvents: AttachedChannelEvent[] = [];

  const deliver = (event: AttachedChannelEvent): void => {
    if (released) return;
    if (!listener) {
      earlyEvents.push(event);
      return;
    }
    if (event.kind === 'closed') {
      released = true;
      listener.onClosed(event.closure);
      return;
    }
    if (event.kind === 'out') listener.onStdoutLine(event.line);
    else listener.onStderrLine(event.line);
  };

  const channel: PiRpcChannel = {
    listen: (next) => {
      if (listener) throw new Error('Pi shared channel already has a listener');
      listener = next;
      for (const event of earlyEvents.splice(0)) deliver(event);
    },
    write: (line) => new Promise<void>((resolve, reject) => {
      if (released || connection.closed) {
        reject(bridgeUnavailable());
        return;
      }
      connection.socket.write(`${line}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
    // Detaching never touches Pi: the user's terminal session keeps running.
    close: async () => {
      if (released) return;
      released = true;
      onRelease();
    },
  };
  return { connection, channel, deliver };
}

export function createPiSharedTerminalHost(params: Readonly<{
  requestRunnerTermination: (event: RunnerTerminationEvent) => void;
  /** Process boundary; defaults to the owned-terminal launcher. */
  launch?: (spec: PiRpcChannelOpenSpec) => Promise<PiSharedTerminalProcess>;
}>): PiSharedTerminalHost {
  const launch = params.launch ?? launchPiInThisTerminal;
  let server: Server | null = null;
  let listening: Promise<PiSharedControlConfig> | null = null;
  let bridgeExtension: Promise<string> | null = null;
  let tokenDigest: Buffer | null = null;
  const sockets = new Set<Socket>();

  let launched = false;
  let launching: Promise<PiSharedTerminalProcess> | null = null;
  let pi: PiSharedTerminalProcess | null = null;
  // Held from launch until Pi exits: Pi's TUI owns the screen, so the runner prints nothing.
  let releaseConsole: (() => void) | null = null;
  let piExit: Readonly<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  const retainedArtifacts: Array<() => Promise<void>> = [];

  let connection: BridgeConnection | null = null;
  // True from launch until the first hello, and after a `bye` that announces a reconnect.
  let awaitingHello = false;
  const helloWaiters = new Set<HelloWaiter>();
  let attached: AttachedChannelBinding | null = null;
  let opening = false;
  // Backends to wake when the terminal is back on the bound session with nothing attached.
  const availabilityListeners = new Set<() => void>();

  let boundSession: NonNullable<PiRpcChannelOpenOptions['expectedSession']> | null = null;
  let fenced = false;
  let session: PiSharedTerminalSession | null = null;
  let unsubscribeConnectionState: (() => void) | null = null;
  let publication: {
    session: PiSharedTerminalSession;
    remoteWritable: boolean;
    inFlight: boolean;
    retryAfterFailure: boolean;
  } | null = null;

  let disposed = false;
  let disposePromise: Promise<void> | null = null;

  const isBoundSession = ({ sessionId, sessionFile }: PiSharedControlHello): boolean => (
    boundSession?.sessionId === sessionId
    && (boundSession.sessionFile === undefined || boundSession.sessionFile === sessionFile)
  );

  const publish = async (target: PiSharedTerminalSession, reconnecting = false): Promise<void> => {
    if (disposed || session !== target) return;
    const remoteWritable = !fenced;
    if (publication?.session === target && publication.remoteWritable === remoteWritable) {
      if (reconnecting && publication.inFlight) publication.retryAfterFailure = true;
      return;
    }
    const attempt = { session: target, remoteWritable, inFlight: true, retryAfterFailure: false };
    publication = attempt;
    try {
      await target.updateAgentState((state) => ({
        ...state,
        localControl: createAgentLocalControlState({
          attached: true,
          topology: 'shared',
          remoteWritable,
          canAttach: false,
          canDetach: false,
        }),
      }));
    } catch (error) {
      logger.infoFile('[pi] Shared terminal local-control publication failed', serializeAxiosErrorForLog(error));
      if (publication === attempt) {
        publication = null;
        if (attempt.retryAfterFailure) void publish(target);
      }
    } finally {
      attempt.inFlight = false;
    }
  };

  const updateFence = (next: boolean): void => {
    if (next !== fenced) {
      fenced = next;
      logger.infoFile(`[pi] Shared terminal ${fenced ? 'left' : 'returned to'} the bound Pi session`);
      if (fenced) session?.sendAgentMessage('pi', { type: 'message', message: SESSION_FENCE_NOTICE });
    }
    // A rebind can retry a failed publication even when the fence itself is unchanged.
    if (session) void publish(session);
  };

  const rejectHelloWaiters = (error: Error): void => {
    for (const waiter of [...helloWaiters]) waiter.reject(error);
  };

  // Serialized so disposal also waits for a release that Pi's exit already started.
  let artifactRelease: Promise<void> = Promise.resolve();
  const releaseArtifacts = (): Promise<void> => {
    const cleanups = retainedArtifacts.splice(0);
    artifactRelease = artifactRelease.then(async () => {
      const results = await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
      if (results.some((result) => result.status === 'rejected')) {
        logger.infoFile('[pi] Shared terminal launch artifact cleanup incomplete');
      }
    });
    return artifactRelease;
  };

  const closureFor = (closed: BridgeConnection, superseded: boolean): PiRpcChannelClosure => {
    if (piExit) return { kind: 'exited', code: piExit.code, signal: piExit.signal };
    if (superseded) return { kind: 'detached', reattachable: true };
    if (closed.bye) return { kind: 'detached', reattachable: closed.bye !== 'quit' };
    return { kind: 'failed', error: bridgeUnavailable() };
  };

  const handleConnectionClosed = (closed: BridgeConnection): void => {
    if (closed.closed) return;
    closed.closed = true;
    const superseded = connection !== closed;
    if (!superseded) {
      awaitingHello = !piExit && !disposed && closed.bye !== null && closed.bye !== 'quit';
      if (!awaitingHello) rejectHelloWaiters(bridgeUnavailable());
    }
    logger.infoFile('[pi] Shared terminal bridge disconnected', { bye: closed.bye, superseded });
    const binding = attached;
    if (binding?.connection !== closed) return;
    attached = null;
    binding.deliver({ kind: 'closed', closure: closureFor(closed, superseded) });
  };

  const handleFrame = (from: BridgeConnection, line: string): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      logger.debug('[pi] Ignored a malformed shared terminal frame');
      return;
    }
    const frame = PiSharedControlBridgeFrameSchema.safeParse(raw);
    if (!frame.success) {
      logger.debug('[pi] Ignored an unknown shared terminal frame');
      return;
    }
    if (!('ch' in frame.data)) {
      from.bye = frame.data.reason;
      return;
    }
    // No backend attached (between a reload and its re-attach): there is no replay by design.
    if (attached?.connection !== from) return;
    attached.deliver({ kind: frame.data.ch, line: frame.data.line });
  };

  const readAuthenticatedHello = (line: string): PiSharedControlHello | null => {
    if (!tokenDigest || Buffer.byteLength(line, 'utf8') > PI_SHARED_CONTROL_HELLO_MAX_BYTES) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return null;
    }
    const hello = PiSharedControlHelloSchema.safeParse(raw);
    if (!hello.success) return null;
    return timingSafeEqual(digestToken(hello.data.token), tokenDigest) ? hello.data : null;
  };

  const admit = (next: BridgeConnection): void => {
    const previous = connection;
    connection = next;
    awaitingHello = false;
    // A reconnecting bridge can say hello before its predecessor's close is observed.
    if (previous && !previous.closed) previous.socket.destroy();
    // Pi preserves the header ID when importing a session into a separate file.
    if (!boundSession || isBoundSession(next.hello)) {
      boundSession = { sessionId: next.hello.sessionId, sessionFile: next.hello.sessionFile };
    }
    const onBoundSession = isBoundSession(next.hello);
    // Leaving fences at once; returning lifts the fence only when a backend binds again (bindChannel).
    if (onBoundSession) {
      next.socket.write(`${JSON.stringify({ type: PI_SHARED_CONTROL_ADMISSION_FRAME })}\n`);
    } else {
      updateFence(true);
    }
    logger.infoFile('[pi] Shared terminal bridge connected');
    const backendWaiting = helloWaiters.size > 0 || opening || attached !== null;
    for (const waiter of [...helloWaiters]) waiter.admit(next);
    // The terminal came back after the backend gave up on a foreign session: nothing re-attaches
    // on its own, so terminal turns would go unmirrored while the web shows the session writable.
    if (onBoundSession && !backendWaiting) {
      for (const listener of [...availabilityListeners]) listener();
    }
  };

  const handleSocket = (socket: Socket): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    if (disposed) {
      socket.destroy();
      return;
    }
    let authenticated: BridgeConnection | null = null;
    let refused = false;
    let preAuthBytes = 0;
    const refuse = (reason: string): void => {
      if (refused) return;
      refused = true;
      logger.infoFile(`[pi] Refused a shared terminal connection (${reason})`);
      socket.destroy();
    };
    attachPiRpcJsonlLineReader(socket, (line) => {
      if (refused || disposed) return;
      if (authenticated) {
        handleFrame(authenticated, line);
        return;
      }
      const hello = readAuthenticatedHello(line);
      if (!hello) {
        refuse('invalid hello');
        return;
      }
      if (!launched) {
        refuse('terminal was not launched');
        return;
      }
      authenticated = { socket, hello, bye: null, closed: false };
      admit(authenticated);
    });
    // Registered after the line reader so a chunk carrying the hello plus frames is not counted
    // as pre-auth bytes once the hello authenticated.
    socket.on('data', (chunk: Buffer) => {
      if (authenticated || refused) return;
      preAuthBytes += chunk.length;
      if (preAuthBytes > PI_SHARED_CONTROL_HELLO_MAX_BYTES) refuse('oversized hello');
    });
    socket.on('close', () => {
      if (authenticated) handleConnectionClosed(authenticated);
    });
  };

  const ensureListening = (): Promise<PiSharedControlConfig> => {
    listening ??= new Promise<PiSharedControlConfig>((resolve, reject) => {
      if (disposed) {
        reject(bridgeUnavailable());
        return;
      }
      const token = randomBytes(PI_SHARED_CONTROL_TOKEN_BYTES).toString('base64url');
      tokenDigest = digestToken(token);
      const created = createServer(handleSocket);
      server = created;
      created.once('error', reject);
      created.listen(0, '127.0.0.1', () => {
        created.off('error', reject);
        created.on('error', (error) => logger.infoFile('[pi] Shared terminal listener error', error));
        const address = created.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Pi shared terminal listener has no TCP address'));
          return;
        }
        resolve({ host: '127.0.0.1', port: address.port, token });
      });
    });
    return listening;
  };

  const ensureBridgeExtension = (): Promise<string> => {
    bridgeExtension ??= (async () => {
      if (disposed) throw bridgeUnavailable();
      const artifact = await materializeProtectedTempTextArtifact({
        prefix: 'happier-pi-shared-bridge-',
        filename: 'happier-pi-tools-bridge.mjs',
        contents: buildPiBridgeExtensionSource(),
      });
      if (disposed) {
        await artifact.cleanup();
        throw bridgeUnavailable();
      }
      retainedArtifacts.push(artifact.cleanup);
      return artifact.path;
    })();
    return bridgeExtension;
  };

  const onPiExited = (exit: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>): void => {
    if (piExit) return;
    piExit = exit;
    awaitingHello = false;
    rejectHelloWaiters(bridgeUnavailable());
    logger.infoFile('[pi] Shared terminal Pi exited', { code: exit.code, signal: exit.signal });
    releaseConsole?.();
    connection?.socket.destroy();
    void releaseArtifacts();
    // The runner's own disposal ended Pi; only an exit Pi chose ends the runner.
    if (!disposed) params.requestRunnerTermination({ kind: 'exit', code: exit.code ?? 1 });
  };

  const bindChannel = (live: BridgeConnection): PiRpcChannel => {
    // A bridge can send frames in the same read as hello, before the backend can query its state.
    if (!isBoundSession(live.hello)) {
      throw new PiSharedTerminalSessionMismatchError('The Pi terminal is on another session');
    }
    const binding = createAttachedChannel(live, () => {
      if (attached === binding) attached = null;
    });
    attached = binding;
    updateFence(false);
    return binding.channel;
  };

  // Binds at hello time: the bridge flushes buffered frames right behind its hello, often in the
  // same read, and those must reach this channel rather than be dropped as unattached.
  const waitForHello = (signal: AbortSignal | undefined): Promise<PiRpcChannel> => (
    new Promise<PiRpcChannel>((resolve, reject) => {
      const settle = (): void => {
        helloWaiters.delete(waiter);
        signal?.removeEventListener('abort', onAbort);
      };
      const waiter: HelloWaiter = {
        admit: (next) => {
          settle();
          try {
            resolve(bindChannel(next));
          } catch (error) {
            reject(error);
          }
        },
        reject: (error) => { settle(); reject(error); },
      };
      const onAbort = (): void => {
        if (signal) waiter.reject(attachCancelled(signal));
      };
      helloWaiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    })
  );

  const channelHost: PiRpcChannelHost = {
    kind: 'attached',
    open: async (spec, options) => {
      if (disposed) {
        // Nothing will launch with these artifacts. Leave a pending Pi's files to disposal.
        await options?.retainArtifacts?.();
        throw bridgeUnavailable();
      }
      let unusedCleanup = options?.retainArtifacts;
      if (attached || opening) {
        await unusedCleanup?.();
        throw new Error('Pi shared terminal already has an attached backend');
      }
      opening = true;
      try {
        if (!launched) {
          await ensureListening();
          if (disposed) throw bridgeUnavailable();
          if (options?.signal?.aborted) throw attachCancelled(options.signal);
          // Pi re-reads its launch files on /reload, so retain only files it actually launches with.
          if (unusedCleanup) retainedArtifacts.push(unusedCleanup);
          unusedCleanup = undefined;
          boundSession = options?.expectedSession ?? null;
          launched = true;
          awaitingHello = true;
          const ready = connection && !connection.closed
            ? Promise.resolve(bindChannel(connection))
            : waitForHello(options?.signal);
          // Hello can settle while launch is still pending. Observe rejection immediately.
          void ready.catch(() => undefined);
          releaseConsole = logger.muteConsole('the Pi terminal');
          try {
            launching = launch(spec);
            pi = await launching;
          } catch (error) {
            // Pi never took the terminal; the failed session start ends the runner with this error.
            releaseConsole();
            piExit = { code: null, signal: null };
            awaitingHello = false;
            rejectHelloWaiters(bridgeUnavailable());
            connection?.socket.destroy();
            throw error;
          } finally {
            launching = null;
          }
          pi.whenExited.then(
            (exit) => onPiExited({ code: exit.code, signal: exit.signal }),
            () => onPiExited({ code: null, signal: null }),
          );
          if (disposed) throw bridgeUnavailable();
          return await ready;
        }
        if (connection && !connection.closed) return bindChannel(connection);
        if (!awaitingHello || piExit) throw bridgeUnavailable();
        return await waitForHello(options?.signal);
      } finally {
        opening = false;
        try {
          await unusedCleanup?.();
        } catch (error) {
          logger.infoFile('[pi] Shared terminal unused launch artifact cleanup incomplete', error);
        }
      }
    },
    onSessionAvailable: (listener) => {
      availabilityListeners.add(listener);
      return () => { availabilityListeners.delete(listener); };
    },
  };

  return {
    channelHost,
    ensureListening,
    ensureBridgeExtension,
    publishLocalControl: (target) => {
      if (disposed) return;
      if (session !== target) {
        unsubscribeConnectionState?.();
        session = target;
        unsubscribeConnectionState = target.subscribeToSessionConnectionState((state) => {
          if (state.phase === 'online') void publish(target, true);
        });
      }
      void publish(target);
    },
    dispose: () => {
      disposePromise ??= (async () => {
        disposed = true;
        unsubscribeConnectionState?.();
        unsubscribeConnectionState = null;
        awaitingHello = false;
        rejectHelloWaiters(bridgeUnavailable());
        for (const socket of sockets) socket.destroy();
        const closing = (async () => {
          // Let a pending listen settle before closing, including a failed bind.
          await listening?.catch(() => undefined);
          const listener = server;
          if (listener) await new Promise<void>((resolve) => listener.close(() => resolve()));
        })();
        const process = pi ?? await launching?.catch(() => null);
        if (process && !piExit) {
          try {
            await process.terminate();
          } catch (error) {
            logger.infoFile('[pi] Shared terminal Pi could not be terminated', error);
          }
        }
        await bridgeExtension?.catch(() => undefined);
        await releaseArtifacts();
        await closing;
      })();
      return disposePromise;
    },
  };
}
