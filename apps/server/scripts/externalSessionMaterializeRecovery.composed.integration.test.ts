import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1,
  EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION_V1,
  ExternalSessionOperationActionResponseV1Schema,
  FeaturesResponseSchema,
  makeExternalSessionHistoricalImportBatchIdV1,
  type ExternalSessionMaterializeStartInputV1,
  type ExternalSessionOperationSemanticRequestV1,
  type ExternalSessionOperationSocketBatchItemV1,
  type ExternalSessionOperationSocketCommandV1,
  type ExternalSessionOperationSocketResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createExternalSessionMaterializeActionExecutor } from '../../cli/src/session/actions/externalSessions/materializeAction';
import { createExternalSessionMaterializeStartActionExecutor } from '../../cli/src/session/actions/externalSessions/materializeStartAction';
import { resolveExternalSessionOperationStartAdmission } from '../../cli/src/session/actions/externalSessions/operationRecordStore';
import { readExternalSessionOperationSharedPresentation } from '../../cli/src/session/actions/externalSessions/operationProgressPublisher';
import { createExternalSessionOperationExclusion } from '../../cli/src/session/external/operationExclusion';
import { createExternalSessionOperationPrivateStagingStore } from '../../cli/src/session/external/staging/operationPrivateStaging';
import { registerMachineExternalSessionsRpcHandlers } from '../../cli/src/api/machine/rpcHandlers.externalSessions';
import type { RpcActionExecutor } from '../../cli/src/rpc/handlers/_actionDispatchAdapter';
import type { CliServerFeaturesSnapshot } from '../../cli/src/features/serverFeaturesClient';
import { machineUpdateHandler } from '../sources/app/api/socket/machineUpdateHandler';
import {
  createFakeSocket,
  getSocketHandler,
} from '../sources/app/api/testkit/socketHarness';
import { db } from '../sources/storage/db';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '../sources/testkit/lightSqliteHarness';

const qualifiedIdentity = {
  v: 1 as const,
  agent: { pluginId: 'example.plugin', localId: 'example' },
  source: { kind: 'jsonl', contractVersion: 1 as const },
};

type MaterializeSemanticRequest = Extract<
  ExternalSessionOperationSemanticRequestV1,
  { plan: 'materialize' }
>;

function historyItem(id: string): ExternalSessionOperationSocketBatchItemV1 {
  return {
    localId: `history:${id}`,
    sidechainId: null,
    messageRole: 'user',
    content: { t: 'plain', v: { role: 'user', text: id } },
  };
}

function createOperationSocketSender(input: Readonly<{
  accountId: string;
  machineId: string;
}>): (
  command: ExternalSessionOperationSocketCommandV1,
) => Promise<ExternalSessionOperationSocketResponseV1> {
  const socket = createFakeSocket({
    data: {
      clientType: 'machine-scoped',
      machineId: input.machineId,
    },
  });
  // Test socket implements the handler-owned `data`/`on` surface; transport methods are not used.
  machineUpdateHandler(
    input.accountId,
    socket as unknown as Parameters<typeof machineUpdateHandler>[1],
    {
      operationSocketBatchLimits: {
        ok: true,
        limits: { maxItems: 200, maxSerializedBytes: 524_288 },
      },
    },
  );
  const handleOperation = getSocketHandler(
    socket,
    EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1,
  );
  return async (command) => await new Promise((resolve, reject) => {
    Promise.resolve(handleOperation(command, (response: unknown) => {
      if (!response || typeof response !== 'object') {
        reject(new Error('Operation socket returned an invalid response.'));
        return;
      }
      // The socket handler owns schema validation; this fixture only transports its callback.
      resolve(response as ExternalSessionOperationSocketResponseV1);
    })).catch(reject);
  });
}

