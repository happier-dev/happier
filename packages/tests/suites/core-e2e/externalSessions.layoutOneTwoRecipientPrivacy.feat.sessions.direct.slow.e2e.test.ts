import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  buildAccountStoredContentCompatibilityHttpHeadersV1,
  createPlainSessionOwnerMetadataEnvelopeV1,
  createSessionOwnerMetadataV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
  deriveBoxPublicKeyFromSeed,
  EXTERNAL_SESSION_OPERATION_METADATA_KEY,
  EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY,
  EXTERNAL_SESSION_OPERATION_TIMELINES_V1,
  ExternalSessionOperationRecordV1Schema,
  ExternalSessionOperationSharedPresentationV1Schema,
  ExternalSessionOperationStateV1Schema,
  openSessionOwnerMetadataEnvelopeV1,
  projectExternalSessionOperationProgressV1,
  projectExternalSessionOperationSharedPresentationV1,
  projectSessionOwnerCompatibilityViewV1,
  projectSessionSharedMetadataV1,
  sealEncryptedDataKeyEnvelopeV1,
  sealSessionOwnerMetadataEnvelopeV1,
  SessionSharedMetadataV1Schema,
  type ExternalSessionOperationSharedPresentationV1,
  type SessionSharedMetadataV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { projectSessionMetadataForAgentHandoff } from '../../../agents/src/runtime/surfaces/handoff';
import {
  readExternalSessionOperationRecord,
  writeExternalSessionOperationRecord,
} from '../../../../apps/cli/src/session/actions/externalSessions/operationRecordStore';
import {
  buildPreAttestedExternalSessionLiveEnv,
  createTwoIsolatedExternalSessionLiveAccounts,
  type IsolatedExternalSessionLiveAccount,
} from '../../src/testkit/externalSessionLiveLifecycleFixture';
import { fetchJson } from '../../src/testkit/http';
import { decryptDataKeyBase64, encryptDataKeyBase64 } from '../../src/testkit/rpcCrypto';
import {
  resolveTestDbProvider,
  startServerLight,
  type StartedServer,
} from '../../src/testkit/process/serverLight';
import {
  createUserScopedSocketCollector,
  type CapturedEvent,
  type SocketCollector,
} from '../../src/testkit/socketClient';
import { addFriend, fetchAccountId, setUsername } from '../../src/testkit/socialFriends';
import { waitFor } from '../../src/testkit/timing';

type AccountMode = 'plain' | 'e2ee';
type JsonRecord = Record<string, unknown>;

type ScenarioPrivacySentinels = Readonly<{
  claim: string;
  staging: string;
  log: string;
  workspace: string;
  providerNative: string;
  transcript: string;
}>;

type LayoutOneScenario = Readonly<{
  mode: AccountMode;
  owner: IsolatedExternalSessionLiveAccount;
  recipient: IsolatedExternalSessionLiveAccount;
  dataKey: Uint8Array | null;
  sessionId: string;
  shareId: string;
  publicToken: string;
  sentinels: ScenarioPrivacySentinels;
}>;

const suiteDbProvider = resolveTestDbProvider(process.env, {
  fallbackProvider: 'sqlite',
});

const CURRENT_HEADERS = buildAccountStoredContentCompatibilityHttpHeadersV1(
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
);

// Public links still use the released secretbox envelope format. The server
// treats this as an opaque, syntax-valid fixture value; shared metadata is
// independently opened with the real per-Scenario DEK below.
const CURRENT_RELEASED_PUBLIC_SHARE_DATA_KEY_ENVELOPE =
  'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJRIYkKAXBR77d5HFP5Lil/o4VB5lvpZLQNo94yuThilYBtgQ9LbGUyV6dWcbPnLGHBPcxyNkBZf40BNOjG6UZHJeiKCEmhA0XoQPUg27S16lSOR18S2AquqS32k0IM423w3n9rcPLiwrLKN7Pw9JYN+Ubz8mNl4CQHdiIDyjQKosZbPxByuWtcw+kPOkR';

