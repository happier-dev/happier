import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  projectExternalSessionOperationSharedPresentationV1,
  type ExternalSessionOperationProgressV1,
  type ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol/sessions';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import {
  replaceTestDaemonWithoutStoppingSessions,
  startTestDaemon,
  type StartedDaemon,
} from '../../src/testkit/daemon/daemon';
import { fetchJson } from '../../src/testkit/http';
import {
  readExternalSessionOperationTerminalReceipt,
  readImportingMaterializeProgressPatch,
  readPlainSessionOwnerOperationProgress,
} from '../../src/testkit/externalSessionOperationProgressPatch';
import {
  buildPreAttestedExternalSessionLiveEnv,
} from '../../src/testkit/externalSessionLiveLifecycleFixture';
import {
  startHttpRequestRecordingProxy,
  type HttpRequestRecordingProxy,
} from '../../src/testkit/httpRequestRecordingProxy';
import {
  renderServerLightSqliteDatabaseUrl,
  resolveTestDbProvider,
  startServerLight,
  type StartedServer,
} from '../../src/testkit/process/serverLight';
import {
  readServerLightMaterializationRows,
  type ServerLightQueryableDbProvider,
} from '../../src/testkit/process/serverLightDatabase';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import {
  createMachineRpcClient,
  unwrapDataKeyRpcResult,
} from '../../src/testkit/syntheticAgent/rpcClient';
import { sleep, waitFor } from '../../src/testkit/timing';
import { withTimeoutMs } from '../../src/testkit/timing/withTimeout';

const run = createRunDirs({ runLabel: 'core' });
const suiteDbProvider = resolveTestDbProvider(process.env, {
  fallbackProvider: 'sqlite',
});
const transcriptRowCount = 1_001;
const childThreadId = '22222222-2222-2222-2222-222222222222';

type JsonRecord = Record<string, unknown>;

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
  return 'materialize-restart-row-' + index.toString().padStart(4, '0');
}

function buildCodexRolloutTranscripts(params: Readonly<{
  remoteSessionId: string;
  childThreadId: string;
  rootFileRelPath: string;
  childFileRelPath: string;
}>): Readonly<{
  root: string;
  child: string;
  expectedLocalIds: readonly string[];
  expectedSidechainIds: readonly (string | null)[];
  expectedMessageRoles: readonly ('user' | 'agent' | 'event')[];
}> {
  const baseMs = Date.UTC(2026, 6, 28, 0, 0, 0);
  const timestamp = (offsetMs: number): string =>
    new Date(baseMs + offsetMs).toISOString();
  const rootLines = [
    jsonlLine({
      type: 'session_meta',
      timestamp: timestamp(0),
      payload: {
        id: params.remoteSessionId,
        timestamp: timestamp(0),
        cwd: '/tmp/materialize-restart-project',
      },
    }),
    jsonlLine({
      type: 'event_msg',
      timestamp: timestamp(1),
      payload: {
        type: 'collab_agent_spawn_end',
        new_thread_id: params.childThreadId,
        new_agent_nickname: 'Child',
        new_agent_role: 'explorer',
        prompt: 'inspect the materialize fixture',
      },
    }),
  ];
  const childLines = [
    jsonlLine({
      type: 'session_meta',
      timestamp: timestamp(0),
      payload: {
        id: params.childThreadId,
        session_id: params.remoteSessionId,
        timestamp: timestamp(0),
        cwd: '/tmp/materialize-restart-project',
      },
    }),
    // Child-stream user actions are intentionally not projected as transcript rows.
    jsonlLine({
      type: 'response_item',
      timestamp: timestamp(2),
      payload: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'child user input stays suppressed',
        }],
      },
    }),
  ];
  let rootOffsetBytes = Buffer.byteLength(rootLines.join(''), 'utf8');
  let childOffsetBytes = Buffer.byteLength(childLines.join(''), 'utf8');
  const expectedLocalIds: string[] = [];
  const expectedSidechainIds: Array<string | null> = [];
  const expectedMessageRoles: Array<'user' | 'agent' | 'event'> = [];

  for (let index = 0; index < transcriptRowCount; index += 1) {
    const marker = rowMarker(index);
    const rowKind = index % 3;
    const isChildStream = rowKind === 1;
    const line = jsonlLine({
      type: 'response_item',
      timestamp: timestamp(1_000 + index),
      payload: rowKind === 0
        ? {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: marker }],
          }
        : rowKind === 1
          ? {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: marker }],
            }
          : {
              type: 'function_call',
              name: 'exec_command',
              arguments: JSON.stringify({ cmd: 'echo ' + marker }),
              call_id:
                'materialize-restart-tool-' + index.toString().padStart(4, '0'),
            },
    });
    if (!isChildStream) {
      expectedLocalIds.push(
        'history:codex:'
          + params.rootFileRelPath
          + ':'
          + String(rootOffsetBytes).padStart(12, '0')
          + ':000',
      );
      rootLines.push(line);
      rootOffsetBytes += Buffer.byteLength(line, 'utf8');
      expectedSidechainIds.push(null);
    } else {
      expectedLocalIds.push(
        'history:codex:'
          + params.childFileRelPath
          + ':'
          + String(childOffsetBytes).padStart(12, '0')
          + ':000',
      );
      childLines.push(line);
      childOffsetBytes += Buffer.byteLength(line, 'utf8');
      expectedSidechainIds.push(params.childThreadId);
    }
    expectedMessageRoles.push(
      rowKind === 0 ? 'user' : rowKind === 1 ? 'agent' : 'event',
    );
  }

  return {
    root: rootLines.join(''),
    child: childLines.join(''),
    expectedLocalIds,
    expectedSidechainIds,
    expectedMessageRoles,
  };
}

