import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliDataKeyAuthForServer } from '../../src/testkit/cliAuth';
import {
  replaceTestDaemonWithoutStoppingSessions,
  startTestDaemon,
  type StartedDaemon,
} from '../../src/testkit/daemon/daemon';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import {
  createDataKeyRpcClient,
  unwrapDataKeyRpcResult,
} from '../../src/testkit/syntheticAgent/rpcClient';
import { sleep, waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });
const daemonStartupTimeoutMs = 90_000;
const transcriptRowCount = 241;
const transcriptPayloadPadding = 'x'.repeat(32 * 1024);

type JsonRecord = Record<string, unknown>;

type OperationProgress = Readonly<{
  operationId: string;
  revision: number;
  status: string;
  phase: string;
  currentStorageState: string;
  checkpoint: Readonly<{
    sourcePagesRead: number;
    stagedItemCount: number;
    importedItemCount: number;
    acceptedThroughServerSeq?: number;
  }>;
}>;

type StagingAcknowledgement = Readonly<{
  acceptedThroughServerSeq: number;
  manifestText: string;
}>;

type PrivatePublicationEvidence = Readonly<{
  publicationIdDigest: string;
  materializedThroughSourceAt: number;
  publishedThroughServerSeq: number;
}>;

type InitialStartSettlement =
  | Readonly<{ kind: 'returned'; result: unknown }>
  | Readonly<{ kind: 'failed'; error: unknown }>;

class EarlyMaterializeStartSettlementError extends Error {}
class UnexpectedMaterializeRecoveryStateError extends Error {}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function assertInitialStartPending(
  settlement: InitialStartSettlement | null,
): void {
  if (settlement === null) return;
  const detail = settlement.kind === 'returned'
    ? describeUnknown(settlement.result)
    : describeUnknown(settlement.error);
  throw new EarlyMaterializeStartSettlementError(
    `Materialize Start settled before a durable running/importing batch was observed (${settlement.kind}: ${detail}).`,
  );
}

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function rowMarker(index: number): string {
  return `materialize-restart-row-${index.toString().padStart(3, '0')}`;
}

function buildClaudeTranscript(): string {
  return Array.from({ length: transcriptRowCount }, (_, index) => {
    const marker = rowMarker(index);
    const common = {
      uuid: `materialize-restart-${index.toString().padStart(3, '0')}`,
      cwd: '/tmp/materialize-restart-project',
      timestamp: new Date(1_700_000_000_000 + index).toISOString(),
    };
    if (index % 2 === 0) {
      return jsonlLine({
        ...common,
        type: 'user',
        message: {
          content: `${marker}:${transcriptPayloadPadding}`,
        },
      });
    }
    return jsonlLine({
      ...common,
      type: 'assistant',
      message: {
        model: 'claude-test',
        content: [{
          type: 'text',
          text: `${marker}:${transcriptPayloadPadding}`,
        }],
      },
    });
  }).join('');
}

function requireRecord(value: unknown, context: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`Expected ${context} to be an object.`);
  return value;
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected ${context} to be a non-empty string.`);
  }
  return value;
}

function requireNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Expected ${context} to be a non-negative safe integer.`);
  }
  return value;
}

function privatePublicationEvidence(
  value: unknown,
  context: string,
): PrivatePublicationEvidence {
  const publication = requireRecord(value, context);
  const publicationId = requireString(
    publication.materializationPublicationId,
    `${context} publication id`,
  );
  return {
    publicationIdDigest: createHash('sha256')
      .update(publicationId, 'utf8')
      .digest('base64url'),
    materializedThroughSourceAt: requireNumber(
      publication.materializedThroughSourceAt,
      `${context} materialized source time`,
    ),
    publishedThroughServerSeq: requireNumber(
      publication.publishedThroughServerSeq,
      `${context} published sequence`,
    ),
  };
}

async function readDurableOperationEvidence(params: Readonly<{
  activeServerDir: string;
  operationId: string;
}>): Promise<Readonly<{
  sessionId: string;
  status: string;
  publication: PrivatePublicationEvidence;
}>> {
  const operationKey = createHash('sha256')
    .update(params.operationId, 'utf8')
    .digest('hex');
  const serialized = await readFile(join(
    params.activeServerDir,
    'external-session-operations',
    'records',
    `${operationKey}.json`,
  ), 'utf8');
  const record = requireRecord(
    JSON.parse(serialized) as unknown,
    'durable materialize operation',
  );
  const request = requireRecord(
    record.request,
    'durable materialize operation request',
  );
  return {
    sessionId: requireString(
      request.sessionId,
      'durable materialize operation session id',
    ),
    status: requireString(record.status, 'durable materialize operation status'),
    publication: privatePublicationEvidence(
      record.publication,
      'durable materialize operation publication',
    ),
  };
}

