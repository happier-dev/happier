import { once } from 'node:events';
import { createServer } from 'node:http';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_SECURITY_PATH_V1, ApprovalRequestSchema, accountSettingsParse, decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { refreshTerminalPresentUserPolicy } from '@/settings/accountSettings/resolveEffectiveTerminalPresentUserPolicy';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createDaemonExternalActionTargetResolver } from './externalActions/daemonExternalActionTargetResolver';
import { createDaemonControlApp } from './controlServer';
import { getSharedBlockingApprovalCoordinator } from '@/session/actions/approvals/blockingApprovalCoordinator';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

// Configuration is the environment boundary. Account policy, catalog and execution stay real.
vi.mock('@/configuration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return { ...actual, configuration: { ...actual.configuration, terminalPresentUserPolicy: 'allowed' as const } };
});

describe('signed root Action lifetime', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns the durable pool approval before a human decision instead of retaining the root request', async () => {
    let storedApproval: unknown;
    let poolRequested = false;
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
        response.end(JSON.stringify({ ...wire, headerVersion: 1, bodyVersion: 1 }));
        return;
      }
      poolRequested ||= request.url === '/v4/connect/qualified/groups';
      response.writeHead(404).end(JSON.stringify({ error: 'unexpected_request' }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const credentials = { token: 'boundary-token', encryption: null } as const;
    const serverHttpBaseUrl = `http://127.0.0.1:${address.port}`;
    const { executor } = createCliActionExecutorHarness({
      token: credentials.token, credentials, serverId: 'server-local', serverHttpBaseUrl,
      sessionId: '', mode: 'plain', ctx: null,
      actionsSettingsProvider: createActionSettingsProvider({
        scopeKey: 'root-pool-approval-boundary', accountSettings: accountSettingsParse({}),
      }),
    });
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine-local', controlToken: 'private-control-token',
      stopSession: async () => { throw new Error('Unexpected process stop'); },
      spawnSession: async () => { throw new Error('Unexpected process spawn'); },
      requestShutdown: () => { throw new Error('Unexpected process shutdown'); },
      onHappySessionWebhook: () => {},
      externalActionApi: {
        currentServerId: 'server-local', executor,
        verifyPat: async () => { throw new Error('Signed root does not use PAT verification'); },
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: serverHttpBaseUrl }),
      },
    });
    const coordinator = getSharedBlockingApprovalCoordinator();
    let approvalCreated!: (artifactId: string) => void;
    const created = new Promise<string>((resolve) => { approvalCreated = resolve; });
    const subscription = coordinator.subscribeApprovalChanges(({ artifactId, request }) => {
      if ('actionId' in request && request.actionId === 'connectedServices.pools.create') approvalCreated(artifactId);
    });
    const response = runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => await app.inject({ method: 'POST', url: '/actions/root/execute',
      headers: { 'x-happier-daemon-token': 'private-control-token' },
      payload: { actionId: 'connectedServices.pools.create', actionRequestId: 'pool-approval-request', input: {
        service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, group: { groupId: 'pool-approval' },
      } },
    }));
    let artifactId: string | undefined;
    try {
      artifactId = await Promise.race([created, response.then((reply) => {
        throw new Error(`Root request ended before approval persistence: ${JSON.stringify(reply.json())}`);
      })]);
      // Artifact acknowledgement has completed. Deferred response settlement is
      // microtask-only; a blocking decision waiter survives the next event-loop turn.
      const result = await Promise.race([response.then((reply) => reply.json()),
        new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending')))]);
      expect(result).toEqual({ ok: true, result: { kind: 'approval_request_created', artifactId,
        actionId: 'connectedServices.pools.create' } });
      expect(storedApproval).toMatchObject({ status: 'open', approval: { flow: 'deferred', result: 'required' },
        actionId: 'connectedServices.pools.create', requestedSurface: 'cli' });
      expect(poolRequested).toBe(false);
    } finally {
      if (artifactId) coordinator.cancelApproval(artifactId, 'test cleanup');
      subscription.dispose();
      await response;
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await app.close();
    }
  });

  it('cancels abandoned root pool requests and returns an uncertain result on the service deadline', async () => {
    let received!: () => void;
    let closed!: () => void;
    const accepted = new Promise<void>((resolve) => { received = resolve; });
    const cancelled = new Promise<void>((resolve) => { closed = resolve; });
    let releasePolicy!: () => void;
    let policyRequested!: () => void;
    const policyAccepted = new Promise<void>((resolve) => { policyRequested = resolve; });
    let upstreamPath: string | undefined;
    const upstream = createServer((request, response) => {
      if (request.url === ACCOUNT_SECURITY_PATH_V1) {
        releasePolicy = () => {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ v: 1, encryptionMode: 'plain', nativeEmail: null,
            password: { status: 'not_enrolled', revision: null }, terminalPresentUserPolicy: 'allowed' }));
        };
        policyRequested();
        return;
      }
      upstreamPath = request.url;
      request.resume();
      request.on('end', received);
      response.on('close', closed);
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const credentials = { token: 'boundary-token', encryption: null } as const;
    const serverHttpBaseUrl = `http://127.0.0.1:${address.port}`;
    const { executor } = createCliActionExecutorHarness({
      token: credentials.token, credentials, serverId: 'server-local', serverHttpBaseUrl,
      sessionId: '', mode: 'plain', ctx: null,
      actionsSettingsProvider: createActionSettingsProvider({ scopeKey: 'root-action-hang-boundary', accountSettings: accountSettingsParse({
        actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'connectedServices.pools.create': ['cli'] } },
      }) }),
    });
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine-local', controlToken: 'private-control-token',
      stopSession: async () => { throw new Error('Unexpected process stop'); },
      spawnSession: async () => { throw new Error('Unexpected process spawn'); },
      requestShutdown: () => { throw new Error('Unexpected process shutdown'); },
      onHappySessionWebhook: () => {},
      externalActionApi: {
        currentServerId: 'server-local', executor,
        terminalPolicyScope: { token: credentials.token, serverHttpBaseUrl },
        verifyPat: async () => { throw new Error('Signed root does not use the PAT network verifier'); },
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: serverHttpBaseUrl }),
      },
    });
    const controller = new AbortController();
    let rootRequested!: () => void;
    const rootAccepted = new Promise<void>((resolve) => { rootRequested = resolve; });
    app.addHook('onRequest', async (request) => {
      if (request.url === '/actions/root/execute') rootRequested();
    });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const rootAddress = app.server.address();
      if (!rootAddress || typeof rootAddress === 'string') throw new Error('Missing daemon address');
      const url = `http://127.0.0.1:${rootAddress.port}/actions/root/execute`;
      const headers = { 'x-happier-daemon-token': 'private-control-token' };
      const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
      const policyRefresh = refreshTerminalPresentUserPolicy({ token: credentials.token, serverHttpBaseUrl });
      await policyAccepted;
      const request = axios.post(url, { actionId: 'connectedServices.pools.create', input: { service, group: { groupId: 'pool-cancel' } } }, {
        signal: controller.signal, headers,
      });
      const outcome = request.catch((error: unknown) => error);
      await rootAccepted;
      expect((await app.inject({ method: 'POST', url: '/ping', payload: {}, headers })).statusCode).toBe(200);
      expect(upstreamPath).toBeUndefined();
      releasePolicy();
      expect(await policyRefresh).toBe('allowed');
      await Promise.race([accepted, outcome.then((value) => {
        const data = value && typeof value === 'object' && 'data' in value ? value.data : value;
        throw new Error(`Root request ended before pool HTTP: ${axios.isAxiosError(value) ? value.message : JSON.stringify(data)}`);
      })]);
      expect(upstreamPath).toBe('/v4/connect/qualified/groups');
      expect((await app.inject({ method: 'POST', url: '/ping', payload: {}, headers })).statusCode).toBe(200);
      controller.abort();
      expect(axios.isCancel(await outcome)).toBe(true);
      await cancelled;
      vi.stubEnv('HAPPIER_CONNECTED_SERVICES_API_TIMEOUT_MS', '1000');
      const timedOut = await axios.post(url, {
        actionId: 'connectedServices.pools.create', input: { service, group: { groupId: 'pool-timeout' } },
      }, { headers });
      expect(timedOut.data).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    } finally {
      controller.abort();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await app.close();
    }
  }, 4000);
});
