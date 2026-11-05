import { expect, it } from 'vitest';
import fastify from 'fastify';
import { Server, type Socket } from 'socket.io';
import { FeaturesResponseSchema, MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createTargetActionApprovalDecision } from '@happier-dev/protocol/actions/targetActionApprovalDecision';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCliApprovalsArtifactStore } from './artifactStore';
import { createCredentialedTargetActionCurrentIntent } from './credentialedTargetActionCurrentIntent';

it.each(['unchanged', 'changed-input'] as const)('resumes the original CLI target approval through its published origin (%s)', async mode => {
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'alice', session: 'terminal', tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  const credentials = { token, encryption: null, credentialProvenance: 'stored_session' } as const;
  const app = fastify();
  const sockets = new Server(app.server, { path: '/v1/updates' });
  const registrations = new Map<string, Socket>();
  const calls: string[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  let created!: (id: string) => void;
  const published = new Promise<string>(resolve => { created = resolve; });
  const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_tunnel' } } });
  app.get('/v1/features', async () => features);
  app.get('/v1/features/authenticated', async () => features);
  app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
  app.get('/v1/account/profile', async () => ({ id: 'alice' }));
  app.get('/v1/machines/context-machine', async () => ({ machine: { id: 'context-machine', active: true,
    kind: 'persistent', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null } }));
  app.get<{ Params: { id: string } }>('/v1/artifacts/:id', async (request, reply) => rows.get(request.params.id) ?? reply.code(404).send());
  app.post<{ Body: { id: string; header: string; body: string; dataEncryptionKey: string } }>('/v1/artifacts', async request => {
    const row = { ...request.body, ownerAccountId: 'alice', access: 'owner', encryptionMode: 'plain',
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    rows.set(row.id, row);
    created(row.id);
    return row;
  });
  app.post<{ Params: { id: string }; Body: { header: string; body: string; expectedHeaderVersion: number;
    expectedBodyVersion: number } }>('/v1/artifacts/:id', async request => {
    const previous = rows.get(request.params.id)!;
    expect(request.body.expectedHeaderVersion).toBe(previous.headerVersion);
    expect(request.body.expectedBodyVersion).toBe(previous.bodyVersion);
    const row = { ...previous, header: request.body.header, body: request.body.body,
      headerVersion: request.body.expectedHeaderVersion + 1, bodyVersion: request.body.expectedBodyVersion + 1 };
    rows.set(request.params.id, row);
    return { success: true, headerVersion: row.headerVersion, bodyVersion: row.bodyVersion };
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing Home fixture address');
  const serverUrl = `http://127.0.0.1:${address.port}`;
  const store = createCliApprovalsArtifactStore({ credentials, serverId: 'original-cli', serverHttpBaseUrl: serverUrl });
  // This Home boundary models a different daemon process: that daemon does not
  // possess the original CLI's live operands or authenticated decision waiter.
  const daemonDecision = createTargetActionApprovalDecision({
    read: artifactId => store.targetActionApprovalsGet({ artifactId }),
    update: args => store.targetActionApprovalsUpdate(args), hasLiveInvocation: () => false,
  });
  sockets.on('connection', socket => {
    expect(socket.handshake.auth.token).toBe(token);
    socket.on(SOCKET_RPC_EVENTS.REGISTER, (packet: { method: string }) => {
      registrations.set(packet.method, socket);
      socket.emit(SOCKET_RPC_EVENTS.REGISTERED, packet);
    });
    socket.on('disconnect', () => { for (const [method, owner] of registrations) if (owner === socket) registrations.delete(method); });
    socket.on(SOCKET_RPC_EVENTS.UNREGISTER, (packet: { method: string }) => registrations.delete(packet.method));
    socket.on(SOCKET_RPC_EVENTS.CALL, async (packet, ack) => {
      calls.push(packet.method);
      const owner = registrations.get(packet.method);
      if (owner?.connected) {
        const unavailable = () => ack({ ok: false, error: 'method_not_found' });
        owner.once('disconnect', unavailable);
        owner.emit(SOCKET_RPC_EVENTS.REQUEST, { ...packet, callerAuthority: 'present_user' }, (result: unknown) => {
          owner.off('disconnect', unavailable);
          ack({ ok: true, result });
        });
      }
      else if (packet.method !== 'context-machine:approval.request.decide') ack({ ok: false, error: 'method_not_found' });
      else ack({ ok: true, result: await runWithServerHttpBaseUrl(serverUrl, () => daemonDecision({
        artifactId: packet.params.artifactId, decision: 'approve', context: { surface: 'cli', authority: 'present_user', runtimeAccountId: 'alice' },
      })) });
    });
  });
  const lifetime = new AbortController();
  let effects = 0;
  const pending = runWithServerHttpBaseUrl(serverUrl, async () => {
    const admitted = await createCredentialedTargetActionCurrentIntent(credentials)({
      action: { qualifiedId: 'acme.tunnel/actions/configure', pluginId: 'acme.tunnel', localId: 'configure', occurrenceId: 'tunnel',
        sourceCustody: { kind: 'development', registeredRootId: 'tunnel-root' }, dangerLevel: 'writesRemote', scopes: ['global'],
        surfaces: ['cli'], hostAccess: [], input: { hostname: 'qa.example.test', service: 'http://127.0.0.1:37597' },
        policyFingerprint: 'a'.repeat(64), confirmation: { title: 'Prepare this tunnel?' } },
      fingerprint: 'b'.repeat(64), surface: 'cli', approvalInputCustody: 'live_only', signal: lifetime.signal,
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
        serverId: 'original-cli', serverIdentityId: 'srv_tunnel', machineId: 'context-machine',
        target: { kind: 'machine', machineId: 'context-machine' }, actionId: 'action.invoke', requestId: 'original-tunnel-invocation' },
    });
    if (admitted.status === 'approved' && admitted.settleExecution) {
      effects++;
      await admitted.settleExecution({ artifactId: admitted.artifactId!, execution: { ok: true, effectAttempted: true } });
    }
    return admitted;
  });
  void pending.catch(() => undefined);
  try {
    const artifactId = await Promise.race([published, pending.then(result => { throw new Error(`Original invocation ended before publication: ${JSON.stringify(result)}`); })]);
    const standalone = createCliActionExecutorFromCredentials({ credentials, serverId: 'deciding-cli', serverApiUrl: serverUrl,
      actionsSettingsProvider: createActionSettingsProvider() });
    if (mode === 'changed-input') {
      const request = await runWithServerHttpBaseUrl(serverUrl, () => store.targetActionApprovalsGet({ artifactId }));
      if (!request) throw new Error('Missing original approval');
      // Keep the Home boundary's replacement body/header consistent through
      // the same producer codecs; only the live waiter's subject has changed.
      const changed = { ...request, input: { hostname: 'different.example.test', service: 'http://127.0.0.1:37597' } };
      const row = rows.get(artifactId)!;
      rows.set(artifactId, { ...row,
        header: encodePlainArtifactStoredContent(buildTargetActionApprovalArtifactHeaderV1(changed)),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(changed) }) });
    }
    const decided = await runWithServerHttpBaseUrl(serverUrl, () => standalone.execute('approval.request.decide',
      { artifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user', runtimeAccountId: 'alice' }));
    if (mode === 'changed-input') {
      expect(decided, JSON.stringify(decided)).toMatchObject({ ok: false, errorCode: 'approval_context_unavailable' });
      expect(await runWithServerHttpBaseUrl(serverUrl, () => store.targetActionApprovalsGet({ artifactId })))
        .toMatchObject({ status: 'open' });
      expect(effects).toBe(0);
    } else {
      expect(decided, JSON.stringify({ decided, calls })).toMatchObject({ ok: true });
      expect(await pending).toMatchObject({ status: 'approved' });
      expect(await runWithServerHttpBaseUrl(serverUrl, () => store.targetActionApprovalsGet({ artifactId }))).toMatchObject({ status: 'executed', execution: { ok: true } });
      expect(effects).toBe(1);
      expect(await runWithServerHttpBaseUrl(serverUrl, () => standalone.execute('approval.request.decide',
        { artifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user', runtimeAccountId: 'alice' })))
        .toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(effects).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(/^approval-origin\..+:approval\.origin\.decide$/);
    }
  } finally {
    lifetime.abort();
    await pending.catch(() => undefined);
    getSharedBlockingApprovalCoordinator().dispose();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await app.close();
  }
});
