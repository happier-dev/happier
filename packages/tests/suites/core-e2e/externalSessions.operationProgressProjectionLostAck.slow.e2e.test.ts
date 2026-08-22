import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY,
  EXTERNAL_SESSION_OPERATION_TIMELINES_V1,
  ExternalSessionOperationRecordV1Schema,
  ExternalSessionOperationSharedPresentationV1Schema,
  ExternalSessionOperationStateV1Schema,
  openSessionOwnerMetadataEnvelopeV1,
  projectExternalSessionOperationProgressV1,
  projectExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readExternalSessionOperationRecord,
  readExternalSessionOperationStoredEntry,
  writeExternalSessionOperationRecord,
} from '../../../../apps/cli/src/session/actions/externalSessions/operationRecordStore';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import {
  replaceTestDaemonWithoutStoppingSessions,
  startTestDaemon,
  type StartedDaemon,
} from '../../src/testkit/daemon/daemon';
import {
  startHttpRequestRecordingProxy,
  type HttpRequestRecordingProxy,
  type RecordedHttpProxyRequest,
} from '../../src/testkit/httpRequestRecordingProxy';
import {
  decryptLegacyBase64,
  encryptLegacyBase64,
} from '../../src/testkit/messageCrypto';
import { buildPreAttestedExternalSessionLiveEnv } from '../../src/testkit/externalSessionLiveLifecycleFixture';
import {
  resolveTestDbProvider,
  startServerLight,
  type StartedServer,
} from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import {
  createSessionWithCiphertexts,
  fetchSessionV2,
} from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';
import { withTimeoutMs } from '../../src/testkit/timing/withTimeout';

const run = createRunDirs({ runLabel: 'core' });
const suiteDbProvider = resolveTestDbProvider(process.env, {
  fallbackProvider: 'sqlite',
});

function createTerminalOperationRecord(input: Readonly<{
  operationId: string;
  sessionId: string;
}>) {
  return ExternalSessionOperationRecordV1Schema.parse({
    v: 1,
    operationId: input.operationId,
    revision: 2,
    request: {
      v: 1,
      idempotencyKey: `key-${input.operationId}`,
      sessionId: input.sessionId,
      source: {
        machineId: 'machine-lost-ack',
        remoteSessionId: 'remote-lost-ack',
        qualifiedIdentity: {
          v: 1,
          agent: {
            pluginId: 'com.example.external-session-lost-ack',
            localId: 'fixture',
          },
          source: { kind: 'jsonl', contractVersion: 1 },
        },
        linkGeneration: 'link-generation-lost-ack',
        sourceGeneration: 'source-generation-lost-ack',
        contributionGeneration: 'contribution-generation-lost-ack',
      },
      plan: 'materialize',
      targetStorageMode: 'external-linked',
      targetRuntimeMode: null,
    },
    status: 'completed',
    phase: 'publishing',
    timeline: EXTERNAL_SESSION_OPERATION_TIMELINES_V1.materialize,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
    priorStableStorage: { state: 'machine_only' },
    currentStorageState: 'snapshot_complete',
    checkpoint: {
      sourcePagesRead: 0,
      stagedItemCount: 0,
      importedItemCount: 0,
      acceptedThroughServerSeq: 0,
      acknowledgedBatchId: 'historical-import-complete',
      requiredItemFailures: {
        total: 0,
        record: 0,
        media: 0,
        conversion: 0,
        diagnosticsTruncated: false,
        diagnostics: [],
      },
    },
    bindings: { operationClaimId: `claim-${input.operationId}` },
    progressProjection: { acknowledgedRevision: null },
    canonicalOwnerEvidence: { linkedSessionRevision: 1 },
    fence: { kind: 'none' },
    publication: {
      materializationPublicationId: `publication-${input.operationId}`,
      materializedThroughSourceAt: 2_000,
      publishedThroughServerSeq: 0,
    },
    terminalResult: { kind: 'completed' },
  });
}

function isExactSessionMetadataPatch(
  request: RecordedHttpProxyRequest,
  sessionId: string,
): boolean {
  return request.method === 'PATCH'
    && request.path === `/v2/sessions/${encodeURIComponent(sessionId)}`;
}