function registerMaterializeRpcExecutor(
  fixture: Readonly<{
    activeServerDir: string;
    configuredSource: MaterializeSemanticRequest['source'];
    executor: ReturnType<typeof createExternalSessionMaterializeActionExecutor>;
  }>,
): Readonly<{
  invoke(method: string, input: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}> {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  // The composed fixture installs only the daemon-owned result of linked/configured
  // source resolution. RPC callers still cross the canonical strict public Start
  // parser and receipt-aware admission before the private semantic request exists.
  const materializeStart = createExternalSessionMaterializeStartActionExecutor({
    resolveAdmission: async (intent, authorIntent) =>
      await resolveExternalSessionOperationStartAdmission({
        activeServerDir: fixture.activeServerDir,
        durableIdempotencyKey: intent.idempotencyKey,
        intent,
        ...(authorIntent ? { authorIntent } : {}),
        nowMs: Date.now(),
        readSelectedPresentation:
          readExternalSessionOperationSharedPresentation,
      }),
    describeSession: async (intent) => ({
      ...intent,
      source: fixture.configuredSource,
    }),
    startSemanticRequest: fixture.executor.start,
  });
  const actionExecutor: RpcActionExecutor = {
    execute: async (actionId, input) => {
      switch (actionId) {
        case 'sessions.external.materialize.start':
          return { ok: true, result: await materializeStart.start(input) };
        case 'sessions.external.operation.status.get':
          return { ok: true, result: await fixture.executor.status(input) };
        case 'sessions.external.operation.resume':
          return { ok: true, result: await fixture.executor.resume(input) };
        default:
          return {
            ok: false,
            errorCode: 'unsupported_action',
            error: `unsupported_action:${actionId}`,
          };
      }
    },
  };
  const features = FeaturesResponseSchema.parse({
    features: {},
    capabilities: {
      session: {
        externalImport: {
          publicationFenceVersion:
            EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION_V1,
        },
      },
    },
  });
  const rpcHandlerManager = {
    hasHandler: (method: string) => handlers.has(method),
    registerHandler: (
      method: string,
      handler: (input: unknown) => Promise<unknown>,
    ) => {
      handlers.set(method, handler);
    },
  };
  // This composed fixture needs only the machine registrar's handler contract.
  const registration = registerMachineExternalSessionsRpcHandlers({
    rpcHandlerManager:
      rpcHandlerManager as unknown as Parameters<
        typeof registerMachineExternalSessionsRpcHandlers
      >[0]['rpcHandlerManager'],
    actionExecutor,
    getServerFeaturesSnapshot: (): CliServerFeaturesSnapshot => ({
      status: 'ready',
      features,
    }),
  });
  return {
    async invoke(method, input) {
      const handler = handlers.get(method);
      if (!handler) throw new Error(`Missing registered RPC handler: ${method}`);
      return await handler(input);
    },
    dispose: async () => await registration.dispose(),
  };
}

describe('materialize recovery composed across the daemon and SQLite server owners', () => {
  let harness: LightSqliteHarness;
  let previousStoragePolicy: string | undefined;

  beforeAll(async () => {
    previousStoragePolicy = process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
    process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = 'optional';
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-materialize-recovery-composed-',
      initAuth: false,
    });
  }, 120_000);

  afterAll(async () => {
    if (previousStoragePolicy === undefined) {
      delete process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
    } else {
      process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = previousStoragePolicy;
    }
    await harness.close();
  });

  async function createFixture(params: Readonly<{
    id: string;
    loseFirstCallbackFor: 'batch' | 'finalize' | 'discard';
    failSecondBatch?: boolean;
  }>) {
    const activeServerDir = await mkdtemp(join(tmpdir(), `happier-${params.id}-`));
    const account = await db.account.create({
      data: { publicKey: `materialize-recovery-${params.id}-${randomUUID()}` },
      select: { id: true },
    });
    const machineId = `materialize-machine-${params.id}-${randomUUID()}`;
    await db.machine.create({
      data: { id: machineId, accountId: account.id, metadata: '{}' },
    });
    const executeServerCommand = createOperationSocketSender({
      accountId: account.id,
      machineId,
    });
    const session = await db.session.create({
      data: {
        tag: `materialize-recovery-${params.id}-${randomUUID()}`,
        accountId: account.id,
        metadata: 'metadata',
        encryptionMode: 'plain',
        currentStorageState: 'machine_only',
      },
      select: { id: true },
    });
    const request = {
      v: 1 as const,
      idempotencyKey: `materialize-${params.id}`,
      sessionId: session.id,
      source: {
        machineId,
        remoteSessionId: `remote-${params.id}`,
        qualifiedIdentity,
        linkGeneration: 'link-1',
        sourceGeneration: 'source-1',
        contributionGeneration: 'contribution-1',
      },
      plan: 'materialize' as const,
      targetStorageMode: 'external-linked' as const,
      targetRuntimeMode: null,
    };
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: `owner-${params.id}`,
    });
    const staging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    let requestedCallbackLost = false;
    let secondBatchCallbackLost = false;
    let batchCount = 0;
    const sendHistoricalCommand = async (
      command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> => {
      const committed = await executeServerCommand(command);
      if (command.kind === 'batch') batchCount += 1;
      const shouldLoseRequested = !requestedCallbackLost
        && command.kind === params.loseFirstCallbackFor;
      const shouldLoseSecondBatch = !secondBatchCallbackLost
        && params.failSecondBatch === true
        && command.kind === 'batch'
        && batchCount === 2;
      const shouldLose = shouldLoseRequested || shouldLoseSecondBatch;
      if (shouldLose) {
        if (shouldLoseRequested) requestedCallbackLost = true;
        if (shouldLoseSecondBatch) secondBatchCallbackLost = true;
        return {
          v: 1,
          kind: 'error',
          errorCode: 'internal_error',
          message: `Committed ${command.kind}; socket callback was lost.`,
        };
      }
      return committed;
    };
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: `source-${params.id}`,
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          boundary: 'boundary-1',
        },
        priorStableStorage: { state: 'machine_only' },
        linkedSessionRevision: 1,
      }),
      revalidateSource: async (_request, capturedSource, sourceSnapshotEvidenceRef) => {
        expect(capturedSource).toMatchObject({
          sourceIdentity: `source-${params.id}`,
          sourceGeneration: 'source-1',
        });
        expect(sourceSnapshotEvidenceRef).toBe('revision-1');
      },
      readNewestFirstPages: async function* () {
        yield {
          groupId: 'newest-page',
          items: [historyItem('newest')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: `source-${params.id}`,
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: false,
          },
        } as const;
        yield {
          groupId: 'oldest-page',
          items: [historyItem('oldest')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: `source-${params.id}`,
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: true,
          },
        } as const;
      },
      readFinalCatchUpPages: async function* () {
        // This recovery fixture holds its source stable after the captured EOF.
      },
      sendHistoricalCommand,
    });
    return {
      activeServerDir,
      executor,
      request,
      sessionId: session.id,
      cleanup: async () => await rm(activeServerDir, { recursive: true, force: true }),
    };
  }

  it('resumes the same server job after the daemon persists interruption and explicit intent revisions', async () => {
    const fixture = await createFixture({
      id: 'revision',
      loseFirstCallbackFor: 'batch',
    });
    try {
      const interrupted = await fixture.executor.start({ request: fixture.request });
      if (!interrupted.ok) {
        throw new Error(
          `Expected interrupted materialization: ${JSON.stringify(interrupted.error)}`,
        );
      }
      expect(interrupted).toMatchObject({
        ok: true,
        progress: { status: 'awaiting_user_resume', phase: 'importing' },
      });

      const resumed = await fixture.executor.resume({
        sessionId: fixture.request.sessionId,
        operationId: interrupted.progress.operationId,
        revision: interrupted.progress.revision,
      });
      if (!resumed.ok) {
        throw new Error(
          `Expected resumed materialization: ${JSON.stringify(resumed.error)}`,
        );
      }
      expect(resumed).toMatchObject({
        ok: true,
        progress: {
          status: 'completed',
          currentStorageState: 'snapshot_complete',
          checkpoint: { importedItemCount: 2, acceptedThroughServerSeq: 2 },
        },
      });
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);

  it('replays a large newest-first synthetic Agent capture once through registered RPC after passive daemon restart', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-registered-restart-'));
    const account = await db.account.create({
      data: { publicKey: `materialize-registered-${randomUUID()}` },
      select: { id: true },
    });
    const machineId = `materialize-registered-machine-${randomUUID()}`;
    await db.machine.create({
      data: { id: machineId, accountId: account.id, metadata: '{}' },
    });
    const executeServerCommand = createOperationSocketSender({
      accountId: account.id,
      machineId,
    });
    const session = await db.session.create({
      data: {
        tag: `materialize-registered-${randomUUID()}`,
        accountId: account.id,
        metadata: 'metadata',
        encryptionMode: 'plain',
        currentStorageState: 'machine_only',
      },
      select: { id: true },
    });
    const request = {
      v: 1 as const,
      idempotencyKey: 'materialize-registered-restart',
      sessionId: session.id,
      source: {
        machineId,
        remoteSessionId: 'remote-registered',
        qualifiedIdentity,
        linkGeneration: 'link-1',
        sourceGeneration: 'source-1',
        contributionGeneration: 'contribution-1',
      },
      plan: 'materialize' as const,
      targetStorageMode: 'external-linked' as const,
      targetRuntimeMode: null,
    };
    const publicRequest = {
      request: {
        v: request.v,
        idempotencyKey: request.idempotencyKey,
        sessionId: request.sessionId,
        plan: request.plan,
        targetStorageMode: request.targetStorageMode,
        targetRuntimeMode: request.targetRuntimeMode,
      },
    } satisfies ExternalSessionMaterializeStartInputV1;
    const chronologicalItems = Array.from(
      { length: 450 },
      (_, index): ExternalSessionOperationSocketBatchItemV1 => ({
        localId: `history:registered:${index.toString().padStart(3, '0')}`,
        sidechainId: index === 73 ? 'sidechain:synthetic' : null,
        messageRole: index % 2 === 0 ? 'user' : 'agent',
        content: {
          t: 'plain',
          v: {
            role: index % 2 === 0 ? 'user' : 'assistant',
            text: `synthetic-${index.toString().padStart(3, '0')}`,
            ...(index === 73
              ? {
                  sidechain: { parentId: 'synthetic-072', branch: 'analysis' },
                  media: {
                    kind: 'session_media.v1',
                    payload: {
                      media: [],
                      failures: [{
                        index: 0,
                        code: 'source_media_unavailable',
                        role: 'output',
                        category: 'tool-artifact',
                        mediaKind: 'image',
                        name: 'synthetic-proof.png',
                        origin: { source: 'tool-output', agentId: 'example' },
                      }],
                    },
                  },
                }
              : {}),
          },
        },
      }),
    );
    const sourcePages = [
      chronologicalItems.slice(300),
      chronologicalItems.slice(150, 300),
      chronologicalItems.slice(0, 150),
    ];
    let sourceReadCount = 0;
    let loseFirstBatchCallback = true;
    const commandKinds: ExternalSessionOperationSocketCommandV1['kind'][] = [];
    const sendHistoricalCommand = async (
      command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> => {
      commandKinds.push(command.kind);
      const committed = await executeServerCommand(command);
      if (command.kind === 'batch' && loseFirstBatchCallback) {
        loseFirstBatchCallback = false;
        return {
          v: 1,
          kind: 'error',
          errorCode: 'internal_error',
          message: 'Committed the first batch; the operation socket callback was lost.',
        };
      }
      return committed;
    };
    const createRestartableExecutor = () => createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion: createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: `registered-owner:${randomUUID()}`,
      }),
      staging: createExternalSessionOperationPrivateStagingStore({
        activeServerDir,
        limits: {
          perOperation: { maxItems: 1_000, maxBytes: 5_000_000 },
          aggregate: { maxItems: 2_000, maxBytes: 10_000_000 },
        },
      }),
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'synthetic-agent:remote-registered',
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          boundary: 'tail-449',
        },
        priorStableStorage: { state: 'machine_only' },
        linkedSessionRevision: 1,
      }),
      revalidateSource: async (_request, capturedSource, sourceSnapshotEvidenceRef) => {
        expect(capturedSource).toMatchObject({
          sourceIdentity: 'synthetic-agent:remote-registered',
          sourceGeneration: 'source-1',
        });
        expect(sourceSnapshotEvidenceRef).toBe('revision-1');
      },
      readNewestFirstPages: async function* () {
        for (const [pageIndex, items] of sourcePages.entries()) {
          sourceReadCount += 1;
          yield {
            groupId: `synthetic-newest-page:${pageIndex}`,
            items,
            sourceRead: {
              availability: 'reachable',
              sourceIdentity: 'synthetic-agent:remote-registered',
              sourceGeneration: 'source-1',
              revision: 'revision-1',
              relationshipToCapture: 'same',
              eof: pageIndex === sourcePages.length - 1,
            },
          } as const;
        }
      },
      readFinalCatchUpPages: async function* () {
        sourceReadCount += 1;
      },
      sendHistoricalCommand,
    });

    let activeRpc: ReturnType<typeof registerMaterializeRpcExecutor> | null = null;
    try {
      activeRpc = registerMaterializeRpcExecutor({
        activeServerDir,
        configuredSource: request.source,
        executor: createRestartableExecutor(),
      });
      const interrupted = await activeRpc.invoke(
        RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START,
        publicRequest,
      );
      const interruptedResponse =
        ExternalSessionOperationActionResponseV1Schema.parse(interrupted);
      expect(interruptedResponse).toMatchObject({
        ok: true,
        progress: {
          status: 'awaiting_user_resume',
          phase: 'importing',
          currentStorageState: 'machine_only',
          checkpoint: {
            importedItemCount: 0,
          },
        },
      });
      if (!interruptedResponse.ok) {
        throw new Error('Expected a known interrupted materialization reference.');
      }
      const known = interruptedResponse.progress;
      await expect(db.sessionMessage.count({ where: { sessionId: session.id } }))
        .resolves.toBe(150);

      const effectsBeforePassiveRestart = {
        sourceReadCount,
        commandCount: commandKinds.length,
      };
      await activeRpc.dispose();
      activeRpc = null;
      activeRpc = registerMaterializeRpcExecutor({
        activeServerDir,
        configuredSource: request.source,
        executor: createRestartableExecutor(),
      });
      await expect(activeRpc.invoke(
        RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET,
        {
          sessionId: request.sessionId,
          operationId: known.operationId,
          revision: known.revision,
        },
      )).resolves.toMatchObject({
        ok: true,
        progress: {
          status: 'awaiting_user_resume',
          phase: 'importing',
        },
      });
      expect({
        sourceReadCount,
        commandCount: commandKinds.length,
      }).toEqual(effectsBeforePassiveRestart);

      const completed = await activeRpc.invoke(
        RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME,
        {
          sessionId: request.sessionId,
          operationId: known.operationId,
          revision: known.revision,
        },
      );
      expect(completed).toMatchObject({
        ok: true,
        progress: {
          status: 'completed',
          currentStorageState: 'snapshot_complete',
          checkpoint: {
            stagedItemCount: 450,
            importedItemCount: 450,
            acceptedThroughServerSeq: 450,
          },
        },
      });

      const rows = await db.sessionMessage.findMany({
        where: { sessionId: session.id },
        orderBy: { seq: 'asc' },
        select: {
          seq: true,
          localId: true,
          sidechainId: true,
          content: true,
        },
      });
      expect(rows).toHaveLength(450);
      expect(rows.map((row) => row.seq)).toEqual(
        Array.from({ length: 450 }, (_, index) => index + 1),
      );
      expect(rows.map((row) => row.localId)).toEqual(
        chronologicalItems.map((item) => item.localId),
      );
      const semanticRow = rows[73]!;
      expect(semanticRow.sidechainId).toBe('sidechain:synthetic');
      expect(semanticRow.content).toMatchObject({
        t: 'plain',
        v: {
          sidechain: { parentId: 'synthetic-072', branch: 'analysis' },
          media: {
            kind: 'session_media.v1',
            payload: {
              failures: [{
                code: 'source_media_unavailable',
                name: 'synthetic-proof.png',
              }],
            },
          },
        },
      });
      expect(commandKinds.filter((kind) => kind === 'finalize')).toHaveLength(1);
      expect(await readdir(join(activeServerDir, 'external-session-operation-staging')))
        .toEqual([]);
    } finally {
      await activeRpc?.dispose();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.each([
    ['rewritten', 'source_changed'],
    ['unreachable', 'source_unavailable'],
  ] as const)(
    'preserves the prior SQLite publication when the synthetic Agent becomes %s before finalize',
    async (sourceFailure, expectedErrorCode) => {
      const activeServerDir = await mkdtemp(join(tmpdir(), `happier-materialize-${sourceFailure}-`));
      const account = await db.account.create({
        data: { publicKey: `materialize-${sourceFailure}-${randomUUID()}` },
        select: { id: true },
      });
      const machineId = `materialize-${sourceFailure}-machine-${randomUUID()}`;
      await db.machine.create({
        data: { id: machineId, accountId: account.id, metadata: '{}' },
      });
      const executeServerCommand = createOperationSocketSender({
        accountId: account.id,
        machineId,
      });
      const session = await db.session.create({
        data: {
          tag: `materialize-${sourceFailure}-${randomUUID()}`,
          accountId: account.id,
          metadata: 'metadata',
          encryptionMode: 'plain',
          currentStorageState: 'machine_only',
        },
        select: { id: true },
      });
      const priorClaim = {
        sessionId: session.id,
        operationId: `prior-${sourceFailure}`,
        operationClaimId: `prior-claim-${sourceFailure}`,
      };
      await expect(executeServerCommand({
        v: 1,
        kind: 'begin',
        claim: priorClaim,
        expectedRevision: 0,
        expectedPriorStableStorage: { state: 'machine_only' },
      })).resolves.toMatchObject({ kind: 'ready' });
      await expect(executeServerCommand({
        v: 1,
        kind: 'batch',
        claim: priorClaim,
        expectedRevision: 0,
        batchId: makeExternalSessionHistoricalImportBatchIdV1([
          'history:prior-published',
        ]),
        items: [historyItem('prior-published')],
      })).resolves.toMatchObject({
        kind: 'batch_accepted',
        acceptedThroughServerSeq: 1,
      });
      await expect(executeServerCommand({
        v: 1,
        kind: 'finalize',
        claim: priorClaim,
        expectedRevision: 0,
        expectedAcceptedThroughServerSeq: 1,
      })).resolves.toMatchObject({ kind: 'finalized' });
      const priorPublication = await db.session.findUniqueOrThrow({
        where: { id: session.id },
        select: {
          materializationPublicationId: true,
          materializedThroughSourceAt: true,
          publishedThroughServerSeq: true,
        },
      });
      const normalizedPriorPublication = {
        materializationPublicationId: priorPublication.materializationPublicationId!,
        materializedThroughSourceAt: Number(priorPublication.materializedThroughSourceAt!),
        publishedThroughServerSeq: priorPublication.publishedThroughServerSeq!,
      };
      const request = {
        v: 1 as const,
        idempotencyKey: `materialize-${sourceFailure}-catch-up`,
        sessionId: session.id,
        source: {
          machineId,
          remoteSessionId: `remote-${sourceFailure}`,
          qualifiedIdentity,
          linkGeneration: 'link-1',
          sourceGeneration: 'source-1',
          contributionGeneration: 'contribution-1',
        },
        plan: 'materialize' as const,
        targetStorageMode: 'external-linked' as const,
        targetRuntimeMode: null,
      };
      const publicRequest = {
        request: {
          v: request.v,
          idempotencyKey: request.idempotencyKey,
          sessionId: request.sessionId,
          plan: request.plan,
          targetStorageMode: request.targetStorageMode,
          targetRuntimeMode: request.targetRuntimeMode,
        },
      } satisfies ExternalSessionMaterializeStartInputV1;
      const currentCommandKinds: ExternalSessionOperationSocketCommandV1['kind'][] = [];
      const executor = createExternalSessionMaterializeActionExecutor({
        activeServerDir,
        operationExclusion: createExternalSessionOperationExclusion({
          activeServerDir,
          ownerId: `source-failure:${sourceFailure}`,
        }),
        staging: createExternalSessionOperationPrivateStagingStore({
          activeServerDir,
          limits: {
            perOperation: { maxItems: 20, maxBytes: 50_000 },
            aggregate: { maxItems: 40, maxBytes: 100_000 },
          },
        }),
        describeSource: async () => ({
          capturedSource: {
            sourceIdentity: `synthetic-agent:${sourceFailure}`,
            sourceGeneration: 'source-1',
            revision: 'revision-2',
            boundary: 'tail-new',
          },
          priorStableStorage: {
            state: 'snapshot_complete',
            publication: normalizedPriorPublication,
          },
          linkedSessionRevision: 2,
        }),
        revalidateSource: async (_request, capturedSource, sourceSnapshotEvidenceRef) => {
          expect(capturedSource).toMatchObject({
            sourceIdentity: `synthetic-agent:${sourceFailure}`,
            sourceGeneration: 'source-1',
          });
          expect(sourceSnapshotEvidenceRef).toBe('revision-2');
        },
        readNewestFirstPages: async function* () {
          yield {
            groupId: `new-page-${sourceFailure}`,
            items: [historyItem(`unpublished-${sourceFailure}`)],
            sourceRead: {
              availability: 'reachable',
              sourceIdentity: `synthetic-agent:${sourceFailure}`,
              sourceGeneration: 'source-1',
              revision: 'revision-2',
              relationshipToCapture: 'same',
              eof: true,
            },
          } as const;
        },
        readFinalCatchUpPages: async function* () {
          yield sourceFailure === 'rewritten'
            ? {
                groupId: 'source-rewritten-before-finalize',
                items: [],
                sourceRead: {
                  availability: 'reachable',
                  sourceIdentity: `synthetic-agent:${sourceFailure}`,
                  sourceGeneration: 'source-1',
                  revision: 'revision-rewritten',
                  relationshipToCapture: 'rewritten',
                  eof: false,
                },
              } as const
            : {
                groupId: 'source-deleted-before-finalize',
                items: [],
                sourceRead: { availability: 'unreachable' },
              } as const;
        },
        sendHistoricalCommand: async (command) => {
          currentCommandKinds.push(command.kind);
          return await executeServerCommand(command);
        },
      });

      let rpc: ReturnType<typeof registerMaterializeRpcExecutor> | null = null;
      try {
        rpc = registerMaterializeRpcExecutor({
          activeServerDir,
          configuredSource: request.source,
          executor,
        });
        const interrupted = await rpc.invoke(
          RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START,
          publicRequest,
        );
        expect(interrupted).toMatchObject({
          ok: true,
          progress: {
            status: 'awaiting_user_resume',
            phase: 'importing',
            currentStorageState: 'snapshot_complete',
            checkpoint: {
              importedItemCount: 1,
              acceptedThroughServerSeq: 2,
            },
            fence: {
              kind: 'incomplete_update',
              publication: normalizedPriorPublication,
            },
            error: {
              code: expectedErrorCode,
              retryable: true,
            },
          },
        });
        expect(currentCommandKinds.filter((kind) => kind === 'finalize')).toEqual([]);
        await expect(db.session.findUniqueOrThrow({
          where: { id: session.id },
          select: {
            currentStorageState: true,
            acceptedThroughServerSeq: true,
            materializationPublicationId: true,
            materializedThroughSourceAt: true,
            publishedThroughServerSeq: true,
            seq: true,
          },
        })).resolves.toEqual({
          currentStorageState: 'snapshot_complete',
          acceptedThroughServerSeq: null,
          materializationPublicationId: priorPublication.materializationPublicationId,
          materializedThroughSourceAt: priorPublication.materializedThroughSourceAt,
          publishedThroughServerSeq: 1,
          seq: 2,
        });
      } finally {
        await rpc?.dispose();
        await rm(activeServerDir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it('converges after finalize committed but its socket callback was lost', async () => {
    const fixture = await createFixture({
      id: 'finalize-loss',
      loseFirstCallbackFor: 'finalize',
    });
    try {
      const interrupted = await fixture.executor.start({ request: fixture.request });
      expect(interrupted).toMatchObject({
        ok: true,
        progress: { status: 'awaiting_user_resume', phase: 'importing' },
      });
      if (!interrupted.ok) throw new Error('Expected interrupted materialization.');

      const resumed = await fixture.executor.resume({
        sessionId: fixture.request.sessionId,
        operationId: interrupted.progress.operationId,
        revision: interrupted.progress.revision,
      });
      expect(resumed).toMatchObject({
        ok: true,
        progress: {
          status: 'completed',
          currentStorageState: 'snapshot_complete',
        },
      });
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);

  it('replays a lost discard callback and projects the server-confirmed machine-only terminal state', async () => {
    const fixture = await createFixture({
      id: 'discard-loss',
      loseFirstCallbackFor: 'discard',
      failSecondBatch: true,
    });
    try {
      const interrupted = await fixture.executor.start({ request: fixture.request });
      expect(interrupted).toMatchObject({
        ok: true,
        progress: {
          status: 'awaiting_user_resume',
          currentStorageState: 'server_partial',
        },
      });
      if (!interrupted.ok) throw new Error('Expected partial materialization.');

      await expect(fixture.executor.discard({
        sessionId: fixture.request.sessionId,
        operationId: interrupted.progress.operationId,
        revision: interrupted.progress.revision,
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_state' },
      });

      const discarded = await fixture.executor.discard({
        sessionId: fixture.request.sessionId,
        operationId: interrupted.progress.operationId,
        revision: interrupted.progress.revision,
      });
      if (!discarded.ok) {
        throw new Error(`Expected discard convergence: ${JSON.stringify(discarded.error)}`);
      }
      expect(discarded).toMatchObject({
        ok: true,
        progress: {
          status: 'discarded',
          currentStorageState: 'machine_only',
          checkpoint: {
            sourcePagesRead: 0,
            stagedItemCount: 0,
            importedItemCount: 0,
          },
          fence: { kind: 'none' },
        },
      });
      await expect(db.session.findUniqueOrThrow({
        where: { id: fixture.sessionId },
        select: {
          seq: true,
          currentStorageState: true,
          acceptedThroughServerSeq: true,
          publishedThroughServerSeq: true,
        },
      })).resolves.toEqual({
        seq: 2,
        currentStorageState: 'machine_only',
        acceptedThroughServerSeq: null,
        publishedThroughServerSeq: null,
      });
      await expect(db.sessionMessage.count({
        where: { sessionId: fixture.sessionId },
      })).resolves.toBe(0);
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);
});
