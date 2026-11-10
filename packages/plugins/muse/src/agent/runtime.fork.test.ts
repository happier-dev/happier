import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSessionRuntimeHarness } from '@happier-dev/plugin-sdk/testing';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { evaluateAgentSessionCapabilitySupport } from '@happier-dev/agents';
import type { AgentSessionProviderCheckpoint } from '@happier-dev/plugin-sdk/agents/runtime';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';
import { readMuseRecord } from './events.js';

it('refuses a relocated native fork before starting a process or changing the source workspace', async () => {
  const targetCwd = await mkdtemp(join(tmpdir(), 'happier-muse-fork-workspace-'));
  const fixture = await createAdmittedMuseSessionFixture({ cwd: targetCwd });
  try {
    const result = await fixture.open({ kind: 'fork', sessionId: fixture.context.session.id,
      cwd: targetCwd,
      source: { sessionId: 'source-host-session', providerSessionId: '00000000-0000-7000-8000-000000000002',
        cwd: process.cwd() },
    }).catch(error => error);
    expect(fixture.launchCount).toBe(0);
    expect(result).toMatchObject({ code: 'unsupported' });
  } finally { await fixture.dispose(); await rm(targetCwd, { recursive: true, force: true }); }
});

it('forks the native conversation at the actual cut and continues only the new native identity', async () => {
  const capture = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/isolated-resume-fork-after.json', import.meta.url), 'utf8')));
  if (!Array.isArray(capture.rows)) throw new Error('Expected captured native fork rows');
  const sourceSessionId = '00000000-0000-7000-8000-000000000002';
  const forkSessionId = '00000000-0000-7000-8000-00000000002c';
  const lastTurnId = '00000000-0000-7000-8000-000000000003';
  const before = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/isolated-resume-fork-before.json', import.meta.url), 'utf8')));
  const parentEvents = createAgentSessionRuntimeHarness();
  const parent = await createAdmittedMuseSessionFixture({ native: { recording: before } });
  let checkpoint: AgentSessionProviderCheckpoint | undefined;
  let completedTurnId: string | undefined;
  try {
    const source = await parent.open({ kind: 'create', sessionId: parent.context.session.id, cwd: process.cwd() });
    source.watch(parentEvents.recordRuntimeEvent);
    expect(source.runtimeDescriptorV1?.agent.providerSessionId).toBe(sourceSessionId);
    expect(await source.send({ inputIds: ['source-first-input'], input: { text: 'ISOLATED-HISTORY-0000' },
      delivery: { kind: 'newTurn', turnId: 'source-host-first-turn' } })).toMatchObject({ status: 'admitted' });
    await parentEvents.until('turn-complete', { signal: parent.context.signal });
    const completed = parentEvents.canonicalEvents().find(event => event.kind === 'turn-complete');
    completedTurnId = completed?.kind === 'turn-complete' ? completed.agentTurnId : undefined;
    if (!completedTurnId) throw new Error('Native parent completion did not retain its turn identity');
    const boundary = parentEvents.canonicalEvents().find(event => event.kind === 'turn-rollback-boundary');
    expect(boundary).toMatchObject({ turnId: 'source-host-first-turn', agentTurnId: completedTurnId,
      providerCheckpoint: { lastTurnId: completedTurnId } });
    checkpoint = boundary?.kind === 'turn-rollback-boundary' ? boundary.providerCheckpoint : undefined;
    parentEvents.expectExactlyOneTerminalEvent({ turnId: 'source-host-first-turn' });
    parentEvents.expectAllEventsValidated();
    await parent.closeSession();
    const audit = await parent.readAudit();
    expect(audit.commandTargets).toMatchObject([
      { method: 'session/start' }, { method: 'turn/start', sessionId: sourceSessionId },
    ]);
    expect(audit.commandTargets).toHaveLength(2);
    expect(source.runtimeDescriptorV1?.agent.providerSessionId).toBe(sourceSessionId);
  } finally { parentEvents.dispose(); await parent.dispose(); }
  if (checkpoint === undefined) throw new Error('Native turn did not publish its message fork checkpoint');
  // Cross-process capture alignment: the echo recording reused its command UUID
  // as the native turn UUID, so playback correlates it to the submitted command.
  // Preserve the observed carrier across the next process without changing either Session UUID.
  const alignTurnReference = (value: JsonValue): JsonValue => {
    if (value === lastTurnId) return completedTurnId!;
    if (Array.isArray(value)) return value.map(alignTurnReference);
    if (value !== null && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, alignTurnReference(child)]));
    return value;
  };
  const forkReply = readMuseRecord(readMuseRecord(readMuseRecord(capture.rows[25]).message).result);
  const expectedProvenance = readMuseRecord(readMuseRecord(forkReply.session).forkedFrom);
  const events = createAgentSessionRuntimeHarness();
  // Exact captured fork + fork turn; omit the observational session/read between
  // them because the fork result itself carries its initial inline projection.
  const fixture = await createAdmittedMuseSessionFixture({ native: {
    recording: { rows: [...capture.rows.slice(0, 3), ...capture.rows.slice(23, 26), ...capture.rows.slice(28, 46)].map(alignTurnReference) },
    playbackSteps: [{ requestRow: 3, receiveUntilRow: 6 }, { requestRow: 6, receiveUntilRow: 24 }],
  } });
  try {
    const session = await fixture.open({ kind: 'fork', sessionId: 'host-admitted-muse', cwd: process.cwd(),
      source: { sessionId: parent.context.session.id, providerSessionId: sourceSessionId, cwd: process.cwd(),
        target: { turnId: 'source-host-first-turn', providerCheckpoint: checkpoint } },
    });
    session.watch(events.recordRuntimeEvent);
    expect(session.runtimeDescriptorV1?.agent.providerSessionId).toBe(forkSessionId);
    expect(session.runtimeDescriptorV1?.agent.forkedFrom).toMatchObject({
      sessionId: sourceSessionId, cutCursor: expectedProvenance.cutCursor, cutExplicit: true,
    });
    expect(forkSessionId).not.toBe(sourceSessionId);
    const historical = events.canonicalEvents().filter(event => event.kind === 'transcript-message-committed');
    expect(historical).toMatchObject([
      { role: 'user', text: 'ISOLATED-HISTORY-0000' }, { role: 'assistant', text: 'echo: ISOLATED-HISTORY-0000' },
    ]);
    expect(events.canonicalEvents().filter(event => event.kind === 'turn-complete' || event.kind === 'usage-observed')).toEqual([]);
    expect(await session.send({ inputIds: ['fork-input'], input: { text: 'ISOLATED-FORK-0001' },
      delivery: { kind: 'newTurn', turnId: 'fork-host-turn' } })).toMatchObject({ status: 'admitted' });
    await events.until('turn-complete', { signal: fixture.context.signal });
    events.expectExactlyOneTerminalEvent({ turnId: 'fork-host-turn' });
    events.expectAllEventsValidated();
    await fixture.closeSession();
    const audit = await fixture.readAudit();
    expect(fixture.launchCount).toBe(1);
    expect(audit.initializeCount).toBe(1);
    expect(audit.methods.filter(method => method === 'session/fork')).toHaveLength(1);
    expect(audit.methods.filter(method => method === 'session/start' || method === 'session/resume' || method === 'session/read')).toEqual([]);
    expect(audit.commandTargets).toMatchObject([
      { method: 'session/fork', sessionId: sourceSessionId, lastTurnId: completedTurnId },
      { method: 'turn/start', sessionId: forkSessionId },
    ]);
    for (const capability of ['sessionFork.conversation', 'sessionFork.fromMessage'] as const) {
      expect(evaluateAgentSessionCapabilitySupport({ agentId: 'muse', capability,
        metadata: { agentRuntimeCapabilitiesV1: session.runtimeCapabilities } })).toBe('supported');
    }
  } finally { events.dispose(); await fixture.dispose(); }
});
