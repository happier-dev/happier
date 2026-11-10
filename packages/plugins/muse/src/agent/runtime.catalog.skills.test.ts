import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { AgentRuntimeJsonValueSchema, type AgentSessionControlContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createAgentSessionRuntimeHarness } from '@happier-dev/plugin-sdk/testing';
import { buildMentionRefForKindV1, MENTION_KIND_V1 } from '@happier-dev/protocol';
import { projectNativeSkillCatalog } from '@/session/catalogControls/nativeSkillCatalog';
import { resolveStructuredInputProviderDispatchContext } from '@/agent/runtime/turns/resolveStructuredInputProviderContext';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.js';
import { readMuseRecord } from './events.js';

async function skillRecording() {
  const recording = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/isolated-echo-skill-arguments.json', import.meta.url), 'utf8')));
  if (!Array.isArray(recording.rows)) throw new Error('Captured native rows are unavailable');
  const rows = recording.rows;
  const requestRow = rows.findIndex(row => readMuseRecord(readMuseRecord(row).message).method === 'skill/list');
  const request = readMuseRecord(readMuseRecord(rows[requestRow]).message);
  const sessionId = readMuseRecord(request.params).sessionId;
  if (typeof sessionId !== 'string') throw new Error('Captured native Session identity is unavailable');
  // Schema-derived duplicate of a real user selector in the captured bundled source.
  // This discriminates source identity without introducing another native schema.
  const composed = rows.map(row => {
    const frame = readMuseRecord(row);
    const message = readMuseRecord(frame.message);
    if (frame.direction !== 'recv' || message.id !== request.id) return row;
    const result = readMuseRecord(message.result);
    if (!Array.isArray(result.skills)) return row;
    const selected = result.skills.map(readMuseRecord).find(skill => skill.selector === 'happier-isolated-probe');
    if (!selected) throw new Error('Captured native skill is unavailable');
    return { ...frame, message: { ...message, result: { ...result,
      skills: [...result.skills, { ...selected, source: 'bundled' }] } } };
  });
  const playbackSteps = rows.flatMap((row, requestRow) => {
    const frame = readMuseRecord(row);
    const method = readMuseRecord(frame.message).method;
    if (frame.direction !== 'send' || !['skill/list', 'session/start', 'turn/start'].includes(String(method))) return [];
    const nextSend = rows.findIndex((row, index) => index > requestRow && readMuseRecord(row).direction === 'send');
    return [{ requestRow, receiveUntilRow: nextSend === -1 ? rows.length : nextSend }];
  });
  return { sessionId, native: { recording: { ...recording, rows: composed } as JsonValue, playbackSteps } };
}

it('lists source-qualified native skills for the selected admitted Session without opening another Session', async () => {
  const capture = await skillRecording();
  const fixture = await createAdmittedMuseSessionFixture({ native: capture.native });
  try {
    const context: AgentSessionControlContext = { ...fixture.context, session: {
      id: 'selected-history-session', cwd: process.cwd(), activity: 'inactive', providerSessionId: capture.sessionId,
      connectedAccounts: [], nativeLaunch: fixture.context.session.services.nativeLaunch,
      launchEnvironment: { values: { MUSE_TEST_SELECTED_HOME: '/selected/catalog/home' }, unset: [] },
    } };
    const result = await fixture.runtime.sessions!.catalog!.list({ kind: 'skills' }, context);
    expect(result).toMatchObject({ status: 'ok', kind: 'skills' });
    if (result.status !== 'ok' || result.kind !== 'skills') return;
    const sameSelector = result.items.filter(skill => skill.name === 'happier-isolated-probe');
    expect(sameSelector).toMatchObject([
      { origin: 'vendor', backendId: 'muse', agentId: 'muse', idSource: 'generated', projectionRef: 'user' },
      { origin: 'vendor', backendId: 'muse', agentId: 'muse', idSource: 'generated', projectionRef: 'bundled' },
    ]);
    expect(new Set(sameSelector.map(skill => skill.id)).size).toBe(2);
    const audit = await fixture.readAudit();
    expect(audit.initializeCount).toBe(1);
    expect(audit.initializedCount).toBe(1);
    expect(audit.methods.filter(method => method !== 'initialize' && method !== 'initialized')).toEqual(['skill/list']);
    expect(audit.commandCount).toBe(0);
    expect(audit.selectedHome).toBe('/selected/catalog/home');
    expect(audit.cwd).toBe(process.cwd());
  } finally { await fixture.dispose(); }
});

