import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { AgentExternalSessionsResult } from '@happier-dev/plugin-sdk/sessions/external';
import { createBoundedAgentExternalSessionsContribution } from '@/session/external/agentExternalSessionsInvocation';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { museExternalSessionsContribution } from './externalSessions.js';
import { readMuseRecord } from './events.js';
import { createMuseMspProcessFixture, readMuseMspProcessAudit } from './testkit/mspProcess.js';

function value<T>(result: AgentExternalSessionsResult<T>): T {
  expect(result.ok ? null : result).toBeNull();
  if (!result.ok) throw new Error(`External history was refused: ${result.code}`);
  return result.value;
}

async function boundary() {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-muse-history-bound-'));
  const signal = new AbortController().signal;
  const audits: string[] = [];
  let native: Awaited<ReturnType<typeof createMuseMspProcessFixture>> | undefined;
  const callbacks = createBoundedAgentExternalSessionsContribution({
    contribution: museExternalSessionsContribution,
    identity: { pluginId: 'happier.agent.muse', agentId: 'muse', occurrenceId: 'history-boundary-fixture',
      contributionQualifiedId: 'happier.agent.muse/agents/muse',
      sourceCustody: { kind: 'development', registeredRootId: 'muse-history-boundary-fixture' } },
    isCurrent: () => true, retirementSignal: signal,
    async createInvocationExec(invocationSignal) {
      if (!native) throw new Error('No native playback selected');
      const { launch: _launch, ...osBoundary } = native;
      return createStablePluginExecService({ signal: invocationSignal, isOccurrenceCurrent: () => true, ...osBoundary });
    },
  });
  return {
    callbacks, invocation: { signal, maxSerializedBytes: 524_288 },
    source: { kind: 'museNative', museHome: join(scratch, 'data/muse') },
    async recording(name: 'history' | 'isolated-long-history-reader') {
      const gzip = name !== 'history';
      const bytes = await readFile(new URL(`./testkit/fixtures/${name}.json${gzip ? '.gz' : ''}`, import.meta.url));
      const text = (gzip ? gunzipSync(bytes) : bytes).toString('utf8');
      const rows = readMuseRecord(JSON.parse(text.replaceAll(gzip ? '[TEMP]/isolated-long-history' : '[TEMP]/history', scratch))).rows;
      if (!Array.isArray(rows)) throw new Error('Sanitized native capture is missing');
      return rows;
    },
    async phase(rows: readonly JsonValue[], requestRows: readonly number[]) {
      const auditPath = join(scratch, `native-${audits.length}.json`);
      audits.push(auditPath);
      const recordingPath = join(scratch, `recording-${audits.length}.json`);
      await writeFile(recordingPath, JSON.stringify({ rows }));
      native = await createMuseMspProcessFixture({ recordingPath, auditPath,
        playbackSteps: requestRows.map(requestRow => ({ requestRow, receiveUntilRow: requestRow + 2 })) });
    },
    async assertReadOnly() {
      for (const path of audits) {
        const audit = await readMuseMspProcessAudit(path);
        expect(audit.initializeCount).toBe(1);
        expect(audit.commandCount).toBe(0);
        expect(audit.methods.every(method => ['initialize', 'initialized', 'session/read', 'view/page'].includes(method))).toBe(true);
      }
    },
    async audit(index: number) { return await readMuseMspProcessAudit(audits[index]!); },
    async dispose() { await rm(scratch, { recursive: true, force: true }); },
  };
}

