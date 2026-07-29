import { afterEach, describe, expect, it } from 'vitest';

import {
  openEncryptedDataKeyEnvelopeV1,
  RPC_METHODS,
  SessionForkRpcResultSchema,
} from '@happier-dev/protocol';

import {
  spawnConnectedCodexSession,
  startConnectedServicesCodexDaemon,
  startFakeTokenServer,
  type StartedConnectedServicesCodexDaemonFixture,
} from '../../src/testkit/connectedServicesCodexDaemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fetchJson } from '../../src/testkit/http';
import { type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { encryptDataKeyBase64, decryptDataKeyBase64 } from '../../src/testkit/rpcCrypto';
import { createUserScopedSocketCollector, type SocketCollector } from '../../src/testkit/socketClient';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { createDataKeyRpcClient } from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';
import { unwrapSerializedJsonValue } from '../../src/testkit/unwrapSerializedJsonValue';

const run = createRunDirs({ runLabel: 'core' });

type SessionCryptoSnapshot = Readonly<{
  metadataCiphertextBase64: string;
  dataEncryptionKeyBase64: string;
}>;

async function fetchSessionCryptoSnapshot(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
}): Promise<SessionCryptoSnapshot> {
  const res = await fetchJson<{ session?: { metadata?: unknown; dataEncryptionKey?: unknown } }>(
    `${params.baseUrl}/v2/sessions/${params.sessionId}`,
    {
      headers: { Authorization: `Bearer ${params.token}` },
      timeoutMs: 20_000,
    },
  );
  if (res.status !== 200) {
    throw new Error(`Failed to fetch session crypto snapshot (status=${res.status})`);
  }
  const metadata = res.data?.session?.metadata;
  const dataEncryptionKey = res.data?.session?.dataEncryptionKey;
  if (typeof metadata !== 'string' || metadata.length === 0) {
    throw new Error('Expected session metadata ciphertext');
  }
  if (typeof dataEncryptionKey !== 'string' || dataEncryptionKey.length === 0) {
    throw new Error('Expected session dataEncryptionKey');
  }
  return {
    metadataCiphertextBase64: metadata,
    dataEncryptionKeyBase64: dataEncryptionKey,
  };
}

function openSessionDataKey(snapshot: SessionCryptoSnapshot, machineKey: Uint8Array): Uint8Array {
  const dataKey = openEncryptedDataKeyEnvelopeV1({
    envelope: new Uint8Array(Buffer.from(snapshot.dataEncryptionKeyBase64, 'base64')),
    recipientSecretKeyOrSeed: machineKey,
  });
  if (!dataKey || dataKey.length !== 32) {
    throw new Error('Failed to open session dataEncryptionKey');
  }
  return dataKey;
}

function readMetadata(ciphertextBase64: string, dataKey: Uint8Array): Record<string, unknown> {
  const decrypted = unwrapSerializedJsonValue(decryptDataKeyBase64(ciphertextBase64, dataKey));
  if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) {
    throw new Error('Expected decryptable session metadata object');
  }
  return decrypted as Record<string, unknown>;
}

function readMaterializationIdentityId(metadata: Record<string, unknown>): string {
  const identity = metadata.connectedServiceMaterializationIdentityV1;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new Error('Expected connectedServiceMaterializationIdentityV1 object');
  }
  const id = (identity as { id?: unknown }).id;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('Expected connectedServiceMaterializationIdentityV1.id');
  }
  return id;
}

