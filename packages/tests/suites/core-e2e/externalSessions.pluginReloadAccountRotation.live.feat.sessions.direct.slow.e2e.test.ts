import { randomBytes } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildExternalSessionStatusDemandReplaceV1,
  buildConnectedServiceCredentialRecord,
  decideExternalSessionTranscriptRefreshApplicationV1,
  EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
  ExternalSessionTranscriptInvalidationV1Schema,
  ExternalSessionTranscriptRefreshReadAfterResponseV1Schema,
  RPC_METHODS,
  sealAccountScopedBlobCiphertext,
  type ExternalAgentObservationSnapshotV1,
  type ExternalSessionTranscriptInvalidationV1,
} from '@happier-dev/protocol';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import {
  replaceTestDaemonWithoutStoppingSessions,
  startTestDaemon,
  type StartedDaemon,
} from '../../src/testkit/daemon/daemon';
import {
  applyTrustedLocalPluginFixture,
  buildPreAttestedExternalSessionLiveEnv,
  countExternalSessionLiveFollowerReadEvents,
  countExternalSessionLiveLifecycleEvents,
  countExternalSessionLiveObserverLifecycleEvents,
  countExternalSessionLiveRefreshRequestEvents,
  createTwoIsolatedExternalSessionLiveAccounts,
  enableExternalSessionPassiveRestoreForAccount,
  ensureLinkedPassiveExternalSession,
  findUnmatchedExternalSessionLiveObserverStarts,
  hasExpectedAdvancedExternalSessionLivePulseEvidence,
  hasUnmatchedExternalSessionLiveObserverStarts,
  readExternalSessionLiveLifecycleMarkerEvents,
  readExternalSessionLiveObservationSnapshot,
  reloadTrustedLocalPluginFixture,
  seedExternalSessionLiveAccount,
  type ExternalSessionLiveLifecycleObserverMarkerEvent,
  writeInstrumentedExternalSessionLivePlugin,
} from '../../src/testkit/externalSessionLiveLifecycleFixture';
import { fetchSessionMetadataV2 } from '../../src/testkit/sessionHandoffMetadata';
import {
  resolveTestDbProvider,
  startServerLight,
  type StartedServer,
} from '../../src/testkit/process/serverLight';
import {
  decryptDataKeyBase64,
  encryptDataKeyBase64,
} from '../../src/testkit/rpcCrypto';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import {
  createDataKeyRpcClient,
  unwrapDataKeyRpcResult,
} from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';
import { fetchJson } from '../../src/testkit/http';
import { unwrapSerializedJsonValue } from '../../src/testkit/unwrapSerializedJsonValue';

const PLUGIN_ID = 'acme.external-session-live';
const AGENT_ID = 'fixture-agent';
const REMOTE_SESSION_ID = 'fixture-live-remote';
const SOURCE = Object.freeze({ kind: 'fixtureLive' });
const EXPECTED_OBSERVATION_IDENTITY = Object.freeze({
  pluginId: PLUGIN_ID,
  agentId: AGENT_ID,
  sourceKind: SOURCE.kind,
});
const suiteDbProvider = resolveTestDbProvider(process.env, {
  fallbackProvider: 'sqlite',
});

type JsonRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

async function pulseFixture(params: Readonly<{
  daemon: StartedDaemon;
  expectedGeneration: string;
  emitRetired?: boolean;
}>): Promise<void> {
  const response = await daemonControlPostJson({
    port: params.daemon.state.httpPort,
    path: '/plugins/actions/execute',
    controlToken: params.daemon.state.controlToken,
    body: {
      actionId: `${PLUGIN_ID}/pulse`,
      input: {
        emit: true,
        refresh: true,
        ...(params.emitRetired ? { emitRetired: true } : {}),
      },
      surface: 'cli',
    },
    timeoutMs: 30_000,
  });
  const data = asRecord(response.data);
  const result = asRecord(data?.result);
  const actionResult = asRecord(result?.result);
  if (
    response.status !== 200
    || data?.matched !== true
    || result?.ok !== true
    || actionResult?.available !== true
    || actionResult?.generation !== params.expectedGeneration
  ) {
    throw new Error(
      `External Session live pulse failed (status=${response.status}, data=${JSON.stringify(response.data)})`,
    );
  }
}

async function writeConnectedCodexCredential(params: Readonly<{
  serverBaseUrl: string;
  token: string;
  machineKey: Uint8Array;
}>): Promise<string> {
  const now = Date.now();
  const record = buildConnectedServiceCredentialRecord({
    now,
    serviceId: 'openai-codex',
    profileId: 'work',
    kind: 'oauth',
    expiresAt: now + 60 * 60_000,
    oauth: {
      accessToken: 'external-session-live-access',
      refreshToken: 'external-session-live-refresh',
      idToken: 'external-session-live-id',
      scope: null,
      tokenType: null,
      providerAccountId: 'external-session-live-account',
      providerEmail: 'external-session-live@example.test',
    },
  });
  const ciphertext = sealAccountScopedBlobCiphertext({
    kind: 'connected_service_credential',
    material: { type: 'dataKey', machineKey: params.machineKey },
    payload: record,
    randomBytes: (length) => randomBytes(length),
  });
  const oauth = record.oauth;
  if (!oauth) {
    throw new Error('Expected the connected Codex fixture to contain OAuth metadata.');
  }
  const response = await fetchJson<{
    success?: boolean;
    credentialRevision?: string;
  }>(
    `${params.serverBaseUrl}/v2/connect/openai-codex/profiles/work/credential`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: oauth.providerEmail,
          providerAccountId: oauth.providerAccountId,
          expiresAt: record.expiresAt,
        },
      }),
      timeoutMs: 20_000,
    },
  );
  if (
    response.status !== 200
    || response.data?.success !== true
    || typeof response.data.credentialRevision !== 'string'
  ) {
    throw new Error(
      `Connected-service credential write failed (${response.status})`,
    );
  }
  return response.data.credentialRevision;
}

async function requestConnectedCodexStatusReconciliation(params: Readonly<{
  call: ReturnType<typeof createDataKeyRpcClient>['call'];
  machineId: string;
  sessionId: string;
  remoteSessionId: string;
  codexHome: string;
}>): Promise<void> {
  const response = asRecord(await params.call(
    `${params.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET}`,
    {
      machineId: params.machineId,
      sessionId: params.sessionId,
      agentId: 'codex',
      providerId: 'codex',
      remoteSessionId: params.remoteSessionId,
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'work',
        homePath: params.codexHome,
      },
    },
  ));
  const result = asRecord(response?.result);
  if (response?.ok !== true || result?.ok !== true) {
    throw new Error(
      `Connected Codex status reconciliation failed (${JSON.stringify(response)})`,
    );
  }
  const externalAgent = asRecord(result.externalAgent);
  if (
    externalAgent === null
    || typeof externalAgent.status !== 'string'
    || externalAgent.status === 'unknown'
  ) {
    throw new Error(
      `Connected Codex status reconciliation returned no current evidence (${JSON.stringify(response)})`,
    );
  }
}

function readTranscriptInvalidations(
  socket: ReturnType<typeof createUserScopedSocketCollector>,
): ExternalSessionTranscriptInvalidationV1[] {
  return socket.getEvents().flatMap((event) => {
    if (
      event.kind !== 'ephemeral'
      || event.payload.type !== 'external-session-transcript-invalidated'
    ) {
      return [];
    }
    const parsed = ExternalSessionTranscriptInvalidationV1Schema.safeParse(
      event.payload,
    );
    return parsed.success ? [parsed.data] : [];
  });
}

async function callRawEncryptedMachineRpc(params: Readonly<{
  socket: ReturnType<typeof createUserScopedSocketCollector>;
  machineKey: Uint8Array;
  method: string;
  payload: unknown;
}>): Promise<Readonly<{
  requestCiphertext: string;
  responseCiphertext: string;
  result: unknown;
}>> {
  const requestCiphertext = encryptDataKeyBase64(
    params.payload,
    params.machineKey,
  );
  const response = await params.socket.rpcCall<{
    ok?: unknown;
    result?: unknown;
    error?: unknown;
    errorCode?: unknown;
  }>(params.method, requestCiphertext, 30_000);
  if (response?.ok !== true || typeof response.result !== 'string') {
    throw new Error(
      `Raw encrypted machine RPC failed (${String(
        response?.errorCode ?? response?.error ?? 'invalid-response',
      )})`,
    );
  }
  const responseCiphertext = response.result;
  return {
    requestCiphertext,
    responseCiphertext,
    result: unwrapSerializedJsonValue(
      decryptDataKeyBase64(responseCiphertext, params.machineKey),
    ),
  };
}

