import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';

import rawAxios from 'axios';
import { expect, it } from 'vitest';

import axios from '@/api/client/credentialAxios';
import { createDeferred } from '@/testkit/async/deferred';
import { installAxiosProxySupport } from '@/utils/proxy/axiosProxy';

import { readHostedSessionScope, type HostedSessionScope } from './hostedSessionScope';
import { bindHostedSessionStop, endSessionCommand, requestHostedSessionTermination } from './runnerTerminationHandlers';
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

it('releases its Stop handler even when an async resource keeps the ended Session scope alive', async () => {
  const processEvents = new EventEmitter();
  const retainedScope = createDeferred<HostedSessionScope>();
  let stops = 0;
  const host = await startSessionHost({
    readTrustedCaller: async () => null,
    process: processEvents,
    exit: () => undefined,
    runSessionCommand: async () => {
      const scope = readHostedSessionScope();
      if (!scope) throw new Error('Expected a hosted Session scope');
      bindHostedSessionStop(async () => { stops += 1; });
      retainedScope.resolve(scope);
      endSessionCommand(0);
    },
  });
  try {
    await expect(host.addSession({ trackingKey: 'ended', argv: ['ended'], env: {}, cwd: process.cwd() }))
      .resolves.toEqual({ exitCode: 0 });
    expect(requestHostedSessionTermination(await retainedScope.promise, { kind: 'signal', signal: 'SIGTERM' })).toBe(false);
    expect(stops).toBe(0);
  } finally {
    processEvents.emit('SIGTERM');
    await host.whenEnded;
  }
});
