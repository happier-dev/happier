import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

const home = vi.hoisted(() => {
  const directory = `${process.env.TMPDIR ?? '/tmp'}/happier-client-scope-${process.pid}-${Date.now()}`;
  process.env.HAPPIER_HOME_DIR = directory;
  return directory;
});
import { startSessionHost } from '@/agent/runtime/lifecycle/sessionHost';
import { createDeferred } from '@/testkit/async/deferred';
import { readDaemonState, writeDaemonState } from '@/persistence';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY, serializeConnectedServiceChildSelectionValues } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { ConnectedServiceTurnLifecycleRequestBodySchema, connectedServiceTurnLifecycleContinue } from '@/daemon/connectedServices/connectedServiceTurnLifecycleContract';
import { UpdateSchema } from '@/api/types';
import { ApiSessionClient } from './sessionClient';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

afterEach(() => vi.unstubAllEnvs());
afterAll(() => rm(home, { recursive: true, force: true }));

it('notifies the daemon with each added Session selection after a live Home message on a shared host', async () => {
  const requests: unknown[] = [];
  const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { session: {
    pendingInput: { protocolVersion: 1 }, runtimeActivity: { protocolVersion: 2 }, publisherAuthority: { protocolVersion: 1 },
  } } });
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/connected-service-turn-lifecycle') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(ConnectedServiceTurnLifecycleRequestBodySchema.parse(JSON.parse(Buffer.concat(chunks).toString())));
      response.end(JSON.stringify({ ok: true, result: connectedServiceTurnLifecycleContinue({ status: 'ignored_missing_exact_turn', activeTurnId: null }) }));
    } else {
      response.end(JSON.stringify(request.url?.startsWith('/v1/features') ? features : {}));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP endpoint');
  const snapshot = await fetchServerFeaturesSnapshot({ serverUrl: `http://127.0.0.1:${address.port}`, token: 'synthetic-owner-token' });
  expect(snapshot.status).toBe('ready');
  writeDaemonState({ pid: process.pid, httpPort: address.port, startedAt: Date.now(), startedWithCliVersion: 'test', controlToken: 'synthetic-daemon-token' });
  expect((await readDaemonState())?.httpPort).toBe(address.port);
  vi.stubEnv(HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY, '');
  const selections = ['profile-a', 'profile-b'].map(profileId => serializeConnectedServiceChildSelectionValues([
    { kind: 'profile', serviceId: 'happier.agent.codex/openai-codex', profileId },
  ])!);
  const clients: ApiSessionClient[] = [];
  const sockets: { sessionId: string; socket: ReturnType<typeof createApiSessionSocketStub> }[] = [];
  const bothAdded = createDeferred<void>();
  let added = 0;
  const hostProcess = new EventEmitter();
  const errors: unknown[] = [];
  const host = await startSessionHost({ process: hostProcess, exit: () => {}, readTrustedCallerPid: async () => process.pid,
    runSessionCommand: async argv => {
      try {
        const sessionId = argv[0]!;
        const socket = createApiSessionSocketStub({ connected: false });
        const client = new ApiSessionClient('synthetic-owner-token', createPlainSessionFixture({ id: sessionId }), {
          getServerFeaturesSnapshot: () => snapshot,
          metadataAuthority: { kind: 'shared_editor' }, durableMutationDeliveryInitiallyActive: false,
          transport: { serverId: 'fixture-home', serverUrl: `http://127.0.0.1:${address.port}`,
            createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
        });
        clients.push(client);
        sockets.push({ sessionId, socket });
        const userMessages: unknown[] = [];
        client.on('user-message', message => userMessages.push(message));
        expect(client.getServerIdentityId()).toBe(null);
        if (++added === 2) bothAdded.resolve();
        await bothAdded.promise;
        await vi.waitFor(() => expect(userMessages).toHaveLength(1));
        await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 10_000 });
      } catch (error) { errors.push(error); throw error; }
    },
  });
  try {
    const addedSessions = Promise.all(selections.map((selection, index) => host.addSession({ trackingKey: `session-${index}`,
      argv: [`session-${index}`, '--started-by', 'daemon'], cwd: home,
      env: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: selection },
    })));
    await bothAdded.promise;
    // Network events run outside either Session's async context. The client retains its owner environment.
    for (const { sessionId, socket } of sockets) {
        await vi.waitFor(() => expect(socket.getHandler('update')).toBeTypeOf('function'));
        socket.trigger('update', UpdateSchema.parse({ id: `update-${sessionId}`, seq: 1, createdAt: 1000,
          body: { t: 'new-message', delivery: 'full', sid: sessionId,
            message: { id: `message-${sessionId}`, seq: 1, localId: `input-${sessionId}`, createdAt: 1000, updatedAt: 1000,
              content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Continue' }, localId: `input-${sessionId}` } } } },
        }));
    }
    expect(await addedSessions).toEqual([{ exitCode: 0 }, { exitCode: 0 }]);
    expect(errors).toEqual([]);
    expect(requests).toEqual(expect.arrayContaining(selections.map((selection, index) => ({
      sessionId: `session-${index}`, event: 'prompt_or_steer', connectedServiceSelectionsEnvRaw: selection,
    }))));
  } finally {
    await Promise.all(clients.map(client => client.close()));
    hostProcess.emit('SIGTERM');
    await host.whenEnded;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
