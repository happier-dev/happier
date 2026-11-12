import fastify from 'fastify';
import { Server, type Socket } from 'socket.io';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema, decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { createExternalMcpServer } from '@/mcp/createExternalMcpServer';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import * as controlHttp from '@/daemon/controlHttp';
import { registerAccountHomeHttp, registerPlainArtifactRoutes } from '../widgetApproval.testkit';

afterEach(() => { vi.restoreAllMocks(); getSharedBlockingApprovalCoordinator().dispose(); });

it('resumes private clipboard input in its original MCP process with unchanged Machine and Session context', async () => {
  const accountId = 'mcp-owner';
  const machineId = 'mcp-machine';
  const sessionId = 'mcp-session';
  const homeId = 'srv_mcp_live';
  const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: accountId, session: 'terminal', tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`,
    encryption: null, credentialProvenance: 'stored_session' as const };
  const app = fastify();
  const sockets = new Server(app.server, { path: '/v1/updates' });
  const registrations = new Map<string, Socket>();
  const features = registerAccountHomeHttp(app, { accountId, serverId: homeId });
  const artifacts = registerPlainArtifactRoutes(app, accountId);
  app.get('/v1/features', async () => features);
  app.get('/v1/features/authenticated', async () => features);
  app.get('/v1/machines/:id', async () => ({ machine: { id: machineId, kind: 'persistent', active: true,
    installationId: 'mcp-installation', revokedAt: null, replacedByMachineId: null,
    access: { custodian: { accountId, displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } } }));
  let createdArtifactId = '';
  app.addHook('preHandler', async request => {
    if (request.method === 'POST' && request.url === '/v1/artifacts' && request.body
      && typeof request.body === 'object' && 'id' in request.body && typeof request.body.id === 'string') {
      createdArtifactId = request.body.id;
    }
  });
  sockets.on('connection', socket => {
    expect(socket.handshake.auth.token).toBe(credentials.token);
    socket.on(SOCKET_RPC_EVENTS.REGISTER, (packet: { method: string }) => {
      registrations.set(packet.method, socket);
      socket.emit(SOCKET_RPC_EVENTS.REGISTERED, packet);
    });
    socket.on(SOCKET_RPC_EVENTS.UNREGISTER, (packet: { method: string }) => registrations.delete(packet.method));
    socket.on('disconnect', () => { for (const [method, owner] of registrations) if (owner === socket) registrations.delete(method); });
    socket.on(SOCKET_RPC_EVENTS.CALL, (packet, ack) => {
      const owner = registrations.get(packet.method);
      if (!owner?.connected) return ack({ ok: false, error: 'method_not_found' });
      owner.emit(SOCKET_RPC_EVENTS.REQUEST, { ...packet, callerAuthority: 'present_user' },
        (result: unknown) => ack({ ok: true, result }));
    });
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing Home address');
  const endpoint = `http://127.0.0.1:${address.port}`;
  // The remote daemon has no private operands from this MCP process. This is
  // its observed #43 refusal; only transport is substituted, not replay logic.
  vi.spyOn(machineRpc, 'callExactMachineRpc').mockResolvedValue({ ok: false,
    errorCode: 'approval_origin_unavailable', error: 'approval_origin_unavailable', details: { reason: 'live_invocation_unavailable' } });
  const effects: unknown[] = [];
  vi.spyOn(controlHttp, 'daemonPost').mockImplementation(async (_path, body) => {
    effects.push(body);
    return { result: { ok: true } };
  });
  const { mcp } = runWithServerHttpBaseUrl(endpoint, () => createExternalMcpServer({ credentials,
    machineId, defaultSessionId: sessionId, daemonControlTarget: null,
    serverFeaturesSnapshot: { status: 'ready', provenance: 'authenticated', features } }));
  const client = new Client({ name: 'mcp-private-input', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  const lifetime = new AbortController();
  const pending = client.callTool({ name: 'action_execute', arguments: { actionId: 'computer.clipboard.write',
    input: { machineId, text: 'COMPUTER-FIX-1107-canary' } },
    _meta: { 'happier/action-request-id': 'COMPUTER-FIX-1107-mcp-private-input' } }, undefined, { signal: lifetime.signal });
  void pending.catch(() => undefined);
  const readRequest = () => {
    const stored = decodePlainArtifactStoredContent(artifacts.read(createdArtifactId)!.body);
    if (!stored || typeof stored !== 'object' || !('body' in stored) || typeof stored.body !== 'string') throw new Error('Missing approval');
    return ApprovalRequestV2Schema.parse(JSON.parse(stored.body));
  };
  try {
    await vi.waitFor(() => {
      expect(createdArtifactId).not.toBe('');
      expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount(createdArtifactId)).toBe(1);
    });
    expect(readRequest()).toMatchObject({ status: 'open', actionArgs: {}, executionOriginV1: {
      surface: 'mcp', authority: 'account_automation', sessionId, target: { kind: 'machine', machineId } } });
    expect(readRequest().actionArgs).not.toHaveProperty('text');
    expect(effects).toEqual([]);
    const decider = createCliActionExecutorFromCredentials({ credentials,
      serverId: readRequest().executionOriginV1.serverId, serverApiUrl: endpoint,
      serverIdentityId: homeId, externalActionClient: true });
    const decided = await runWithServerHttpBaseUrl(endpoint, () => decider.execute('approval.request.decide',
      { artifactId: createdArtifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user', runtimeAccountId: accountId }));
    expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'approved' } });
    const response = CallToolResultSchema.parse(await pending);
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(effects).toEqual([{ actionId: 'computer.clipboard.write',
      input: { machineId, text: 'COMPUTER-FIX-1107-canary' }, sessionId, approvalAdmitted: true }]);
    expect(readRequest()).toMatchObject({ status: 'executed', execution: { ok: true } });
  } finally {
    lifetime.abort();
    await pending.catch(() => undefined);
    await client.close(); await mcp.close();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await app.close();
  }
});
