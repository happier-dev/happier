import { expect, it } from 'vitest';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createAgentSessionRuntimeHarness } from '@happier-dev/plugin-sdk/testing';
import { CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY, CurrentSessionPresentationStateV1Schema } from '@happier-dev/protocol/sessions/presentation/currentSessionPresentationV1';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';
import { readMuseLoginRecording } from './testkit/mspProcess.js';
import { readMuseRecord } from './events.js';

it('reanchors native gap and unhealthy history through the same projector without duplicate items or historical spend', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-muse-history-health-'));
  const nativeNotificationPath = join(scratch, 'notifications.json');
  const captured = readMuseRecord(await readMuseLoginRecording());
  if (!Array.isArray(captured.rows)) throw new Error('Expected captured Muse startup');
  const startup = captured.rows.slice(0, 14);
  const started = readMuseRecord(readMuseRecord(startup[12]).message);
  const nativeSession = readMuseRecord(readMuseRecord(started.params).session);
  const sessionId = nativeSession.sessionId;
  if (typeof sessionId !== 'string') throw new Error('Expected captured native Session identity');
  // Constructed v1 recovery interleavings around the captured process handshake.
  // Items, health reasons and history envelopes use the observed native schema.
  const item = { itemId: 'history-item', revision: 1, kind: 'agentMessage',
    text: 'Recovered native history', status: 'completed', turnId: 'historical-turn' };
  const rows: JsonValue[] = [...startup];
  const playbackSteps = [{ requestRow: 11, receiveUntilRow: 14 }];
  function readReply(history: JsonValue) {
    const requestRow = rows.length;
    const id = `read-${requestRow}`;
    rows.push({ direction: 'send', message: { jsonrpc: '2.0', id, method: 'session/read', params: { sessionId, excludeItems: false } } },
      { direction: 'recv', message: { jsonrpc: '2.0', id, result: { session: nativeSession,
        history, pendingRequests: [], viewCursor: 'reanchored' } } });
    playbackSteps.push({ requestRow, receiveUntilRow: rows.length });
  }
  readReply({ mode: 'none', items: null, snapshot: null, noneReason: 'historyBudget' });
  const pageRow = rows.length;
  rows.push({ direction: 'send', message: { jsonrpc: '2.0', id: 'page', method: 'view/page', params: { sessionId } } },
    { direction: 'recv', message: { jsonrpc: '2.0', id: 'page', result: { nextCursor: null, events: [
      { method: 'item/completed', params: { sessionId, item, viewCursor: 'item-cursor' } },
      { method: 'session/tokenUsage', params: { sessionId, viewCursor: 'usage-cursor', promptTokens: 12,
        totalTokens: 18, usage: { outputTokens: 6, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
    ] } } });
  playbackSteps.push({ requestRow: pageRow, receiveUntilRow: rows.length });
  readReply({ mode: 'anchoredSnapshot', items: null, snapshot: { schemaVersion: 1, state: { items: [item] } } });
  readReply({ mode: 'none', items: null, snapshot: null, noneReason: 'projectionUnavailable' });
  readReply({ mode: 'inline', items: [item], snapshot: null });
  const fixture = await createAdmittedMuseSessionFixture({ native: { recording: { rows }, playbackSteps, nativeNotificationPath } });
  const events = createAgentSessionRuntimeHarness();
  const status = () => CurrentSessionPresentationStateV1Schema.safeParse(
    fixture.host.getAgentStateSnapshot()?.[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]);
  const historyStatus = () => { const result = status(); return result.success
    ? result.data.statuses.find(entry => entry.localKey === 'muse.history')?.text : undefined; };
  async function notify(method: string, params: Record<string, JsonValue>, before: readonly JsonValue[] = []) {
    await writeFile(`${nativeNotificationPath}.complete`, JSON.stringify([...before,
      { jsonrpc: '2.0', method, params: { sessionId, ...params } }]));
    await rename(`${nativeNotificationPath}.complete`, nativeNotificationPath);
  }
  try {
    const session = await fixture.open({ kind: 'create', sessionId: fixture.context.session.id, cwd: process.cwd() });
    session.watch(events.recordRuntimeEvent);
    await notify('view/gap', { after: 'before-gap', next: 'after-gap' }, [
      { jsonrpc: '2.0', method: 'view/gap', params: { sessionId: 'another-native-session', after: 'a', next: 'b' } },
      { jsonrpc: '2.0', method: 'session/viewHealthChanged', params: { sessionId, health: 'healthy' } },
    ]);
    await expect.poll(() => events.canonicalEvents().filter(event => event.kind === 'transcript-message-committed'))
      .toMatchObject([{ messageId: item.itemId, text: item.text }]);
    const original = events.canonicalEvents().find(event => event.kind === 'transcript-message-committed');
    await notify('session/viewHealthChanged', { health: 'unavailable', noneReason: 'projectionUnavailable' });
    await fixture.waitForAudit(audit => audit.sessionReads.length === 2);
    await notify('session/viewHealthChanged', { health: 'unavailable', noneReason: 'projectionUnavailable' });
    await expect.poll(historyStatus).toContain('projectionUnavailable');
    expect(historyStatus()).toContain('incomplete');
    expect(historyStatus()).toContain('Reopen');
    await notify('view/gap', { after: 'before-next-gap', next: 'after-next-gap' });
    await expect.poll(historyStatus).toBeUndefined();
    const all = events.canonicalEvents();
    expect(all.filter(event => event.kind === 'transcript-message-committed')).toEqual([original]);
    expect(all.filter(event => event.kind === 'usage-observed' || event.kind === 'message-delta'
      || event.kind === 'turn-complete' || event.kind === 'runtime-ended')).toEqual([]);
    await fixture.closeSession();
    const audit = await fixture.readAudit();
    expect(audit.sessionReads).toHaveLength(4);
    expect(audit.viewPages).toHaveLength(1);
    expect(audit.methods.filter(method => method === 'session/start')).toHaveLength(1);
    expect(audit.methods.filter(method => method === 'turn/start' || method === 'session/resume')).toEqual([]);
    events.expectAllEventsValidated();
  } finally { events.dispose(); await fixture.dispose(); await rm(scratch, { recursive: true, force: true }); }
});
