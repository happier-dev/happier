import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { countDuplicateLocalIds, createSession, fetchAllMessages, fetchMessagesSince, maxMessageSeq } from '../../src/testkit/sessions';
import { fetchChanges, fetchCursor } from '../../src/testkit/changes';
import { createSessionScopedSocketCollector, createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifest } from '../../src/testkit/manifest';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: session-scoped agent messages + multi-device reconnect catch-up', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('device B disconnects while agent writes; on reconnect, /v2/changes hints + messages(afterSeq) catch up to agent messages', async () => {
    const testDir = run.testDir('agent-messages-multi-device-reconnect');
    const saveArtifactsOnSuccess = envFlag('HAPPY_E2E_SAVE_ARTIFACTS', false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);

    const uiA = createUserScopedSocketCollector(server.baseUrl, auth.token);
    const uiB = createUserScopedSocketCollector(server.baseUrl, auth.token);
    const agent = createSessionScopedSocketCollector(server.baseUrl, auth.token, sessionId);

    writeTestManifest(testDir, {
      startedAt,
      runId: run.runId,
      testName: 'agent-messages-multi-device-reconnect',
      baseUrl: server.baseUrl,
      ports: { server: server.port },
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPY_E2E_SAVE_ARTIFACTS: process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('uiA.events.json', () => uiA.getEvents());
    artifacts.json('uiB.events.json', () => uiB.getEvents());
    artifacts.json('agent.events.json', () => agent.getEvents());
    artifacts.json('changes.json', async () => await fetchChanges(server!.baseUrl, auth.token, { after: 0 }));
    artifacts.json('transcript.json', async () => await fetchAllMessages(server!.baseUrl, auth.token, sessionId));

    let passed = false;
    uiA.connect();
    uiB.connect();
    agent.connect();
    await waitFor(() => uiA.isConnected() && uiB.isConnected() && agent.isConnected(), { timeoutMs: 25_000 });

    const cursor0 = await fetchCursor(server.baseUrl, auth.token);

    const sent: Array<{ label: string; seq: number; localId: string }> = [];
    const sendFromAgent = async (label: string) => {
      const ciphertext = Buffer.from(label, 'utf8').toString('base64');
      const localId = randomUUID();
      const ack = await agent.emitWithAck<{ ok: boolean; seq: number; localId: string | null }>('message', {
        sid: sessionId,
        message: ciphertext,
        localId,
      });
      expect(ack.ok).toBe(true);
      sent.push({ label, seq: ack.seq, localId });
    };

    try {
      // Phase 1: agent writes while both UIs are connected; both should receive the updates.
      await sendFromAgent('assistant-1');
      await sendFromAgent('assistant-2');

      await waitFor(() => {
        const updatesB = uiB.getEvents().filter((e) => e.kind === 'update' && e.payload?.body?.t === 'new-message');
        return updatesB.length >= 2;
      });

      const baselineSeq = Math.max(...sent.map((m) => m.seq));

      // Phase 2: B offline while agent writes more.
      uiB.disconnect();
      await waitFor(() => !uiB.isConnected(), { timeoutMs: 10_000 });

      await sendFromAgent('assistant-3');
      await sendFromAgent('assistant-4');
      await sendFromAgent('assistant-5');

      const maxSeq = Math.max(...sent.map((m) => m.seq));

      // Verify the still-online UI observes agent-sent updates.
      await waitFor(() => {
        const updatesA = uiA.getEvents().filter((e) => e.kind === 'update' && e.payload?.body?.t === 'new-message');
        return updatesA.length >= 5;
      });

      // Reconnect B and do an explicit catch-up pass like the UI would.
      uiB.connect();
      await waitFor(() => uiB.isConnected(), { timeoutMs: 20_000 });

      const changesRes = await fetchChanges(server.baseUrl, auth.token, { after: cursor0.cursor });
      const sessionChanges = changesRes.changes.filter((c) => c.kind === 'session' && c.entityId === sessionId);
      expect(sessionChanges.length).toBeGreaterThan(0);

      const last = sessionChanges[sessionChanges.length - 1]!;
      const hint = last.hint && typeof last.hint === 'object' ? (last.hint as Record<string, unknown>) : null;
      const hintedLastMessageSeq = hint && typeof hint.lastMessageSeq === 'number' ? hint.lastMessageSeq : null;
      expect(hintedLastMessageSeq).not.toBeNull();
      expect(hintedLastMessageSeq!).toBeGreaterThanOrEqual(maxSeq);

      const caughtUp = await fetchMessagesSince({ baseUrl: server.baseUrl, token: auth.token, sessionId, afterSeq: baselineSeq });
      const caughtSeqs = new Set(caughtUp.map((m) => m.seq));
      const shouldExist = sent.filter((m) => m.seq > baselineSeq).map((m) => m.seq);
      for (const seq of shouldExist) expect(caughtSeqs.has(seq)).toBe(true);

      const transcript = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
      expect(countDuplicateLocalIds(transcript)).toBe(0);
      expect(maxMessageSeq(transcript)).toBeGreaterThanOrEqual(maxSeq);

      const localIdSet = new Set(transcript.map((m) => m.localId).filter((v): v is string => typeof v === 'string'));
      for (const { localId } of sent) expect(localIdSet.has(localId)).toBe(true);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      uiA.close();
      uiB.close();
      agent.close();
    }
  });
});

