import fastify from 'fastify';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { expect, it, vi } from 'vitest';
import type { StoredCredentials } from '@/persistence';
import type { PendingQueueWriteBody } from '@/api/session/pendingQueueV2Transport';
import { openSessionMessageContent } from '@/session/transport/encryption/sessionEncryptionContext';
import type { ApiMachineClient } from '@/api/apiMachine';
import { createApiMachineTransportFixture } from '@/testkit/apiMachineTransport';
import { createSessionRecordFixture, createSessionNotificationContextFixture, createCompactSessionListRowFixture, createSessionReadBatchResponseFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';
import { readOrCreateInstallationIdentitySync } from '../identity/store';
import { bootstrapMachineSyncRuntime, retireMachineSyncRuntimeAttempt, type BootstrapMachineSyncRuntimeParams } from './bootstrapMachineSyncRuntime';

it.each(['plain', 'e2ee'] as const)('tells the child once for an observed attach, detach and offline manager change (%s)', async mode => {
  await withConfiguredDaemonTestHome({ prefix: 'manager-notice-' }, async ({ homeDir }) => {
    const machineId = 'child-machine';
    const serverId = 'child-home';
    const accountId = 'child-account';
    const sessionId = 'c111111111111111111111111';
    const first = 'c222222222222222222222222';
    const second = 'c333333333333333333333333';
    const secret = new Uint8Array(32).fill(17);
    const credentials: StoredCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.fixture`, encryption: mode === 'plain' ? null : { type: 'legacy', secret } };
    const installationId = readOrCreateInstallationIdentitySync().installationId;
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: mode,
      ...(mode === 'plain' ? { storedContentMode: mode } : { storedContentMode: mode, encryptionKey: secret, encryptionVariant: 'legacy' }),
      metadata: { path: homeDir, host: 'host', machineId }, agentState: null });
    const child = { ...createSessionNotificationContextFixture(sessionId), ...createSessionRecordFixture({ id: sessionId, ownerAccountId: accountId, encryptionMode: mode,
      metadataLayoutVersion: 1, metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata,
      dataEncryptionKey: null, active: true, archivedAt: null, manager: undefined }) };
    V2SessionByIdResponseSchema.parse({ session: child });
    const pending: unknown[] = [];
    const payload = (index: number) => {
      const request = pending[index] as { content: Parameters<typeof openSessionMessageContent>[0]['content'] };
      expect(request.content.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
      return openSessionMessageContent(mode === 'plain' ? { mode, ctx: null, content: request.content }
        : { mode, ctx: { encryptionKey: secret, encryptionVariant: 'legacy' }, content: request.content });
    };
    const app = fastify();
    app.get('/v1/account/encryption/currentness', async () => ({ mode, version: 1, updatedAt: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null }));
    app.get('/v2/sessions/:sessionId', async () => V2SessionByIdResponseSchema.parse({ session: child }));
    app.get('/v2/sessions', async () => ({ sessions: [createCompactSessionListRowFixture(child)], hasNext: false, nextCursor: null }));
    app.post('/v2/sessions/read-batch', async request => createSessionReadBatchResponseFixture({ request: request.body, sessions: [child] }));
    app.post<{ Body: PendingQueueWriteBody }>('/v2/sessions/:sessionId/pending', async request => {
      pending.push({ ...request.body, sessionId });
      return { didWrite: true };
    });
    app.get('/v2/changes', async () => ({ changes: [], nextCursor: 0 }));
    app.get('/v2/account/session-follow-rules', async () => ({ rules: [] }));
    app.get('/v2/account/session-follow-preferences', async () => ({ assigned: false, direct: false, team: false, group: false }));
    app.get('/v2/account/session-follows', async () => ({ follows: [] }));
    app.get('/v2/sessions/:sessionId/delivery-mutes', async () => ({ scopes: [] }));
    app.post('/v2/follows/pending-receivers', async () => ({ ok: true, v: 1, sessionIds: [] }));
    app.post('/v2/sessions/:sessionId/follows/inactive-observations', async () => ({ ok: true, v: 1, sessionId,
      target: { homeId: serverId, accountId, sessionId, machineId, installationId }, currentSourceSessionIds: [], observations: [] }));
    app.patch('/v2/sessions/:sessionId', async request => {
      const body = request.body as { ownerMetadata?: typeof child.ownerMetadata; sharedMetadata?: { ciphertext: string } };
      if (body.ownerMetadata) child.ownerMetadata = body.ownerMetadata;
      if (body.sharedMetadata) child.metadata = body.sharedMetadata.ciphertext;
      child.metadataVersion += 1;
      return { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: child.metadataVersion }, agentState: { version: child.agentStateVersion } };
    });
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: new URL(resolveServerHttpBaseUrl()).origin });
    const listeners = new Set<Parameters<ApiMachineClient['onSessionFollowRulesChanged']>[0]>();
    let connectOptions: { onConnect?: () => Promise<void> | void } | undefined;
    const transport = { ...createApiMachineTransportFixture(),
      onSessionFollowRulesChanged: (listener: Parameters<ApiMachineClient['onSessionFollowRulesChanged']>[0]) => {
        listeners.add(listener); return () => { listeners.delete(listener); };
      },
      enqueueSessionPendingByMachine: async (request: { localId: string }) => {
        pending.push(request); return { status: 'accepted' as const, localId: request.localId };
      },
      setRPCHandlers: () => ({}), registerLiveStreamRelayRoutes: vi.fn(),
      connect: (options: typeof connectOptions) => { connectOptions = options; },
      updateDaemonState: async () => 'published' as const, updateMachineMetadata: async () => 'published' as const,
      emitExternalSessionTranscriptUpdate: vi.fn(), sendMachineTransferEnvelope: vi.fn(), sendTransferRelayV2Envelope: vi.fn(),
      sendMachineLiveStreamRelayEnvelope: vi.fn(),
      getPeerMediationMachineRpcHandlerManager: () => ({ invokeLocal: async () => ({ ok: true }) }),
    };
    let runtime: Awaited<ReturnType<typeof bootstrapMachineSyncRuntime>> | undefined;
    const changed = async () => {
      expect(listeners.size).toBeGreaterThan(0);
      await Promise.all([...listeners].map(listener => listener({ full: false, workflowRunIds: [], receiverSessionIds: [sessionId] })));
    };
    try {
      runtime = await bootstrapMachineSyncRuntime({ cliVersion: 'test', machineId, credentials,
        machine: { id: machineId, encryptionMode: 'plain', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 },
        requesterServerId: serverId, preferredHost: 'host', happyHomeDir: homeDir, happyLibDir: homeDir,
        filesystemAccessPolicy: { kind: 'osUser' }, takeoverRequested: false, isShuttingDown: () => false,
        createConnectedApiMachine: () => transport as unknown as NonNullable<Awaited<ReturnType<BootstrapMachineSyncRuntimeParams['createConnectedApiMachine']>>>,
        attachTransferRuntimeStatePublisher: async () => {}, startAutomationWorkerForMachine: () => null,
        startMemoryWorkerForMachine: async () => null, startVoiceInferenceWorkerForMachine: async () => null,
        spawnSessionForInternalResume: async () => { throw new Error('A notice must stay in Pending'); },
        spawnSession: async () => { throw new Error('A notice must not change execution'); },
        stopSession: async () => ({ status: 'stopped' }), isSessionAlreadyRunning: async () => true,
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId, machineId }),
        loadLocalSessionMetadataForHandoff: async () => null, beforeShutdown: async () => {}, requestShutdown: () => {},
        directPeerServerLifecycle: null, directTransferRegistryHost: createCliRegistryHostV1(),
        connectedServiceRefreshLoopHandle: null, connectedServiceQuotasLoopHandle: null, daemonServerWorkScheduler: {} as never,
      });
      await changed();
      expect(pending).toHaveLength(0);
      child.manager = { sessionId: first };
      await changed();
      expect(pending, 'committed attach must enqueue one input in the child').toHaveLength(1);
      expect(pending[0]).toMatchObject({ sessionId, requestedAction: { v: 1, kind: 'enqueue' } });
      expect(payload(0)).toMatchObject({ content: { text: expect.stringContaining(first) } });
      await changed();
      expect(pending, 'same-manager/no-op hints must not enqueue another notice').toHaveLength(1);
      child.manager = { sessionId: second };
      await changed();
      expect(pending, 'a new immediate manager must produce one new notice').toHaveLength(2);
      expect(payload(1)).toMatchObject({ content: { text: expect.stringContaining(second) } });
      child.manager = undefined;
      await changed();
      expect(pending).toHaveLength(3);
      expect(payload(2)).toMatchObject({ content: { text: expect.stringContaining('detached') } });
      await changed();
      expect(pending).toHaveLength(3);
      child.manager = { sessionId: first };
      await connectOptions?.onConnect?.();
      expect(pending, 'reconnect discovers the current manager without a live hint').toHaveLength(4);
      expect(payload(3)).toMatchObject({ content: { text: expect.stringContaining(first) } });
      await changed();
      expect(pending).toHaveLength(4);
    } finally {
      if (runtime) await retireMachineSyncRuntimeAttempt(runtime);
      restoreHttp();
      await app.close();
    }
  });
});