describe('core e2e: External Sessions plugin reload and account rotation', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let retiredDaemon: StartedDaemon | null = null;
  const sockets: Array<ReturnType<typeof createUserScopedSocketCollector>> = [];
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    const cleanupErrors: Error[] = [];
    await daemon?.stop().catch((error: unknown) => {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    });
    daemon = null;
    await retiredDaemon?.proc.stop().catch((error: unknown) => {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    });
    retiredDaemon = null;
    await server?.stop().catch(() => {});
    server = null;
    for (const root of temporaryRoots.splice(0)) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Plugin reload restart teardown failed');
  });

  it('classifies connected Codex status reconciliation as active evidence production', async () => {
    const calls: Array<Readonly<{ method: string; payload: unknown }>> = [];
    const call: ReturnType<typeof createDataKeyRpcClient>['call'] = async (
      method,
      payload,
    ) => {
      calls.push({ method, payload });
      return {
        ok: true,
        result: {
          ok: true,
          externalAgent: {
            status: 'working',
          },
        },
      };
    };

    await requestConnectedCodexStatusReconciliation({
      call,
      machineId: 'machine-passive-oracle',
      sessionId: 'session-passive-oracle',
      remoteSessionId: 'remote-passive-oracle',
      codexHome: '/tmp/passive-oracle-codex-home',
    });

    expect(calls).toEqual([{
      method: `machine-passive-oracle:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET}`,
      payload: expect.objectContaining({
        machineId: 'machine-passive-oracle',
        sessionId: 'session-passive-oracle',
        remoteSessionId: 'remote-passive-oracle',
      }),
    }]);
  });

  it('fences a changed plugin generation and re-inventories a second isolated account after daemon restart', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-external-live-e2e-'));
    temporaryRoots.push(testDir);
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const pluginRoot = resolve(join(testDir, 'plugin'));
    const markerPath = resolve(join(testDir, 'lifecycle.jsonl'));
    await mkdir(daemonHomeDir, { recursive: true });

    const preAttestedEnv = buildPreAttestedExternalSessionLiveEnv();
    server = await startServerLight({
      testDir,
      dbProvider: suiteDbProvider,
      extraEnv: preAttestedEnv,
    });
    const accounts = await createTwoIsolatedExternalSessionLiveAccounts(
      server.baseUrl,
    );
    await Promise.all([
      enableExternalSessionPassiveRestoreForAccount({
        account: accounts.accountA,
        serverBaseUrl: server.baseUrl,
      }),
      enableExternalSessionPassiveRestoreForAccount({
        account: accounts.accountB,
        serverBaseUrl: server.baseUrl,
      }),
    ]);
    const seededA = await seedExternalSessionLiveAccount({
      account: accounts.accountA,
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
    });
    await writeInstrumentedExternalSessionLivePlugin({
      pluginRoot,
      pluginId: PLUGIN_ID,
      agentId: AGENT_ID,
      generation: 'generation-one',
      observationStatus: 'waiting',
      markerPath,
    });

    const daemonEnv = {
      ...process.env,
      ...preAttestedEnv,
      CI: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_VARIANT: 'dev',
    };
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
    });
    await applyTrustedLocalPluginFixture({
      daemonPort: daemon.state.httpPort,
      controlToken: daemon.state.controlToken,
      pluginRoot,
      pluginId: PLUGIN_ID,
      interactionId: 'external-session-live-install',
    });

    const socketA = createUserScopedSocketCollector(
      server.baseUrl,
      accounts.accountA.auth.token,
    );
    sockets.push(socketA);
    socketA.connect();
    await waitFor(() => socketA.isConnected(), {
      timeoutMs: 20_000,
      context: 'account A live socket connected',
    });
    const rpcA = createDataKeyRpcClient(socketA, accounts.accountA.machineKey);
    const linkedA = await ensureLinkedPassiveExternalSession({
      machineId: seededA.machineId,
      agentId: AGENT_ID,
      remoteSessionId: REMOTE_SESSION_ID,
      source: SOURCE,
      call: rpcA.call,
    });
    await waitFor(async () => (
      await readExternalSessionLiveLifecycleMarkerEvents(markerPath)
    ).some(
      (event) => event.kind === 'observer_started'
        && event.generation === 'generation-one',
    ), {
      timeoutMs: 30_000,
      context: 'account A observation active before fixture pulse',
    });
    let accountAObservationBeforePulse:
      ExternalAgentObservationSnapshotV1 | null = null;
    await waitFor(async () => {
      const snapshot = await readExternalSessionLiveObservationSnapshot({
        serverBaseUrl: server!.baseUrl,
        token: accounts.accountA.auth.token,
        sessionId: linkedA.sessionId,
        machineKey: accounts.accountA.machineKey,
      });
      if (
        snapshot?.status !== 'waiting'
        || snapshot.qualifiedLinkIdentity.agent.pluginId !== PLUGIN_ID
        || snapshot.qualifiedLinkIdentity.agent.localId !== AGENT_ID
        || snapshot.qualifiedLinkIdentity.source.kind !== SOURCE.kind
        || typeof snapshot.observedAtMs !== 'number'
      ) {
        return false;
      }
      accountAObservationBeforePulse = snapshot;
      return true;
    }, {
      timeoutMs: 30_000,
      context: 'account A initial External Agent observation publication',
    });
    if (!accountAObservationBeforePulse) {
      throw new Error('Account A initial External Agent observation was not captured');
    }
    const accountAObservationBaseline = accountAObservationBeforePulse;
    await pulseFixture({
      daemon,
      expectedGeneration: 'generation-one',
    });
    await waitFor(async () => {
      const events = await readExternalSessionLiveLifecycleMarkerEvents(markerPath);
      const currentObservation = await readExternalSessionLiveObservationSnapshot({
        serverBaseUrl: server!.baseUrl,
        token: accounts.accountA.auth.token,
        sessionId: linkedA.sessionId,
        machineKey: accounts.accountA.machineKey,
      });
      return hasExpectedAdvancedExternalSessionLivePulseEvidence({
        markerEvents: events,
        generation: 'generation-one',
        minimumCounts: {
          observersStarted: 1,
          followerReads: 1,
          refreshRequests: 1,
        },
        expectedIdentity: EXPECTED_OBSERVATION_IDENTITY,
        expectedStatus: 'waiting',
        before: accountAObservationBaseline,
        after: currentObservation,
      });
    }, {
      timeoutMs: 30_000,
      context: 'account A observation, refresh, follow, and publication',
    });

    const reloadRequestedAtMs = Date.now();
    await writeInstrumentedExternalSessionLivePlugin({
      pluginRoot,
      pluginId: PLUGIN_ID,
      agentId: AGENT_ID,
      generation: 'generation-two',
      observationStatus: 'working',
      markerPath,
    });
    await reloadTrustedLocalPluginFixture({
      daemonPort: daemon.state.httpPort,
      controlToken: daemon.state.controlToken,
      pluginRoot,
      pluginId: PLUGIN_ID,
      changedPaths: ['daemon.mjs'],
    });
    let reloadMarkerCounts = {
      generationOneStarted: 0,
      generationOneDisposed: 0,
      generationTwoStarted: 0,
      generationTwoDisposed: 0,
      generationOneLive: 0,
      generationTwoLive: 0,
    };
    const accountADaemonPid = daemon.state.pid;
    const requestedLinkKey = `fixture-live-link:${REMOTE_SESSION_ID}`;
    const accountAGenerationTwoObserverCapture: {
      current: ExternalSessionLiveLifecycleObserverMarkerEvent | null;
    } = { current: null };
    try {
      await waitFor(async () => {
        const events = await readExternalSessionLiveLifecycleMarkerEvents(markerPath);
        const generationOne = events.filter(
          (event) => event.generation === 'generation-one',
        );
        const generationTwo = events.filter(
          (event) => event.generation === 'generation-two',
        );
        const generationOneLive = findUnmatchedExternalSessionLiveObserverStarts({
          markerEvents: generationOne,
          daemonPid: accountADaemonPid,
          resourceKey: 'fixture-live-resource',
        });
        const generationTwoLive = findUnmatchedExternalSessionLiveObserverStarts({
          markerEvents: generationTwo,
          daemonPid: accountADaemonPid,
          resourceKey: 'fixture-live-resource',
        });
        reloadMarkerCounts = {
          generationOneStarted: generationOne.filter(
            (event) => event.kind === 'observer_started',
          ).length,
          generationOneDisposed: generationOne.filter(
            (event) => event.kind === 'observer_disposed',
          ).length,
          generationTwoStarted: generationTwo.filter(
            (event) => event.kind === 'observer_started',
          ).length,
          generationTwoDisposed: generationTwo.filter(
            (event) => event.kind === 'observer_disposed',
          ).length,
          generationOneLive: generationOneLive.length,
          generationTwoLive: generationTwoLive.length,
        };
        const currentGenerationTwoObserver = generationTwoLive[0];
        const lifecycleConverged = reloadMarkerCounts.generationOneStarted >= 1
          && reloadMarkerCounts.generationOneDisposed
            === reloadMarkerCounts.generationOneStarted
          && reloadMarkerCounts.generationOneLive === 0
          && reloadMarkerCounts.generationTwoStarted >= 1
          && reloadMarkerCounts.generationTwoDisposed
            === reloadMarkerCounts.generationTwoStarted - 1
          && reloadMarkerCounts.generationTwoLive === 1
          && currentGenerationTwoObserver?.requestedLinkKeys?.includes(
            requestedLinkKey,
          ) === true;
        if (lifecycleConverged) {
          accountAGenerationTwoObserverCapture.current =
            currentGenerationTwoObserver ?? null;
        }
        return lifecycleConverged;
      }, {
        timeoutMs: 30_000,
        context: 'changed plugin generation retires and reacquires observer',
      });
    } catch (error) {
      throw new Error(
        'Changed plugin generation did not retire and reacquire its observer '
        + `(markers=${JSON.stringify(reloadMarkerCounts)})`,
        { cause: error },
      );
    }
    const accountAGenerationTwoObserver =
      accountAGenerationTwoObserverCapture.current;
    if (!accountAGenerationTwoObserver) {
      throw new Error('Generation-two observer identity was not captured');
    }
    let accountAReloadObservationBeforePulse:
      ExternalAgentObservationSnapshotV1 | null = null;
    await waitFor(async () => {
      const snapshot = await readExternalSessionLiveObservationSnapshot({
        serverBaseUrl: server!.baseUrl,
        token: accounts.accountA.auth.token,
        sessionId: linkedA.sessionId,
        machineKey: accounts.accountA.machineKey,
      });
      if (
        snapshot?.status !== 'working'
        || snapshot.qualifiedLinkIdentity.agent.pluginId !== PLUGIN_ID
        || snapshot.qualifiedLinkIdentity.agent.localId !== AGENT_ID
        || snapshot.qualifiedLinkIdentity.source.kind !== SOURCE.kind
        || typeof snapshot.observedAtMs !== 'number'
        || snapshot.observedAtMs < reloadRequestedAtMs
      ) {
        return false;
      }
      accountAReloadObservationBeforePulse = snapshot;
      return true;
    }, {
      timeoutMs: 30_000,
      context: 'generation-two initial External Agent observation publication',
    });
    if (!accountAReloadObservationBeforePulse) {
      throw new Error(
        'Generation-two initial External Agent observation was not captured',
      );
    }
    const accountAReloadObservationBaseline =
      accountAReloadObservationBeforePulse;
    await pulseFixture({
      daemon,
      expectedGeneration: 'generation-two',
      emitRetired: true,
    });
    let accountAObservationAfterReloadPulse:
      ExternalAgentObservationSnapshotV1 | null = null;
    await waitFor(async () => {
      const events = await readExternalSessionLiveLifecycleMarkerEvents(markerPath);
      const currentObservation = await readExternalSessionLiveObservationSnapshot({
        serverBaseUrl: server!.baseUrl,
        token: accounts.accountA.auth.token,
        sessionId: linkedA.sessionId,
        machineKey: accounts.accountA.machineKey,
      });
      const hasCurrentGenerationField =
        hasExpectedAdvancedExternalSessionLivePulseEvidence({
          markerEvents: events,
          generation: 'generation-two',
          minimumCounts: {
            observersStarted: 1,
            followerReads: 1,
            refreshRequests: 1,
          },
          expectedIdentity: EXPECTED_OBSERVATION_IDENTITY,
          expectedStatus: 'working',
          before: accountAReloadObservationBaseline,
          after: currentObservation,
        });
      const retiredGenerationAttemptedLateEmission = events.some(
        (event) => event.kind === 'late_emission_attempted'
          && event.generation === 'generation-one',
      );
      if (hasCurrentGenerationField && retiredGenerationAttemptedLateEmission) {
        accountAObservationAfterReloadPulse = currentObservation;
        return true;
      }
      return false;
    }, {
      timeoutMs: 30_000,
      context: 'changed plugin generation owns the exact field after a retired generation emits late',
    });
    if (!accountAObservationAfterReloadPulse) {
      throw new Error(
        'Generation-two External Agent observation was not captured after the retired emission',
      );
    }

    await daemon.stop();
    daemon = null;
    await waitFor(async () => {
      const events = await readExternalSessionLiveLifecycleMarkerEvents(markerPath);
      const generationTwo = events.filter(
        (event) => event.generation === 'generation-two',
      );
      const counts = countExternalSessionLiveObserverLifecycleEvents({
        markerEvents: generationTwo,
        daemonPid: accountADaemonPid,
        resourceKey: 'fixture-live-resource',
      });
      return counts.observersStarted >= 1
        && counts.observersDisposed === counts.observersStarted
        && countExternalSessionLiveObserverLifecycleEvents({
          markerEvents: generationTwo,
          daemonPid: accountADaemonPid,
          resourceKey: 'fixture-live-resource',
          observerInstanceId:
            accountAGenerationTwoObserver.observerInstanceId,
        }).observersDisposed === 1
        && findUnmatchedExternalSessionLiveObserverStarts({
          markerEvents: generationTwo,
          daemonPid: accountADaemonPid,
          resourceKey: 'fixture-live-resource',
        }).length === 0;
    }, {
      timeoutMs: 30_000,
      context: 'generation-two observers are fully retired before account rotation',
    });
    await expect(readExternalSessionLiveObservationSnapshot({
      serverBaseUrl: server.baseUrl,
      token: accounts.accountA.auth.token,
      sessionId: linkedA.sessionId,
      machineKey: accounts.accountA.machineKey,
    })).resolves.toEqual(accountAObservationAfterReloadPulse);
    socketA.close();
    sockets.splice(sockets.indexOf(socketA), 1);

    const seededB = await seedExternalSessionLiveAccount({
      account: accounts.accountB,
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
    });
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
    });
    const socketB = createUserScopedSocketCollector(
      server.baseUrl,
      accounts.accountB.auth.token,
    );
    sockets.push(socketB);
    socketB.connect();
    await waitFor(() => socketB.isConnected(), {
      timeoutMs: 20_000,
      context: 'account B live socket connected',
    });
    const rpcB = createDataKeyRpcClient(socketB, accounts.accountB.machineKey);
    const linkedB = await ensureLinkedPassiveExternalSession({
      machineId: seededB.machineId,
      agentId: AGENT_ID,
      remoteSessionId: REMOTE_SESSION_ID,
      source: SOURCE,
      call: rpcB.call,
    });
    const accountBDaemonPid = daemon.state.pid;
    const accountBObserverCapture: {
      current: ExternalSessionLiveLifecycleObserverMarkerEvent | null;
    } = { current: null };
    await waitFor(async () => {
      const generationTwo = (
        await readExternalSessionLiveLifecycleMarkerEvents(markerPath)
      ).filter((event) => event.generation === 'generation-two');
      const liveObservers = findUnmatchedExternalSessionLiveObserverStarts({
        markerEvents: generationTwo,
        daemonPid: accountBDaemonPid,
        resourceKey: 'fixture-live-resource',
      });
      const currentObserver = liveObservers[0];
      if (
        liveObservers.length !== 1
        || currentObserver?.requestedLinkKeys?.includes(requestedLinkKey) !== true
      ) {
        return false;
      }
      accountBObserverCapture.current = currentObserver;
      return true;
    }, {
      timeoutMs: 30_000,
      context: 'account B observation active before fixture pulse',
    });
    const accountBObserver = accountBObserverCapture.current;
    if (!accountBObserver) {
      throw new Error('Account B observer identity was not captured');
    }
    let accountBObservationBeforePulse:
      ExternalAgentObservationSnapshotV1 | null = null;
    await waitFor(async () => {
      const snapshot = await readExternalSessionLiveObservationSnapshot({
        serverBaseUrl: server!.baseUrl,
        token: accounts.accountB.auth.token,
        sessionId: linkedB.sessionId,
        machineKey: accounts.accountB.machineKey,
      });
      if (
        snapshot?.status !== 'working'
        || snapshot.qualifiedLinkIdentity.agent.pluginId !== PLUGIN_ID
        || snapshot.qualifiedLinkIdentity.agent.localId !== AGENT_ID
        || snapshot.qualifiedLinkIdentity.source.kind !== SOURCE.kind
        || typeof snapshot.observedAtMs !== 'number'
      ) {
        return false;
      }
      accountBObservationBeforePulse = snapshot;
      return true;
    }, {
      timeoutMs: 30_000,
      context: 'account B initial External Agent observation publication',
    });
    if (!accountBObservationBeforePulse) {
      throw new Error('Account B initial External Agent observation was not captured');
    }
    const accountBObservationBaseline = accountBObservationBeforePulse;
    await pulseFixture({
      daemon,
      expectedGeneration: 'generation-two',
    });
    await waitFor(async () => {
      const events = await readExternalSessionLiveLifecycleMarkerEvents(markerPath);
      const currentObservation = await readExternalSessionLiveObservationSnapshot({
        serverBaseUrl: server!.baseUrl,
        token: accounts.accountB.auth.token,
        sessionId: linkedB.sessionId,
        machineKey: accounts.accountB.machineKey,
      });
      return hasExpectedAdvancedExternalSessionLivePulseEvidence({
        markerEvents: events,
        generation: 'generation-two',
        minimumCounts: {
          observersStarted: 2,
          followerReads: 2,
          refreshRequests: 2,
        },
        expectedIdentity: EXPECTED_OBSERVATION_IDENTITY,
        expectedStatus: 'working',
        before: accountBObservationBaseline,
        after: currentObservation,
      });
    }, {
      timeoutMs: 30_000,
      context: 'account B observation, refresh, follow, and publication',
    });

    await expect(readExternalSessionLiveObservationSnapshot({
      serverBaseUrl: server.baseUrl,
      token: accounts.accountA.auth.token,
      sessionId: linkedA.sessionId,
      machineKey: accounts.accountA.machineKey,
    })).resolves.toEqual(accountAObservationAfterReloadPulse);

    const steadyStateEvents =
      await readExternalSessionLiveLifecycleMarkerEvents(markerPath);
    const steadyStateReconcileCount = steadyStateEvents.filter(
      (event) => event.kind === 'reconcile_requested',
    ).length;
    const steadyStateAccountBObserverCounts =
      countExternalSessionLiveObserverLifecycleEvents({
        markerEvents: steadyStateEvents.filter(
          (event) => event.generation === 'generation-two',
        ),
        daemonPid: accountBDaemonPid,
        resourceKey: 'fixture-live-resource',
      });
    await new Promise((resolveQuietWindow) => setTimeout(resolveQuietWindow, 500));
    const afterQuietWindowEvents =
      await readExternalSessionLiveLifecycleMarkerEvents(markerPath);
    expect(afterQuietWindowEvents.filter(
      (event) => event.kind === 'reconcile_requested',
    )).toHaveLength(steadyStateReconcileCount);
    const afterQuietGenerationTwoEvents = afterQuietWindowEvents.filter(
      (event) => event.generation === 'generation-two',
    );
    expect(countExternalSessionLiveObserverLifecycleEvents({
      markerEvents: afterQuietGenerationTwoEvents,
      daemonPid: accountBDaemonPid,
      resourceKey: 'fixture-live-resource',
    })).toEqual(steadyStateAccountBObserverCounts);
    expect(findUnmatchedExternalSessionLiveObserverStarts({
      markerEvents: afterQuietGenerationTwoEvents,
      daemonPid: accountBDaemonPid,
      resourceKey: 'fixture-live-resource',
    })).toEqual([accountBObserver]);

    expect(seededB.machineId).not.toBe(seededA.machineId);
    expect(linkedB.sessionId).not.toBe(linkedA.sessionId);
  }, 600_000);

  it('releases a connected-profile passive observer after real credential removal and reacquires it after restoration', async () => {
    const testDir = await mkdtemp(
      join(tmpdir(), 'happier-external-credential-live-e2e-'),
    );
    temporaryRoots.push(testDir);
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    await mkdir(daemonHomeDir, { recursive: true });

    const preAttestedEnv = buildPreAttestedExternalSessionLiveEnv();
    server = await startServerLight({
      testDir,
      dbProvider: suiteDbProvider,
      extraEnv: preAttestedEnv,
    });
    const { accountA } = await createTwoIsolatedExternalSessionLiveAccounts(
      server.baseUrl,
    );
    await enableExternalSessionPassiveRestoreForAccount({
      account: accountA,
      serverBaseUrl: server.baseUrl,
    });
    const seeded = await seedExternalSessionLiveAccount({
      account: accountA,
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
    });
    let credentialRevision = await writeConnectedCodexCredential({
      serverBaseUrl: server.baseUrl,
      token: accountA.auth.token,
      machineKey: accountA.machineKey,
    });
    const initialCredentialRevision = credentialRevision;

    const remoteSessionId = '44444444-4444-4444-4444-444444444444';
    const codexHome = resolve(join(
      daemonHomeDir,
      'servers',
      seeded.serverId,
      'daemon',
      'connected-services',
      'homes',
      'openai-codex',
      'work',
      'codex',
      'codex-home',
    ));
    const rolloutDir = join(codexHome, 'sessions', '2026', '07', '26');
    const rolloutPath = join(
      rolloutDir,
      `rollout-2026-07-26T00-00-00-${remoteSessionId}.jsonl`,
    );
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(
      rolloutPath,
      `${JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-07-26T00:00:00.000Z',
        payload: {
          id: remoteSessionId,
          timestamp: '2026-07-26T00:00:00.000Z',
          cwd: testDir,
        },
      })}\n`,
      'utf8',
    );

    const daemonEnv = {
      ...process.env,
      ...preAttestedEnv,
      CI: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_VARIANT: 'dev',
    };
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
    });

    const socket = createUserScopedSocketCollector(
      server.baseUrl,
      accountA.auth.token,
    );
    sockets.push(socket);
    socket.connect();
    await waitFor(() => socket.isConnected(), {
      timeoutMs: 20_000,
      context: 'credential-removal account socket connected',
    });
    const rpc = createDataKeyRpcClient(socket, accountA.machineKey);
    const linkedSession = await ensureLinkedPassiveExternalSession({
      machineId: seeded.machineId,
      agentId: 'codex',
      remoteSessionId,
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'work',
        homePath: codexHome,
      },
      call: rpc.call,
    });

    credentialRevision = await writeConnectedCodexCredential({
      serverBaseUrl: server.baseUrl,
      token: accountA.auth.token,
      machineKey: accountA.machineKey,
    });
    expect(credentialRevision).not.toBe(initialCredentialRevision);
    const credentialRotationCompletedAtMs = Date.now();
    const currentEvidenceAt = new Date(credentialRotationCompletedAtMs + 1);
    await utimes(rolloutPath, currentEvidenceAt, currentEvidenceAt);
    const currentBeforeRemovalHolder: {
      value: ExternalAgentObservationSnapshotV1 | null;
    } = { value: null };
    await waitFor(async () => {
      const snapshot = await readExternalSessionLiveObservationSnapshot({
        serverBaseUrl: server!.baseUrl,
        token: accountA.auth.token,
        sessionId: linkedSession.sessionId,
        machineKey: accountA.machineKey,
      });
      if (
        snapshot === null
        || snapshot.status === 'unknown'
        || typeof snapshot.observedAtMs !== 'number'
        || snapshot.observedAtMs <= credentialRotationCompletedAtMs
        || snapshot.qualifiedLinkIdentity.agent.localId !== 'codex'
        || snapshot.qualifiedLinkIdentity.source.kind !== 'codexHome'
      ) {
        await requestConnectedCodexStatusReconciliation({
          call: rpc.call,
          machineId: seeded.machineId,
          sessionId: linkedSession.sessionId,
          remoteSessionId,
          codexHome,
        });
        return false;
      }
      currentBeforeRemovalHolder.value = snapshot;
      return true;
    }, {
      timeoutMs: 30_000,
      context: 'connected-profile current observation before credential removal',
    });
    const currentBeforeRemovalBaseline = currentBeforeRemovalHolder.value;
    if (!currentBeforeRemovalBaseline) {
      throw new Error('Current credential observation field was not captured');
    }

    const removed = await fetchJson<{ success?: boolean }>(
      `${server.baseUrl}/v2/connect/openai-codex/profiles/work/credential`
      + `?expectedCredentialRevision=${encodeURIComponent(credentialRevision)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accountA.auth.token}` },
        timeoutMs: 20_000,
      },
    );
    expect(removed.status).toBe(200);
    expect(removed.data?.success).toBe(true);
    const credentialRemovalCompletedAtMs = Date.now();

    let releasedField: ExternalAgentObservationSnapshotV1 | null = null;
    await waitFor(async () => {
      const snapshot = await readExternalSessionLiveObservationSnapshot({
        serverBaseUrl: server!.baseUrl,
        token: accountA.auth.token,
        sessionId: linkedSession.sessionId,
        machineKey: accountA.machineKey,
      });
      if (
        snapshot?.status !== 'unknown'
        || snapshot.linkGeneration !== currentBeforeRemovalBaseline.linkGeneration
        || JSON.stringify(snapshot.qualifiedLinkIdentity)
          !== JSON.stringify(currentBeforeRemovalBaseline.qualifiedLinkIdentity)
      ) {
        return false;
      }
      releasedField = snapshot;
      return true;
    }, {
      timeoutMs: 10_000,
      context: 'real /v2/changes credential removal releases passive observation',
    });
    if (!releasedField) {
      throw new Error('Credential-removal release field was not captured');
    }

    await appendFile(
      rolloutPath,
      `${JSON.stringify({
        type: 'event_msg',
        timestamp: new Date().toISOString(),
        payload: { type: 'user_message', message: 'after-removal' },
      })}\n`,
      'utf8',
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
    expect(await readExternalSessionLiveObservationSnapshot({
      serverBaseUrl: server.baseUrl,
      token: accountA.auth.token,
      sessionId: linkedSession.sessionId,
      machineKey: accountA.machineKey,
    })).toEqual(releasedField);

    const removedCredentialRevision = credentialRevision;
    credentialRevision = await writeConnectedCodexCredential({
      serverBaseUrl: server.baseUrl,
      token: accountA.auth.token,
      machineKey: accountA.machineKey,
    });
    expect(credentialRevision).toMatch(/^csr_/);
    expect(credentialRevision).not.toBe(initialCredentialRevision);
    expect(credentialRevision).not.toBe(removedCredentialRevision);
    let currentAfterRestoration: ExternalAgentObservationSnapshotV1 | null = null;
    await waitFor(async () => {
      const snapshot = await readExternalSessionLiveObservationSnapshot({
        serverBaseUrl: server!.baseUrl,
        token: accountA.auth.token,
        sessionId: linkedSession.sessionId,
        machineKey: accountA.machineKey,
      });
      if (
        snapshot !== null
        && snapshot.status !== 'unknown'
        && snapshot.linkGeneration === currentBeforeRemovalBaseline.linkGeneration
        && JSON.stringify(snapshot.qualifiedLinkIdentity)
          === JSON.stringify(currentBeforeRemovalBaseline.qualifiedLinkIdentity)
        && typeof snapshot.observedAtMs === 'number'
        && snapshot.observedAtMs > credentialRemovalCompletedAtMs
      ) {
        currentAfterRestoration = snapshot;
        return true;
      }
      return false;
    }, {
      timeoutMs: 30_000,
      intervalMs: 500,
      context: 'credential restoration passively reacquires the current observation field',
    });
    if (!currentAfterRestoration) {
      throw new Error('Restored credential observation field was not captured');
    }
  }, 300_000);

  it('QA-ST-6 restores only durable explicit follow across an isolated daemon replacement and preserves archive suspension', async () => {
    const testDir = await mkdtemp(
      join(tmpdir(), 'happier-external-qa-st6-e2e-'),
    );
    temporaryRoots.push(testDir);
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const pluginRoot = resolve(join(testDir, 'plugin'));
    const markerPath = resolve(join(testDir, 'lifecycle.jsonl'));
    await mkdir(daemonHomeDir, { recursive: true });

    const preAttestedEnv = buildPreAttestedExternalSessionLiveEnv();
    server = await startServerLight({
      testDir,
      dbProvider: suiteDbProvider,
      extraEnv: preAttestedEnv,
    });
    const { accountA } = await createTwoIsolatedExternalSessionLiveAccounts(
      server.baseUrl,
    );
    await enableExternalSessionPassiveRestoreForAccount({
      account: accountA,
      serverBaseUrl: server.baseUrl,
    });
    const seeded = await seedExternalSessionLiveAccount({
      account: accountA,
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
    });
    await writeInstrumentedExternalSessionLivePlugin({
      pluginRoot,
      pluginId: PLUGIN_ID,
      agentId: AGENT_ID,
      generation: 'qa-st6-generation',
      observationStatus: 'working',
      markerPath,
    });

    const daemonEnv = {
      ...process.env,
      ...preAttestedEnv,
      CI: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_VARIANT: 'dev',
    };
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
    });
    await applyTrustedLocalPluginFixture({
      daemonPort: daemon.state.httpPort,
      controlToken: daemon.state.controlToken,
      pluginRoot,
      pluginId: PLUGIN_ID,
      interactionId: 'external-session-qa-st6-install',
    });

    const uiSocket = createUserScopedSocketCollector(
      server.baseUrl,
      accountA.auth.token,
    );
    sockets.push(uiSocket);
    uiSocket.connect();
    await waitFor(() => uiSocket.isConnected(), {
      timeoutMs: 20_000,
      context: 'QA-ST-6 isolated UI socket connected',
    });
    const rpc = createDataKeyRpcClient(uiSocket, accountA.machineKey);
    const durable = await ensureLinkedPassiveExternalSession({
      machineId: seeded.machineId,
      agentId: AGENT_ID,
      remoteSessionId: 'fixture-live-durable',
      source: SOURCE,
      call: rpc.call,
    });
    const ephemeralLink = asRecord(unwrapDataKeyRpcResult(
      await rpc.call(
        `${seeded.machineId}:`
        + RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE,
        {
          machineId: seeded.machineId,
          agentId: AGENT_ID,
          remoteSessionId: 'fixture-live-ephemeral',
          source: SOURCE,
          titleHint: 'QA-ST-6 ephemeral interest',
        },
      ),
      'QA-ST-6 ephemeral link',
    ));
    expect(ephemeralLink).toEqual(expect.objectContaining({
      ok: true,
      sessionId: expect.any(String),
    }));
    const ephemeralSessionId = String(ephemeralLink?.sessionId);

    const ephemeralStatus = asRecord(unwrapDataKeyRpcResult(
      await rpc.call(
        `${seeded.machineId}:`
        + RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET,
        {
          machineId: seeded.machineId,
          sessionId: ephemeralSessionId,
          agentId: AGENT_ID,
          remoteSessionId: 'fixture-live-ephemeral',
          source: SOURCE,
        },
      ),
      'QA-ST-6 ephemeral status',
    ));
    const ephemeralExternalAgent = asRecord(ephemeralStatus?.externalAgent);
    expect(ephemeralExternalAgent).toEqual(expect.objectContaining({
      linkGeneration: expect.any(String),
    }));

    const ephemeralAttach = asRecord(unwrapDataKeyRpcResult(
      await rpc.call(
        `${seeded.machineId}:`
        + RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH,
        {
          machineId: seeded.machineId,
          sessionId: ephemeralSessionId,
          agentId: AGENT_ID,
          remoteSessionId: 'fixture-live-ephemeral',
          source: SOURCE,
          ttlMs: 60_000,
        },
      ),
      'QA-ST-6 ephemeral focused attach',
    ));
    expect(ephemeralAttach).toEqual(expect.objectContaining({
      ok: true,
      leaseId: expect.any(String),
    }));
    const ephemeralLeaseId = String(ephemeralAttach?.leaseId);
    uiSocket.emit(
      EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
      buildExternalSessionStatusDemandReplaceV1({
        revision: 1,
        entries: [{
          sessionId: ephemeralSessionId,
          machineId: seeded.machineId,
          linkGeneration: String(ephemeralExternalAgent?.linkGeneration),
          demand: 'visible',
        }],
      }),
    );

    await waitFor(async () => {
      const counts = countExternalSessionLiveLifecycleEvents({
        markerEvents:
          await readExternalSessionLiveLifecycleMarkerEvents(markerPath),
      });
      return counts.observersStarted >= 1;
    }, {
      timeoutMs: 30_000,
      context: 'QA-ST-6 pre-restart durable and ephemeral interest active',
    });
    await pulseFixture({
      daemon,
      expectedGeneration: 'qa-st6-generation',
    });

    uiSocket.emit(
      EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
      buildExternalSessionStatusDemandReplaceV1({
        revision: 2,
        entries: [],
      }),
    );
    expect(asRecord(unwrapDataKeyRpcResult(
      await rpc.call(
        `${seeded.machineId}:`
        + RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH,
        {
          machineId: seeded.machineId,
          sessionId: ephemeralSessionId,
          leaseId: ephemeralLeaseId,
        },
      ),
      'QA-ST-6 pre-restart ephemeral detach',
    ))).toEqual(expect.objectContaining({ ok: true, detached: true }));

    const beforeArchiveCounts = countExternalSessionLiveLifecycleEvents({
      markerEvents:
        await readExternalSessionLiveLifecycleMarkerEvents(markerPath),
    });
    const archived = await fetchJson<{
      success?: boolean;
      archivedAt?: number;
    }>(
      `${server.baseUrl}/v2/sessions/${durable.sessionId}/archive`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accountA.auth.token}` },
        timeoutMs: 20_000,
      },
    );
    expect(archived.status).toBe(200);
    expect(archived.data).toEqual(expect.objectContaining({
      success: true,
      archivedAt: expect.any(Number),
    }));
    await waitFor(async () => {
      const counts = countExternalSessionLiveLifecycleEvents({
        markerEvents:
          await readExternalSessionLiveLifecycleMarkerEvents(markerPath),
      });
      return counts.observersDisposed
        > beforeArchiveCounts.observersDisposed;
    }, {
      timeoutMs: 30_000,
      context: 'QA-ST-6 archive event disposes durable follow interest',
    });

    const beforeReplacementEvents =
      await readExternalSessionLiveLifecycleMarkerEvents(markerPath);
    const beforeReplacementCounts =
      countExternalSessionLiveLifecycleEvents({
        markerEvents: beforeReplacementEvents,
      });
    const originalDaemonPid = daemon.state.pid;
    const replacementState = await replaceTestDaemonWithoutStoppingSessions({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
      originalDaemon: daemon,
    });
    retiredDaemon = daemon;
    daemon = replacementState;
    expect(replacementState.state.pid).not.toBe(originalDaemonPid);

    await new Promise((resolveQuietWindow) =>
      setTimeout(resolveQuietWindow, 1_000));
    const archivedReplacementEvents =
      await readExternalSessionLiveLifecycleMarkerEvents(markerPath);
    const archivedReplacementCounts =
      countExternalSessionLiveLifecycleEvents({
        markerEvents: archivedReplacementEvents,
      });
    const replacementObserverCounts =
      countExternalSessionLiveObserverLifecycleEvents({
        markerEvents: archivedReplacementEvents,
        daemonPid: replacementState.state.pid,
        resourceKey: 'fixture-live-resource',
      });
    expect(replacementObserverCounts.observersStarted).toBe(0);
    expect(archivedReplacementCounts.followerReads)
      .toBe(beforeReplacementCounts.followerReads);

    const archivedPulse = await daemonControlPostJson({
      port: replacementState.state.httpPort,
      path: '/plugins/actions/execute',
      controlToken: replacementState.state.controlToken,
      body: {
        actionId: `${PLUGIN_ID}/pulse`,
        input: { emit: true, refresh: true },
        surface: 'cli',
      },
      timeoutMs: 30_000,
    });
    const archivedPulseData = asRecord(archivedPulse.data);
    const archivedPulseResult = asRecord(
      asRecord(archivedPulseData?.result)?.result,
    );
    expect(archivedPulseResult).toEqual(expect.objectContaining({
      available: false,
      generation: 'qa-st6-generation',
    }));

    const rpcAfterReplacement = createDataKeyRpcClient(
      uiSocket,
      accountA.machineKey,
    );
    expect(asRecord(unwrapDataKeyRpcResult(
      await rpcAfterReplacement.call(
        `${seeded.machineId}:`
        + RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH,
        {
          machineId: seeded.machineId,
          sessionId: ephemeralSessionId,
          leaseId: ephemeralLeaseId,
        },
      ),
      'QA-ST-6 stale ephemeral lease after daemon replacement',
    ))).toEqual(expect.objectContaining({ ok: true, detached: false }));

    const archivedToggleTruth = asRecord(unwrapDataKeyRpcResult(
      await rpcAfterReplacement.call(
        `${seeded.machineId}:`
        + RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET,
        {
          machineId: seeded.machineId,
          sessionId: durable.sessionId,
          agentId: AGENT_ID,
          remoteSessionId: 'fixture-live-durable',
          source: SOURCE,
          enabled: true,
        },
      ),
      'QA-ST-6 archived durable toggle truth',
    ));
    expect(archivedToggleTruth).toEqual(expect.objectContaining({
      ok: true,
      enabled: true,
      leaseActive: false,
    }));

    const unarchived = await fetchJson<{
      success?: boolean;
      archivedAt?: null;
    }>(
      `${server.baseUrl}/v2/sessions/${durable.sessionId}/unarchive`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accountA.auth.token}` },
        timeoutMs: 20_000,
      },
    );
    expect(unarchived.status).toBe(200);
    expect(unarchived.data).toEqual({ success: true, archivedAt: null });
    const replacementDurableObserverCapture: {
      current: ExternalSessionLiveLifecycleObserverMarkerEvent | null;
    } = { current: null };
    await waitFor(async () => {
      const events =
        await readExternalSessionLiveLifecycleMarkerEvents(markerPath);
      const replacementDurableObserver =
        findUnmatchedExternalSessionLiveObserverStarts({
          markerEvents: events,
          daemonPid: replacementState.state.pid,
          resourceKey: 'fixture-live-resource',
          requestedLinkKey: 'fixture-live-link:fixture-live-durable',
        }).find(
          (event) => event.requestedLinkKeys?.includes(
            'fixture-live-link:fixture-live-durable',
          ) === true
          && event.requestedLinkKeys?.includes(
            'fixture-live-link:fixture-live-ephemeral',
          ) === false,
        );
      if (!replacementDurableObserver) {
        return false;
      }
      replacementDurableObserverCapture.current = replacementDurableObserver;
      const metadata = await fetchSessionMetadataV2({
        baseUrl: server!.baseUrl,
        token: accountA.auth.token,
        sessionId: durable.sessionId,
        machineKeys: [accountA.machineKey],
      });
      const linked = asRecord(metadata.externalSessionV1);
      const followPolicy = asRecord(linked?.followPolicyV1);
      const followStatus = asRecord(linked?.followStatusV1);
      return followPolicy?.policy === 'background_follow'
        && followStatus?.status === 'active';
    }, {
      timeoutMs: 30_000,
      context:
        'QA-ST-6 unarchive resumes only retained durable explicit intent',
    });
    const replacementDurableObserverStarted =
      replacementDurableObserverCapture.current;
    if (
      !replacementDurableObserverStarted
      || typeof replacementDurableObserverStarted.daemonPid !== 'number'
      || typeof replacementDurableObserverStarted.resourceKey !== 'string'
      || typeof replacementDurableObserverStarted.observerInstanceId !== 'string'
      || !replacementDurableObserverStarted.requestedLinkKeys
    ) {
      throw new Error(
        'QA-ST-6 did not capture the replacement durable observer instance',
      );
    }
    const replacementDurableObserver = {
      daemonPid: replacementDurableObserverStarted.daemonPid,
      resourceKey: replacementDurableObserverStarted.resourceKey,
      observerInstanceId:
        replacementDurableObserverStarted.observerInstanceId,
      requestedLinkKeys:
        replacementDurableObserverStarted.requestedLinkKeys,
    } as const;

    const beforeReplacementPulseEvents =
      await readExternalSessionLiveLifecycleMarkerEvents(markerPath);
    const followerReadsBeforeReplacementPulse =
      countExternalSessionLiveFollowerReadEvents({
        markerEvents: beforeReplacementPulseEvents,
        daemonPid: replacementState.state.pid,
        remoteSessionId: 'fixture-live-durable',
      });
    const refreshRequestsBeforeReplacementPulse =
      countExternalSessionLiveRefreshRequestEvents({
        markerEvents: beforeReplacementPulseEvents,
        daemonPid: replacementState.state.pid,
        linkKey: 'fixture-live-link:fixture-live-durable',
      });
    await pulseFixture({
      daemon: {
        ...daemon,
        state: replacementState.state,
      },
      expectedGeneration: 'qa-st6-generation',
    });
    await waitFor(async () => {
      const events =
        await readExternalSessionLiveLifecycleMarkerEvents(markerPath);
      const followerReads = countExternalSessionLiveFollowerReadEvents({
        markerEvents: events,
        daemonPid: replacementState.state.pid,
        remoteSessionId: 'fixture-live-durable',
      });
      const refreshRequests = countExternalSessionLiveRefreshRequestEvents({
        markerEvents: events,
        daemonPid: replacementState.state.pid,
        linkKey: 'fixture-live-link:fixture-live-durable',
      });
      return followerReads > followerReadsBeforeReplacementPulse
        && refreshRequests > refreshRequestsBeforeReplacementPulse;
    }, {
      timeoutMs: 30_000,
      context: 'QA-ST-6 durable follow active in replacement daemon',
    });

    const finalMetadata = await fetchSessionMetadataV2({
      baseUrl: server.baseUrl,
      token: accountA.auth.token,
      sessionId: durable.sessionId,
      machineKeys: [accountA.machineKey],
    });
    const daemonList = await daemonControlPostJson({
      port: replacementState.state.httpPort,
      path: '/list',
      controlToken: replacementState.state.controlToken,
      body: {},
      timeoutMs: 20_000,
    });
    expect(daemonList.status).toBe(200);
    expect(daemonList.data.children).toEqual([]);
    expect(finalMetadata.externalSessionV1).toBeDefined();
    expect(finalMetadata.externalHistoryImportV1).toBeUndefined();
    expect(finalMetadata.externalSessionOperationV1).toBeUndefined();

    const liveReplacementDurableObservers =
      findUnmatchedExternalSessionLiveObserverStarts({
        markerEvents:
          await readExternalSessionLiveLifecycleMarkerEvents(markerPath),
        daemonPid: replacementState.state.pid,
        resourceKey: replacementDurableObserver.resourceKey,
        requestedLinkKey: 'fixture-live-link:fixture-live-durable',
      });
    expect(liveReplacementDurableObservers).toEqual([
      replacementDurableObserverStarted,
    ]);

    const disabled = asRecord(unwrapDataKeyRpcResult(
      await rpcAfterReplacement.call(
        `${seeded.machineId}:`
        + RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET,
        {
          machineId: seeded.machineId,
          sessionId: durable.sessionId,
          agentId: AGENT_ID,
          remoteSessionId: 'fixture-live-durable',
          source: SOURCE,
          enabled: false,
        },
      ),
      'QA-ST-6 final durable cleanup',
    ));
    expect(disabled).toEqual(expect.objectContaining({
      ok: true,
      enabled: false,
      leaseActive: false,
    }));
    await waitFor(async () => {
      const events =
        await readExternalSessionLiveLifecycleMarkerEvents(markerPath);
      const hasExactReplacementDisposal = events.some(
        (event) => event.kind === 'observer_disposed'
          && event.daemonPid === replacementDurableObserver.daemonPid
          && event.resourceKey === replacementDurableObserver.resourceKey
          && event.observerInstanceId
            === replacementDurableObserver.observerInstanceId
          && event.requestedLinkKeys?.length
            === replacementDurableObserver.requestedLinkKeys.length
          && event.requestedLinkKeys?.every(
            (linkKey, index) => linkKey
              === replacementDurableObserver.requestedLinkKeys[index],
          ) === true,
      );
      return hasExactReplacementDisposal
        && !hasUnmatchedExternalSessionLiveObserverStarts({
          markerEvents: events,
          daemonPid: replacementState.state.pid,
          resourceKey: 'fixture-live-resource',
          requestedLinkKey: 'fixture-live-link:fixture-live-durable',
        });
    }, {
      timeoutMs: 30_000,
      context:
        'QA-ST-6 cleanup disposes the exact replacement observer instance',
    });
    const disabledPulse = await daemonControlPostJson({
      port: replacementState.state.httpPort,
      path: '/plugins/actions/execute',
      controlToken: replacementState.state.controlToken,
      body: {
        actionId: `${PLUGIN_ID}/pulse`,
        input: { emit: true, refresh: true },
        surface: 'cli',
      },
      timeoutMs: 30_000,
    });
    const disabledPulseResult = asRecord(
      asRecord(asRecord(disabledPulse.data)?.result)?.result,
    );
    expect(disabledPulseResult).toEqual(expect.objectContaining({
      available: false,
      generation: 'qa-st6-generation',
    }));
    uiSocket.close();
    sockets.splice(sockets.indexOf(uiSocket), 1);
    expect((await daemonControlPostJson({
      port: replacementState.state.httpPort,
      path: '/list',
      controlToken: replacementState.state.controlToken,
      body: {},
      timeoutMs: 20_000,
    })).data.children).toEqual([]);
    expect(hasUnmatchedExternalSessionLiveObserverStarts({
      markerEvents:
        await readExternalSessionLiveLifecycleMarkerEvents(markerPath),
      daemonPid: replacementState.state.pid,
      resourceKey: 'fixture-live-resource',
      requestedLinkKey: 'fixture-live-link:fixture-live-durable',
    })).toBe(false);
  }, 600_000);

  it('J9 preserves encrypted owner-only refresh continuity from the accepted cursor across daemon restart and owner reconnect', async () => {
    const testDir = await mkdtemp(
      join(tmpdir(), 'happier-external-j9-reconnect-e2e-'),
    );
    temporaryRoots.push(testDir);
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const pluginRoot = resolve(join(testDir, 'plugin'));
    const markerPath = resolve(join(testDir, 'lifecycle.jsonl'));
    const transcriptStatePath = resolve(join(testDir, 'transcript-state.json'));
    const transcriptText = 'j9-owner-transcript-must-stay-encrypted';
    const directoryHint = resolve(join(testDir, 'owner-private-source-path'));
    await mkdir(daemonHomeDir, { recursive: true });

    const preAttestedEnv = buildPreAttestedExternalSessionLiveEnv();
    server = await startServerLight({
      testDir,
      dbProvider: suiteDbProvider,
      extraEnv: preAttestedEnv,
    });
    const accounts = await createTwoIsolatedExternalSessionLiveAccounts(
      server.baseUrl,
    );
    await enableExternalSessionPassiveRestoreForAccount({
      account: accounts.accountA,
      serverBaseUrl: server.baseUrl,
    });
    const seeded = await seedExternalSessionLiveAccount({
      account: accounts.accountA,
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
    });
    await writeInstrumentedExternalSessionLivePlugin({
      pluginRoot,
      pluginId: PLUGIN_ID,
      agentId: AGENT_ID,
      generation: 'j9-generation',
      observationStatus: 'working',
      markerPath,
      transcriptStatePath,
      transcriptText,
    });

    const daemonEnv = {
      ...process.env,
      ...preAttestedEnv,
      CI: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_VARIANT: 'dev',
    };
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
    });
    await applyTrustedLocalPluginFixture({
      daemonPort: daemon.state.httpPort,
      controlToken: daemon.state.controlToken,
      pluginRoot,
      pluginId: PLUGIN_ID,
      interactionId: 'external-session-j9-install',
    });

    const ownerSocket = createUserScopedSocketCollector(
      server.baseUrl,
      accounts.accountA.auth.token,
    );
    const outsiderSocket = createUserScopedSocketCollector(
      server.baseUrl,
      accounts.accountB.auth.token,
    );
    sockets.push(ownerSocket, outsiderSocket);
    ownerSocket.connect();
    outsiderSocket.connect();
    await waitFor(
      () => ownerSocket.isConnected() && outsiderSocket.isConnected(),
      {
        timeoutMs: 20_000,
        context: 'J9 owner and outsider sockets connected',
      },
    );

    const ownerRpc = createDataKeyRpcClient(
      ownerSocket,
      accounts.accountA.machineKey,
    );
    const linked = await ensureLinkedPassiveExternalSession({
      machineId: seeded.machineId,
      agentId: AGENT_ID,
      remoteSessionId: REMOTE_SESSION_ID,
      source: SOURCE,
      titleHint: transcriptText,
      directoryHint,
      call: ownerRpc.call,
    });
    await waitFor(async () => (
      await readExternalSessionLiveLifecycleMarkerEvents(markerPath)
    ).some(
      (event) => event.kind === 'observer_started'
        && event.generation === 'j9-generation',
    ), {
      timeoutMs: 30_000,
      context: 'J9 initial passive observer active',
    });

    const baselinePageEnvelope = await ownerRpc.call(
      `${seeded.machineId}:`
      + RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE,
      {
        machineId: seeded.machineId,
        agentId: AGENT_ID,
        remoteSessionId: REMOTE_SESSION_ID,
        source: SOURCE,
        direction: 'older',
        maxItems: 1,
      },
    );
    const baselinePage = asRecord(unwrapDataKeyRpcResult(
      baselinePageEnvelope,
      'J9 initial transcript baseline',
    ));
    expect(baselinePage).toEqual(expect.objectContaining({
      ok: true,
      tailCursor: expect.stringMatching(/^happier_external_cursor_v1:/),
    }));
    const initialAcceptedCursor = String(baselinePage?.tailCursor);

    const attachEnvelope = await ownerRpc.call(
      `${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH}`,
      {
        machineId: seeded.machineId,
        sessionId: linked.sessionId,
        agentId: AGENT_ID,
        remoteSessionId: REMOTE_SESSION_ID,
        source: SOURCE,
        ttlMs: 60_000,
        acceptedTailCursor: initialAcceptedCursor,
      },
    );
    const attachResult = asRecord(unwrapDataKeyRpcResult(
      attachEnvelope,
      'J9 initial owner attach',
    ));
    expect(attachResult).toEqual(expect.objectContaining({
      ok: true,
      leaseId: expect.any(String),
      acceptedTailCursor: expect.stringMatching(
        /^happier_external_cursor_v1:/,
      ),
    }));
    const leaseId = String(attachResult?.leaseId);

    ownerSocket.disconnect();
    await waitFor(() => !ownerSocket.isConnected(), {
      timeoutMs: 10_000,
      context: 'J9 original owner client disconnected before source advance',
    });

    await daemon.stop();
    daemon = null;
    await writeFile(
      transcriptStatePath,
      `${JSON.stringify({ version: 1 })}\n`,
      'utf8',
    );
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
    });
    await waitFor(async () => (
      await readExternalSessionLiveLifecycleMarkerEvents(markerPath)
    ).filter(
      (event) => event.kind === 'observer_started'
        && event.generation === 'j9-generation',
    ).length >= 2, {
      timeoutMs: 30_000,
      context: 'J9 passive observer restored after disposable daemon restart',
    });

    const reconnectedOwnerSocket = createUserScopedSocketCollector(
      server.baseUrl,
      accounts.accountA.auth.token,
    );
    sockets.push(reconnectedOwnerSocket);
    reconnectedOwnerSocket.connect();
    await waitFor(
      () => reconnectedOwnerSocket.isConnected()
        && outsiderSocket.isConnected(),
      {
        timeoutMs: 20_000,
        context:
          'J9 fresh owner client re-authenticated and outsider remained connected',
      },
    );
    const reconnectedOwnerRpc = createDataKeyRpcClient(
      reconnectedOwnerSocket,
      accounts.accountA.machineKey,
    );

    const reconnectAttachEnvelope = await reconnectedOwnerRpc.call(
      `${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH}`,
      {
        machineId: seeded.machineId,
        sessionId: linked.sessionId,
        agentId: AGENT_ID,
        remoteSessionId: REMOTE_SESSION_ID,
        source: SOURCE,
        leaseId,
        ttlMs: 60_000,
        acceptedTailCursor: initialAcceptedCursor,
      },
    );
    const reconnectAttachResult = asRecord(unwrapDataKeyRpcResult(
      reconnectAttachEnvelope,
      'J9 reconnect owner attach',
    ));
    expect(reconnectAttachResult).toEqual(expect.objectContaining({
      ok: true,
      leaseId,
      acceptedTailCursor: initialAcceptedCursor,
    }));

    const firstInvalidationCount = readTranscriptInvalidations(
      reconnectedOwnerSocket,
    ).length;
    await pulseFixture({
      daemon,
      expectedGeneration: 'j9-generation',
    });
    await waitFor(
      () => readTranscriptInvalidations(reconnectedOwnerSocket).length
        > firstInvalidationCount,
      {
        timeoutMs: 30_000,
        context: 'J9 owner receives missed-update invalidation after reconnect',
      },
    );
    const firstInvalidation = readTranscriptInvalidations(
      reconnectedOwnerSocket,
    ).at(-1);
    if (!firstInvalidation) {
      throw new Error('J9 owner reconnect invalidation was not captured');
    }
    expect(firstInvalidation.binding.sessionId).toBe(linked.sessionId);
    expect(firstInvalidation.binding.machineId).toBe(seeded.machineId);
    expect(Object.keys(firstInvalidation).sort()).toEqual([
      'binding',
      'type',
      'v',
    ]);

    const firstSecureRead = await callRawEncryptedMachineRpc({
      socket: reconnectedOwnerSocket,
      machineKey: accounts.accountA.machineKey,
      method:
        `${seeded.machineId}:`
        + RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER,
      payload: {
        v: 1,
        binding: firstInvalidation.binding,
        cursor: initialAcceptedCursor,
      },
    });
    const firstResponse =
      ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse(
        firstSecureRead.result,
      );
    expect(firstResponse.result.outcome).toBe('advanced');

    const appliedItemIds: string[] = [];
    const firstDecision = decideExternalSessionTranscriptRefreshApplicationV1(
      firstInvalidation.binding,
      initialAcceptedCursor,
      firstResponse,
    );
    expect(firstDecision.kind).toBe('apply');
    if (firstDecision.kind !== 'apply') {
      throw new Error('J9 reconnect refresh did not admit the owner delta');
    }
    appliedItemIds.push(...firstDecision.items.map((item) => item.id));
    const acceptedAdvancedCursor = firstDecision.nextCursor;

    const advanceAttachEnvelope = await reconnectedOwnerRpc.call(
      `${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH}`,
      {
        machineId: seeded.machineId,
        sessionId: linked.sessionId,
        agentId: AGENT_ID,
        remoteSessionId: REMOTE_SESSION_ID,
        source: SOURCE,
        leaseId,
        ttlMs: 60_000,
        acceptedTailCursor: acceptedAdvancedCursor,
      },
    );
    const advanceAttachResult = asRecord(unwrapDataKeyRpcResult(
      advanceAttachEnvelope,
      'J9 accepted-cursor owner attach',
    ));
    expect(advanceAttachResult).toEqual(expect.objectContaining({
      ok: true,
      leaseId,
      acceptedTailCursor: acceptedAdvancedCursor,
    }));

    const currentInvalidationCount = readTranscriptInvalidations(
      reconnectedOwnerSocket,
    ).length;
    await pulseFixture({
      daemon,
      expectedGeneration: 'j9-generation',
    });
    await waitFor(
      () => readTranscriptInvalidations(reconnectedOwnerSocket).length
        > currentInvalidationCount,
      {
        timeoutMs: 30_000,
        context: 'J9 owner receives accepted-cursor invalidation',
      },
    );
    const currentInvalidation = readTranscriptInvalidations(
      reconnectedOwnerSocket,
    ).at(-1);
    if (!currentInvalidation) {
      throw new Error('J9 current-cursor invalidation was not captured');
    }
    const currentSecureRead = await callRawEncryptedMachineRpc({
      socket: reconnectedOwnerSocket,
      machineKey: accounts.accountA.machineKey,
      method:
        `${seeded.machineId}:`
        + RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER,
      payload: {
        v: 1,
        binding: currentInvalidation.binding,
        cursor: acceptedAdvancedCursor,
      },
    });
    const currentResponse =
      ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse(
        currentSecureRead.result,
      );
    expect(currentResponse.result).toEqual({ outcome: 'already_current' });
    const currentDecision = decideExternalSessionTranscriptRefreshApplicationV1(
      currentInvalidation.binding,
      acceptedAdvancedCursor,
      currentResponse,
    );
    expect(currentDecision).toEqual({
      kind: 'no_apply',
      reason: 'already_current',
      items: [],
    });
    expect(appliedItemIds).toHaveLength(1);
    expect(new Set(appliedItemIds).size).toBe(1);

    await new Promise((resolveQuietWindow) => setTimeout(resolveQuietWindow, 500));
    expect(readTranscriptInvalidations(outsiderSocket)).toEqual([]);
    expect(decryptDataKeyBase64(
      firstSecureRead.responseCiphertext,
      accounts.accountB.machineKey,
    )).toBeNull();
    for (const serverVisibleValue of [
      JSON.stringify(firstInvalidation),
      JSON.stringify(currentInvalidation),
      firstSecureRead.requestCiphertext,
      firstSecureRead.responseCiphertext,
      currentSecureRead.requestCiphertext,
      currentSecureRead.responseCiphertext,
    ]) {
      expect(serverVisibleValue).not.toContain(transcriptText);
      expect(serverVisibleValue).not.toContain(directoryHint);
      expect(serverVisibleValue).not.toContain('fixture-live-tail');
    }

    const logVisibleFixtureEnvelope = await readFile(markerPath, 'utf8');
    expect(logVisibleFixtureEnvelope).not.toContain(transcriptText);
    expect(logVisibleFixtureEnvelope).not.toContain(directoryHint);
    expect(logVisibleFixtureEnvelope).not.toContain('fixture-live-tail');
  }, 600_000);
});
