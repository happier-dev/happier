import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchMessagesSince, fetchSessionV2 } from '../../src/testkit/sessions';
import { decryptLegacyBase64Normalized } from '../../src/testkit/decryptLegacyBase64Normalized';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { waitFor } from '../../src/testkit/timing';
import { enqueuePendingQueueV2, listPendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import {
  readFakeCodexAppServerRequestLog,
  startCodexAppServerRemoteHarness,
  type StartedCodexAppServerRemoteHarness,
} from '../../src/testkit/codexAppServerRemoteHarness';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: Codex app-server remote smoke', () => {
  let harness: StartedCodexAppServerRemoteHarness | null = null;

  afterEach(async () => {
    await harness?.stop().catch(() => {});
    harness = null;
  });

  it('starts a Codex app-server remote session and materializes a queued prompt into transcript messages', async () => {
    const testDir = run.testDir('codex-app-server-remote-smoke');
    harness = await startCodexAppServerRemoteHarness({
      testDir,
      runId: run.runId,
      testName: 'codex-app-server-remote-smoke',
    });
    const { auth, requestLogPath, secret, serverBaseUrl, sessionId } = harness;

    const baselineSeq = harness.readySession.seq ?? 0;

    const localId = `pending-${randomUUID()}`;
    const userText = 'bridge-streams';
    const enqueue = await enqueuePendingQueueV2({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      localId,
      ciphertext: encryptLegacyBase64(
        {
          role: 'user',
          content: { type: 'text', text: userText },
          localId,
          meta: { source: 'ui', sentFrom: 'e2e' },
        },
        secret,
      ),
      timeoutMs: 20_000,
    });
    expect(enqueue.status).toBe(200);

    await waitFor(async () => {
      const pending = await listPendingQueueV2({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        timeoutMs: 20_000,
      });
      return pending.status === 200
        && Array.isArray(pending.data?.pending)
        && pending.data.pending.every((row) => row.localId !== localId);
    }, { timeoutMs: 45_000, context: 'codex app-server remote drains queued prompt' });

    let transcriptRows = await fetchMessagesSince({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      afterSeq: baselineSeq,
    });
    await waitFor(async () => {
      transcriptRows = await fetchMessagesSince({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        afterSeq: baselineSeq,
      });
      const localRow = transcriptRows.find((row) => row.localId === localId) ?? null;
      if (!localRow) return false;
      const userRecord = decryptLegacyBase64Normalized(localRow.content.c, secret) as Record<string, unknown> | null;
      const content = userRecord?.content as Record<string, unknown> | undefined;
      if (!(userRecord?.role === 'user' && content?.type === 'text' && content.text === userText)) return false;
      const snap = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      return typeof snap.seq === 'number' && snap.seq > baselineSeq;
    }, { timeoutMs: 45_000, context: 'codex app-server remote transcript materializes queued prompt' });

    const requests = await readFakeCodexAppServerRequestLog(requestLogPath);
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'thread/resume', params: expect.objectContaining({ threadId: sessionId }) }),
      expect.objectContaining({
        method: 'turn/start',
        params: expect.objectContaining({
          threadId: sessionId,
          input: expect.arrayContaining([expect.objectContaining({ type: 'text', text: userText })]),
        }),
      }),
    ]));
    expect(requests.some((entry) => entry.method === 'collaborationMode/list')).toBe(true);
    expect(requests.some((entry) => entry.method === 'model/list')).toBe(true);
  }, 240_000);
});