function readPrivateServerEvidence(params: Readonly<{
  dbPath: string;
  sessionId: string;
  operationId: string;
}>): Readonly<{
  publication: PrivatePublicationEvidence | null;
  pendingMessageCount: number;
  turnCount: number;
  historicalJobCount: number;
  historicalJobPriorStorageState: string | null;
  historicalJobState: string | null;
  historicalJobAcceptedThroughServerSeq: number | null;
}> {
  const database = new DatabaseSync(params.dbPath, { readOnly: true });
  try {
    const session = requireRecord(
      database.prepare(`
        SELECT materializationPublicationId,
               materializedThroughSourceAt,
               publishedThroughServerSeq
        FROM Session
        WHERE id = ?
      `).get(params.sessionId),
      'private materialized session row',
    );
    const publication = session.materializationPublicationId === null
      ? null
      : privatePublicationEvidence(
        session,
        'private materialized session publication',
      );
    const pending = requireRecord(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM SessionPendingMessage
        WHERE sessionId = ?
      `).get(params.sessionId),
      'private pending-message count',
    );
    const turns = requireRecord(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM SessionTurn
        WHERE sessionId = ?
      `).get(params.sessionId),
      'private turn count',
    );
    const historicalRows = database.prepare(`
      SELECT content
      FROM SessionSystemRecord
      WHERE sessionId = ?
        AND namespace = 'external_sessions'
        AND kind = 'historical_import'
        AND localId = ?
    `).all(
      params.sessionId,
      `historical-import:${params.operationId}`,
    ) as unknown[];
    const historicalJob = historicalRows.length === 1
      ? requireRecord(
        JSON.parse(requireString(
          requireRecord(
            historicalRows[0],
            'private historical-import row',
          ).content,
          'private historical-import content',
        )) as unknown,
        'private historical-import job',
      )
      : null;
    return {
      publication,
      pendingMessageCount: requireNumber(
        pending.count,
        'private pending-message count',
      ),
      turnCount: requireNumber(turns.count, 'private turn count'),
      historicalJobCount: historicalRows.length,
      historicalJobPriorStorageState:
        typeof historicalJob?.priorStorageState === 'string'
          ? historicalJob.priorStorageState
          : null,
      historicalJobState:
        typeof historicalJob?.state === 'string'
          ? historicalJob.state
          : null,
      historicalJobAcceptedThroughServerSeq:
        typeof historicalJob?.acceptedThroughServerSeq === 'number'
          ? historicalJob.acceptedThroughServerSeq
          : null,
    };
  } finally {
    database.close();
  }
}

function readOperationProgress(metadata: unknown): OperationProgress | null {
  if (!isRecord(metadata)) return null;
  const state = metadata.externalSessionOperationV1;
  if (!isRecord(state) || state.v !== 1 || !isRecord(state.progress)) return null;
  const progress = state.progress;
  if (
    typeof progress.operationId !== 'string'
    || typeof progress.revision !== 'number'
    || typeof progress.status !== 'string'
    || typeof progress.phase !== 'string'
    || typeof progress.currentStorageState !== 'string'
    || !isRecord(progress.checkpoint)
  ) {
    return null;
  }
  const checkpoint = progress.checkpoint;
  if (
    typeof checkpoint.sourcePagesRead !== 'number'
    || typeof checkpoint.stagedItemCount !== 'number'
    || typeof checkpoint.importedItemCount !== 'number'
  ) {
    return null;
  }
  if (Object.hasOwn(checkpoint, 'acknowledgedBatchId')) {
    throw new Error('Public operation progress leaked its private acknowledged batch id.');
  }
  return {
    operationId: progress.operationId,
    revision: progress.revision,
    status: progress.status,
    phase: progress.phase,
    currentStorageState: progress.currentStorageState,
    checkpoint: {
      sourcePagesRead: checkpoint.sourcePagesRead,
      stagedItemCount: checkpoint.stagedItemCount,
      importedItemCount: checkpoint.importedItemCount,
      ...(typeof checkpoint.acceptedThroughServerSeq === 'number'
        ? { acceptedThroughServerSeq: checkpoint.acceptedThroughServerSeq }
        : {}),
    },
  };
}

async function fetchPlainSessionMetadataV2(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
}>): Promise<JsonRecord> {
  const session = await fetchSessionV2(
    params.baseUrl,
    params.token,
    params.sessionId,
  );
  let metadata: unknown;
  try {
    metadata = JSON.parse(session.metadata) as unknown;
  } catch {
    throw new Error(`Expected plain session metadata JSON (${params.sessionId}).`);
  }
  return requireRecord(metadata, `plain session metadata (${params.sessionId})`);
}

