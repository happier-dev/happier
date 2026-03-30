import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchSessionV2, patchSessionMetadataWithRetry } from '../../src/testkit/sessions';
import { createSessionScopedSocketCollector, createUserScopedSocketCollector, type CapturedEvent } from '../../src/testkit/socketClient';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';

const run = createRunDirs({ runLabel: 'core' });

function findMetadataUpdateEvent(events: CapturedEvent[], sessionId: string, version: number): CapturedEvent | null {
  for (const event of events) {
    if (event.kind !== 'update') continue;
    const body = event.payload?.body;
    if (body?.t !== 'update-session') continue;
    const sid = typeof body.sid === 'string' ? body.sid : typeof body.id === 'string' ? body.id : null;
    if (sid !== sessionId) continue;
    const metadata = body.metadata as { version?: unknown } | undefined;
    if (metadata?.version === version) {
      return event;
    }
  }
  return null;
}

describe('core e2e: HTTP v2 session patch emits updated metadata ciphertext over sockets', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('broadcasts the patched metadata ciphertext to both user-scoped and session-scoped sockets', async () => {
    const testDir = run.testDir('session-http-v2patch-emits-metadata-socket-update');
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const secret = Uint8Array.from(randomBytes(32));

    const initialMetadata = {
      path: testDir,
      host: 'e2e',
      name: 'session-http-v2patch-emits-metadata-socket-update',
      createdAt: Date.now(),
      permissionMode: 'default',
      permissionModeUpdatedAt: 1000,
    };
    const initialCiphertext = encryptLegacyBase64(initialMetadata, secret);

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-session-http-v2patch-emits-metadata-socket-update-${randomUUID()}`,
      metadataCiphertextBase64: initialCiphertext,
      agentStateCiphertextBase64: null,
    });

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'session-http-v2patch-emits-metadata-socket-update',
      sessionIds: [sessionId],
      env: {},
    });

    const userSocket = createUserScopedSocketCollector(server.baseUrl, auth.token);
    const sessionSocket = createSessionScopedSocketCollector(server.baseUrl, auth.token, sessionId);

    try {
      userSocket.connect();
      sessionSocket.connect();
      await waitFor(() => userSocket.isConnected() && sessionSocket.isConnected(), { timeoutMs: 20_000 });

      const before = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      const nextMetadata = {
        ...(decryptLegacyBase64(before.metadata, secret) as Record<string, unknown>),
        acpSessionModeOverrideV1: { v: 1, updatedAt: 2000, modeId: 'plan' },
      };
      const updatedCiphertext = encryptLegacyBase64(nextMetadata, secret);

      await patchSessionMetadataWithRetry({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        ciphertext: updatedCiphertext,
        expectedVersion: before.metadataVersion,
      });

      const expectedVersion = before.metadataVersion + 1;

      await waitFor(() => findMetadataUpdateEvent(userSocket.getEvents(), sessionId, expectedVersion) !== null, { timeoutMs: 20_000 });
      await waitFor(() => findMetadataUpdateEvent(sessionSocket.getEvents(), sessionId, expectedVersion) !== null, { timeoutMs: 20_000 });

      const after = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      expect(after.metadataVersion).toBe(expectedVersion);
      expect(after.metadata).toBe(updatedCiphertext);

      const userEvent = findMetadataUpdateEvent(userSocket.getEvents(), sessionId, expectedVersion);
      const sessionEvent = findMetadataUpdateEvent(sessionSocket.getEvents(), sessionId, expectedVersion);
      expect(userEvent).not.toBeNull();
      expect(sessionEvent).not.toBeNull();

      const userValue = (userEvent as Extract<CapturedEvent, { kind: 'update' }>).payload.body?.metadata as { value?: unknown };
      const sessionValue = (sessionEvent as Extract<CapturedEvent, { kind: 'update' }>).payload.body?.metadata as { value?: unknown };

      expect(userValue.value).toBe(updatedCiphertext);
      expect(sessionValue.value).toBe(updatedCiphertext);
      expect(decryptLegacyBase64(String(userValue.value), secret)).toEqual(nextMetadata);
      expect(decryptLegacyBase64(String(sessionValue.value), secret)).toEqual(nextMetadata);
    } finally {
      userSocket.close();
      sessionSocket.close();
    }
  }, 120_000);
});