it('reports an unavailable native skill scope without launching a throwaway Session', async () => {
  const fixture = await createAdmittedMuseSessionFixture();
  try {
    const context: AgentSessionControlContext = { ...fixture.context, session: {
      id: 'history-without-native-id', cwd: process.cwd(), activity: 'inactive', connectedAccounts: [],
    } };
    expect(await fixture.runtime.sessions!.catalog!.list({ kind: 'skills' }, context))
      .toMatchObject({ status: 'unavailable', retryable: false });
    expect(fixture.launchCount).toBe(0);
  } finally { await fixture.dispose(); }
});

it('dispatches a source-qualified catalog reference through the host resolver to the same native skill source', async () => {
  const capture = await skillRecording();
  const fixture = await createAdmittedMuseSessionFixture({ native: capture.native });
  const events = createAgentSessionRuntimeHarness();
  try {
    const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
    session.watch(events.recordRuntimeEvent);
    const nativeSessionId = session.runtimeDescriptorV1?.agent.providerSessionId;
    if (typeof nativeSessionId !== 'string') throw new Error('Opened native Session identity is unavailable');
    const context: AgentSessionControlContext = { ...fixture.context, session: {
      id: 'host-admitted-muse', cwd: process.cwd(), activity: 'active', providerSessionId: nativeSessionId,
      connectedAccounts: [], nativeLaunch: fixture.context.session.services.nativeLaunch,
    } };
    const readCatalog = () => fixture.runtime.sessions!.catalog!.list({ kind: 'skills' }, context);
    const nativeCatalog = await readCatalog();
    expect(nativeCatalog).toMatchObject({ status: 'ok', kind: 'skills' });
    if (nativeCatalog.status !== 'ok' || nativeCatalog.kind !== 'skills') return;
    const selected = nativeCatalog.items.find(item => item.name === 'happier-isolated-probe' && item.projectionRef === 'bundled');
    expect(selected).toBeDefined();
    if (!selected) return;
    const resolved = await resolveStructuredInputProviderDispatchContext({ structuredInput: { v: 1, mentions: [{
      kind: MENTION_KIND_V1.skill, ref: buildMentionRefForKindV1(MENTION_KIND_V1.skill, selected.id),
      token: '@happier-isolated-probe', start: 0, end: 23,
    }] }, catalogs: { listSkills: async () => projectNativeSkillCatalog('muse', await readCatalog()) } });
    expect(await session.send({ inputIds: ['source-qualified-skill'], delivery: { kind: 'newTurn', turnId: 'qualified-skill-turn' },
      input: { text: 'PEBBLE', structuredInput: AgentRuntimeJsonValueSchema.parse(resolved.structuredInput) },
    })).toMatchObject({ status: 'admitted' });
    expect(resolved.structuredInput?.skillMentions?.[0]).toMatchObject({ id: selected.id, idSource: 'generated', projectionRef: 'bundled' });
    await events.until('turn-complete', { signal: new AbortController().signal });
    await fixture.closeSession();
    expect((await fixture.readAudit()).turnInputs).toEqual([[{
      type: 'skill', selector: selected.name, source: 'bundled', arguments: 'PEBBLE',
    }]]);
    events.expectAllEventsValidated();
  } finally { events.dispose(); await fixture.dispose(); }
});
