import fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { createApiMachineTransportFixture } from '@/testkit/apiMachineTransport';
import { createDeferred } from '@/testkit/async/deferred';
import { createAccountEncryptionCurrentnessFixture, createCompactSessionListQueryResponseFixture,
  createSessionNotificationContextFixture, createSessionReadBatchResponseFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { bindProcessLogger, Logger } from '@/ui/logger';
import { startAutomationWorker } from '../automation/automationWorker';
import { createDaemonTransferRuntimeState, createDaemonTransferRuntimeStatePublisher } from '../transferRuntimeState';
import { createDaemonServerWorkBudget, createDaemonServerWorkScheduler } from '../serverWork';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';
import { bootstrapMachineSyncRuntime, retireMachineSyncRuntimeAttempt, type BootstrapMachineSyncRuntimeParams } from './bootstrapMachineSyncRuntime';

describe('Pending recovery after Machine endpoint publication', () => {
  it.each((['automation-read', 'transfer-ack', 'orphan-capture', 'admission-drain'] as const)
    .flatMap(heldBoundary => (['connect', 'resume'] as const).map(entry => ({ heldBoundary, entry }))))(
    'publishes the endpoint on $entry without waiting for $heldBoundary', async ({ heldBoundary, entry }) => {
    await withConfiguredDaemonTestHome({ prefix: 'endpoint-order-' }, async ({ homeDir }) => {
      const hold = createDeferred<void>();
      let boundaryEntered = false;
      let admissionQuiescing = false;
      let endpointWrites = 0;
      let onConnect: (() => void | Promise<void>) | undefined;
      const log = new Logger({ logFilePath: join(homeDir, 'reconnect.log'),
        allowDangerousRemoteLogging: false, pruneCurrentProcessLogs: false });
      const restoreLogger = bindProcessLogger(log);
      const app = fastify();
      app.get('/v3/automations/worker/assignments', async () => {
        boundaryEntered = true;
        await hold.promise;
        return { assignments: [], settings: { maxActiveRunsPerMachine: 1 } };
      });
      app.get('/v3/automations/worker/run-lifecycle', async () => ({ sources: [] }));
      app.post('/v3/automations/runs/claim', async () => ({ run: null, automation: null, accountCurrentness: null }));
      await app.ready();
      const restoreHttp = installAxiosFastifyAdapter({ app, origin: new URL(resolveServerHttpBaseUrl()).origin });
      const transfer = createDaemonTransferRuntimeStatePublisher({ initialTransferState: createDaemonTransferRuntimeState({
        directPeer: { featureEnabled: false, serverEnabled: false, bindHost: '127.0.0.1', bindPort: 0, advertisedHosts: [] },
      }) });
      type MachineClient = NonNullable<Awaited<ReturnType<BootstrapMachineSyncRuntimeParams['createConnectedApiMachine']>>>;
      const transport = { ...createApiMachineTransportFixture(),
        connect: (options: { onConnect?: typeof onConnect }) => { onConnect = options.onConnect; },
        setRPCHandlers: () => ({}), registerLiveStreamRelayRoutes: () => {},
        updateDaemonState: async (reduce: Parameters<MachineClient['updateDaemonState']>[0]) => {
          const state = reduce({ status: 'running' });
          if (state?.transfer) {
            if (heldBoundary === 'transfer-ack') { boundaryEntered = true; await hold.promise; }
          } else endpointWrites++;
          return 'published' as const;
        },
        captureMachineSessionTerminal: async (): ReturnType<MachineClient['captureMachineSessionTerminal']> => {
          boundaryEntered = true; await hold.promise;
          return { v: 1, status: 'rejected', reason: 'internal_error' };
        },
        updateMachineMetadata: async () => 'published' as const,
        emitExternalSessionTranscriptUpdate: () => {}, sendMachineTransferEnvelope: () => {},
        sendTransferRelayV2Envelope: () => {}, sendMachineLiveStreamRelayEnvelope: () => {},
        getPeerMediationMachineRpcHandlerManager: () => ({ invokeLocal: async () => ({ ok: true }) }),
      };
      let runtime: Awaited<ReturnType<typeof bootstrapMachineSyncRuntime>> | undefined;
      let connecting: Promise<void> | undefined;
      try {
        runtime = await bootstrapMachineSyncRuntime({ cliVersion: 'test', machineId: 'endpoint-machine',
          machine: { id: 'endpoint-machine', encryptionMode: 'plain', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 },
          preferredHost: 'host', happyHomeDir: homeDir, happyLibDir: homeDir,
          filesystemAccessPolicy: { kind: 'osUser' }, takeoverRequested: false,
          isShuttingDown: () => admissionQuiescing, isPublicationQuiescing: () => false,
          createConnectedApiMachine: () => transport as unknown as MachineClient,
          attachTransferRuntimeStatePublisher: target => transfer.attachApiMachine(target),
          startAutomationWorkerForMachine: machineId => heldBoundary === 'automation-read'
            ? startAutomationWorker({ token: 'test', machineId, env: { NODE_ENV: 'test' } }) : null,
          startMemoryWorkerForMachine: async () => null, startVoiceInferenceWorkerForMachine: async () => null,
          orphanedDeadDaemonSessions: heldBoundary === 'orphan-capture' ? [{ sessionId: 'dead-session', pid: 1234567 }] : [],
          spawnSessionForInternalResume: async () => ({ type: 'success', sessionId: 'unused' }),
          spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
          stopSession: async () => ({ status: 'stopped' }), isSessionAlreadyRunning: async () => false,
          loadLocalSessionMetadataForHandoff: async () => null, beforeShutdown: async () => {}, requestShutdown: () => {},
          directPeerServerLifecycle: null, directTransferRegistryHost: createCliRegistryHostV1(),
          connectedServiceRefreshLoopHandle: null, connectedServiceQuotasLoopHandle: null,
          daemonServerWorkScheduler: createDaemonServerWorkScheduler({ budget: createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }) }),
        });
        if (!onConnect) throw new Error('Missing connected edge');
        admissionQuiescing = heldBoundary === 'admission-drain';
        connecting = entry === 'connect' ? Promise.resolve(onConnect()) : runtime.resumeMachineConnectionPublications();
        if (admissionQuiescing) await connecting;
        else await vi.waitFor(() => expect(boundaryEntered).toBe(true));
        // No unrelated HTTP read, transfer ACK or dead-runner settlement may
        // precede the broker's first endpoint publication on a connected Machine.
        expect(endpointWrites).toBe(1);
        hold.resolve();
        await connecting;
        expect(endpointWrites).toBe(1);
        log.flushSync();
        const phases = (await readFile(log.logFilePath, 'utf8')).split('\n')
          .filter(line => line.includes('Machine reconnect phase')).map(line => JSON.parse(line.slice(line.indexOf('{'))));
        const pendingPhases = !admissionQuiescing ? ['entered', 'completed'] : [];
        for (const phase of ['automation-catch-up', 'transfer-publication', 'orphan-settlement', 'endpoint-publication', 'metadata-publication', 'pending-recovery']) {
          expect(phases.filter(record => record.phase === phase).map(record => record.status)).toEqual(
            phase === 'pending-recovery' ? pendingPhases
              : admissionQuiescing && phase !== 'endpoint-publication' ? [] : ['entered', 'completed']);
        }
      } finally {
        hold.resolve(); await connecting;
        if (runtime) await retireMachineSyncRuntimeAttempt(runtime);
        restoreHttp(); await app.close(); restoreLogger();
      }
    });
  });

  it.each((['connect', 'resume'] as const).flatMap(entry => [
    { entry, publicationOutcome: 'published' as const, pending: 'none' as const },
    { entry, publicationOutcome: 'published' as const, pending: 'independent' as const },
    ...(['published', 'unchanged', 'suppressed', 'failed'] as const).map(publicationOutcome =>
      ({ entry, publicationOutcome, pending: 'broker-blocked' as const })),
  ]))(
    'uses one discovery pass on $entry with $pending demand and $publicationOutcome endpoint ACK', async ({ entry, publicationOutcome, pending }) => {
    await withConfiguredDaemonTestHome({ prefix: 'pending-endpoint-' }, async ({ homeDir }) => {
      const machineId = 'pending-machine';
      const sessionId = 'c111111111111111111111111';
      const heldSessionId = 'c222222222222222222222222';
      const credentials = { token: 'e30.eyJzdWIiOiJvd25lciJ9.signature', encryption: null } as const;
      const createSession = (id: string) => ({ ...createSessionNotificationContextFixture(id), encryptionMode: 'plain' as const, active: false,
        metadataLayoutVersion: 0 as const, pendingCount: 1, pendingVersion: 1,
        pendingActivationAuthorization: { requestId: 'input-1', requestedAt: 12, status: 'waiting' as const },
        metadata: JSON.stringify({ machineId, path: homeDir, flavor: 'codex', codexSessionId: `native-${id}`,
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' } }) });
      const sessions = pending === 'none' ? [] : pending === 'independent'
        ? [createSession(sessionId)] : [createSession(heldSessionId), createSession(sessionId)];
      const app = fastify();
      const failedActivations: unknown[] = [];
      const listResponse = createCompactSessionListQueryResponseFixture({ sessions,
        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false });
      app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture());
      app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
      let inventoryTraversals = 0;
      app.get('/v2/sessions', async () => { inventoryTraversals++; return listResponse; });
      app.post('/v2/sessions/read-batch', async request => createSessionReadBatchResponseFixture({
        request: request.body, sessions }));
      app.get('/v2/sessions/:sessionId', async request => ({
        session: sessions.find(session => session.id === (request.params as { sessionId: string }).sessionId) }));
      app.get('/v2/sessions/:sessionId/pending', async () => ({ pending: [{ localId: 'input-1', messageRole: 'user',
        requestedAction: { v: 1, kind: 'send_now' }, deliveryStatus: { status: 'queued' } }] }));
      app.post('/v2/sessions/:sessionId/follows/inactive-observations', async () => ({ ok: false, v: 1, error: 'forbidden' }));
      app.post('/v2/follows/pending-receivers', async () => ({ ok: true, v: 1, sessionIds: [] }));
      app.post('/v2/sessions/:sessionId/pending/activation/fail', async request => {
        failedActivations.push(request.body);
        return { ok: true, didFail: true };
      });
      await app.ready();
      const restoreHttp = installAxiosFastifyAdapter({ app, origin: new URL(resolveServerHttpBaseUrl()).origin });
      const endpointAck = createDeferred<void>();
      const endpointEntered = createDeferred<void>();
      const metadataAck = createDeferred<void>();
      let metadataEntered = false;
      const unrelatedStartup = createDeferred<void>();
      const unrelatedStartupEntered = createDeferred<void>();
      let endpointPublished = false;
      let running = false;
      let attempts = 0;
      let onConnect: (() => void | Promise<void>) | undefined;
      type MachineClient = NonNullable<Awaited<ReturnType<BootstrapMachineSyncRuntimeParams['createConnectedApiMachine']>>>;
      // Socket publication acknowledgements and physical runner launch are the boundaries.
      // Real reconnect composition, Pending discovery, eligibility and retry classification run beneath them.
      const transport = { ...createApiMachineTransportFixture(),
        connect: (options: { onConnect?: typeof onConnect }) => { onConnect = options.onConnect; },
        setRPCHandlers: () => ({}), registerLiveStreamRelayRoutes: () => {},
        updateDaemonState: async () => { endpointEntered.resolve(); await endpointAck.promise;
          if (publicationOutcome === 'failed') throw new Error('Endpoint publication failed');
          endpointPublished = publicationOutcome !== 'suppressed'; return publicationOutcome; },
        updateMachineMetadata: async () => { metadataEntered = true; await metadataAck.promise; return 'published' as const; },
        emitExternalSessionTranscriptUpdate: () => {}, sendMachineTransferEnvelope: () => {},
        sendTransferRelayV2Envelope: () => {}, sendMachineLiveStreamRelayEnvelope: () => {},
        getPeerMediationMachineRpcHandlerManager: () => ({ invokeLocal: async () => ({ ok: true }) }),
      };
      let runtime: Awaited<ReturnType<typeof bootstrapMachineSyncRuntime>> | undefined;
      let connecting: Promise<void> | undefined;
      try {
        runtime = await bootstrapMachineSyncRuntime({ cliVersion: 'test', machineId, credentials,
          machine: { id: machineId, encryptionMode: 'plain', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 },
          preferredHost: 'host', happyHomeDir: homeDir, happyLibDir: homeDir,
          filesystemAccessPolicy: { kind: 'osUser' }, takeoverRequested: false, isShuttingDown: () => false,
          createConnectedApiMachine: () => transport as unknown as MachineClient,
          attachTransferRuntimeStatePublisher: async () => {}, startAutomationWorkerForMachine: () => null,
          startMemoryWorkerForMachine: async () => null, startVoiceInferenceWorkerForMachine: async () => null,
          spawnSessionForInternalResume: async options => {
            if (options.existingSessionId === heldSessionId) {
              unrelatedStartupEntered.resolve();
              await unrelatedStartup.promise;
              return { type: 'success', sessionId: heldSessionId };
            }
            expect(options.existingSessionId).toBe(sessionId);
            expect(options.executionAuthorization).toMatchObject({ requestId: 'input-1', requestedAt: 12 });
            attempts++;
            if (pending === 'broker-blocked' && !endpointPublished) {
              return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                errorMessage: 'Broker unavailable', errorDetail: { kind: 'launch_error', code: 'broker_unavailable',
                  message: 'Initiator endpoint missing' } };
            }
            running = true;
            return { type: 'success', sessionId };
          },
          spawnSession: async () => { throw new Error('Pending must use internal resume'); },
          stopSession: async () => ({ status: 'stopped' }), isSessionAlreadyRunning: async () => running,
          loadLocalSessionMetadataForHandoff: async () => null, beforeShutdown: async () => {}, requestShutdown: () => {},
          directPeerServerLifecycle: null, directTransferRegistryHost: createCliRegistryHostV1(),
          connectedServiceRefreshLoopHandle: null, connectedServiceQuotasLoopHandle: null,
          daemonServerWorkScheduler: createDaemonServerWorkScheduler({ budget: createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }) }),
        });
        if (!onConnect) throw new Error('Machine reconnect callback missing');
        connecting = entry === 'connect' ? Promise.resolve(onConnect()) : runtime.resumeMachineConnectionPublications();
        await endpointEntered.promise;
        if (pending === 'broker-blocked') await unrelatedStartupEntered.promise;
        await vi.waitFor(() => expect(inventoryTraversals).toBe(1));
        if (pending !== 'none') await vi.waitFor(() => expect(attempts).toBe(1));
        expect(running).toBe(pending === 'independent');
        expect(failedActivations).toEqual([]);
        endpointAck.resolve();
        if (pending === 'broker-blocked' && (publicationOutcome === 'published' || publicationOutcome === 'unchanged')) {
          // Metadata and another Session's physical startup remain held.
          await vi.waitFor(() => expect(running).toBe(true));
          expect(attempts).toBe(2);
          await vi.waitFor(() => expect(metadataEntered).toBe(true));
        }
        unrelatedStartup.resolve();
        metadataAck.resolve();
        await connecting;
        expect(inventoryTraversals).toBe(1);
        expect(running).toBe(pending === 'independent' || pending === 'broker-blocked' && endpointPublished);
        expect(attempts).toBe(pending === 'none' ? 0 : pending === 'independent' ? 1 : endpointPublished ? 2 : 1);
        expect(failedActivations).toEqual([]);
      } finally {
        endpointAck.resolve(); metadataAck.resolve(); unrelatedStartup.resolve();
        await connecting;
        if (runtime) await retireMachineSyncRuntimeAttempt(runtime);
        restoreHttp(); await app.close();
      }
    });
  });
});
