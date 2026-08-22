import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';

import { WebSocketServer } from 'ws';

import {
  createEphemeralTlsServerFixture,
} from '../testkit/tls/ephemeralTlsServerFixture.mjs';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeFrame(payload) {
  try {
    const text = Buffer.isBuffer(payload)
      ? payload.toString('utf8')
      : Array.isArray(payload)
        ? Buffer.concat(payload).toString('utf8')
        : Buffer.from(payload).toString('utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * C9's archive-local test endpoint. It is deliberately outside the product
 * HTTP stack: the packed fixture reaches it only through the host-vended
 * WebSocket capability granted to its one dynamic, archive-bound origin.
 */
export async function startPackedChannelProviderLoopback() {
  const tlsFixture = await createEphemeralTlsServerFixture();
  const observerSockets = new Set();
  const receivedFrameKinds = [];
  let server = null;
  let webSocketServer = null;
  let stopPromise = null;

  const stop = () => {
    stopPromise ??= (async () => {
      for (const socket of webSocketServer?.clients ?? []) socket.terminate();
      if (server?.listening) {
        await new Promise((resolveClosed, rejectClosed) => {
          server.close((error) => {
            if (error) rejectClosed(error);
            else resolveClosed();
          });
        });
      }
      await tlsFixture.cleanup();
    })().catch((error) => {
      stopPromise = null;
      throw error;
    });
    return stopPromise;
  };

  try {
    const [key, cert] = await Promise.all([
      readFile(tlsFixture.privateKeyPath),
      readFile(tlsFixture.leafCertificatePath),
    ]);
    server = createHttpsServer({ key, cert });
    webSocketServer = new WebSocketServer({
      server,
      path: '/socket',
      handleProtocols: (protocols) => (
        protocols.has('channels-fixture-v1')
          ? 'channels-fixture-v1'
          : false
      ),
    });
    webSocketServer.on('connection', (socket) => {
      let observer = false;
      socket.on('message', (payload) => {
        const frame = decodeFrame(payload);
        if (!isRecord(frame) || typeof frame.kind !== 'string') return;
        receivedFrameKinds.push(frame.kind);
        if (frame.kind === 'subscribe' && !observer) {
          observer = true;
          observerSockets.add(socket);
        }
      });
      socket.once('close', () => observerSockets.delete(socket));
    });
    await new Promise((resolveListen, rejectListen) => {
      const onError = (error) => {
        server.off('listening', onListening);
        rejectListen(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolveListen();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('packed_channel_provider_loopback_address_missing');
    }
    const origin = `https://127.0.0.1:${address.port}`;
    return Object.freeze({
      origin,
      socketUrl: `wss://127.0.0.1:${address.port}/socket`,
      pairingCode: randomUUID(),
      caCertificatePath: tlsFixture.caCertificatePath,
      observerSocketCount: () => observerSockets.size,
      receivedFrameKinds: () => [...receivedFrameKinds],
      sendObservation: () => {
        for (const socket of observerSockets) {
          socket.send(JSON.stringify({
            kind: 'observation',
            observation: {
              v: 1,
              providerMessageId: `fixture-message-${randomUUID()}`,
              endpoint: {
                kind: 'direct',
                audience: 'direct',
                id: 'fixture:room',
                label: 'Fixture room',
              },
              sender: {
                id: 'fixture:human',
                kind: 'human',
                label: 'Fixture human',
              },
              text: 'fixture loopback observation',
              observedAt: Date.now(),
            },
          }));
        }
      },
      sendHistoryGap: () => {
        for (const socket of observerSockets) {
          socket.send(JSON.stringify({ kind: 'historyGap' }));
        }
      },
      closeObserverSockets: () => {
        for (const socket of observerSockets) {
          socket.close(1000, 'fixture close');
        }
      },
      waitForObserverSocketCount: async (expected, context) => {
        const deadline = Date.now() + 20_000;
        while (observerSockets.size !== expected) {
          if (Date.now() >= deadline) {
            throw new Error(
              `packed_channel_provider_loopback_socket_count_timeout:${context}`,
            );
          }
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        }
      },
      stop,
    });
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}