async function readStagingAcknowledgement(params: Readonly<{
  activeServerDir: string;
  operationId: string;
}>): Promise<StagingAcknowledgement | null> {
  const operationKey = createHash('sha256')
    .update(params.operationId, 'utf8')
    .digest('hex');
  const manifestPath = join(
    params.activeServerDir,
    'external-session-operation-staging',
    operationKey,
    'manifest.json',
  );
  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.operationId !== params.operationId) return null;
  if (!Array.isArray(parsed.groups)) return null;
  const acknowledged = parsed.groups
    .filter((group): group is JsonRecord =>
      isRecord(group)
      && group.state === 'acknowledged'
      && typeof group.acceptedThroughServerSeq === 'number'
      && Number.isSafeInteger(group.acceptedThroughServerSeq)
      && group.acceptedThroughServerSeq >= 0,
    )
    .map((group) => group.acceptedThroughServerSeq as number);
  if (acknowledged.length === 0) return null;
  return {
    acceptedThroughServerSeq: Math.max(...acknowledged),
    manifestText,
  };
}

async function fetchPublicMessages(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
}>): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [];
  let afterSeq = 0;
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const response = await fetchJson<{
      messages?: unknown;
      nextAfterSeq?: unknown;
    }>(
      `${params.baseUrl}/v1/sessions/${params.sessionId}/messages?afterSeq=${afterSeq}&limit=200`,
      {
        headers: { Authorization: `Bearer ${params.token}` },
        timeoutMs: 30_000,
      },
    );
    if (response.status !== 200 || !Array.isArray(response.data?.messages)) {
      throw new Error(`Failed to read public materialized transcript (status=${response.status}).`);
    }
    rows.push(...response.data.messages.map((row, index) =>
      requireRecord(row, `public transcript page ${pageIndex} row ${index}`),
    ));
    const nextAfterSeq = response.data.nextAfterSeq;
    if (typeof nextAfterSeq !== 'number') return rows;
    if (!Number.isSafeInteger(nextAfterSeq) || nextAfterSeq <= afterSeq) {
      throw new Error('Public transcript pagination did not advance.');
    }
    afterSeq = nextAfterSeq;
  }
  throw new Error('Public transcript pagination exceeded its test bound.');
}

