import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { fetchJson } from '../../src/testkit/http';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { deletePendingQueueV2, enqueuePendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { createMachineBoundSessionScopedSocketCollector } from '../../src/testkit/sessionSocketBinding';
import { createSessionWithCiphertexts, fetchSessionV2 } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';
import { runCliJson } from '../../src/testkit/uiE2e/cliJson';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: session wait with blocked pending delivery', () => {
  let server: StartedServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('ignores only proven no-effect blocks after a completed turn', async () => {
    const testDir = run.testDir('session-wait-idle-pending-blocked');
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: { HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1' },
    });
    const baseUrl = server.baseUrl;
    const auth = await createTestAuth(baseUrl);
    const secret = new Uint8Array(randomBytes(32));
    const cliHomeDir = join(testDir, 'cli-home');
    await seedCliAuthForServer({ cliHome: cliHomeDir, serverUrl: baseUrl, token: auth.token, secret });
    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl,
      token: auth.token,
      metadataCiphertextBase64: encryptLegacyBase64({ path: testDir }, secret),
      agentStateCiphertextBase64: encryptLegacyBase64({ controlledByUser: false, requests: {} }, secret),
    });
    const { socket } = await createMachineBoundSessionScopedSocketCollector({
      baseUrl, token: auth.token, sessionId,
    });

    try {
      socket.connect();
      await waitFor(() => socket.isConnected(), { timeoutMs: 20_000 });
      await expect(socket.emitWithAck('session-runtime-activity-snapshot', {
        sessionId, mutationId: randomUUID(), snapshot: { state: 'unknown', activeCount: 0 },
      })).resolves.toMatchObject({ status: 'unchanged' });
      const turnId = randomUUID();
      for (const action of ['begin', 'complete'] as const) {
        await expect(socket.emitWithAck('session-turn-mutation', {
          v: 1, sessionId, mutationId: randomUUID(), turnId, action, observedAt: Date.now(),
        })).resolves.toMatchObject({ result: 'success', applied: true });
      }
      expect(await fetchSessionV2(baseUrl, auth.token, sessionId)).toMatchObject({ latestTurnStatus: 'completed' });

      const waitIdle = async (label: string, expectTimeout = false) => {
        const command = runCliJson({
          testDir, cliHomeDir, serverUrl: baseUrl, webappUrl: baseUrl,
          env: { ...process.env, HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1' },
          label, args: ['session', 'wait', sessionId, '--timeout', '2', '--json'],
          launchOptions: { preferSourceEntrypoint: true },
        });
        if (!expectTimeout) return await command;
        // Timeout is an expected nonzero CLI result; the JSON envelope must still
        // prove that it reached the wait owner rather than failing during launch.
        await expect(command).rejects.toThrow('exited with code 1');
        const stdout = await readFile(join(testDir, `cli.${label}.stdout.log`), 'utf8');
        return JSON.parse(stdout.trim()) as unknown;
      };
      const block = async (localId: string, reason: string) => {
        const response = await fetchJson(`${baseUrl}/v2/sessions/${sessionId}/pending/${localId}/delivery/block`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        });
        expect(response.status).toBe(200);
        expect(response.data).toMatchObject({ ok: true });
      };
      const enqueue = async () => {
        const localId = randomUUID();
        const response = await enqueuePendingQueueV2({
          baseUrl, token: auth.token, sessionId, localId,
          ciphertext: encryptLegacyBase64({ role: 'user', content: { type: 'text', text: 'pending input' } }, secret),
        });
        expect(response.status).toBe(200);
        return localId;
      };

      const noEffectLocalId = await enqueue();
      await block(noEffectLocalId, 'runtime_disposed_before_delivery');
      expect(await waitIdle('no-effect-block')).toMatchObject({ ok: true, kind: 'session_wait', data: { sessionId, idle: true } });

      // A safe blocked row must not hide separate runnable input.
      const uncertainLocalId = await enqueue();
      expect(await waitIdle('ordinary-queued', true)).toMatchObject({ ok: false, kind: 'session_wait', error: { code: 'timeout' } });
      await block(uncertainLocalId, 'ambiguous_terminal_delivery');
      expect(await waitIdle('uncertain-block', true)).toMatchObject({ ok: false, kind: 'session_wait', error: { code: 'timeout' } });

      expect((await deletePendingQueueV2({ baseUrl, token: auth.token, sessionId, localId: uncertainLocalId })).status).toBe(409);
      const dismissed = await fetchJson(`${baseUrl}/v2/sessions/${sessionId}/pending/${uncertainLocalId}/delivery/dismiss`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(dismissed.status).toBe(200);
      expect(dismissed.data).toMatchObject({ ok: true, didDismiss: true });
      expect(await waitIdle('recovered-no-effect-only')).toMatchObject({ ok: true, kind: 'session_wait', data: { idle: true } });
    } finally {
      socket.close();
    }
  });
});
