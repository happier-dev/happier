import { randomUUID } from 'node:crypto';
import { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod/mini';
import {
  V2SessionByIdResponseSchema,
  SessionLookupByTagsRequestV2Schema,
} from '@happier-dev/protocol/sessions/control/contract';
import {
  SessionMetadataOwnerPatchV1Schema,
  SessionMetadataTuplePatchSuccessV1Schema,
  SessionMetadataVersionConflictV1Schema,
  SessionOwnerMetadataEnvelopeV1Schema,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import {
  SessionExternalShareableMessagesPageV1Schema,
  SessionMessagesPageV1Schema,
} from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { SessionOrganizationPlacementV1Schema } from '@happier-dev/protocol';
import { ApiClient } from '@/api/api';
import type { StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import {
  buildCommittedLaunchMetadata,
  captureSessionLaunchControlMetadata,
  createSessionMetadata,
} from '@/agent/runtime/createSessionMetadata';
import {
  executeSpawnSessionRequest,
  type ExecuteSpawnSessionRequestParams,
} from '@/daemon/startup/executeSpawnSessionRequest';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { cleanupSessionResources } from '@/daemon/sessions/cleanupSessionResources';
import { createOnChildExited } from '@/daemon/sessions/onChildExited';
import { createOnHappySessionWebhook } from '@/daemon/sessions/onHappySessionWebhook';
import { createAcceptedSessionWorkspaceRegistration } from '@/daemon/sessions/registerAcceptedSessionWorkspace';
import * as processIdentity from '@/daemon/processIdentity';
import * as happyCliProcess from '@/utils/spawnHappyCLI';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { commitDaemonLaunchSession } from '@/daemon/spawn/commitDaemonLaunchSession';
import { createSpawnNewSessionLifecycleActionHandler } from '@/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { registerPrivateSpawnSessionRpcHandlers } from '@/rpc/handlers/sessionLifecycle';
import type { FilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import {
  createSessionNotificationContextFixture,
  createSessionRecordFixture,
} from '@/testkit/backends/sessionFixtures';
import { findTranscriptMessagesQueryRejection } from '@/testkit/transcript/transcriptMessagesRouteContract';
import { registerSessionCreationTargetPreparationRpc } from './registerSessionCreationTargetPreparationRpc';

const BirthRequestSchema = z.looseObject({
  tag: z.string(),
  encryptionMode: z.enum(['plain', 'e2ee']),
  sharedMetadata: z.looseObject({ ciphertext: z.string() }),
  ownerMetadata: SessionOwnerMetadataEnvelopeV1Schema,
  dataEncryptionKey: z.optional(z.nullable(z.string())),
  organizationPlacement: z.optional(SessionOrganizationPlacementV1Schema),
});

/** Home persistence and the physical runner acknowledgement for composed Session journeys.
 * The real creator authors metadata, identity and custody; this boundary stores its bytes.
 * Directory preparation and private spawn settlement use their production registrations.
 */
export function createSessionSpawnComposedBoundary(
  input: Readonly<{
    machineId: string;
    serverId: string;
    accountId: string;
    credentials: StoredCredentials;
    onSpawn?: (request: SpawnSessionOptions) => void | Promise<void>;
  }>,
) {
  type SessionRecord = ReturnType<
    typeof V2SessionByIdResponseSchema.parse
  >['session'];
  const sessions = new Map<string, SessionRecord>();
  const sessionAccountIds = new Map<string, string>();
  const creations = new Map<string, string>();
  const births: Array<
    Readonly<{
      sessionId: string;
      accountId: string;
      request: z.infer<typeof BirthRequestSchema>;
    }>
  > = [];
  const launches: SpawnSessionOptions[] = [];
  const nativeResults: Awaited<
    ReturnType<typeof executeSpawnSessionRequest>
  >[] = [];
  const failures: unknown[] = [];
  const httpFailures: Array<Readonly<{ url: string; error: Error }>> = [];
  const acceptedWorkspaces: Array<
    Readonly<{
      sessionId: string;
      phase: 'started' | 'completed' | 'failed';
      metadata: Parameters<
        ReturnType<typeof createAcceptedSessionWorkspaceRegistration>
      >[0];
    }>
  > = [];
  const handlers = new Map<string, RpcHandler>();
  const cleanups: Array<() => Promise<void>> = [];
  const registrar: RpcHandlerRegistrar = {
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
  registerPrivateSpawnSessionRpcHandlers({
    rpcHandlerManager: registrar,
    requireSessionCreationOutcome: true,
    spawnLifecycleHandler: createSpawnNewSessionLifecycleActionHandler({
      serverId: input.serverId,
      spawnSession: async (request) => {
        const { vi } = await import('vitest');
        const api = await ApiClient.create(input.credentials);
        api.setLocalMachineId(input.machineId);
        const deviceLocalSecretStorage =
          await readOrCreateDeviceLocalSecretStorage({
            path: join(
              configuration.happyHomeDir,
              'chain-device-local-secret.key',
            ),
          });
        const nativeMaps: Pick<
          ExecuteSpawnSessionRequestParams,
          | 'trackedSessionsByKey'
          | 'spawnAwaiterByKey'
          | 'spawnResultResolverByKey'
          | 'spawnWebhookTimeoutByKey'
          | 'spawnResourceCleanupByKey'
          | 'sessionAttachCleanupByKey'
        > = {
          trackedSessionsByKey: new Map(),
          spawnAwaiterByKey: new Map(),
          spawnResultResolverByKey: new Map(),
          spawnWebhookTimeoutByKey: new Map(),
          spawnResourceCleanupByKey: new Map(),
          sessionAttachCleanupByKey: new Map(),
        };
        const children = new Map<
          number,
          Readonly<{
            child: ChildProcess;
            environment: NodeJS.ProcessEnv;
            command: string;
          }>
        >();
        const readRealIdentity = processIdentity.readProcessIdentityByPid;
        const identitySpy = vi
          .spyOn(processIdentity, 'readProcessIdentityByPid')
          .mockImplementation(async (pid, dependencies) => {
            const process = children.get(pid);
            return process
              ? { pid, processStartTimeMs: 1, command: process.command }
              : await readRealIdentity(pid, dependencies);
          });
        const spawnSpy = vi
          .spyOn(happyCliProcess, 'spawnHappyCLI')
          .mockImplementation((args, options) => {
            // An impossible native PID keeps every signal confined to this OS stub.
            const pid = 2_000_000_000 + children.size;
            const child = new ChildProcess();
            Object.defineProperties(child, {
              pid: { value: pid },
              stdout: { value: new PassThrough() },
              stderr: { value: new PassThrough() },
            });
            child.kill = (signal) => {
              child.emit('exit', null, signal ?? 'SIGTERM');
              child.emit('close', null, signal ?? 'SIGTERM');
              return true;
            };
            children.set(pid, {
              child,
              environment: { ...options?.env },
              command: `happier ${args.join(' ')}`,
            });
            return child;
          });
        const onChildExited = createOnChildExited({
          ...nativeMaps,
          getApiMachineForSessions: () => null,
        });
        const registerAcceptedWorkspace =
          createAcceptedSessionWorkspaceRegistration({
            credentials: input.credentials,
            serverId: input.serverId,
            machineId: input.machineId,
          });
        const reportSessionStarted = createOnHappySessionWebhook({
          ...nativeMaps,
          deviceLocalSecretStorage,
          readCredentialsFn: async () => input.credentials,
          registerAcceptedWorkspace: async (metadata, sessionId) => {
            acceptedWorkspaces.push({ sessionId, metadata, phase: 'started' });
            try {
              await registerAcceptedWorkspace(metadata, sessionId);
              acceptedWorkspaces.push({
                sessionId,
                metadata,
                phase: 'completed',
              });
            } catch (error) {
              acceptedWorkspaces.push({ sessionId, metadata, phase: 'failed' });
              failures.push(error);
              throw error;
            }
          },
        });
        cleanups.push(async () => {
          try {
            for (const trackingKey of nativeMaps.trackedSessionsByKey.keys()) {
              const cleaned = await cleanupSessionResources({
                trackingKey,
                ...nativeMaps,
              });
              if (!cleaned)
                throw new Error('Native Session resource cleanup failed');
            }
            for (const { child } of children.values()) child.kill('SIGTERM');
            await onChildExited.awaitPendingExits();
          } finally {
            spawnSpy.mockRestore();
            identitySpy.mockRestore();
          }
        });
        const result = await executeSpawnSessionRequest({
          options: request,
          credentials: input.credentials,
          api,
          machineId: input.machineId,
          connectedServicesMaterializationBaseDir: join(
            configuration.happyHomeDir,
            'connected-services',
          ),
          connectedServiceRefreshCoordinator: null,
          connectedServiceQuotasCoordinator: null,
          connectedServiceRuntimeRegistry:
            new ConnectedServiceRuntimeRegistry(),
          deviceLocalSecretStorage,
          ...nativeMaps,
          onChildExited,
          resolveCanonicalTrackedSessionId: (key) =>
            nativeMaps.trackedSessionsByKey.get(key)?.happySessionId ?? '',
          processEnv: {
            ...process.env,
            HAPPIER_DAEMON_STARTUP_SOURCE: 'manual',
          },
          onTrackedSessionRegistered: () => {
            const tracked = [...nativeMaps.trackedSessionsByKey.values()].find(
              (row) => children.has(row.pid),
            );
            if (!tracked) throw new Error('Native child was not tracked');
            const child = children.get(tracked.pid)!;
            // The real native owner installs the startup waiter synchronously
            // after registration; the runner then reports through its webhook.
            void Promise.resolve()
              .then(async () => {
                let launch = tracked.spawnOptions;
                if (!launch) throw new Error('Native launch options missing');
                if (!launch.existingSessionId) {
                  // Ordinary native launches create in the runner. Execute the
                  // existing real creator against Home instead of inventing a row.
                  const committed = await commitDaemonLaunchSession({
                    api,
                    credentials: input.credentials,
                    options: launch,
                    directory: launch.directory,
                  });
                  if (!committed.ok)
                    throw new Error(
                      `Runner Session birth refused: ${committed.result.errorCode}`,
                    );
                  launch = committed.session.options;
                  tracked.sessionCreationOutcome =
                    committed.session.sessionCreationOutcome;
                }
                const sessionId = launch.existingSessionId;
                if (!sessionId || !sessions.has(sessionId))
                  throw new Error(
                    'Native runner requires its committed Session',
                  );
                const descriptor = launch.runtimeDescriptorV1;
                if (!descriptor)
                  throw new Error(
                    'Native Agent owner did not author a runtime descriptor',
                  );
                launches.push(launch);
                await input.onSpawn?.(launch);
                sessions.set(sessionId, {
                  ...sessions.get(sessionId)!,
                  active: true,
                  activeAt: Date.now(),
                });
                const { metadata } = createSessionMetadata({
                  flavor: descriptor.agentId,
                  machineId: input.machineId,
                  directory: launch.directory,
                  startedBy: 'daemon',
                  runtimeDescriptorV1: descriptor,
                  launchControlMetadata: captureSessionLaunchControlMetadata({
                    processEnvironment: { ...child.environment },
                  }),
                });
                await reportSessionStarted(
                  sessionId,
                  {
                    ...metadata,
                    ...buildCommittedLaunchMetadata({
                      options: launch,
                      directory: launch.directory,
                    }),
                    hostPid: tracked.pid,
                    hostProcessStartTimeMs: 1,
                  },
                  undefined,
                  tracked.sessionCreationOutcome,
                  tracked.trackingKey,
                );
              })
              .catch((error) => {
                failures.push(error);
                child.child.stderr?.emit(
                  'data',
                  Buffer.from(
                    error instanceof Error ? error.message : String(error),
                  ),
                );
                child.child.emit('exit', 1, null);
                child.child.emit('close', 1, null);
              });
          },
        });
        nativeResults.push(result);
        return result;
      },
    }),
  });
  const installRoutes = (app: FastifyInstance): void => {
    app.addHook('onError', async (request, _reply, error) => {
      httpFailures.push({ url: request.url, error });
    });
    app.post('/v2/sessions/lookup-by-tags', async (request) => {
      const body = SessionLookupByTagsRequestV2Schema.parse(request.body);
      return {
        sessions: body.tags.flatMap((tag) => {
          const id = creations.get(tag);
          return id ? [sessions.get(id)!] : [];
        }),
      };
    });
    app.post('/v1/sessions', async (request) => {
      const body = BirthRequestSchema.parse(request.body);
      const existingId = creations.get(body.tag);
      const organizationPlacement =
        body.organizationPlacement ??
        SessionOrganizationPlacementV1Schema.parse({
          folderId: null,
          tagIds: [],
        });
      if (existingId)
        return {
          created: false,
          session: sessions.get(existingId),
          organizationPlacement,
        };
      const sessionId = randomUUID();
      const session = V2SessionByIdResponseSchema.parse({
        session: createSessionRecordFixture({
          ...createSessionNotificationContextFixture(sessionId),
          id: sessionId,
          metadata: body.sharedMetadata.ciphertext,
          ownerMetadata: body.ownerMetadata,
          metadataLayoutVersion: 1,
          share: null,
          ownerAccountId: input.accountId,
          encryptionMode: body.encryptionMode,
          dataEncryptionKey: body.dataEncryptionKey ?? null,
        }),
      }).session;
      sessions.set(sessionId, session);
      sessionAccountIds.set(sessionId, input.accountId);
      creations.set(body.tag, sessionId);
      births.push({ sessionId, accountId: input.accountId, request: body });
      return { created: true, session, organizationPlacement };
    });
    app.get<{ Params: { sessionId: string } }>(
      '/v2/sessions/:sessionId',
      async (request, reply) => {
        const session = sessions.get(request.params.sessionId);
        return session
          ? { session }
          : reply.code(404).send({ error: 'Session not found' });
      },
    );
    app.patch<{ Params: { sessionId: string } }>(
      '/v2/sessions/:sessionId',
      async (request, reply) => {
        const session = sessions.get(request.params.sessionId);
        if (!session)
          return reply.code(404).send({ error: 'Session not found' });
        const body = SessionMetadataOwnerPatchV1Schema.parse(request.body);
        if (
          body.sharedMetadata.expectedVersion !== session.metadataVersion ||
          body.agentState.expectedVersion !== session.agentStateVersion ||
          !isDeepStrictEqual(body.expectedOwnerMetadata, session.ownerMetadata)
        ) {
          return reply.code(409).send(
            SessionMetadataVersionConflictV1Schema.parse({
              code: 'session_metadata_version_conflict',
              metadataLayoutVersion: 1,
              sharedMetadata: { version: session.metadataVersion },
              agentState: { version: session.agentStateVersion },
            }),
          );
        }
        const updated = {
          ...session,
          metadata: body.sharedMetadata.ciphertext,
          metadataVersion: session.metadataVersion + 1,
          ownerMetadata: body.ownerMetadata,
          agentState: body.agentState.ciphertext,
          agentStateVersion: (session.agentStateVersion ?? 0) + 1,
          ...(body.projectKey !== undefined
            ? {
                projectKey: body.projectKey,
              }
            : {}),
          ...(body.displayProjectionV1
            ? { displayProjectionV1: body.displayProjectionV1 }
            : {}),
        };
        if (body.projectKey === null) updated.projectKeyNone = true;
        else if (body.projectKey !== undefined) delete updated.projectKeyNone;
        if (body.displayProjectionV1 === null)
          delete updated.displayProjectionV1;
        sessions.set(
          session.id,
          V2SessionByIdResponseSchema.parse({ session: updated }).session,
        );
        return SessionMetadataTuplePatchSuccessV1Schema.parse({
          success: true,
          metadataLayoutVersion: 1,
          sharedMetadata: { version: updated.metadataVersion },
          agentState: { version: updated.agentStateVersion },
        });
      },
    );
    app.get<{ Params: { sessionId: string } }>(
      '/v1/sessions/:sessionId/messages',
      async (request, reply) => {
        if (!sessions.has(request.params.sessionId)) {
          return reply.code(404).send({ error: 'Session not found' });
        }
        const query = new URL(request.url, 'http://session-boundary.test')
          .searchParams;
        const rejection = findTranscriptMessagesQueryRejection(query);
        if (rejection) return reply.code(400).send({ error: rejection });
        const page = {
          messages: [],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        };
        return query.get('projection') === 'externalShareableV1'
          ? SessionExternalShareableMessagesPageV1Schema.parse({
              ...page,
              externalShareableSnapshot: { turns: [], referencedUserRows: [] },
            })
          : SessionMessagesPageV1Schema.parse(page);
      },
    );
    const accessKeys = new Map<string, string>();
    app.get<{ Params: { sessionId: string; machineId: string } }>(
      '/v1/access-keys/:sessionId/:machineId',
      async (request) => {
        const data = accessKeys.get(
          `${request.params.sessionId}:${request.params.machineId}`,
        );
        return { accessKey: data ? { data } : null };
      },
    );
    app.post<{ Params: { sessionId: string; machineId: string } }>(
      '/v1/access-keys/:sessionId/:machineId',
      async (request) => {
        const { data } = z.object({ data: z.string() }).parse(request.body);
        accessKeys.set(
          `${request.params.sessionId}:${request.params.machineId}`,
          data,
        );
        return { success: true, accessKey: { data } };
      },
    );
  };
  const registerHandlers = (
    target: RpcHandlerRegistrar,
    directoryPreflightAdmission: FilesystemEffectAdmission,
  ): void => {
    registerSessionCreationTargetPreparationRpc({
      rpcHandlerManager: target,
      directoryPreflightAdmission,
    });
    for (const [method, handler] of handlers)
      target.registerHandler(method, handler);
  };
  const close = async (): Promise<void> => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  };
  return {
    sessions,
    sessionAccountIds,
    births,
    launches,
    nativeResults,
    failures,
    httpFailures,
    acceptedWorkspaces,
    registerHandlers,
    installRoutes,
    close,
  };
}