describe('core e2e: External Sessions Claude materialize restart recovery', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  it.each([
    {
      recovery: 'resume' as const,
      description: 'then exact-current Resume publishes one gapless snapshot',
    },
    {
      recovery: 'discard' as const,
      description: 'then source replacement is fenced and exact-current Discard removes the initial partial',
    },
  ])(
    'stays passive after a committed batch $description',
    async ({ recovery }) => {
    const testDir = run.testDir(
      `external-sessions-claude-materialize-restart-recovery-${recovery}`,
    );
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const claudeConfigDir = resolve(join(testDir, '.claude'));
    const projectId = 'proj-materialize-restart';
    const remoteSessionId = 'sess-materialize-restart';
    const claudeSessionFile = resolve(
      join(claudeConfigDir, 'projects', projectId, `${remoteSessionId}.jsonl`),
    );

    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(join(claudeConfigDir, 'projects', projectId), { recursive: true });
    await writeFile(claudeSessionFile, buildClaudeTranscript(), 'utf8');

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
      },
    });
    const auth = await createTestAuth(server.baseUrl);
    const machineKey = Uint8Array.from(randomBytes(32));
    const seeded = await seedCliDataKeyAuthForServer({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      machineKey,
    });
    const daemonEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_CLAUDE_CONFIG_DIR: claudeConfigDir,
      HAPPIER_DIRECT_SESSIONS_PAGE_MAX_ITEMS: '5',
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
    };
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      startupTimeoutMs: daemonStartupTimeoutMs,
      env: daemonEnv,
    });
    const originalDaemonPid = daemon.state.pid;

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();

    try {
      await waitFor(() => ui.isConnected(), {
        timeoutMs: 20_000,
        context: 'socket connected for materialize restart recovery',
      });
      const machineRpc = createDataKeyRpcClient(ui, machineKey);
      const route = (method: string): string => `${seeded.machineId}:${method}`;
      const source = {
        kind: 'claudeConfig',
        configDir: claudeConfigDir,
        projectId,
      } as const;

      await waitFor(
        async () => {
          const candidates = await machineRpc.call(
            route(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST),
            {
              machineId: seeded.machineId,
              providerId: 'claude',
              source,
              limit: 20,
            },
          );
          if (!candidates.ok || !isRecord(candidates.result)) return false;
          return Array.isArray(candidates.result.candidates)
            && candidates.result.candidates.some(
              (candidate) =>
                isRecord(candidate)
                && candidate.remoteSessionId === remoteSessionId,
            );
        },
        {
          timeoutMs: 30_000,
          context: 'materialize Claude source candidate available',
        },
      );

      const link = await machineRpc.call(
        route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE),
        {
          machineId: seeded.machineId,
          providerId: 'claude',
          remoteSessionId,
          titleHint: 'Materialize restart recovery fixture',
          directoryHint: '/tmp/materialize-restart-project',
          source,
        },
      );
      const linkResult = requireRecord(
        unwrapDataKeyRpcResult(link, 'materialize restart linked session'),
        'materialize link result',
      );
      expect(linkResult).toEqual(expect.objectContaining({
        ok: true,
        created: true,
      }));
      const sessionId = requireString(linkResult.sessionId, 'linked session id');

      const request = {
        v: 1 as const,
        idempotencyKey: `materialize-restart-${randomUUID()}`,
        sessionId,
        plan: 'materialize' as const,
        targetStorageMode: 'external-linked' as const,
        targetRuntimeMode: null,
      };

      let initialStartSettlement: InitialStartSettlement | null = null;
      void machineRpc.call(
        route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START),
        { request },
        180_000,
      ).then(
        (result) => {
          initialStartSettlement = { kind: 'returned', result };
        },
        (error: unknown) => {
          initialStartSettlement = { kind: 'failed', error };
        },
      );

      const committedPartialObservation: {
        session: Awaited<ReturnType<typeof fetchSessionV2>> | null;
        staging: StagingAcknowledgement | null;
        progress: OperationProgress | null;
      } = { session: null, staging: null, progress: null };
      await waitFor(
        async () => {
          assertInitialStartPending(initialStartSettlement);
          const [session, metadata] = await Promise.all([
            fetchSessionV2(server!.baseUrl, auth.token, sessionId),
            fetchPlainSessionMetadataV2({
              baseUrl: server!.baseUrl,
              token: auth.token,
              sessionId,
            }),
          ]);
          const progress = readOperationProgress(metadata);
          const accepted = session.acceptedThroughServerSeq;
          const staging = progress
            ? await readStagingAcknowledgement({
                activeServerDir: join(daemonHomeDir, 'servers', seeded.serverId),
                operationId: progress.operationId,
              })
            : null;
          if (
            session.currentStorageState === 'server_partial'
            && typeof accepted === 'number'
            && accepted > 0
            && accepted < transcriptRowCount
            && progress?.status === 'running'
            && progress.phase === 'importing'
            && staging?.acceptedThroughServerSeq === accepted
          ) {
            assertInitialStartPending(initialStartSettlement);
            committedPartialObservation.session = session;
            committedPartialObservation.staging = staging;
            committedPartialObservation.progress = progress;
            return true;
          }
          return false;
        },
        {
          timeoutMs: 120_000,
          intervalMs: 1,
          shouldRetryOnError: (error) =>
            !(error instanceof EarlyMaterializeStartSettlementError),
          context: 'acknowledged bounded materialize batch committed before finalize',
        },
      );
      const replacement = await replaceTestDaemonWithoutStoppingSessions({
        testDir,
        happyHomeDir: daemonHomeDir,
        env: daemonEnv,
        originalDaemon: daemon,
      });
      expect(replacement.pid).not.toBe(originalDaemonPid);

      const committedPartial = committedPartialObservation.session;
      const committedStaging = committedPartialObservation.staging;
      const committedProgress = committedPartialObservation.progress;
      if (
        committedPartial === null
        || committedStaging === null
        || committedProgress === null
      ) {
        throw new Error('Missing committed partial materialize session observation.');
      }
      expect(committedPartial).toEqual(expect.objectContaining({
        currentStorageState: 'server_partial',
        acceptedThroughServerSeq: expect.any(Number),
        publishedThroughServerSeq: null,
      }));
      const committedPartialRows = await fetchPublicMessages({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
      });
      const committedAcceptedThrough = requireNumber(
        committedPartial.acceptedThroughServerSeq,
        'committed partial accepted sequence',
      );
      expect(committedStaging.acceptedThroughServerSeq).toBe(committedAcceptedThrough);
      expect(committedPartialRows.length).toBeGreaterThanOrEqual(committedAcceptedThrough);
      const committedPartialPrefix = committedPartialRows.slice(0, committedAcceptedThrough);
      expect(committedPartialPrefix.map((row) => row.seq)).toEqual(
        Array.from({ length: committedAcceptedThrough }, (_, index) => index + 1),
      );
      expect(committedPartialPrefix.map((row) =>
        JSON.stringify(row.content).match(/materialize-restart-row-\d{3}/u)?.[0],
      )).toEqual(
        Array.from({ length: committedAcceptedThrough }, (_, index) => rowMarker(index)),
      );

      await waitFor(
        async () => {
          const metadata = await fetchPlainSessionMetadataV2({
            baseUrl: server!.baseUrl,
            token: auth.token,
            sessionId,
          });
          const progress = readOperationProgress(metadata);
          if (
            progress
            && progress.operationId !== committedProgress.operationId
          ) {
            throw new UnexpectedMaterializeRecoveryStateError(
              `Restart projected a different materialize operation (${progress.operationId}).`,
            );
          }
          if (
            progress?.status === 'awaiting_user_resume'
            && progress.phase === 'importing'
          ) {
            return true;
          }
          if (
            progress?.operationId === committedProgress.operationId
            && progress.status !== 'running'
          ) {
            throw new UnexpectedMaterializeRecoveryStateError(
              `Restart settled materialize recovery at ${progress.status}/${progress.phase} instead of awaiting_user_resume/importing.`,
            );
          }
          return false;
        },
        {
          timeoutMs: 60_000,
          shouldRetryOnError: (error) =>
            !(error instanceof UnexpectedMaterializeRecoveryStateError),
          context: 'reconstructed daemon publishes awaiting_user_resume',
        },
      );
      const awaiting = readOperationProgress(await fetchPlainSessionMetadataV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
      }));
      if (!awaiting) throw new Error('Missing awaiting materialize operation progress.');

      const passiveSessionBefore = await fetchSessionV2(
        server.baseUrl,
        auth.token,
        sessionId,
      );
      expect(passiveSessionBefore.currentStorageState).toBe('server_partial');
      const passiveAcceptedThrough = requireNumber(
        passiveSessionBefore.acceptedThroughServerSeq,
        'passive partial accepted sequence',
      );
      expect(passiveAcceptedThrough).toBeGreaterThan(0);
      expect(passiveAcceptedThrough).toBeLessThan(transcriptRowCount);
      expect(passiveAcceptedThrough).toBeGreaterThanOrEqual(committedAcceptedThrough);
      const passiveRowsBefore = await fetchPublicMessages({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
      });
      expect(passiveRowsBefore).toHaveLength(passiveAcceptedThrough);
      expect(passiveRowsBefore.map((row) => row.seq)).toEqual(
        Array.from({ length: passiveAcceptedThrough }, (_, index) => index + 1),
      );
      expect(passiveRowsBefore.map((row) =>
        JSON.stringify(row.content).match(/materialize-restart-row-\d{3}/u)?.[0],
      )).toEqual(
        Array.from({ length: passiveAcceptedThrough }, (_, index) => rowMarker(index)),
      );
      const passiveStagingBefore = await readStagingAcknowledgement({
        activeServerDir: join(daemonHomeDir, 'servers', seeded.serverId),
        operationId: awaiting.operationId,
      });
      if (!passiveStagingBefore) {
        throw new Error('Missing durable staging acknowledgement after daemon reconstruction.');
      }
      const effectsBeforePassiveActions = {
        checkpoint: awaiting.checkpoint,
        stagingManifest: passiveStagingBefore.manifestText,
        session: {
          currentStorageState: passiveSessionBefore.currentStorageState,
          acceptedThroughServerSeq: passiveSessionBefore.acceptedThroughServerSeq,
          publishedThroughServerSeq: passiveSessionBefore.publishedThroughServerSeq,
        },
      };
      const serverDbPath = join(
        server.dataDir,
        'happier-server-light.sqlite',
      );
      const privatePassiveEvidence = readPrivateServerEvidence({
        dbPath: serverDbPath,
        sessionId,
        operationId: awaiting.operationId,
      });
      expect(privatePassiveEvidence).toEqual({
        publication: null,
        pendingMessageCount: 0,
        turnCount: 0,
        historicalJobCount: 1,
        historicalJobPriorStorageState: 'machine_only',
        historicalJobState: 'importing',
        historicalJobAcceptedThroughServerSeq: passiveAcceptedThrough,
      });
      expect(passiveSessionBefore).not.toHaveProperty(
        'materializationPublicationId',
      );

      const staleResume = await machineRpc.call(
        route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME),
        {
          sessionId,
          operationId: awaiting.operationId,
          revision: awaiting.revision - 1,
        },
      );
      expect(unwrapDataKeyRpcResult(staleResume, 'stale materialize Resume'))
        .toEqual(expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'stale_revision' }),
        }));

      const duplicateStartResults = await Promise.all([
        machineRpc.call(
          route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START),
          { request },
        ),
        machineRpc.call(
          route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START),
          { request },
        ),
      ]);
      for (const [index, result] of duplicateStartResults.entries()) {
        expect(unwrapDataKeyRpcResult(result, `duplicate materialize Start ${index}`))
          .toEqual(expect.objectContaining({
            ok: true,
            progress: expect.objectContaining({
              operationId: awaiting.operationId,
              revision: awaiting.revision,
              status: 'awaiting_user_resume',
            }),
          }));
      }

      const competingStart = await machineRpc.call(
        route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START),
        {
          request: {
            ...request,
            idempotencyKey: `${request.idempotencyKey}-changed-request`,
          },
        },
      );
      expect(unwrapDataKeyRpcResult(
        competingStart,
        'competing materialize Start',
      )).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'operation_conflict' }),
      }));

      const wrongSessionResume = await machineRpc.call(
        route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME),
        {
          sessionId: randomUUID(),
          operationId: awaiting.operationId,
          revision: awaiting.revision,
        },
      );
      expect(unwrapDataKeyRpcResult(
        wrongSessionResume,
        'cross-session materialize Resume',
      )).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'operation_not_found' }),
      }));

      const secondUi = createUserScopedSocketCollector(server.baseUrl, auth.token);
      secondUi.connect();
      try {
        await waitFor(() => secondUi.isConnected(), {
          timeoutMs: 20_000,
          context: 'second client connected for passive materialize hydration',
        });
        const secondMachineRpc = createDataKeyRpcClient(secondUi, machineKey);
        const passiveStatuses = await Promise.all([
          machineRpc.call(
            route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET),
            {
              sessionId,
              operationId: awaiting.operationId,
              revision: awaiting.revision,
            },
          ),
          secondMachineRpc.call(
            route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET),
            {
              sessionId,
              operationId: awaiting.operationId,
              revision: awaiting.revision,
            },
          ),
        ]);
        for (const [index, status] of passiveStatuses.entries()) {
          expect(unwrapDataKeyRpcResult(
            status,
            `passive materialize status client ${index}`,
          )).toEqual(expect.objectContaining({
            ok: true,
            progress: expect.objectContaining({
              operationId: awaiting.operationId,
              revision: awaiting.revision,
              status: 'awaiting_user_resume',
              phase: 'importing',
            }),
          }));
        }
      } finally {
        secondUi.close();
      }

      await sleep(1_000);
      const passiveMetadata = await fetchPlainSessionMetadataV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
      });
      const passiveProgress = readOperationProgress(passiveMetadata);
      const passiveSession = await fetchSessionV2(
        server.baseUrl,
        auth.token,
        sessionId,
      );
      expect({
        checkpoint: passiveProgress?.checkpoint,
        stagingManifest: (await readStagingAcknowledgement({
          activeServerDir: join(daemonHomeDir, 'servers', seeded.serverId),
          operationId: awaiting.operationId,
        }))?.manifestText,
        session: {
          currentStorageState: passiveSession.currentStorageState,
          acceptedThroughServerSeq: passiveSession.acceptedThroughServerSeq,
          publishedThroughServerSeq: passiveSession.publishedThroughServerSeq,
        },
      }).toEqual(effectsBeforePassiveActions);
      const passiveRows = await fetchPublicMessages({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
      });
      expect(passiveRows).toHaveLength(
        requireNumber(
          passiveSession.acceptedThroughServerSeq,
          'passive partial accepted sequence',
        ),
      );
      expect(passiveRows.map((row) => row.localId))
        .toEqual(passiveRowsBefore.map((row) => row.localId));

      if (recovery === 'discard') {
        await writeFile(
          claudeSessionFile,
          jsonlLine({
            uuid: 'materialize-restart-replacement',
            cwd: '/tmp/materialize-restart-project',
            timestamp: new Date(1_800_000_000_000).toISOString(),
            type: 'user',
            message: { content: 'replacement-source-generation' },
          }),
          'utf8',
        );
        const refusedResume = await machineRpc.call(
          route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME),
          {
            sessionId,
            operationId: awaiting.operationId,
            revision: awaiting.revision,
          },
          180_000,
        );
        const refusedResumeResult = requireRecord(
          unwrapDataKeyRpcResult(
            refusedResume,
            'source-replaced materialize Resume',
          ),
          'source-replaced materialize Resume',
        );
        expect(refusedResumeResult).toEqual(expect.objectContaining({
          ok: true,
          progress: expect.objectContaining({
            operationId: awaiting.operationId,
            status: 'awaiting_user_resume',
            phase: 'importing',
            currentStorageState: 'server_partial',
            error: expect.objectContaining({ code: 'source_changed' }),
          }),
        }));
        const refusedProgress = requireRecord(
          refusedResumeResult.progress,
          'source-replaced materialize progress',
        );
        const refusedRevision = requireNumber(
          refusedProgress.revision,
          'source-replaced materialize revision',
        );
        const beforeDiscard = await fetchSessionV2(
          server.baseUrl,
          auth.token,
          sessionId,
        );
        expect(beforeDiscard).toEqual(expect.objectContaining({
          currentStorageState: 'server_partial',
          acceptedThroughServerSeq: passiveAcceptedThrough,
          publishedThroughServerSeq: null,
        }));
        expect((await fetchPublicMessages({
          baseUrl: server.baseUrl,
          token: auth.token,
          sessionId,
        })).map((row) => row.localId)).toEqual(
          passiveRowsBefore.map((row) => row.localId),
        );

        const discard = await machineRpc.call(
          route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_DISCARD),
          {
            sessionId,
            operationId: awaiting.operationId,
            revision: refusedRevision,
          },
          180_000,
        );
        const discardResult = requireRecord(
          unwrapDataKeyRpcResult(discard, 'initial-partial materialize Discard'),
          'initial-partial materialize Discard',
        );
        expect(discardResult).toEqual(expect.objectContaining({
          ok: true,
          progress: expect.objectContaining({
            operationId: awaiting.operationId,
            status: 'discarded',
            currentStorageState: 'machine_only',
            checkpoint: expect.objectContaining({
              sourcePagesRead: 0,
              stagedItemCount: 0,
              importedItemCount: 0,
            }),
          }),
        }));
        const discardProgress = requireRecord(
          discardResult.progress,
          'discarded materialize progress',
        );
        const discardRevision = requireNumber(
          discardProgress.revision,
          'discarded materialize revision',
        );
        const discardedSession = await fetchSessionV2(
          server.baseUrl,
          auth.token,
          sessionId,
        );
        expect(discardedSession).toEqual(expect.objectContaining({
          currentStorageState: 'machine_only',
          acceptedThroughServerSeq: null,
          publishedThroughServerSeq: null,
        }));
        expect(await fetchPublicMessages({
          baseUrl: server.baseUrl,
          token: auth.token,
          sessionId,
        })).toEqual([]);
        expect(await readStagingAcknowledgement({
          activeServerDir: join(daemonHomeDir, 'servers', seeded.serverId),
          operationId: awaiting.operationId,
        })).toBeNull();
        expect(readPrivateServerEvidence({
          dbPath: serverDbPath,
          sessionId,
          operationId: awaiting.operationId,
        })).toEqual({
          publication: null,
          pendingMessageCount: 0,
          turnCount: 0,
          historicalJobCount: 1,
          historicalJobPriorStorageState: 'machine_only',
          historicalJobState: 'discarded',
          historicalJobAcceptedThroughServerSeq: null,
        });

        const duplicateDiscard = await machineRpc.call(
          route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_DISCARD),
          {
            sessionId,
            operationId: awaiting.operationId,
            revision: discardRevision,
          },
        );
        expect(unwrapDataKeyRpcResult(
          duplicateDiscard,
          'duplicate completed materialize Discard',
        )).toEqual(discardResult);
        return;
      }

      const currentResume = {
        sessionId,
        operationId: awaiting.operationId,
        revision: awaiting.revision,
      };
      const resumeResults = await Promise.all([
        machineRpc.call(
          route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME),
          currentResume,
          180_000,
        ),
        machineRpc.call(
          route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME),
          currentResume,
          180_000,
        ),
      ]);
      const resumeActions = resumeResults.map((result, index) =>
        requireRecord(
          unwrapDataKeyRpcResult(result, `duplicate exact-current Resume ${index}`),
          `duplicate exact-current Resume ${index}`,
        ),
      );
      expect(resumeActions.some((result) => result.ok === true)).toBe(true);
      for (const result of resumeActions) {
        if (result.ok === true) continue;
        const error = requireRecord(result.error, 'duplicate Resume convergence error');
        expect(['operation_conflict', 'stale_revision', 'invalid_state'])
          .toContain(error.code);
      }

      await waitFor(
        async () => {
          const metadata = await fetchPlainSessionMetadataV2({
            baseUrl: server!.baseUrl,
            token: auth.token,
            sessionId,
          });
          const progress = readOperationProgress(metadata);
          if (
            progress?.operationId === awaiting.operationId
            && progress.status === 'completed'
            && progress.currentStorageState === 'snapshot_complete'
          ) {
            return true;
          }
          return false;
        },
        {
          timeoutMs: 120_000,
          context: 'materialize completes after exact-current Resume',
        },
      );
      const completedProgress = readOperationProgress(await fetchPlainSessionMetadataV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
      }));
      expect(completedProgress?.checkpoint).toEqual(expect.objectContaining({
        stagedItemCount: transcriptRowCount,
        importedItemCount: transcriptRowCount,
        acceptedThroughServerSeq: transcriptRowCount,
      }));

      const finalSession = await fetchSessionV2(
        server.baseUrl,
        auth.token,
        sessionId,
      );
      expect(finalSession).toEqual(expect.objectContaining({
        id: sessionId,
        currentStorageState: 'snapshot_complete',
        acceptedThroughServerSeq: null,
        publishedThroughServerSeq: transcriptRowCount,
        materializedThroughSourceAt: expect.any(Number),
        pendingCount: 0,
      }));
      expect(finalSession).not.toHaveProperty('materializationPublicationId');

      const rows = await fetchPublicMessages({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
      });
      expect(rows).toHaveLength(transcriptRowCount);
      expect(rows.map((row) => row.seq)).toEqual(
        Array.from({ length: transcriptRowCount }, (_, index) => index + 1),
      );
      const localIds = rows.map((row) =>
        requireString(row.localId, 'materialized historical local id'),
      );
      expect(new Set(localIds).size).toBe(transcriptRowCount);
      expect(rows.map((row) => {
        const serialized = JSON.stringify(row.content);
        return serialized.match(/materialize-restart-row-\d{3}/u)?.[0];
      })).toEqual(
        Array.from({ length: transcriptRowCount }, (_, index) => rowMarker(index)),
      );
      const activeServerDir = join(
        daemonHomeDir,
        'servers',
        seeded.serverId,
      );
      const durableOperation = await readDurableOperationEvidence({
        activeServerDir,
        operationId: awaiting.operationId,
      });
      const privateFinalEvidence = readPrivateServerEvidence({
        dbPath: serverDbPath,
        sessionId,
        operationId: awaiting.operationId,
      });
      expect({
        sameLogicalSession: durableOperation.sessionId === sessionId,
        durableStatus: durableOperation.status,
        publicationMatches:
          durableOperation.publication.publicationIdDigest
            === privateFinalEvidence.publication?.publicationIdDigest
          && durableOperation.publication.materializedThroughSourceAt
            === privateFinalEvidence.publication?.materializedThroughSourceAt
          && durableOperation.publication.publishedThroughServerSeq
            === privateFinalEvidence.publication?.publishedThroughServerSeq,
        pendingMessageCount: privateFinalEvidence.pendingMessageCount,
        turnCount: privateFinalEvidence.turnCount,
        historicalJobCount: privateFinalEvidence.historicalJobCount,
        historicalJobPriorStorageState:
          privateFinalEvidence.historicalJobPriorStorageState,
        historicalJobState: privateFinalEvidence.historicalJobState,
        historicalJobAcceptedThroughServerSeq:
          privateFinalEvidence.historicalJobAcceptedThroughServerSeq,
      }).toEqual({
        sameLogicalSession: true,
        durableStatus: 'completed',
        publicationMatches: true,
        pendingMessageCount: 0,
        turnCount: 0,
        historicalJobCount: 1,
        historicalJobPriorStorageState: 'machine_only',
        historicalJobState: 'finalized',
        historicalJobAcceptedThroughServerSeq: transcriptRowCount,
      });

      const duplicateCompletedStart = await machineRpc.call(
        route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START),
        { request },
      );
      expect(unwrapDataKeyRpcResult(
        duplicateCompletedStart,
        'duplicate completed materialize Start',
      )).toEqual(expect.objectContaining({
        ok: true,
        progress: expect.objectContaining({
          operationId: awaiting.operationId,
          status: 'completed',
          currentStorageState: 'snapshot_complete',
        }),
      }));
      const duplicateFinalSession = await fetchSessionV2(
        server.baseUrl,
        auth.token,
        sessionId,
      );
      expect(duplicateFinalSession).toEqual(expect.objectContaining({
        id: sessionId,
        currentStorageState: finalSession.currentStorageState,
        acceptedThroughServerSeq: finalSession.acceptedThroughServerSeq,
        publishedThroughServerSeq: finalSession.publishedThroughServerSeq,
        materializedThroughSourceAt: finalSession.materializedThroughSourceAt,
        pendingCount: 0,
      }));
      expect(duplicateFinalSession).not.toHaveProperty(
        'materializationPublicationId',
      );
      const duplicatePrivateFinalEvidence = readPrivateServerEvidence({
        dbPath: serverDbPath,
        sessionId,
        operationId: awaiting.operationId,
      });
      expect({
        publicationUnchanged:
          duplicatePrivateFinalEvidence.publication?.publicationIdDigest
            === privateFinalEvidence.publication?.publicationIdDigest
          && duplicatePrivateFinalEvidence.publication?.materializedThroughSourceAt
            === privateFinalEvidence.publication?.materializedThroughSourceAt
          && duplicatePrivateFinalEvidence.publication?.publishedThroughServerSeq
            === privateFinalEvidence.publication?.publishedThroughServerSeq,
        pendingMessageCount: duplicatePrivateFinalEvidence.pendingMessageCount,
        turnCount: duplicatePrivateFinalEvidence.turnCount,
        historicalJobCount: duplicatePrivateFinalEvidence.historicalJobCount,
        historicalJobState: duplicatePrivateFinalEvidence.historicalJobState,
      }).toEqual({
        publicationUnchanged: true,
        pendingMessageCount: 0,
        turnCount: 0,
        historicalJobCount: 1,
        historicalJobState: 'finalized',
      });
      const duplicateRows = await fetchPublicMessages({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
      });
      expect(duplicateRows.map((row) => row.localId)).toEqual(localIds);
      expect(await readStagingAcknowledgement({
        activeServerDir,
        operationId: awaiting.operationId,
      })).toBeNull();

    } finally {
      ui.close();
    }
    },
    360_000,
  );
});
