import { once } from 'node:events';
import { createServer } from 'node:http';
import { Server as SocketIoServer } from 'socket.io';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalRequestSchema, accountSettingsParse, decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createDaemonExternalActionTargetResolver } from './externalActions/daemonExternalActionTargetResolver';
import { createDaemonControlApp } from './controlServer';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

// Host configuration is the environment boundary; admission and policy stay real.
vi.mock('@/configuration', async importOriginal => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return { ...actual, configuration: { ...actual.configuration, terminalPresentUserPolicy: 'allowed' as const } };
});

afterEach(() => vi.unstubAllEnvs());

it('returns a deferred live-result approval from the daemon root endpoint', async () => {
    const actionId = 'connectedServices.authentication.beginConnect';
    let storedApproval: unknown;
    let storedArtifact: Readonly<Record<string, unknown>> | undefined;
    const upstream = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/account/encryption') {
        response.end(JSON.stringify({ mode: 'plain', updatedAt: 0 }));
        return;
      }
      if (request.url === '/v1/artifacts' && request.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const wire = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const content = decodePlainArtifactStoredContent(wire.body);
        if (!content || typeof content !== 'object' || !('body' in content) || typeof content.body !== 'string') {
          response.writeHead(400).end();
          return;
        }
        storedApproval = ApprovalRequestSchema.parse(JSON.parse(content.body));
        storedArtifact = { ...wire, headerVersion: 1, bodyVersion: 1, seq: 1,
          createdAt: 1, updatedAt: 1, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain', publicAudience: null };
        response.end(JSON.stringify(storedArtifact));
        return;
      }
      if (request.method === 'GET' && request.url === `/v1/artifacts/${storedArtifact?.id}`) {
        response.end(JSON.stringify(storedArtifact));
        return;
      }
      response.writeHead(404).end(JSON.stringify({ error: 'unexpected_request' }));
    });
    // Home socket I/O is the boundary; registration and the live approval owner remain real.
    const sockets = new SocketIoServer(upstream, { path: '/v1/updates/' });
    sockets.on('connection', socket => {
      socket.on(SOCKET_RPC_EVENTS.REGISTER, ({ method }: { method: string }) => {
        socket.emit(SOCKET_RPC_EVENTS.REGISTERED, { method });
      });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', provenance: {
      v: 1, kind: 'account', authority: 'present_user',
    } })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null } as const;
    const serverHttpBaseUrl = `http://127.0.0.1:${address.port}`;
    const { executor } = createCliActionExecutorHarness({
      token: credentials.token, credentials, serverId: 'server-local', serverIdentityId: 'srv_home', serverHttpBaseUrl,
      sessionId: '', mode: 'plain', ctx: null,
      actionsSettingsProvider: createActionSettingsProvider({
        scopeKey: 'root-deferred-live-result', accountSettings: accountSettingsParse({ actionsSettingsV1: { v: 1,
          actions: { 'connectedServices.authentication.beginConnect': { approvalRequiredSurfaces: ['cli'] } },
        } }),
      }),
    });
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine-local', controlToken: 'private-control-token',
      stopSession: async () => { throw new Error('Unexpected process stop'); },
      spawnSession: async () => { throw new Error('Unexpected process spawn'); },
      requestShutdown: () => { throw new Error('Unexpected process shutdown'); },
      onHappySessionWebhook: () => {},
      externalActionApi: {
        currentServerId: 'server-local', currentAccountId: 'account', executor,
        verifyPat: async () => { throw new Error('Signed root does not use PAT verification'); },
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: serverHttpBaseUrl }),
      },
    });
    const coordinator = getSharedBlockingApprovalCoordinator();
    let approvalCreated!: (artifactId: string) => void;
    const created = new Promise<string>((resolve) => { approvalCreated = resolve; });
    const subscription = coordinator.subscribeApprovalChanges(({ artifactId, request }) => {
      if ('actionId' in request && request.actionId === actionId) {
        approvalCreated(artifactId);
      }
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const rootAddress = app.server.address();
    if (!rootAddress || typeof rootAddress === 'string') throw new Error('Missing daemon address');
    const controller = new AbortController();
    const response = runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
      const reply = await axios.post(`http://127.0.0.1:${rootAddress.port}/actions/root/execute`, { actionId, actionRequestId: 'pool-approval-request', input: { machineId: 'machine-local', service: { pluginId: 'happier.channel.email', localId: 'email-imap-smtp' }, modeId: 'password' } }, { signal: controller.signal, headers: { 'x-happier-daemon-token': 'private-control-token' } });
      return { json: () => reply.data };
    });
    let artifactId: string | undefined;
    try {
      artifactId = await Promise.race([created, response.then((reply) => {
        throw new Error(`Root request ended before approval persistence: ${JSON.stringify(reply.json())}`);
      })]);
      expect((await response).json()).toEqual({ ok: true, result: { kind: 'approval_request_created', artifactId, actionId } });
      expect(storedApproval).toMatchObject({ status: 'open', approval: {
        flow: 'deferred', result: 'required' },
        actionId, requestedSurface: 'cli' });
    } finally {
      if (artifactId) coordinator.cancelApproval(artifactId, 'test cleanup');
      subscription.dispose();
      await response;
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      upstream.closeAllConnections();
      if (upstream.listening) await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await app.close();
    }
  });