function publicRowMarker(row: JsonRecord): string | null {
  const serialized = JSON.stringify(row.content);
  return typeof serialized === 'string'
    ? serialized.match(/materialize-restart-row-\d{4}/u)?.[0] ?? null
    : null;
}

function publicRowSidechainId(row: JsonRecord): string | null {
  if (row.sidechainId === undefined || row.sidechainId === null) return null;
  return requireString(row.sidechainId, 'materialized historical sidechain id');
}

function publicRowMessageRole(row: JsonRecord): 'user' | 'agent' | 'event' {
  const messageRole = requireString(
    row.messageRole,
    'materialized historical message role',
  );
  if (messageRole === 'user' || messageRole === 'agent' || messageRole === 'event') {
    return messageRole;
  }
  throw new Error(`Unexpected materialized historical message role: ${messageRole}.`);
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

function requireDatabaseNumber(value: unknown, context: string): number {
  if (typeof value === 'bigint') {
    const converted = Number(value);
    if (Number.isSafeInteger(converted) && converted >= 0) return converted;
  }
  return requireNumber(value, context);
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

async function readDurableOperationReceiptEvidence(params: Readonly<{
  activeServerDir: string;
  operationId: string;
}>): Promise<ReturnType<
  typeof readExternalSessionOperationTerminalReceipt
>> {
  const operationKey = createHash('sha256')
    .update(params.operationId, 'utf8')
    .digest('hex');
  const serialized = await readFile(join(
    params.activeServerDir,
    'external-session-operations',
    'records',
    `${operationKey}.json`,
  ), 'utf8');
  return readExternalSessionOperationTerminalReceipt(
    JSON.parse(serialized) as unknown,
  );
}

async function readPrivateServerEvidence(params: Readonly<{
  provider: ServerLightQueryableDbProvider;
  databaseUrl: string;
  sessionId: string;
  operationId: string;
}>): Promise<Readonly<{
  publication: PrivatePublicationEvidence | null;
  pendingMessageCount: number;
  turnCount: number;
  historicalJobCount: number;
  historicalJobPriorStorageState: string | null;
  historicalJobState: string | null;
  historicalJobAcceptedThroughServerSeq: number | null;
}>> {
  const rows = await readServerLightMaterializationRows(params);
  const session = requireRecord(rows.session, 'private materialized session row');
  const publication = session.materializationPublicationId === null
    ? null
    : privatePublicationEvidence({
        ...session,
        materializedThroughSourceAt: requireDatabaseNumber(
          session.materializedThroughSourceAt,
          'private materialized session publication materialized source time',
        ),
      }, 'private materialized session publication');
  const historicalJob = rows.historicalRows.length === 1
    ? requireRecord(
        (() => {
          const content = requireRecord(
            rows.historicalRows[0],
            'private historical-import row',
          ).content;
          return typeof content === 'string'
            ? JSON.parse(content) as unknown
            : content;
        })(),
        'private historical-import job',
      )
    : null;
  return {
    publication,
    pendingMessageCount: requireNumber(
      rows.pendingMessageCount,
      'private pending-message count',
    ),
    turnCount: requireNumber(rows.turnCount, 'private turn count'),
    historicalJobCount: rows.historicalRows.length,
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
}

function resolvePrivateServerDatabaseTarget(server: StartedServer): Readonly<{
  provider: ServerLightQueryableDbProvider;
  databaseUrl: string;
}> {
  if (suiteDbProvider === 'pglite') {
    throw new Error('The SQLite-default materialization suite cannot inspect a PGlite server database.');
  }
  if (suiteDbProvider === 'sqlite') {
    return {
      provider: 'sqlite',
      databaseUrl: renderServerLightSqliteDatabaseUrl({
        dbPath: join(server.dataDir, 'happier-server-light.sqlite'),
      }),
    };
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(`Missing DATABASE_URL for ${suiteDbProvider} server database inspection.`);
  }
  return { provider: suiteDbProvider, databaseUrl };
}

async function fetchPlainSessionOperationProgressV2(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
}>): Promise<ExternalSessionOperationProgressV1 | null> {
  const session = await fetchSessionV2(
    params.baseUrl,
    params.token,
    params.sessionId,
  );
  return readPlainSessionOwnerOperationProgress(session);
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
      `${params.baseUrl}/v1/sessions/${params.sessionId}/messages?scope=all&afterSeq=${afterSeq}&limit=200`,
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

describe('core e2e: External Sessions Codex materialize restart recovery', () => {
  let server: StartedServer | null = null;
  let proxy: HttpRequestRecordingProxy | null = null;
  let daemon: StartedDaemon | null = null;
  let retiredDaemon: StartedDaemon | null = null;
  let releaseCommittedPartialResponse: (() => void) | null = null;

  afterEach(async () => {
    releaseCommittedPartialResponse?.();
    releaseCommittedPartialResponse = null;
    const cleanupErrors: Error[] = [];
    await daemon?.stop().catch((error: unknown) => {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    });
    daemon = null;
    await retiredDaemon?.proc.stop().catch((error: unknown) => {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    });
    retiredDaemon = null;
    await proxy?.stop().catch(() => {});
    proxy = null;
    await server?.stop().catch(() => {});
    server = null;
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Materialize restart teardown failed');
  }, 60_000);

  afterAll(async () => {
    releaseCommittedPartialResponse?.();
    await daemon?.stop().catch(() => {});
    await retiredDaemon?.proc.stop().catch(() => {});
    await proxy?.stop().catch(() => {});
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
      `external-sessions-codex-materialize-restart-recovery-${recovery}`,
    );
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const codexHomeDir = resolve(join(testDir, '.codex'));
    const rolloutDir = resolve(join(codexHomeDir, 'sessions', '2026', '07', '28'));
    const remoteSessionId = '11111111-1111-1111-1111-111111111111';
    const rootRolloutFileName = 'rollout-2026-07-28T00-00-00-' + remoteSessionId + '.jsonl';
    const childRolloutFileName = 'rollout-2026-07-28T00-00-01-' + childThreadId + '.jsonl';
    const rootRolloutFileRelPath = join(
      'sessions',
      '2026',
      '07',
      '28',
      rootRolloutFileName,
    );
    const childRolloutFileRelPath = join(
      'sessions',
      '2026',
      '07',
      '28',
      childRolloutFileName,
    );
    const rootRolloutFile = resolve(
      join(rolloutDir, rootRolloutFileName),
    );
    const childRolloutFile = resolve(
      join(rolloutDir, childRolloutFileName),
    );
    const codexRolloutTranscripts = buildCodexRolloutTranscripts({
      remoteSessionId,
      childThreadId,
      rootFileRelPath: rootRolloutFileRelPath,
      childFileRelPath: childRolloutFileRelPath,
    });
    const expectedMarkers = Array.from(
      { length: transcriptRowCount },
      (_, index) => rowMarker(index),
    );
    const expectedLocalIds = codexRolloutTranscripts.expectedLocalIds;
    const expectedSidechainIds = codexRolloutTranscripts.expectedSidechainIds;
    const expectedMessageRoles = codexRolloutTranscripts.expectedMessageRoles;

    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(rootRolloutFile, codexRolloutTranscripts.root, 'utf8');
    await writeFile(childRolloutFile, codexRolloutTranscripts.child, 'utf8');

    server = await startServerLight({
      testDir,
      dbProvider: suiteDbProvider,
      extraEnv: {
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
      },
    });
    const auth = await createTestAuth(server.baseUrl);
    let linkedSessionId: string | null = null;
    let committedPartialResponseHeld = false;
    let observeCommittedPartialResponse = (
      _presentation: ExternalSessionOperationSharedPresentationV1,
    ): void => {};
    const committedPartialResponseObserved =
      new Promise<ExternalSessionOperationSharedPresentationV1>((resolveObserved) => {
        observeCommittedPartialResponse = resolveObserved;
      });
    const committedPartialResponseRelease = new Promise<void>((resolveResponse) => {
      releaseCommittedPartialResponse = resolveResponse;
    });
    proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: server.baseUrl,
      captureRequestBody: (request) => linkedSessionId !== null
        && request.method === 'PATCH'
        && request.path
          === `/v2/sessions/${encodeURIComponent(linkedSessionId)}`,
      beforeForwardResponse: async (request) => {
        const presentation = linkedSessionId === null
          ? null
          : readImportingMaterializeProgressPatch({
              request,
              sessionId: linkedSessionId,
              acceptedThroughServerSeqExclusive: transcriptRowCount,
            });
        if (
          committedPartialResponseHeld
          || presentation === null
          || linkedSessionId === null
        ) {
          return;
        }
        const session = await fetchSessionV2(
          server!.baseUrl,
          auth.token,
          linkedSessionId,
        );
        const accepted = session.acceptedThroughServerSeq;
        if (
          session.currentStorageState !== 'server_partial'
          || typeof accepted !== 'number'
          || accepted <= 0
          || accepted >= transcriptRowCount
        ) {
          return;
        }
        expect(request.statusCode).toBe(200);
        committedPartialResponseHeld = true;
        observeCommittedPartialResponse(presentation);
        await committedPartialResponseRelease;
      },
    });
    const seeded = await seedCliAuthForTestAccount({
      cliHome: daemonHomeDir,
      serverUrl: proxy.baseUrl,
      auth,
      mode: 'tokenOnly',
    });
    const daemonEnv = {
      ...process.env,
      ...buildPreAttestedExternalSessionLiveEnv(),
      CI: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: proxy.baseUrl,
      CODEX_HOME: codexHomeDir,
      HAPPIER_DIRECT_SESSIONS_PAGE_MAX_ITEMS: '50',
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
    };
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
    });
    const originalDaemonPid = daemon.state.pid;

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token, {
      declareCurrentAccountStoredContentCompatibility: true,
    });
    ui.connect();

    try {
      await waitFor(() => ui.isConnected(), {
        timeoutMs: 20_000,
        context: 'socket connected for materialize restart recovery',
      });
      const machineRpc = createMachineRpcClient(ui, { mode: 'plain' });
      const route = (method: string): string => `${seeded.machineId}:${method}`;
      const source = {
        kind: 'codexHome',
        home: 'user',
      } as const;

      let lastCandidateObservation: Readonly<Record<string, unknown>> | null = null;
      try {
        await waitFor(
          async () => {
          const candidates = await machineRpc.call(
            route(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST),
            {
              machineId: seeded.machineId,
              providerId: 'codex',
              source,
              limit: 20,
            },
          );
          if (!candidates.ok) {
            throw new Error(
              `materialize Codex candidate RPC failed: ${candidates.errorCode ?? candidates.error ?? 'unknown_error'}`,
            );
          }
          const candidateResult = requireRecord(
            candidates.result,
            'materialize Codex candidate semantic response',
          );
          lastCandidateObservation = candidateResult.ok === true
            ? {
                ok: true,
                candidateRemoteSessionIds: Array.isArray(candidateResult.candidates)
                  ? candidateResult.candidates.flatMap((candidate) => (
                      isRecord(candidate) && typeof candidate.remoteSessionId === 'string'
                        ? [candidate.remoteSessionId]
                        : []
                    ))
                  : null,
                preparation: candidateResult.preparation ?? null,
              }
            : {
                ok: candidateResult.ok,
                errorCode: candidateResult.errorCode,
                error: candidateResult.error,
              };
          if (candidateResult.ok !== true) {
            const errorCode = typeof candidateResult.errorCode === 'string'
              ? candidateResult.errorCode
              : 'unknown_error';
            const error = typeof candidateResult.error === 'string'
              ? candidateResult.error
              : 'external_session_candidate_listing_failed';
            if (
              errorCode === 'agent_unavailable'
              && error === 'external_session_agent_unavailable'
            ) {
              return false;
            }
            throw new Error(
              `materialize Codex candidate listing failed: ${errorCode}:${error}`,
            );
          }
          return Array.isArray(candidateResult.candidates)
            && candidateResult.candidates.some(
              (candidate) =>
                isRecord(candidate)
                && candidate.remoteSessionId === remoteSessionId,
            );
          },
          {
            timeoutMs: 30_000,
            context: 'materialize Codex source candidate available',
          },
        );
      } catch (error) {
        throw new Error(
          `Materialize Codex source candidate wait failed; last semantic response=${JSON.stringify(lastCandidateObservation)}`,
          { cause: error },
        );
      }

      const link = await machineRpc.call(
        route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE),
        {
          machineId: seeded.machineId,
          providerId: 'codex',
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
      linkedSessionId = sessionId;

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

      const committedPresentation = await withTimeoutMs({
        promise: committedPartialResponseObserved,
        timeoutMs: 120_000,
        label: 'committed bounded materialize progress response to reach proxy latch',
      });
      assertInitialStartPending(initialStartSettlement);
      const [committedPartial, committedProgress] = await Promise.all([
        fetchSessionV2(server.baseUrl, auth.token, sessionId),
        fetchPlainSessionOperationProgressV2({
          baseUrl: server.baseUrl,
          token: auth.token,
          sessionId,
        }),
      ]);
      const committedStaging = committedProgress
        ? await readStagingAcknowledgement({
            activeServerDir: join(daemonHomeDir, 'servers', seeded.serverId),
            operationId: committedProgress.operationId,
          })
        : null;
      const committedAcceptedThrough = committedPartial.acceptedThroughServerSeq;
      if (
        committedPartial.currentStorageState !== 'server_partial'
        || typeof committedAcceptedThrough !== 'number'
        || committedAcceptedThrough <= 0
        || committedAcceptedThrough >= transcriptRowCount
        || committedProgress?.status !== 'running'
        || committedProgress.phase !== 'importing'
        || committedProgress.operationId !== committedPresentation.operationId
        || committedProgress.revision !== committedPresentation.revision
        || committedProgress.checkpoint.acceptedThroughServerSeq
          !== committedAcceptedThrough
        || committedStaging?.acceptedThroughServerSeq !== committedAcceptedThrough
      ) {
        throw new Error('Proxy latch did not preserve the committed importing checkpoint.');
      }
      const replacement = await replaceTestDaemonWithoutStoppingSessions({
        testDir,
        happyHomeDir: daemonHomeDir,
        env: daemonEnv,
        originalDaemon: daemon,
        afterOriginalDaemonExit: () => {
          releaseCommittedPartialResponse?.();
          releaseCommittedPartialResponse = null;
        },
      });
      retiredDaemon = daemon;
      daemon = replacement;
      expect(replacement.state.pid).not.toBe(originalDaemonPid);

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
      const durableCommittedAcceptedThrough = requireNumber(
        committedPartial.acceptedThroughServerSeq,
        'committed partial accepted sequence',
      );
      expect(committedStaging.acceptedThroughServerSeq).toBe(durableCommittedAcceptedThrough);
      expect(committedPartialRows.length).toBeGreaterThanOrEqual(durableCommittedAcceptedThrough);
      const committedPartialPrefix = committedPartialRows.slice(0, durableCommittedAcceptedThrough);
      expect(committedPartialPrefix.map((row) => row.seq)).toEqual(
        Array.from({ length: durableCommittedAcceptedThrough }, (_, index) => index + 1),
      );
      const committedPartialLocalIds = committedPartialPrefix.map((row) =>
        requireString(row.localId, 'committed partial materialized historical local id'),
      );
      expect(new Set(committedPartialLocalIds).size)
        .toBe(durableCommittedAcceptedThrough);
      expect(committedPartialLocalIds).toEqual(
        expectedLocalIds.slice(0, durableCommittedAcceptedThrough),
      );
      expect(committedPartialPrefix.map(publicRowMarker)).toEqual(
        expectedMarkers.slice(0, durableCommittedAcceptedThrough),
      );
      expect(committedPartialPrefix.map(publicRowSidechainId)).toEqual(
        expectedSidechainIds.slice(0, durableCommittedAcceptedThrough),
      );
      expect(committedPartialPrefix.map(publicRowMessageRole)).toEqual(
        expectedMessageRoles.slice(0, durableCommittedAcceptedThrough),
      );

      await waitFor(
        async () => {
          const progress = await fetchPlainSessionOperationProgressV2({
            baseUrl: server!.baseUrl,
            token: auth.token,
            sessionId,
          });
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
      const awaiting = await fetchPlainSessionOperationProgressV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
      });
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
      expect(passiveAcceptedThrough).toBeGreaterThanOrEqual(durableCommittedAcceptedThrough);
      const passiveRowsBefore = await fetchPublicMessages({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
      });
      expect(passiveRowsBefore).toHaveLength(passiveAcceptedThrough);
      expect(passiveRowsBefore.map((row) => row.seq)).toEqual(
        Array.from({ length: passiveAcceptedThrough }, (_, index) => index + 1),
      );
      const passiveRowsBeforeLocalIds = passiveRowsBefore.map((row) =>
        requireString(row.localId, 'passive materialized historical local id'),
      );
      expect(new Set(passiveRowsBeforeLocalIds).size).toBe(passiveAcceptedThrough);
      expect(passiveRowsBeforeLocalIds).toEqual(
        expectedLocalIds.slice(0, passiveAcceptedThrough),
      );
      expect(passiveRowsBefore.map(publicRowMarker)).toEqual(
        expectedMarkers.slice(0, passiveAcceptedThrough),
      );
      expect(passiveRowsBefore.map(publicRowSidechainId)).toEqual(
        expectedSidechainIds.slice(0, passiveAcceptedThrough),
      );
      expect(passiveRowsBefore.map(publicRowMessageRole)).toEqual(
        expectedMessageRoles.slice(0, passiveAcceptedThrough),
      );
      expect(passiveRowsBeforeLocalIds.slice(0, durableCommittedAcceptedThrough))
        .toEqual(committedPartialLocalIds);
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
      const privateServerDatabase = resolvePrivateServerDatabaseTarget(server);
      expect(await readPrivateServerEvidence({
        ...privateServerDatabase,
        sessionId,
        operationId: awaiting.operationId,
      })).toEqual({
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

      const secondUi = createUserScopedSocketCollector(server.baseUrl, auth.token, {
        declareCurrentAccountStoredContentCompatibility: true,
      });
      secondUi.connect();
      try {
        await waitFor(() => secondUi.isConnected(), {
          timeoutMs: 20_000,
          context: 'second client connected for passive materialize hydration',
        });
        const secondMachineRpc = createMachineRpcClient(secondUi, { mode: 'plain' });
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
      const passiveProgress = await fetchPlainSessionOperationProgressV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
      });
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
      expect(passiveRows.map((row) =>
        requireString(row.localId, 'passive stable materialized historical local id'),
      )).toEqual(passiveRowsBeforeLocalIds);
      expect(passiveRows.map(publicRowMarker)).toEqual(
        expectedMarkers.slice(0, passiveRows.length),
      );
      expect(passiveRows.map(publicRowSidechainId)).toEqual(
        expectedSidechainIds.slice(0, passiveRows.length),
      );
      expect(passiveRows.map(publicRowMessageRole)).toEqual(
        expectedMessageRoles.slice(0, passiveRows.length),
      );

      if (recovery === 'discard') {
        await writeFile(
          rootRolloutFile,
          [
            jsonlLine({
              type: 'session_meta',
              timestamp: '2026-07-29T00:00:00.000Z',
              payload: {
                id: remoteSessionId,
                timestamp: '2026-07-29T00:00:00.000Z',
                cwd: '/tmp/materialize-restart-project',
              },
            }),
            jsonlLine({
              type: 'response_item',
              timestamp: '2026-07-29T00:00:01.000Z',
              payload: {
                type: 'message',
                role: 'assistant',
                content: [{
                  type: 'output_text',
                  text: 'replacement-source-generation',
                }],
              },
            }),
          ].join(''),
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
        expect(await readPrivateServerEvidence({
          ...privateServerDatabase,
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
          const progress = await fetchPlainSessionOperationProgressV2({
            baseUrl: server!.baseUrl,
            token: auth.token,
            sessionId,
          });
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
      const completedProgress = await fetchPlainSessionOperationProgressV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
      });
      if (!completedProgress) {
        throw new Error('Missing completed materialize operation progress.');
      }
      expect(completedProgress.checkpoint).toEqual(expect.objectContaining({
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
      expect(localIds).toEqual(expectedLocalIds);
      expect(rows.map(publicRowMarker)).toEqual(expectedMarkers);
      expect(rows.map(publicRowSidechainId)).toEqual(expectedSidechainIds);
      expect(rows.map(publicRowMessageRole)).toEqual(expectedMessageRoles);
      expect(localIds.slice(0, passiveAcceptedThrough))
        .toEqual(passiveRowsBeforeLocalIds);
      const activeServerDir = join(
        daemonHomeDir,
        'servers',
        seeded.serverId,
      );
      const durableReceipt = await readDurableOperationReceiptEvidence({
        activeServerDir,
        operationId: awaiting.operationId,
      });
      expect(durableReceipt).toEqual({
        reference: {
          sessionId,
          operationId: awaiting.operationId,
          revision: completedProgress.revision,
        },
        presentation:
          projectExternalSessionOperationSharedPresentationV1(
            completedProgress,
          ),
        persistedKeys: [
          'terminalAtMs',
          'durableIdempotencyKey',
          'expiresAtMs',
          'idempotencyIntentDigest',
          'presentation',
          'recordKind',
          'reference',
          'v',
        ],
      });
      const privateFinalEvidence = await readPrivateServerEvidence({
        ...privateServerDatabase,
        sessionId,
        operationId: awaiting.operationId,
      });
      expect({
        publicationMatches:
          typeof privateFinalEvidence.publication?.publicationIdDigest
            === 'string'
          && privateFinalEvidence.publication.materializedThroughSourceAt
            === finalSession.materializedThroughSourceAt
          && privateFinalEvidence.publication.publishedThroughServerSeq
            === finalSession.publishedThroughServerSeq,
        pendingMessageCount: privateFinalEvidence.pendingMessageCount,
        turnCount: privateFinalEvidence.turnCount,
        historicalJobCount: privateFinalEvidence.historicalJobCount,
        historicalJobPriorStorageState:
          privateFinalEvidence.historicalJobPriorStorageState,
        historicalJobState: privateFinalEvidence.historicalJobState,
        historicalJobAcceptedThroughServerSeq:
          privateFinalEvidence.historicalJobAcceptedThroughServerSeq,
      }).toEqual({
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
      )).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'invalid_state' }),
      });
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
      const duplicatePrivateFinalEvidence = await readPrivateServerEvidence({
        ...privateServerDatabase,
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