describe('core e2e: External Sessions operation projection lost acknowledgement', () => {
  let server: StartedServer | null = null;
  let proxy: HttpRequestRecordingProxy | null = null;
  let daemon: StartedDaemon | null = null;
  let retiredDaemon: StartedDaemon | null = null;
  let releaseCommittedResponse: (() => void) | null = null;

  afterEach(async () => {
    releaseCommittedResponse?.();
    releaseCommittedResponse = null;
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
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Operation projection restart teardown failed');
  });

  it('repairs a committed presentation whose daemon dies before recording its receipt', async () => {
    const testDir = run.testDir(
      `external-sessions-operation-projection-lost-ack-${randomUUID()}`,
    );
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    await mkdir(daemonHomeDir, { recursive: true });

    server = await startServerLight({
      testDir,
      dbProvider: suiteDbProvider,
      extraEnv: {
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
      },
    });
    const auth = await createTestAuth(server.baseUrl);
    const secret = auth.accountSigningSeed;
    const created = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      metadataCiphertextBase64: encryptLegacyBase64({}, secret),
      agentStateCiphertextBase64: null,
    });
    const sessionId = created.sessionId;

    let committedPatchCount = 0;
    let observeCommittedPatch: (() => void) | null = null;
    const committedPatchObserved = new Promise<void>((resolveObserved) => {
      observeCommittedPatch = resolveObserved;
    });
    const committedResponseRelease = new Promise<void>((resolveResponse) => {
      releaseCommittedResponse = resolveResponse;
    });
    proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: server.baseUrl,
      beforeForwardResponse: async (request) => {
        if (
          committedPatchCount !== 0
          || !isExactSessionMetadataPatch(request, sessionId)
        ) {
          return;
        }
        expect(request.statusCode).toBe(200);
        committedPatchCount += 1;
        observeCommittedPatch?.();
        await committedResponseRelease;
      },
    });

    const seeded = await seedCliAuthForTestAccount({
      cliHome: daemonHomeDir,
      serverUrl: proxy.baseUrl,
      auth,
      mode: 'legacy',
    });
    const activeServerDir = join(
      daemonHomeDir,
      'servers',
      seeded.serverId,
    );
    const initialRecord = createTerminalOperationRecord({
      operationId: `operation-${randomUUID()}`,
      sessionId,
    });
    await writeExternalSessionOperationRecord(
      activeServerDir,
      initialRecord,
    );

    const daemonEnv = {
      ...process.env,
      ...buildPreAttestedExternalSessionLiveEnv(),
      CI: '1',
      HAPPIER_CLI_TEST_SKIP_BUILD: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: proxy.baseUrl,
    };
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      startupTimeoutMs: 90_000,
      env: daemonEnv,
    });

    await withTimeoutMs({
      promise: committedPatchObserved,
      timeoutMs: 60_000,
      label: 'operation presentation PATCH to commit upstream',
    });
    const recordBeforeCrash = await readExternalSessionOperationRecord(
      activeServerDir,
      initialRecord.operationId,
    );
    expect(recordBeforeCrash).toEqual(initialRecord);

    const committedSession = await fetchSessionV2(
      server.baseUrl,
      auth.token,
      sessionId,
    );
    expect(committedSession.metadataLayoutVersion).toBe(1);
    const committedMetadata = decryptLegacyBase64(
      committedSession.metadata,
      secret,
    );
    expect(committedMetadata).toBeTruthy();
    const committedPresentation =
      ExternalSessionOperationSharedPresentationV1Schema.parse(
        (committedMetadata as Record<string, unknown>)[
          EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY
        ],
      );
    expect(committedPresentation).toEqual(
      projectExternalSessionOperationSharedPresentationV1(
        projectExternalSessionOperationProgressV1(initialRecord),
      ),
    );
    const committedOwnerMetadata = openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'e2ee',
      envelope: committedSession.ownerMetadata,
      material: { type: 'legacy', secret },
    });
    expect(committedOwnerMetadata.ok).toBe(true);
    if (!committedOwnerMetadata.ok) {
      throw new Error(`Expected readable owner metadata (${committedOwnerMetadata.reason})`);
    }
    expect(
      ExternalSessionOperationStateV1Schema.parse(
        committedOwnerMetadata.ownerMetadata.runtime?.externalSessionOperationV1,
      ),
    ).toEqual({
      v: 1,
      progress: projectExternalSessionOperationProgressV1(initialRecord),
    });

    const originalDaemonPid = daemon.state.pid;
    const replacementPromise = replaceTestDaemonWithoutStoppingSessions({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
      originalDaemon: daemon,
    });
    await waitFor(() => {
      try {
        process.kill(originalDaemonPid, 0);
        return false;
      } catch {
        return true;
      }
    }, {
      timeoutMs: 30_000,
      context: 'lost-ack daemon process exit',
    });
    releaseCommittedResponse?.();
    const replacement = await replacementPromise;
    retiredDaemon = daemon;
    daemon = replacement;
    expect(replacement.state.pid).not.toBe(originalDaemonPid);

    await waitFor(async () => {
      const current = await readExternalSessionOperationStoredEntry(
        activeServerDir,
        initialRecord.operationId,
      );
      return current?.kind === 'completion_receipt'
        && current.receipt.reference.revision === initialRecord.revision;
    }, {
      timeoutMs: 30_000,
      context: 'replacement daemon receipt-only convergence',
    });

    const repairedEntry = await readExternalSessionOperationStoredEntry(
      activeServerDir,
      initialRecord.operationId,
    );
    expect(repairedEntry).toMatchObject({
      kind: 'completion_receipt',
      receipt: {
        reference: {
          sessionId,
          operationId: initialRecord.operationId,
          revision: initialRecord.revision,
        },
        presentation:
          projectExternalSessionOperationSharedPresentationV1(
            projectExternalSessionOperationProgressV1(initialRecord),
          ),
      },
    });
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      initialRecord.operationId,
    )).resolves.toBeNull();
    const sessionAfterRepair = await fetchSessionV2(
      server.baseUrl,
      auth.token,
      sessionId,
    );
    expect(sessionAfterRepair.metadataVersion).toBe(
      committedSession.metadataVersion,
    );
    expect(sessionAfterRepair.metadata).toBe(committedSession.metadata);
    expect(proxy.entries().filter((request) =>
      isExactSessionMetadataPatch(request, sessionId))).toHaveLength(1);
  }, 180_000);
});
