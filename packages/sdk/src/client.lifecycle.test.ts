import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { Server as NotificationServer } from 'socket.io';
import {
  createActionExecutor,
  ExternalActionRequestEnvelopeV1Schema,
  ExternalActionResponseEnvelopeV1Schema,
  projectSessionSpawnNewApiRequest,
  PublicActionIdSchema,
  type ActionExecutorDeps,
} from '@happier-dev/protocol/actions';
import { projectSessionSpawnNewActionInputV2, SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

import { connect } from './index.js';

const servers: Server[] = [];
const sockets = new Set<Socket>();
const notificationServers: NotificationServer[] = [];

afterEach(async () => {
  await Promise.all(notificationServers.map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))));
  notificationServers.length = 0;
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map(async (server) => await new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  servers.length = 0;
  sockets.clear();
});

describe('Happier SDK client lifecycle', () => {
  it('composes generated Session spawn tool policy through real HTTP and canonical Action ingress', async () => {
    const canonicalInput = SessionSpawnNewInputV2Schema.parse({
      creationKey: 'wil-sdk-spawn',
      executionTarget: { serverId: 'home', machineId: 'machine-1' },
      directory: { kind: 'managed' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      allowedTools: ['mcp__wilson-intake__*'],
      unlistedTools: 'deny',
      organizationPlacement: { folderId: 'intake', tagIds: ['mail'] },
    });
    const producedRequest = projectSessionSpawnNewApiRequest(projectSessionSpawnNewActionInputV2(canonicalInput));
    const admittedProcesses: Array<Parameters<ActionExecutorDeps['sessionSpawnNew']>[0]> = [];
    // Only the execution machine's process-start boundary is substituted. SDK
    // generation, surface binding, strict input/output and executor remain real.
    const processBoundary: Pick<ActionExecutorDeps, 'sessionSpawnNew'> = {
      sessionSpawnNew: async request => {
        admittedProcesses.push(request);
        return SessionSpawnNewResultV1Schema.parse({
          type: 'success', disposition: 'created', sessionId: 'wil-session',
          executionTarget: request.executionTarget,
          organizationPlacement: request.organizationPlacement ?? { folderId: null, tagIds: [] },
          initialInput: { status: 'notRequested' },
        });
      },
    };
    const executor = createActionExecutor(processBoundary as ActionExecutorDeps);
    let misbindRoute = false;
    const failures: unknown[] = [];
    const server = createServer(async (request, response) => {
      try {
        const bytes: Buffer[] = [];
        for await (const chunk of request) bytes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(Buffer.concat(bytes).toString('utf8')));
        const actionId = PublicActionIdSchema.parse(decodeURIComponent(request.url?.split('/').at(-1) ?? ''));
        const execution = await executor.execute(misbindRoute ? 'session.stop' : actionId, envelope.input, {
          surface: 'api', authority: 'present_user', serverId: 'home',
          externalActionTarget: envelope.target,
          actionRequestId: envelope.requestId,
        });
        const body = ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId,
          ...(envelope.requestId ? { requestId: envelope.requestId } : {}), execution });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      } catch (error) {
        failures.push(error);
        response.writeHead(500);
        response.end();
      }
    });
    servers.push(server);
    server.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test endpoint.');
    const client = connect({ endpoint: `http://127.0.0.1:${address.port}`,
      token: 'hap_v1_123e4567-e89b-42d3-a456-426614174000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    try {
      const method = client.machine(producedRequest.target.machineId).actions.session.spawnNew;
      await expect(method(producedRequest.input, { requestId: 'wil-spawn-valid' })).resolves.toMatchObject({
        type: 'success', sessionId: 'wil-session', executionTarget: { serverId: 'home', machineId: 'machine-1' },
        organizationPlacement: { sectionId: 'intake', tagIds: ['mail'] },
      });
      expect(admittedProcesses).toHaveLength(1);
      expect(admittedProcesses[0]).toMatchObject({
        creationKey: 'wil-sdk-spawn', actionRequestId: 'wil-spawn-valid',
        allowedTools: ['mcp__wilson-intake__*'], unlistedTools: 'deny',
        organizationPlacement: { folderId: 'intake', tagIds: ['mail'] },
      });
      // Mutate only the receiving route binding: the same generated method now
      // reaches a wrong real Action, so a wiring-blind test could not pass.
      misbindRoute = true;
      await expect(method(producedRequest.input, { requestId: 'wil-spawn-misbound' }))
        .rejects.toMatchObject({ name: 'HappierActionError', code: 'invalid_parameters' });
      expect(admittedProcesses).toHaveLength(1);
      misbindRoute = false;
      const attestedRequest = projectSessionSpawnNewApiRequest(projectSessionSpawnNewActionInputV2({ ...canonicalInput,
        attestedContext: { externalPrincipalId: 'salesperson@example.test', sourceMessageId: '<lead@example.test>' },
      }));
      await expect(method(attestedRequest.input, { requestId: 'wil-spawn-forged-attestation' }))
        .rejects.toMatchObject({ name: 'HappierActionError', code: 'session_attested_context_forbidden' });
      expect(admittedProcesses).toHaveLength(1);
      expect(failures).toEqual([]);
    } finally { await client.close(); }
  });

  it('releases its HTTP connection when the client is closed after a finite Action', async () => {
    let socketClosed = false;
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        v: 1,
        actionId: 'machines.list',
        execution: { ok: true, result: [] },
      }));
    });
    servers.push(server);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => {
        socketClosed = true;
        sockets.delete(socket);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test endpoint.');

    const client = connect({ endpoint: `http://127.0.0.1:${address.port}`, token: 'hap_v1_123e4567-e89b-42d3-a456-426614174000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    await expect(client.actions.execute('machines.list', {})).resolves.toEqual([]);

    await client.close();

    await expect.poll(() => socketClosed, { interval: 10, timeout: 1_000 }).toBe(true);
  });

  it('recovers after declared and streamed oversized responses on real sockets', async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.on('error', () => undefined);
      if (requestCount === 1) {
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': '24000001',
        });
        response.write('{');
        return;
      }
      if (requestCount === 2) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(Buffer.alloc(24_000_001, 0x20));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        v: 1,
        actionId: 'machines.list',
        execution: { ok: true, result: [] },
      }));
    });
    servers.push(server);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test endpoint.');

    const client = connect({
      endpoint: `http://127.0.0.1:${address.port}`,
      token: 'hap_v1_123e4567-e89b-42d3-a456-426614174000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    await expect(client.actions.execute('machines.list', {})).rejects.toMatchObject({
      code: 'response_too_large',
    });
    await expect(client.actions.execute('machines.list', {})).rejects.toMatchObject({
      code: 'response_too_large',
    });
    await expect(client.actions.execute('machines.list', {})).resolves.toEqual([]);

    await client.close();
    expect(requestCount).toBe(3);
  });

  it('bounds iterator return and close and releases real sockets when transcript cleanup never responds', async () => {
    let unfollowSeen = false;
    let socketClosed = false;
    const server = createServer(async (request, response) => {
      const bytes: Buffer[] = [];
      for await (const chunk of request) bytes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(Buffer.concat(bytes).toString('utf8')));
      const actionId = decodeURIComponent(request.url?.split('/').at(-1) ?? '');
      if (actionId === 'session.status.get') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          v: 1,
          actionId,
          ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
          execution: { ok: true, result: { session: {
            id: 'session-1', active: false, createdAt: 0, updatedAt: 0, activeAt: 0, encryption: null,
          } } },
        }));
        return;
      }
      if (actionId === 'transcript.follow') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          v: 1,
          actionId,
          ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
          execution: { ok: true, result: { items: [{ role: 'assistant' }], nextCursor: '1', truncated: false } },
        }));
        return;
      }
      if (actionId === 'transcript.unfollow') {
        unfollowSeen = true;
        return;
      }
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unexpected_action' }));
    });
    const notifications = new NotificationServer(server, { path: '/v1/updates/' });
    notificationServers.push(notifications);
    const handshakes: unknown[] = [];
    notifications.on('connection', (socket) => { handshakes.push(socket.handshake.auth); });
    servers.push(server);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => {
        socketClosed = true;
        sockets.delete(socket);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test endpoint.');

    const client = connect({ endpoint: `http://127.0.0.1:${address.port}`, token: 'hap_v1_123e4567-e89b-42d3-a456-426614174000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const iterator = client.sessions.get('session-1').followTranscript()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { role: 'assistant' } });
    expect(handshakes).toEqual([]);
    const returned = await Promise.race([
      iterator.return!().then(() => 'returned' as const),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 1_500)),
    ]);
    expect(returned).toBe('returned');
    expect(unfollowSeen).toBe(true);

    const close = client.close();
    try {
      const outcome = await Promise.race([
        close.then(() => 'closed' as const),
        new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 1_500)),
      ]);

      expect(unfollowSeen).toBe(true);
      expect(outcome).toBe('closed');
      await expect.poll(() => socketClosed, { interval: 10, timeout: 1_000 }).toBe(true);
      await expect.poll(() => sockets.size, { interval: 10, timeout: 1_000 }).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await close.catch(() => undefined);
    }
  });
});
