import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';

import rawAxios from 'axios';
import { expect, it } from 'vitest';

import axios from '@/api/client/credentialAxios';
import { createDeferred } from '@/testkit/async/deferred';
import { installAxiosProxySupport } from '@/utils/proxy/axiosProxy';

import { endSessionCommand } from './runnerTerminationHandlers';
import { startSessionHost } from './sessionHost';

it('reuses HTTP connections within a Session and closes only its connections at Session end', async () => {
  installAxiosProxySupport({ axios: rawAxios, env: { NODE_ENV: 'test' } });
  const requests = new Map<string, Socket>();
  const closed = new Set<Socket>();
  const pendingStarted = createDeferred();
  const finishPending = createDeferred();
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    requests.set(path, request.socket);
    if (path === '/a/pending') {
      pendingStarted.resolve();
      void finishPending.promise.then(() => response.end('ok'));
    } else response.end('ok');
  });
  server.on('connection', socket => socket.once('close', () => closed.add(socket)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  const origin = `http://127.0.0.1:${address.port}`;
  const processEvents = new EventEmitter();
  const aReady = createDeferred();
  const bReady = createDeferred();
  const endA = createDeferred();
  const resumeB = createDeferred();
  const pendingCompleted = createDeferred<unknown>();
  const retireA = createDeferred();
  const spareReady = createDeferred();
  const host = await startSessionHost({
    readTrustedCaller: async () => null,
    process: processEvents,
    exit: () => undefined,
    runSessionCommand: async ([name]) => {
      if (name === 'a') {
        await axios.get(origin + '/a/first');
        await axios.get(origin + '/a/second');
        aReady.resolve();
        await endA.promise;
        const response = axios.get(origin + '/a/pending').then(value => value.data, (error: unknown) => error);
        await pendingStarted.promise;
        await axios.get(origin + '/a/spare');
        spareReady.resolve();
        await retireA.promise;
        endSessionCommand(0);
        pendingCompleted.resolve(await response);
      } else {
        await axios.get(origin + '/b/first');
        bReady.resolve();
        await resumeB.promise;
        await axios.get(origin + '/b/second');
      }
    },
  });
  const add = (name: string) => host.addSession({ trackingKey: name, argv: [name], env: {}, cwd: process.cwd() });
  const a = add('a');
  try {
    await aReady.promise;
    const b = add('b');
    await bReady.promise;
    const aSocket = requests.get('/a/first');
    const bSocket = requests.get('/b/first');
    expect(aSocket).toBe(requests.get('/a/second'));
    // Equal URL and transport options would otherwise reuse the first Session's idle socket.
    expect(bSocket).not.toBe(aSocket);
    endA.resolve();
    await spareReady.promise;
    const spare = requests.get('/a/spare')!;
    const spareClosed = once(spare, 'close');
    const requestClosed = once(aSocket!, 'close');
    retireA.resolve();
    await expect(a).resolves.toEqual({ exitCode: 0 });
    await spareClosed;
    expect(requests.get('/a/pending')).toBe(aSocket);
    expect(closed.has(aSocket!)).toBe(false);
    finishPending.resolve();
    await expect(pendingCompleted.promise).resolves.toBe('ok');
    await requestClosed;
    expect(closed.has(bSocket!)).toBe(false);
    resumeB.resolve();
    await expect(b).resolves.toEqual({ exitCode: 0 });
    expect(requests.get('/b/second')).toBe(bSocket);
  } finally {
    endA.resolve();
    finishPending.resolve();
    retireA.resolve();
    resumeB.resolve();
    server.closeAllConnections();
    server.close();
    processEvents.emit('SIGTERM');
    await host.whenEnded;
  }
});