async function postDataKeyUiTextMessage(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  sessionKey: Uint8Array;
  localId: string;
  text: string;
}): Promise<void> {
  const message = {
    role: 'user',
    content: { type: 'text', text: params.text },
    localId: params.localId,
    meta: { source: 'ui', sentFrom: 'e2e' },
  };
  const res = await fetchJson<{ didWrite?: unknown }>(`${params.baseUrl}/v2/sessions/${params.sessionId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': params.localId,
    },
    body: JSON.stringify({
      localId: params.localId,
      messageRole: 'user',
      ciphertext: encryptDataKeyBase64(message, params.sessionKey),
    }),
    timeoutMs: 20_000,
  });
  expect(res.status).toBe(200);
  expect(res.data?.didWrite).toBe(true);
}

describe('core e2e: connected-services fork materialization identity', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let fakeTokenServer: Awaited<ReturnType<typeof startFakeTokenServer>> | null = null;
  let ui: SocketCollector | null = null;

  afterEach(async () => {
    ui?.close();
    await daemon?.stop().catch(() => {});
    await server?.stop();
    await fakeTokenServer?.stop().catch(() => {});
    ui = null;
    daemon = null;
    server = null;
    fakeTokenServer = null;
  });

  async function startFixture(): Promise<StartedConnectedServicesCodexDaemonFixture> {
    fakeTokenServer = await startFakeTokenServer({
      respond: () => ({
        status: 200,
        body: {
          access_token: 'fresh-access',
          refresh_token: 'fresh-refresh',
          id_token: 'fresh-id',
          expires_in: 3600,
        },
      }),
    });

    const fixture = await startConnectedServicesCodexDaemon({
      testDir: run.testDir('connected-services-fork-identity'),
      testName: 'connected-services-fork-identity',
      tokenUrl: fakeTokenServer.tokenUrl,
      accessToken: 'initial-access',
      refreshToken: 'initial-refresh',
      idToken: 'initial-id',
      expiresAt: Date.now() + 60 * 60_000,
      authMode: 'dataKey',
    });
    server = fixture.server;
    daemon = fixture.daemon;
    return fixture;
  }

  it('gives replay forks with inherited connected services a fresh child materialization identity', async () => {
    const fixture = await startFixture();
    const parentSpawn = await spawnConnectedCodexSession(fixture, 'connected-services-fork-parent');

    expect(parentSpawn.status).toBe(200);
    expect(parentSpawn.data?.success).toBe(true);
    expect(typeof parentSpawn.data?.sessionId).toBe('string');
    const parentSessionId = parentSpawn.data.sessionId!;
    const machineKey = fixture.machineKey;
    if (!machineKey) {
      throw new Error('Expected dataKey fixture machineKey');
    }

    const parentCrypto = await fetchSessionCryptoSnapshot({
      baseUrl: fixture.serverBaseUrl,
      token: fixture.auth.token,
      sessionId: parentSessionId,
    });
    const parentSessionKey = openSessionDataKey(parentCrypto, machineKey);

    await postDataKeyUiTextMessage({
      baseUrl: fixture.serverBaseUrl,
      token: fixture.auth.token,
      sessionId: parentSessionId,
      sessionKey: parentSessionKey,
      localId: 'connected-services-fork-identity-user-1',
      text: 'hello from connected-services fork identity e2e',
    });
    await postDataKeyUiTextMessage({
      baseUrl: fixture.serverBaseUrl,
      token: fixture.auth.token,
      sessionId: parentSessionId,
      sessionKey: parentSessionKey,
      localId: 'connected-services-fork-identity-user-2',
      text: 'second message for connected-services fork identity e2e',
    });

    const parent = await fetchSessionV2(fixture.serverBaseUrl, fixture.auth.token, parentSessionId);
    const parentMetadata = readMetadata(parentCrypto.metadataCiphertextBase64, parentSessionKey);
    expect(parentMetadata.connectedServices).toMatchObject({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected', profileId: 'work' },
      },
    });
    const parentIdentityId = readMaterializationIdentityId(parentMetadata);

    ui = createUserScopedSocketCollector(fixture.serverBaseUrl, fixture.auth.token);
    ui.connect();
    await waitFor(() => ui!.isConnected(), { timeoutMs: 20_000 });

    const machineRpc = createDataKeyRpcClient(ui, machineKey);
    const forkResponse = await machineRpc.call(
      `${fixture.machineId}:${RPC_METHODS.SESSION_FORK}`,
      {
        v: 1,
        parentSessionId,
        forkPoint: { type: 'seq', upToSeqInclusive: parent.seq },
        strategy: 'replay',
      },
      120_000,
    );

    if (!forkResponse.ok) {
      throw new Error(`Expected session.fork RPC envelope to succeed: ${forkResponse.errorCode ?? forkResponse.error ?? 'unknown'}`);
    }
    const forkResult = SessionForkRpcResultSchema.parse(forkResponse.result);
    if (!forkResult.ok) {
      throw new Error(`Expected replay fork to succeed: ${forkResult.errorCode}: ${forkResult.errorMessage}`);
    }
    expect(forkResult).toMatchObject({ ok: true });

    const child = await fetchSessionV2(fixture.serverBaseUrl, fixture.auth.token, forkResult.childSessionId);
    const childCrypto = await fetchSessionCryptoSnapshot({
      baseUrl: fixture.serverBaseUrl,
      token: fixture.auth.token,
      sessionId: forkResult.childSessionId,
    });
    const childSessionKey = openSessionDataKey(childCrypto, machineKey);
    const childMetadata = readMetadata(childCrypto.metadataCiphertextBase64, childSessionKey);
    expect(childMetadata.forkV1).toMatchObject({
      v: 1,
      parentSessionId,
      strategy: 'replay',
    });
    expect(childMetadata.replaySeedV1).toMatchObject({
      v: 1,
      sourceSessionId: parentSessionId,
    });
    expect(childMetadata.connectedServices).toEqual(parentMetadata.connectedServices);
    const childIdentityId = readMaterializationIdentityId(childMetadata);
    expect(childIdentityId).toMatch(/^csm_/);
    expect(childIdentityId).not.toBe(parentIdentityId);
    expect(JSON.stringify(child.lastRuntimeIssue ?? {})).not.toContain('connected_service_materialization_identity_missing');

    await daemonControlPostJson({
      port: fixture.daemonPort,
      path: '/stop-session',
      body: { sessionId: forkResult.childSessionId },
      controlToken: fixture.controlToken,
      timeoutMs: 30_000,
    }).catch(() => {});
    await daemonControlPostJson({
      port: fixture.daemonPort,
      path: '/stop-session',
      body: { sessionId: parentSessionId },
      controlToken: fixture.controlToken,
      timeoutMs: 30_000,
    }).catch(() => {});
  }, 300_000);
});