it.each(['forward', 'backward'] as const)('preserves both rows of one captured Tool with one admitted item, direction=%s', async direction => {
  const fixture = await boundary();
  try {
    const rows = await fixture.recording('isolated-long-history-reader');
    const read = readMuseRecord(rows[8]);
    const readMessage = readMuseRecord(read.message);
    const result = readMuseRecord(readMessage.result);
    const page = readMuseRecord(rows[10]);
    const pageMessage = readMuseRecord(page.message);
    const pageResult = readMuseRecord(pageMessage.result);
    const nativeItems = readMuseRecord(result.history).items;
    if (!Array.isArray(pageResult.events) || !Array.isArray(nativeItems)) throw new Error('Captured native history is missing');
    const completed = pageResult.events[9]!;
    const previousCursor = readMuseRecord(readMuseRecord(pageResult.events[8]).params).viewCursor;
    const eventCursor = readMuseRecord(readMuseRecord(completed).params).viewCursor;
    const sessionId = readMuseRecord(result.session).sessionId;
    if (typeof sessionId !== 'string') throw new Error('Captured native identity is missing');
    // Schema-derived one-event window at a captured native cursor. The native
    // completed reminderChild payload is unchanged; the shared Item owner
    // represents its fallback as a Tool call and result. No model turns occur.
    const before = structuredClone(rows);
    before[8] = { ...read, message: { ...readMessage, result: { ...result,
      history: { mode: 'inline', items: nativeItems.slice(0, 1), snapshot: null }, viewCursor: previousCursor } } };
    const oneEvent = structuredClone(rows);
    oneEvent[10] = { ...page, message: { ...pageMessage, result: { ...pageResult, events: [completed], nextCursor: eventCursor } } };
    const preceding = readMuseRecord(oneEvent[12]);
    const precedingMessage = readMuseRecord(preceding.message);
    oneEvent[12] = { ...preceding, message: { ...precedingMessage,
      result: { ...pageResult, events: [pageResult.events[8]!], nextCursor: previousCursor } } };
    const precedingRequest = readMuseRecord(oneEvent[11]);
    oneEvent[11] = { ...precedingRequest, message: { ...readMuseRecord(precedingRequest.message),
      params: { sessionId, cursor: eventCursor, direction: 'backward', limit: 1 } } };
    async function after(cursor: string) {
      const result = value(await fixture.callbacks.readAfterTranscript({ ...fixture.invocation, source: fixture.source,
        remoteSessionId: sessionId as string, cursor, maxItems: 1 }));
      expect(result.outcome).toBe('advanced');
      if (result.outcome !== 'advanced') throw new Error('Tool history did not advance');
      return result;
    }
    let tail: string | undefined;
    if (direction === 'forward') {
      await fixture.phase(before, [7]);
      const initial = value(await fixture.callbacks.pageTranscript({ ...fixture.invocation, source: fixture.source,
        remoteSessionId: sessionId, direction: 'older', maxItems: 100 }));
      if (!initial.tailCursor) throw new Error('Native history did not establish a tail');
      tail = initial.tailCursor;
    }
    await fixture.phase(oneEvent, direction === 'forward' ? [9] : [7, 9, 11]);
    const first = direction === 'forward' ? await after(tail!)
      : value(await fixture.callbacks.pageTranscript({ ...fixture.invocation, source: fixture.source,
        remoteSessionId: sessionId, direction: 'older', maxItems: 1 }));
    expect(first.items).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    if (!first.nextCursor) throw new Error('Split Tool did not retain a continuation');
    await fixture.phase(oneEvent, [9]);
    const second = direction === 'forward' ? await after(first.nextCursor)
      : value(await fixture.callbacks.pageTranscript({ ...fixture.invocation, source: fixture.source,
        remoteSessionId: sessionId, cursor: first.nextCursor, direction: 'older', maxItems: 1 }));
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(2);
    expect([...first.items, ...second.items].map(item => readMuseRecord(readMuseRecord(item.raw.content).data).type))
      .toEqual(direction === 'forward' ? ['tool-call', 'tool-result'] : ['tool-result', 'tool-call']);
    const resumed = await fixture.audit(direction === 'forward' ? 2 : 1);
    expect(resumed.viewPages.map(page => page.cursor)).toEqual([previousCursor]);
    if (direction === 'backward') {
      const initial = await fixture.audit(0);
      expect(initial.viewPages.map(page => page.cursor)).toEqual([null, eventCursor]);
    }
    await fixture.assertReadOnly();
  } finally { await fixture.dispose(); }
});

it('advances through captured nonvisual native events without inventing transcript messages', async () => {
  const fixture = await boundary();
  try {
    const rows = await fixture.recording('history');
    const sessionId = readMuseRecord(readMuseRecord(rows[3]).message).params;
    const id = readMuseRecord(sessionId).sessionId;
    if (typeof id !== 'string') throw new Error('Captured native identity is missing');
    await fixture.phase(rows, [5]);
    const initial = value(await fixture.callbacks.pageTranscript({ ...fixture.invocation, source: fixture.source,
      remoteSessionId: id, direction: 'older', maxItems: 100 }));
    if (!initial.tailCursor) throw new Error('Native history did not establish a tail');
    // Exact capture: two session/branchChanged records have no visual Item.
    await fixture.phase(rows, [37]);
    const advanced = value(await fixture.callbacks.readAfterTranscript({ ...fixture.invocation, source: fixture.source,
      remoteSessionId: id, cursor: initial.tailCursor, maxItems: 2 }));
    expect(advanced).toMatchObject({ outcome: 'advanced', items: [], hasMore: true,
      diagnostics: [expect.objectContaining({ severity: 'benign', count: 2 })] });
    if (advanced.outcome !== 'advanced') throw new Error('Nonvisual native cursor did not advance');
    expect(advanced.nextCursor).not.toBe(initial.tailCursor);
    await fixture.phase(rows, [39]);
    const next = value(await fixture.callbacks.readAfterTranscript({ ...fixture.invocation, source: fixture.source,
      remoteSessionId: id, cursor: advanced.nextCursor, maxItems: 2 }));
    expect(next.outcome).toBe('advanced');
    if (next.outcome !== 'advanced') throw new Error('Following native user message was lost');
    expect(next.items.filter(item => item.raw.role === 'user')).toHaveLength(1);
    await fixture.assertReadOnly();
  } finally { await fixture.dispose(); }
});
