import { afterEach, describe, expect, it } from 'vitest';

import { createTestAuth } from '../../src/testkit/auth';
import { createSession, fetchAllMessages, fetchSessionV2 } from '../../src/testkit/sessions';
import {
  fetchLatestSessionSystemRecord,
  fetchSessionSystemRecord,
  fetchSessionSystemRecordsPage,
  upsertSessionSystemRecord,
} from '../../src/testkit/sessionSystemRecords';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: memory session system records', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('roundtrips memory records through explicit APIs without transcript side effects', async () => {
    const testDir = run.testDir('memory-session-system-records');
    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);
    const before = await fetchSessionV2(server.baseUrl, auth.token, sessionId);

    const summaryContent = {
      t: 'encrypted' as const,
      c: Buffer.from(JSON.stringify({
        v: 1,
        seqFrom: 1,
        seqTo: 5,
        createdAtFromMs: 100,
        createdAtToMs: 500,
        summary: 'System-record memory summary sentinel',
        keywords: ['system-record'],
        entities: [],
        decisions: [],
      }), 'utf8').toString('base64'),
    };

    const summary = await upsertSessionSystemRecord({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      namespace: 'memory',
      kind: 'summary_shard.v1',
      localId: 'memory:summary_shard:v1:1-5',
      content: summaryContent,
    });

    expect(summary).toEqual(expect.objectContaining({
      sessionId,
      namespace: 'memory',
      kind: 'summary_shard.v1',
      localId: 'memory:summary_shard:v1:1-5',
      content: summaryContent,
    }));

    const synopsisContent = {
      t: 'encrypted' as const,
      c: Buffer.from(JSON.stringify({
        v: 1,
        seqTo: 5,
        updatedAtMs: 600,
        synopsis: 'System-record memory synopsis sentinel',
      }), 'utf8').toString('base64'),
    };

    await upsertSessionSystemRecord({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      namespace: 'memory',
      kind: 'synopsis.v1',
      localId: 'memory:synopsis:v1:5',
      content: synopsisContent,
    });

    const summaryPage = await fetchSessionSystemRecordsPage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      namespace: 'memory',
      kind: 'summary_shard.v1',
      limit: 10,
    });
    expect(summaryPage.records.map((record) => record.localId)).toEqual(['memory:summary_shard:v1:1-5']);

    const summaryLookup = await fetchSessionSystemRecord({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      namespace: 'memory',
      localId: 'memory:summary_shard:v1:1-5',
    });
    expect(summaryLookup).toEqual(expect.objectContaining({
      localId: 'memory:summary_shard:v1:1-5',
      content: summaryContent,
    }));

    const latestSynopsis = await fetchLatestSessionSystemRecord({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      namespace: 'memory',
      kind: 'synopsis.v1',
    });
    expect(latestSynopsis).toEqual(expect.objectContaining({
      localId: 'memory:synopsis:v1:5',
      content: synopsisContent,
    }));

    const transcriptMessages = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
    expect(transcriptMessages).toEqual([]);

    const after = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
    expect(after.seq).toBe(before.seq);
    expect(after.activeAt).toBe(before.activeAt);
  }, 180_000);
});