function asRecord(value: unknown, context: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${context} object, got ${JSON.stringify(value)}`);
  }
  return value as JsonRecord;
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected ${context} string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function createTerminalOperationRecord(input: Readonly<{
  operationId: string;
  sessionId: string;
  sentinels: ScenarioPrivacySentinels;
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
        machineId: input.sentinels.providerNative,
        remoteSessionId: input.sentinels.transcript,
        qualifiedIdentity: {
          v: 1,
          agent: {
            pluginId: 'com.example.external-session-layout-one-privacy',
            localId: 'fixture',
          },
          source: { kind: 'jsonl', contractVersion: 1 },
        },
        linkGeneration: `link-${input.operationId}`,
        sourceGeneration: `source-${input.operationId}`,
        contributionGeneration: `contribution-${input.operationId}`,
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
      acknowledgedBatchId: `batch-${input.operationId}`,
      requiredItemFailures: {
        total: 0,
        record: 0,
        media: 0,
        conversion: 0,
        diagnosticsTruncated: false,
        diagnostics: [],
      },
    },
    bindings: {
      operationClaimId: input.sentinels.claim,
      privateStagingId: input.sentinels.staging,
    },
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

function encodeSessionValue(
  mode: AccountMode,
  value: unknown,
  dataKey: Uint8Array | null,
): string {
  if (mode === 'plain') return JSON.stringify(value);
  if (!dataKey) throw new Error('E2EE Scenario is missing its Session DEK');
  return encryptDataKeyBase64(value, dataKey);
}

function decodeSessionValue(
  mode: AccountMode,
  ciphertext: unknown,
  dataKey: Uint8Array | null,
  context: string,
): unknown {
  const encoded = requireString(ciphertext, context);
  if (mode === 'plain') {
    try {
      return JSON.parse(encoded) as unknown;
    } catch {
      throw new Error(`Expected ${context} to contain JSON`);
    }
  }
  if (!dataKey) throw new Error('E2EE Scenario is missing its Session DEK');
  const opened = decryptDataKeyBase64(encoded, dataKey);
  if (opened === null) throw new Error(`Could not open ${context}`);
  return opened;
}

function readSharedMetadata(
  scenario: LayoutOneScenario,
  carrier: JsonRecord,
  context: string,
): SessionSharedMetadataV1 {
  return SessionSharedMetadataV1Schema.parse(
    decodeSessionValue(
      scenario.mode,
      carrier.metadata,
      scenario.dataKey,
      `${context}.metadata`,
    ),
  );
}

function assertExactSharedPresentation(params: Readonly<{
  scenario: LayoutOneScenario;
  carrier: JsonRecord;
  expected: ExternalSessionOperationSharedPresentationV1;
  context: string;
}>): SessionSharedMetadataV1 {
  const shared = readSharedMetadata(
    params.scenario,
    params.carrier,
    params.context,
  );
  const presentation = ExternalSessionOperationSharedPresentationV1Schema.parse(
    shared[EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY],
  );
  expect(presentation).toEqual(params.expected);
  expect(Object.keys(presentation).sort()).toEqual([
    'kind',
    'operationId',
    'phase',
    'revision',
    'status',
    'v',
  ]);
  expect(shared).not.toHaveProperty(EXTERNAL_SESSION_OPERATION_METADATA_KEY);
  const serialized = JSON.stringify(shared);
  for (const sentinel of Object.values(params.scenario.sentinels)) {
    expect(serialized).not.toContain(sentinel);
  }
  return shared;
}

function openOwnerMetadata(
  scenario: LayoutOneScenario,
  carrier: JsonRecord,
  context: string,
) {
  const opened = openSessionOwnerMetadataEnvelopeV1({
    accountMode: scenario.mode,
    envelope: carrier.ownerMetadata,
    material: scenario.mode === 'e2ee'
      ? { type: 'dataKey', machineKey: scenario.owner.machineKey }
      : undefined,
  });
  if (!opened.ok) {
    throw new Error(`Could not open ${context} owner metadata (${opened.reason})`);
  }
  return opened.ownerMetadata;
}

async function fetchSessionListRaw(params: Readonly<{
  baseUrl: string;
  token: string;
}>): Promise<JsonRecord[]> {
  const response = await fetchJson<{ sessions?: unknown }>(
    `${params.baseUrl}/v2/sessions?limit=100`,
    {
      headers: {
        Authorization: `Bearer ${params.token}`,
        ...CURRENT_HEADERS,
      },
      timeoutMs: 20_000,
    },
  );
  if (response.status !== 200 || !Array.isArray(response.data?.sessions)) {
    throw new Error(`Expected Session list (status=${response.status})`);
  }
  return response.data.sessions.map((row, index) =>
    asRecord(row, `sessions[${index}]`));
}

async function fetchSessionDetailRaw(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
}>): Promise<JsonRecord> {
  const response = await fetchJson<{ session?: unknown }>(
    `${params.baseUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}`,
    {
      headers: {
        Authorization: `Bearer ${params.token}`,
        ...CURRENT_HEADERS,
      },
      timeoutMs: 20_000,
    },
  );
  if (response.status !== 200) {
    throw new Error(`Expected Session detail (status=${response.status})`);
  }
  return asRecord(response.data?.session, 'session detail');
}

function findSessionRow(rows: readonly JsonRecord[], sessionId: string): JsonRecord {
  const row = rows.find((candidate) => candidate.id === sessionId);
  if (!row) throw new Error(`Expected Session ${sessionId} in list`);
  return row;
}

function findPresentationSocketUpdate(params: Readonly<{
  events: readonly CapturedEvent[];
  scenario: LayoutOneScenario;
  expected: ExternalSessionOperationSharedPresentationV1;
}>): JsonRecord | null {
  for (const event of params.events) {
    if (event.kind !== 'update') continue;
    const body = event.payload?.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) continue;
    const record = body as JsonRecord;
    if (
      record.t !== 'update-session'
      || (record.id !== params.scenario.sessionId
        && record.sid !== params.scenario.sessionId)
    ) {
      continue;
    }
    const metadata = record.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      continue;
    }
    const metadataRecord = metadata as JsonRecord;
    try {
      const shared = SessionSharedMetadataV1Schema.parse(
        decodeSessionValue(
          params.scenario.mode,
          metadataRecord.value,
          params.scenario.dataKey,
          'socket metadata',
        ),
      );
      const presentation = ExternalSessionOperationSharedPresentationV1Schema.parse(
        shared[EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY],
      );
      if (JSON.stringify(presentation) === JSON.stringify(params.expected)) {
        return record;
      }
    } catch {
      // Ignore unrelated Session updates while the publisher converges.
    }
  }
  return null;
}

async function setPlainAccountMode(baseUrl: string, token: string): Promise<void> {
  const response = await fetchJson<{ mode?: unknown }>(
    `${baseUrl}/v1/account/encryption`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'plain' }),
      timeoutMs: 20_000,
    },
  );
  expect(response.status).toBe(200);
  expect(response.data?.mode).toBe('plain');
}

async function createScenario(params: Readonly<{
  server: StartedServer;
  mode: AccountMode;
}>): Promise<LayoutOneScenario> {
  const { accountA: owner, accountB: recipient } =
    await createTwoIsolatedExternalSessionLiveAccounts(params.server.baseUrl);
  if (params.mode === 'plain') {
    await setPlainAccountMode(params.server.baseUrl, owner.auth.token);
  }

  const suffix = randomUUID().replaceAll('-', '');
  const ownerId = await fetchAccountId(params.server.baseUrl, owner.auth.token);
  const recipientId = await fetchAccountId(
    params.server.baseUrl,
    recipient.auth.token,
  );
  await setUsername(
    params.server.baseUrl,
    owner.auth.token,
    `es_owner_${suffix.slice(0, 12)}`,
  );
  await setUsername(
    params.server.baseUrl,
    recipient.auth.token,
    `es_recipient_${suffix.slice(0, 12)}`,
  );
  await addFriend(params.server.baseUrl, owner.auth.token, recipientId);
  await addFriend(params.server.baseUrl, recipient.auth.token, ownerId);

  const sentinels: ScenarioPrivacySentinels = {
    claim: `private-claim-${suffix}`,
    staging: `private-staging-${suffix}`,
    log: `/private/session-log-${suffix}.jsonl`,
    workspace: `/private/workspace-${suffix}`,
    providerNative: `private-provider-native-${suffix}`,
    transcript: `/private/provider-transcript-${suffix}.jsonl`,
  };
  const ownerMetadataInput: JsonRecord = {
    path: sentinels.workspace,
    host: `private-host-${suffix}`,
    sessionLogPath: sentinels.log,
    codexSessionId: sentinels.providerNative,
    claudeTranscriptPath: sentinels.transcript,
  };
  const ownerProjection = createSessionOwnerMetadataV1({
    metadata: ownerMetadataInput,
  });
  if (!ownerProjection.ok) {
    throw new Error(
      `Owner metadata fixture is unsupported: ${ownerProjection.unsupportedFields.join(', ')}`,
    );
  }
  const agentStateInput = {
    privateProviderNativeState: sentinels.providerNative,
    privateTranscriptDetail: sentinels.transcript,
  };
  const dataKey = params.mode === 'e2ee'
    ? Uint8Array.from(randomBytes(32))
    : null;
  const ownerEnvelope = params.mode === 'plain'
    ? createPlainSessionOwnerMetadataEnvelopeV1(ownerProjection.ownerMetadata)
    : sealSessionOwnerMetadataEnvelopeV1({
        material: { type: 'dataKey', machineKey: owner.machineKey },
        ownerMetadata: ownerProjection.ownerMetadata,
        randomBytes: (length) => Uint8Array.from(randomBytes(length)),
      });
  const sharedMetadata = projectSessionSharedMetadataV1({
    metadata: ownerMetadataInput,
    agentState: agentStateInput,
  });
  const sealedOwnerDataKey = dataKey
    ? sealEncryptedDataKeyEnvelopeV1({
        dataKey,
        recipientPublicKey: deriveBoxPublicKeyFromSeed(owner.machineKey),
        randomBytes: (length) => Uint8Array.from(randomBytes(length)),
      })
    : null;

  const create = await fetchJson<{
    created?: unknown;
    session?: unknown;
  }>(`${params.server.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${owner.auth.token}`,
      'Content-Type': 'application/json',
      ...CURRENT_HEADERS,
    },
    body: JSON.stringify({
      tag: `es-layout-one-privacy-${params.mode}-${suffix}`,
      metadataLayoutVersion: 1,
      sharedMetadata: {
        ciphertext: encodeSessionValue(params.mode, sharedMetadata, dataKey),
      },
      ownerMetadata: ownerEnvelope,
      agentState: encodeSessionValue(params.mode, agentStateInput, dataKey),
      dataEncryptionKey: sealedOwnerDataKey
        ? Buffer.from(sealedOwnerDataKey).toString('base64')
        : null,
      encryptionMode: params.mode,
    }),
    timeoutMs: 20_000,
  });
  expect(create.status).toBe(200);
  expect(create.data?.created).toBe(true);
  const createdSession = asRecord(create.data?.session, 'created Session');
  expect(createdSession.metadataLayoutVersion).toBe(1);
  const sessionId = requireString(createdSession.id, 'created Session id');

  const recipientDataKey = dataKey
    ? Buffer.from(sealEncryptedDataKeyEnvelopeV1({
        dataKey,
        recipientPublicKey: deriveBoxPublicKeyFromSeed(recipient.machineKey),
        randomBytes: (length) => Uint8Array.from(randomBytes(length)),
      })).toString('base64')
    : undefined;
  const share = await fetchJson<{ share?: unknown }>(
    `${params.server.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/shares`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${owner.auth.token}`,
        'Content-Type': 'application/json',
        ...CURRENT_HEADERS,
      },
      body: JSON.stringify({
        userId: recipientId,
        accessLevel: 'view',
        ...(recipientDataKey ? { encryptedDataKey: recipientDataKey } : {}),
      }),
      timeoutMs: 20_000,
    },
  );
  expect(share.status).toBe(200);
  const shareId = requireString(
    asRecord(share.data?.share, 'created share').id,
    'created share id',
  );

  const publicToken = `es_public_${params.mode}_${suffix}`;
  const publicShare = await fetchJson<{ publicShare?: unknown }>(
    `${params.server.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/public-share`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${owner.auth.token}`,
        'Content-Type': 'application/json',
        ...CURRENT_HEADERS,
      },
      body: JSON.stringify({
        token: publicToken,
        isConsentRequired: false,
        ...(params.mode === 'e2ee'
          ? { encryptedDataKey: CURRENT_RELEASED_PUBLIC_SHARE_DATA_KEY_ENVELOPE }
          : {}),
      }),
      timeoutMs: 20_000,
    },
  );
  expect(publicShare.status).toBe(200);

  return {
    mode: params.mode,
    owner,
    recipient,
    dataKey,
    sessionId,
    shareId,
    publicToken,
    sentinels,
  };
}

async function publishOperationTuple(params: Readonly<{
  baseUrl: string;
  scenario: LayoutOneScenario;
  progress: ReturnType<typeof projectExternalSessionOperationProgressV1>;
  presentation: ExternalSessionOperationSharedPresentationV1;
}>): Promise<void> {
  const current = await fetchSessionDetailRaw({
    baseUrl: params.baseUrl,
    token: params.scenario.owner.auth.token,
    sessionId: params.scenario.sessionId,
  });
  const currentShared = readSharedMetadata(
    params.scenario,
    current,
    `${params.scenario.mode} pre-publication owner detail`,
  );
  const currentOwner = openOwnerMetadata(
    params.scenario,
    current,
    `${params.scenario.mode} pre-publication owner detail`,
  );
  const compatibilityMetadata = projectSessionOwnerCompatibilityViewV1({
    sharedMetadata: currentShared,
    ownerMetadata: currentOwner,
  });
  const nextMetadata = {
    ...compatibilityMetadata,
    [EXTERNAL_SESSION_OPERATION_METADATA_KEY]: {
      v: 1,
      progress: params.progress,
    },
    [EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY]:
      params.presentation,
  };
  const nextOwner = createSessionOwnerMetadataV1({ metadata: nextMetadata });
  if (!nextOwner.ok) {
    throw new Error(
      `Published owner metadata is unsupported: ${nextOwner.unsupportedFields.join(', ')}`,
    );
  }
  const currentAgentState = decodeSessionValue(
    params.scenario.mode,
    current.agentState,
    params.scenario.dataKey,
    `${params.scenario.mode} owner Agent state`,
  );
  const nextShared = projectSessionSharedMetadataV1({
    metadata: nextMetadata,
    agentState: currentAgentState,
  });
  const nextOwnerEnvelope = params.scenario.mode === 'plain'
    ? createPlainSessionOwnerMetadataEnvelopeV1(nextOwner.ownerMetadata)
    : sealSessionOwnerMetadataEnvelopeV1({
        material: {
          type: 'dataKey',
          machineKey: params.scenario.owner.machineKey,
        },
        ownerMetadata: nextOwner.ownerMetadata,
        randomBytes: (length) => Uint8Array.from(randomBytes(length)),
      });
  const response = await fetchJson<JsonRecord>(
    `${params.baseUrl}/v2/sessions/${encodeURIComponent(params.scenario.sessionId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${params.scenario.owner.auth.token}`,
        'Content-Type': 'application/json',
        ...CURRENT_HEADERS,
      },
      body: JSON.stringify({
        mode: 'owner',
        metadataLayoutVersion: 1,
        expectedOwnerMetadata: current.ownerMetadata,
        sharedMetadata: {
          ciphertext: encodeSessionValue(
            params.scenario.mode,
            nextShared,
            params.scenario.dataKey,
          ),
          expectedVersion: current.metadataVersion,
        },
        ownerMetadata: nextOwnerEnvelope,
        agentState: {
          ciphertext: current.agentState,
          expectedVersion: current.agentStateVersion,
        },
      }),
      timeoutMs: 20_000,
    },
  );
  expect(response.status).toBe(200);
  expect(response.data?.success).toBe(true);
}

async function updateShareAccess(params: Readonly<{
  baseUrl: string;
  ownerToken: string;
  sessionId: string;
  shareId: string;
  accessLevel: 'edit' | 'admin';
}>): Promise<void> {
  const response = await fetchJson<{ share?: unknown }>(
    `${params.baseUrl}/v1/sessions/${encodeURIComponent(params.sessionId)}/shares/${encodeURIComponent(params.shareId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${params.ownerToken}`,
        'Content-Type': 'application/json',
        ...CURRENT_HEADERS,
      },
      body: JSON.stringify({ accessLevel: params.accessLevel }),
      timeoutMs: 20_000,
    },
  );
  expect(response.status).toBe(200);
  expect(asRecord(response.data?.share, 'updated share').accessLevel).toBe(
    params.accessLevel,
  );
}

describe('core e2e: External Sessions layout-1 two-recipient privacy', () => {
  let server: StartedServer | null = null;
  let testDir: string | null = null;
  const sockets = new Set<SocketCollector>();

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.clear();
    const cleanupErrors: Error[] = [];
    await server?.stop().catch((error: unknown) => {
      cleanupErrors.push(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
    server = null;
    if (testDir) await rm(testDir, { recursive: true, force: true });
    testDir = null;
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'Layout-1 privacy teardown failed');
    }
  });

  it('keeps complete progress and private source facts owner-only for real plain and E2EE rows across sharing, sockets, and export', async () => {
    testDir = await (async () => {
      const prefix = resolve(join(tmpdir(), 'happier-es-layout-one-privacy-'));
      await mkdir(prefix, { recursive: true });
      return resolve(join(prefix, randomUUID()));
    })();
    await mkdir(testDir, { recursive: true });
    server = await startServerLight({
      testDir,
      dbProvider: suiteDbProvider,
      extraEnv: buildPreAttestedExternalSessionLiveEnv({
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: '1',
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: '1',
      }),
    });

    for (const mode of ['plain', 'e2ee'] as const) {
      const scenario = await createScenario({ server, mode });
      const modeDir = resolve(join(testDir, mode));
      const activeServerDir = resolve(join(modeDir, 'private-operation-store'));
      await mkdir(activeServerDir, { recursive: true });

      // Reading before publication makes the shared recipient interested in the
      // Session before the real Server tuple PATCH emits its socket update. The
      // plaintext plan owns fresh-create and canonical CLI publisher evidence;
      // this composed row consumes those producers and attacks recipient egress.
      const initialRecipientDetail = await fetchSessionDetailRaw({
        baseUrl: server.baseUrl,
        token: scenario.recipient.auth.token,
        sessionId: scenario.sessionId,
      });
      expect(initialRecipientDetail).not.toHaveProperty('ownerMetadata');

      const ownerSocket = createUserScopedSocketCollector(
        server.baseUrl,
        scenario.owner.auth.token,
        { declareCurrentAccountStoredContentCompatibility: true },
      );
      const recipientSocket = createUserScopedSocketCollector(
        server.baseUrl,
        scenario.recipient.auth.token,
        { declareCurrentAccountStoredContentCompatibility: true },
      );
      sockets.add(ownerSocket);
      sockets.add(recipientSocket);
      ownerSocket.connect();
      recipientSocket.connect();
      await waitFor(
        () => {
          if (ownerSocket.isConnected() && recipientSocket.isConnected()) {
            return true;
          }
          const ownerConnectivity = ownerSocket.getConnectivityState();
          const recipientConnectivity = recipientSocket.getConnectivityState();
          if (
            ownerConnectivity.lastConnectError
            || recipientConnectivity.lastConnectError
          ) {
            throw new Error(JSON.stringify({
              ownerConnectivity,
              recipientConnectivity,
            }));
          }
          return false;
        },
        { timeoutMs: 30_000, context: `${mode} recipient socket pair` },
      );

      const operation = createTerminalOperationRecord({
        operationId: `operation-${mode}-${randomUUID()}`,
        sessionId: scenario.sessionId,
        sentinels: scenario.sentinels,
      });
      await writeExternalSessionOperationRecord(activeServerDir, operation);
      expect(
        await readExternalSessionOperationRecord(activeServerDir, operation.operationId),
      ).toEqual(operation);

      const expectedProgress = projectExternalSessionOperationProgressV1(operation);
      const expectedPresentation =
        projectExternalSessionOperationSharedPresentationV1(expectedProgress);
      await publishOperationTuple({
        baseUrl: server.baseUrl,
        scenario,
        progress: expectedProgress,
        presentation: expectedPresentation,
      });
      let ownerDetail: JsonRecord | null = null;
      await waitFor(async () => {
        ownerDetail = await fetchSessionDetailRaw({
          baseUrl: server!.baseUrl,
          token: scenario.owner.auth.token,
          sessionId: scenario.sessionId,
        });
        const shared = readSharedMetadata(
          scenario,
          ownerDetail,
          `${mode} owner detail`,
        );
        return JSON.stringify(
          shared[EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY],
        ) === JSON.stringify(expectedPresentation);
      }, {
        timeoutMs: 30_000,
        context: `${mode} operation tuple publication`,
      });
      if (!ownerDetail) throw new Error('Expected converged owner detail');

      const ownerShared = assertExactSharedPresentation({
        scenario,
        carrier: ownerDetail,
        expected: expectedPresentation,
        context: `${mode} owner detail`,
      });
      const ownerMetadata = openOwnerMetadata(
        scenario,
        ownerDetail,
        `${mode} owner detail`,
      );
      const ownerOperation = ExternalSessionOperationStateV1Schema.parse(
        ownerMetadata.runtime?.externalSessionOperationV1,
      );
      expect(ownerOperation).toEqual({ v: 1, progress: expectedProgress });
      expect(JSON.stringify(ownerOperation)).not.toContain(
        scenario.sentinels.claim,
      );
      expect(JSON.stringify(ownerOperation)).not.toContain(
        scenario.sentinels.staging,
      );
      expect(ownerMetadata.workspace?.path).toBe(scenario.sentinels.workspace);
      expect(ownerMetadata.runtime?.sessionLogPath).toBe(scenario.sentinels.log);
      expect(ownerMetadata.nativeSession?.codexSessionId).toBe(
        scenario.sentinels.providerNative,
      );
      expect(ownerMetadata.nativeSession?.claudeTranscriptPath).toBe(
        scenario.sentinels.transcript,
      );

      expect(operation.bindings).toMatchObject({
        operationClaimId: scenario.sentinels.claim,
        privateStagingId: scenario.sentinels.staging,
      });
      expect(operation.request.source).toMatchObject({
        machineId: scenario.sentinels.providerNative,
        remoteSessionId: scenario.sentinels.transcript,
      });

      const ownerListRow = findSessionRow(
        await fetchSessionListRaw({
          baseUrl: server.baseUrl,
          token: scenario.owner.auth.token,
        }),
        scenario.sessionId,
      );
      assertExactSharedPresentation({
        scenario,
        carrier: ownerListRow,
        expected: expectedPresentation,
        context: `${mode} owner list`,
      });
      expect(
        ExternalSessionOperationStateV1Schema.parse(
          openOwnerMetadata(
            scenario,
            ownerListRow,
            `${mode} owner list`,
          ).runtime?.externalSessionOperationV1,
        ),
      ).toEqual({ v: 1, progress: expectedProgress });

      for (const accessLevel of ['view', 'edit', 'admin'] as const) {
        if (accessLevel !== 'view') {
          await updateShareAccess({
            baseUrl: server.baseUrl,
            ownerToken: scenario.owner.auth.token,
            sessionId: scenario.sessionId,
            shareId: scenario.shareId,
            accessLevel,
          });
        }
        const recipientDetail = await fetchSessionDetailRaw({
          baseUrl: server.baseUrl,
          token: scenario.recipient.auth.token,
          sessionId: scenario.sessionId,
        });
        expect(recipientDetail).not.toHaveProperty('ownerMetadata');
        expect(recipientDetail.agentState).toBeNull();
        assertExactSharedPresentation({
          scenario,
          carrier: recipientDetail,
          expected: expectedPresentation,
          context: `${mode} ${accessLevel} detail`,
        });

        const recipientListRow = findSessionRow(
          await fetchSessionListRaw({
            baseUrl: server.baseUrl,
            token: scenario.recipient.auth.token,
          }),
          scenario.sessionId,
        );
        expect(recipientListRow).not.toHaveProperty('ownerMetadata');
        expect(recipientListRow.agentState).toBeNull();
        expect(asRecord(recipientListRow.share, 'recipient share').accessLevel)
          .toBe(accessLevel);
        assertExactSharedPresentation({
          scenario,
          carrier: recipientListRow,
          expected: expectedPresentation,
          context: `${mode} ${accessLevel} list`,
        });
      }

      const publicResponse = await fetchJson<{ session?: unknown }>(
        `${server.baseUrl}/v1/public-share/${encodeURIComponent(scenario.publicToken)}`,
        { headers: CURRENT_HEADERS, timeoutMs: 20_000 },
      );
      expect(publicResponse.status).toBe(200);
      const publicSession = asRecord(
        publicResponse.data?.session,
        `${mode} public Session`,
      );
      expect(publicSession).not.toHaveProperty('ownerMetadata');
      expect(publicSession.agentState).toBeNull();
      assertExactSharedPresentation({
        scenario,
        carrier: publicSession,
        expected: expectedPresentation,
        context: `${mode} public Session`,
      });

      const socketUpdates: {
        owner: JsonRecord | null;
        recipient: JsonRecord | null;
      } = { owner: null, recipient: null };
      await waitFor(() => {
        socketUpdates.owner = findPresentationSocketUpdate({
          events: ownerSocket.getEvents(),
          scenario,
          expected: expectedPresentation,
        });
        socketUpdates.recipient = findPresentationSocketUpdate({
          events: recipientSocket.getEvents(),
          scenario,
          expected: expectedPresentation,
        });
        return socketUpdates.owner !== null && socketUpdates.recipient !== null;
      }, { timeoutMs: 30_000 });
      const ownerSocketUpdate = socketUpdates.owner;
      const recipientSocketUpdate = socketUpdates.recipient;
      if (!ownerSocketUpdate || !recipientSocketUpdate) {
        throw new Error('Expected owner and recipient presentation socket updates');
      }
      expect(ownerSocketUpdate.metadataLayoutVersion).toBe(1);
      expect(ownerSocketUpdate).toHaveProperty('ownerMetadata');
      expect(ownerSocketUpdate).toHaveProperty('agentState');
      const ownerSocketEnvelope = asRecord(
        ownerSocketUpdate.ownerMetadata,
        'owner socket ownerMetadata',
      ).value;
      const ownerSocketMetadata = openOwnerMetadata(
        scenario,
        {
          ...ownerSocketUpdate,
          ownerMetadata: ownerSocketEnvelope,
        },
        `${mode} owner socket`,
      );
      expect(
        ExternalSessionOperationStateV1Schema.parse(
          ownerSocketMetadata.runtime?.externalSessionOperationV1,
        ),
      ).toEqual({ v: 1, progress: expectedProgress });
      const ownerSocketAgentState = asRecord(
        ownerSocketUpdate.agentState,
        'owner socket Agent state',
      ).value;
      expect(decodeSessionValue(
        scenario.mode,
        ownerSocketAgentState,
        scenario.dataKey,
        `${mode} owner socket Agent state`,
      )).toEqual({
        privateProviderNativeState: scenario.sentinels.providerNative,
        privateTranscriptDetail: scenario.sentinels.transcript,
      });
      expect(recipientSocketUpdate.metadataLayoutVersion).toBe(1);
      expect(recipientSocketUpdate).not.toHaveProperty('ownerMetadata');
      expect(asRecord(recipientSocketUpdate.agentState, 'recipient socket Agent state').value)
        .toBeNull();
      const recipientSocketSerialized = JSON.stringify(recipientSocketUpdate);
      for (const sentinel of Object.values(scenario.sentinels)) {
        expect(recipientSocketSerialized).not.toContain(sentinel);
      }

      const ownerCompatibilityView = projectSessionOwnerCompatibilityViewV1({
        sharedMetadata: ownerShared,
        ownerMetadata,
      });
      expect(
        ownerCompatibilityView[
          EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY
        ],
      ).toEqual(expectedPresentation);
      expect(
        ExternalSessionOperationStateV1Schema.parse(
          ownerCompatibilityView[EXTERNAL_SESSION_OPERATION_METADATA_KEY],
        ),
      ).toEqual({ v: 1, progress: expectedProgress });
      const agentHandoffMetadata = projectSessionMetadataForAgentHandoff(
        ownerCompatibilityView,
      );
      expect(agentHandoffMetadata).not.toHaveProperty(
        EXTERNAL_SESSION_OPERATION_METADATA_KEY,
      );
      expect(agentHandoffMetadata).not.toHaveProperty(
        EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY,
      );
      expect(agentHandoffMetadata.path).toBe(scenario.sentinels.workspace);
      expect(agentHandoffMetadata.codexSessionId).toBe(
        scenario.sentinels.providerNative,
      );
      const agentHandoffSerialized = JSON.stringify(agentHandoffMetadata);
      for (const sentinel of [
        scenario.sentinels.claim,
        scenario.sentinels.staging,
        scenario.sentinels.log,
        scenario.sentinels.transcript,
      ]) {
        expect(agentHandoffSerialized).not.toContain(sentinel);
      }

      const runtimeLogs = await Promise.all([
        readFile(server.proc.stdoutPath, 'utf8').catch(() => ''),
        readFile(server.proc.stderrPath, 'utf8').catch(() => ''),
      ]).then((parts) => parts.join('\n'));
      for (const sentinel of [
        scenario.sentinels.claim,
        scenario.sentinels.staging,
        scenario.sentinels.log,
        scenario.sentinels.workspace,
        scenario.sentinels.providerNative,
        scenario.sentinels.transcript,
      ]) {
        expect(runtimeLogs).not.toContain(sentinel);
      }

      const deletePublicShare = await fetchJson(
        `${server.baseUrl}/v1/sessions/${encodeURIComponent(scenario.sessionId)}/public-share`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${scenario.owner.auth.token}`,
            ...CURRENT_HEADERS,
          },
          timeoutMs: 20_000,
        },
      );
      expect(deletePublicShare.status).toBe(200);
      const removedPublicShare = await fetchJson(
        `${server.baseUrl}/v1/public-share/${encodeURIComponent(scenario.publicToken)}`,
        { headers: CURRENT_HEADERS, timeoutMs: 20_000 },
      );
      expect(removedPublicShare.status).toBe(404);
      const deleteDirectShare = await fetchJson(
        `${server.baseUrl}/v1/sessions/${encodeURIComponent(scenario.sessionId)}/shares/${encodeURIComponent(scenario.shareId)}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${scenario.owner.auth.token}`,
            ...CURRENT_HEADERS,
          },
          timeoutMs: 20_000,
        },
      );
      expect(deleteDirectShare.status).toBe(200);
      const removedRecipientDetail = await fetchJson(
        `${server.baseUrl}/v2/sessions/${encodeURIComponent(scenario.sessionId)}`,
        {
          headers: {
            Authorization: `Bearer ${scenario.recipient.auth.token}`,
            ...CURRENT_HEADERS,
          },
          timeoutMs: 20_000,
        },
      );
      expect(removedRecipientDetail.status).toBe(404);
      expect(
        (await fetchSessionListRaw({
          baseUrl: server.baseUrl,
          token: scenario.recipient.auth.token,
        })).some((row) => row.id === scenario.sessionId),
      ).toBe(false);
      ownerSocket.close();
      recipientSocket.close();
      sockets.delete(ownerSocket);
      sockets.delete(recipientSocket);
    }
  }, 420_000);
});
