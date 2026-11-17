import { createServer, type Server, type Socket } from 'node:net';
import { clearTimeout, setTimeout } from 'node:timers';
import type { WorkspaceSyncOwnedLocalAgent } from './workspaceSyncController';
import { createFirstBytesLocalCapability, matchesFirstBytesLocalCapability, readFirstBytesLocalCapability } from '@/daemon/peer/mediation/loopback/firstBytesLocalCapability';

export type WorkspaceSyncMachineIngress = Readonly<{
  port: number;
  /** One-use local listener capability consumed before any rooted-agent bytes. */
  localCapability: string;
  close(): Promise<void>;
}>;

function ingressError(code: string, message: string, workspaceSyncIngressRefusal?: 'authority_closing' | 'agent_aborted'): Error {
  return Object.assign(new Error(message), { code, ...(workspaceSyncIngressRefusal ? { workspaceSyncIngressRefusal } : {}) });
}

function closeListeningServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

/** The existing one-use carrier listener accepts an admitted local or provider process stream. */
export async function openWorkspaceSyncMachineIngress(
  request: Readonly<{ signal?: AbortSignal; expiresAtMs?: number }>,
  input: Readonly<{
    openAgent(signal: AbortSignal): Promise<WorkspaceSyncOwnedLocalAgent>;
    /** Authority-local custody hooks; the carrier adapter needs only openAgent. */
    assertCurrent?(): void;
    isClosing?(): boolean;
    retain?(close: () => Promise<void>): () => void;
  }>,
): Promise<WorkspaceSyncMachineIngress> {
    request.signal?.throwIfAborted();
    if (input.isClosing?.()) {
      throw ingressError('peer_unavailable', 'Workspace sync target authority is shutting down', 'authority_closing');
    }
    input.assertCurrent?.();
    const agentAbort = new AbortController();
    let openerPromise: Promise<WorkspaceSyncOwnedLocalAgent> | null = null;
    let closeIngress: (() => Promise<void>) | null = null;
    let agentStopPromise: Promise<void> | null = null;
    let ingressSettlementPromise: Promise<void> | null = null;
    let activeCloser!: () => Promise<void>;
    let releaseRetention: (() => void) | undefined;
    const stopOpenedAgent = (agent: WorkspaceSyncOwnedLocalAgent): Promise<void> => {
      if (agentStopPromise) return agentStopPromise;
      agentStopPromise = (async () => {
        agent.stream.destroy();
        await agent.stop();
        releaseRetention?.();
      })().catch((error: unknown) => {
        agentStopPromise = null;
        throw error;
      });
      return agentStopPromise;
    };
    activeCloser = (): Promise<void> => {
      if (ingressSettlementPromise) return ingressSettlementPromise;
      ingressSettlementPromise = (async () => {
        agentAbort.abort();
        const pendingOpener = openerPromise;
        if (!pendingOpener) return;
        let openedAgent: WorkspaceSyncOwnedLocalAgent;
        try {
          openedAgent = await pendingOpener;
        } catch {
          request.signal?.removeEventListener('abort', abortFromCaller);
          releaseRetention?.();
          return;
        }
        request.signal?.removeEventListener('abort', abortFromCaller);
        if (closeIngress) await closeIngress();
        else await stopOpenedAgent(openedAgent);
      })().catch((error: unknown) => {
        ingressSettlementPromise = null;
        throw error;
      });
      return ingressSettlementPromise;
    };
    releaseRetention = input.retain?.(activeCloser);
    // Event-driven cleanup (caller abort, peer socket or rooted-agent stream
    // end) consumes its own close rejection: a rooted agent that fails to
    // stop must not surface as an unhandled rejection in the daemon process.
    // Custody stays with `close`, which resets itself on failure so
    // `activeCloser` and the returned explicit closer can retry it.
    const scheduleClose = () => { void activeCloser().catch(() => undefined); };
    const abortFromCaller = () => {
      agentAbort.abort(request.signal?.reason);
      scheduleClose();
    };
    request.signal?.addEventListener('abort', abortFromCaller, { once: true });
    openerPromise = Promise.resolve().then(() => input.openAgent(agentAbort.signal));
    const agent = await openerPromise.catch((error) => {
      request.signal?.removeEventListener('abort', abortFromCaller);
      releaseRetention?.();
      throw error;
    });
    const closeLateAgent = async (): Promise<void> => {
      agentAbort.abort();
      request.signal?.removeEventListener('abort', abortFromCaller);
      await stopOpenedAgent(agent);
    };
    closeIngress = closeLateAgent;
    if (agentAbort.signal.aborted) {
      await activeCloser();
      throw ingressError('peer_unavailable', 'Workspace sync machine ingress ended before the rooted agent was ready', 'agent_aborted');
    }
    if (input.isClosing?.()) {
      await activeCloser();
      throw ingressError('peer_unavailable', 'Workspace sync target authority is shutting down', 'authority_closing');
    }
    try { input.assertCurrent?.(); } catch (error) { await activeCloser(); throw error; }
    const server = createServer({ allowHalfOpen: true });
    const localCapability = createFirstBytesLocalCapability();
    const expectedLocalCapability = Buffer.from(localCapability, 'ascii');
    let accepted: Socket | null = null;
    const pendingCapabilitySockets = new Set<Socket>();
    let closed = false;
    let closePromise: Promise<void> | null = null;
    let attachExpiryTimer: NodeJS.Timeout | null = null;
    const close = (): Promise<void> => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        if (!closed) {
          closed = true;
          if (attachExpiryTimer) clearTimeout(attachExpiryTimer);
          attachExpiryTimer = null;
          request.signal?.removeEventListener('abort', abortFromCaller);
          agentAbort.abort();
          for (const socket of pendingCapabilitySockets) socket.destroy();
          pendingCapabilitySockets.clear();
          accepted?.destroy();
          agent.stream.destroy();
          await closeListeningServer(server);
        }
        await stopOpenedAgent(agent);
      })().catch((error: unknown) => {
        closePromise = null;
        throw error;
      });
      return closePromise;
    };
    closeIngress = close;
    server.on('connection', (socket) => {
      if (closed || accepted || socket.remoteAddress !== '127.0.0.1') {
        socket.destroy();
        return;
      }
      pendingCapabilitySockets.add(socket);
      socket.once('close', () => pendingCapabilitySockets.delete(socket));
      void (async () => {
        let supplied: Buffer;
        try {
          supplied = await readFirstBytesLocalCapability(socket);
        } catch {
          socket.destroy();
          scheduleClose();
          return;
        }
        if (
          closed
          || accepted
          || !matchesFirstBytesLocalCapability(supplied, expectedLocalCapability)
        ) {
          socket.destroy();
          scheduleClose();
          return;
        }
        accepted = socket;
        if (attachExpiryTimer) clearTimeout(attachExpiryTimer);
        attachExpiryTimer = null;
        pendingCapabilitySockets.delete(socket);
        void closeListeningServer(server);
        socket.setNoDelay(true);
        socket.pipe(agent.stream, { end: false });
        agent.stream.pipe(socket, { end: false });
        socket.once('end', () => agent.stream.end());
        agent.stream.once('end', () => { if (!socket.destroyed) socket.end(); });
        socket.once('error', scheduleClose);
        socket.once('close', scheduleClose);
        agent.stream.once('error', scheduleClose);
        agent.stream.once('close', scheduleClose);
        socket.resume();
      })();
    });
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
          server.off('error', rejectListen);
          resolveListen();
        });
      });
    } catch (error) {
      await close();
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === 'string' || !Number.isSafeInteger(address.port) || address.port < 1) {
      await close();
      throw ingressError('agent_unavailable', 'Workspace sync loopback ingress did not bind a port');
    }
    if (request.signal?.aborted) {
      await close();
      request.signal.throwIfAborted();
    }
    try { input.assertCurrent?.(); } catch (error) { await close(); throw error; }
    if (input.isClosing?.()) {
      await close();
      throw ingressError('peer_unavailable', 'Workspace sync target authority is shutting down', 'authority_closing');
    }
    if (request.expiresAtMs !== undefined) {
      const scheduleExpiry: (callback: () => void, delayMs: number) => NodeJS.Timeout = setTimeout;
      attachExpiryTimer = scheduleExpiry(
        scheduleClose,
        Math.max(1, request.expiresAtMs - Date.now()),
      );
      attachExpiryTimer.unref();
    }
    return Object.freeze({ port: address.port, localCapability, close });
}
