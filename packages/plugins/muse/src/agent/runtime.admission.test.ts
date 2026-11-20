import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createAgentSessionRuntimeHarness } from '@happier-dev/plugin-sdk/testing';
import { buildWorkflowRunSystemRecordLocalId, SessionWorkflowRunSnapshotV1Schema, SessionWorkflowActivityHeadlineV1Schema,
  SessionAgentActivityHeadlineV1Schema } from '@happier-dev/plugin-sdk/sessions/work-state';
import { createApiSessionSocketStub, createSessionRuntimeActivityHomeStub, createSessionTranscriptHomeStub, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { projectRuntimeTranscriptEvent } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { SessionTranscriptObservationInputSchema, SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { createAdmittedMuseSessionFixture, MUSE_SESSION_FIXTURE_MACHINE_ID } from './testkit/admittedSession.test-support.js';
import { readMuseRecord } from './events.js';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';

// Only the remote Socket.IO boundary is replaced; the Session client remains real.
const socketObservations = { committed: [] as unknown[], acknowledgments: [] as unknown[],
  sockets: [] as ReturnType<typeof createApiSessionSocketStub>[] };
function createTranscriptSocket(onConnect: () => void) {
  const home = createSessionTranscriptHomeStub();
  const activityHome = createSessionRuntimeActivityHomeStub({ machineId: MUSE_SESSION_FIXTURE_MACHINE_ID });
  const socket = createApiSessionSocketStub({ onConnect, emitWithAck(event, payload) {
    if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) socketObservations.committed.push(SessionTranscriptObservationInputSchema.parse(payload));
    const answer = home.answer(event, payload) ?? activityHome.answer(event, payload) ?? resolveApiSessionSocketDefaultAck(event, payload);
    if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) socketObservations.acknowledgments.push(answer);
    return answer;
  } });
  socketObservations.sockets.push(socket);
  return socket;
}

it.each([undefined, 'default'])('admits Muse with model %s and streams one native owning turn', async selectedModel => {
  const agentId = 'muse';
  const sessionId = 'host-admitted-muse';
  const signal = new AbortController().signal;
  const events = createAgentSessionRuntimeHarness();
  const fixture = await createAdmittedMuseSessionFixture();
  try {
    expect(fixture.admission).toEqual({ untouchedHasMuse: false, untouchedLaunchCount: 0, selectedFactoryLaunchCount: 0 });
    const session = await fixture.open({ kind: 'create', sessionId, cwd: process.cwd(),
      launchEnvironment: { values: { MUSE_TEST_SELECTED_HOME: '/selected/native/home' }, unset: [] },
      ...(selectedModel ? { configuration: {
        model: { value: selectedModel, updatedAtMs: 0, selectionSource: 'explicit' as const },
        mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: null, updatedAtMs: 0 }, options: {},
      } } : {}),
    });
    expect(session.runtimeDescriptorV1).toMatchObject({ v: 1, agentId,
      agent: { providerSessionId: '01a1bf87-da7f-7ce0-a4ff-bab34925049f' } });
    expect(fixture.publications.modelsSource.read()).toMatchObject({ currentModelId: 'meta/muse-wonder-1.0' });
    if (!selectedModel) expect(fixture.publications.modelsSource.read().models).toBeNull();
    session.watch(events.recordRuntimeEvent);
    await session.send({ inputIds: ['admitted-input'], input: { text: 'Reply with exactly PEBBLE. Do not use tools.' },
      delivery: { kind: 'newTurn', turnId: 'admitted-turn' },
    });
    await events.until('turn-complete', { signal });
    events.expectAllEventsValidated();
    events.expectExactlyOneTerminalEvent({ turnId: 'admitted-turn' });
    expect(events.canonicalEvents().filter(event => event.kind === 'message-delta').map(event => event.text).join('')).toBe('PEBBLE');
    expect(events.canonicalEvents().filter(event => event.kind === 'transcript-message-committed' && event.role === 'assistant'))
      .toMatchObject([{ text: 'PEBBLE', turnId: 'admitted-turn' }]);
    expect(events.canonicalEvents().filter(event => event.kind === 'input-accepted'))
      .toMatchObject([{ inputIds: ['admitted-input'], delivery: { kind: 'newTurn', turnId: 'admitted-turn' } }]);
    expect(fixture.launchCount).toBe(1);
    await fixture.closeSession();
    const unboundModels = fixture.publications.modelsSource.read();
    expect(unboundModels).toEqual({ models: null });
    expect(fixture.publications.modelsSource.read()).toBe(unboundModels);
    const audit = await fixture.readAudit();
    expect(audit).toMatchObject({ initializeCount: 1, initializedCount: 1, commandCount: 2,
      cwd: process.cwd(), autoUpdate: '1', selectedHome: '/selected/native/home' });
    expect(audit.methods.filter(method => method === 'session/start')).toHaveLength(1);
    expect(audit.methods.filter(method => method === 'turn/start')).toHaveLength(1);
    expect(audit.methods.filter(method => method === 'model/list')).toHaveLength(selectedModel ? 1 : 0);
    expect(audit.modelSelections).toEqual(selectedModel ? [{ providerId: 'meta', modelId: 'muse-wonder-1.0' }] : [{}]);
    await fixture.retire();
    expect(fixture.retiredHasMuse).toBe(false);
    expect(fixture.launchCount).toBe(1);
  } finally {
    events.dispose();
    await fixture.dispose();
  }
});


it('publishes observed native tool results and inference usage without a foreground terminal', async () => {
  const recording: JsonValue = JSON.parse(await readFile(new URL('./testkit/fixtures/mcp.json', import.meta.url), 'utf8'));
  const fixture = await createAdmittedMuseSessionFixture({ native: { recording } });
  const events = createAgentSessionRuntimeHarness();
  try {
    const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd(),
      mcpServers: { probe: { command: '/fixture/mcp-probe' } } });
    session.watch(events.recordRuntimeEvent);
    await session.send({ inputIds: ['native-tool-input'],
      input: { text: 'Call the injected MCP pebble tool exactly once, then reply only with its returned word. Do not use other tools.' },
      delivery: { kind: 'newTurn', turnId: 'native-tool-turn' },
    });
    await events.until('turn-complete');
    events.expectAllEventsValidated();
    events.expectExactlyOneTerminalEvent({ turnId: 'native-tool-turn' });
    expect(events.canonicalEvents().filter(event => event.kind === 'tool-call' && event.toolName === 'mcp__probe__pebble')).toMatchObject([
      { toolCallId: 'call_01a1bf8c580c759e8fc223725db81940', toolName: 'mcp__probe__pebble', input: {}, turnId: 'native-tool-turn' },
    ]);
    expect(events.canonicalEvents().filter(event => event.kind === 'tool-result' && event.toolCallId === 'call_01a1bf8c580c759e8fc223725db81940')).toMatchObject([
      { toolCallId: 'call_01a1bf8c580c759e8fc223725db81940', output: 'PEBBLE', isError: false, turnId: 'native-tool-turn' },
    ]);
    const inferenceUsage = events.canonicalEvents().filter(event => event.kind === 'usage-observed' && event.tokens);
    expect(inferenceUsage).toMatchObject([
      { scope: 'turn_delta', tokens: { input: 28274, output: 90, reasoning: 33, cacheRead: 0, total: 28364 } },
      { scope: 'turn_delta', tokens: { input: 28397, output: 20, reasoning: 8, cacheRead: 28148, total: 28417 } },
    ]);
    expect(new Set(inferenceUsage.map(event => event.kind === 'usage-observed' && event.observationId)).size).toBe(2);
    const turnEvents = events.canonicalEvents();
    const turnStart = turnEvents.find(event => event.kind === 'turn-start');
    const turnComplete = turnEvents.find(event => event.kind === 'turn-complete');
    expect(turnEvents.filter(event => event.kind === 'mcp-tool-usage')).toMatchObject([{
      turnId: 'native-tool-turn',
      agentTurnId: turnStart?.agentTurnId,
      window: { startMs: turnStart?.emittedAtMs, endMs: expect.any(Number) },
      coverage: 'partial',
      servers: [{ serverName: 'probe', toolCallCount: 1, schemaBytes: null }],
    }]);
    const usage = turnEvents.find(event => event.kind === 'mcp-tool-usage');
    expect(usage?.sequence).toBeLessThan(turnComplete!.sequence);
  } finally {
    events.dispose();
    await fixture.dispose();
  }
});

it('projects partial native arguments through the real Session tool snapshot consumer', async () => {
  const firstSocket = socketObservations.sockets.length;
  const firstCommit = socketObservations.committed.length;
  const firstAcknowledgment = socketObservations.acknowledgments.length;
  const captured: JsonValue = JSON.parse(await readFile(new URL('./testkit/fixtures/mcp.json', import.meta.url), 'utf8'));
  const rows = readMuseRecord(captured).rows;
  if (!Array.isArray(rows)) throw new Error('Expected captured native rows');
  // Schema-derived boundary variation: args is a partial JSON string until the final native snapshot.
  const partialRows = rows.flatMap(row => {
    const message = readMuseRecord(readMuseRecord(row).message);
    const params = readMuseRecord(message.params);
    const item = readMuseRecord(params.item);
    if (item.kind !== 'toolCall') return [row];
    if (message.method === 'item/started') return [{ ...readMuseRecord(row), message: { ...message,
      params: { ...params, item: { ...item, args: '' } } } },
      { ...readMuseRecord(row), message: { ...message, method: 'item/updated',
        params: { ...params, item: { ...item, revision: 2, args: '{' } } } }];
    return [{ ...readMuseRecord(row), message: { ...message, params: { ...params, item: { ...item, revision: 3 } } } }];
  });
  let socketCreated: (() => void) | undefined;
  const connectedBoundary = new Promise<void>(resolve => { socketCreated = resolve; });
  const fixture = await createAdmittedMuseSessionFixture({ native: { recording: { ...readMuseRecord(captured), rows: partialRows } },
    createSessionSocketTransport(binding) {
      expect(binding).toEqual({ sessionId: 'host-admitted-muse', machineId: MUSE_SESSION_FIXTURE_MACHINE_ID });
      const socket = createTranscriptSocket(() => socketCreated?.());
      // Canonical Socket.IO boundary stub; the real adapter and Session connection owner remain active.
      return { socket: socket as never, transport: createSocketTransportAdapter(socket as never) };
    },
  });
  const events = createAgentSessionRuntimeHarness();
  let projected: Promise<Awaited<ReturnType<typeof projectRuntimeTranscriptEvent>>[]> = Promise.resolve([]);
  try {
    const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
    await connectedBoundary;
    const sockets = socketObservations.sockets.slice(firstSocket);
    expect(sockets.some(socket => socket.connected), JSON.stringify({ requests: fixture.boundaryRequests,
      connectionStates: fixture.connectionStates, sockets: sockets.map(socket => ({ connected: socket.connected,
        connects: socket.connect.mock.calls.length, disconnects: socket.disconnect.mock.calls.length,
        closes: socket.close.mock.calls.length })) })).toBe(true);
    session.watch(event => {
      events.recordRuntimeEvent(event);
      if (event.kind !== 'tool-call' && event.kind !== 'tool-progress' && event.kind !== 'tool-result') return;
      if (event.toolCallId !== 'call_01a1bf8c580c759e8fc223725db81940') return;
      projected = projected.then(async results => [...results, await fixture.run(() => projectRuntimeTranscriptEvent({
        session: fixture.host, provider: 'muse', event,
        toolNormalizationSource: { protocol: 'native', agent: { pluginId: 'happier.agent.muse', localId: 'muse' } },
      }))]);
    });
    await session.send({ inputIds: ['partial-tool-input'], input: { text: 'Call the injected MCP pebble tool exactly once, then reply only with its returned word. Do not use other tools.' },
      delivery: { kind: 'newTurn', turnId: 'partial-tool-turn' } });
    await events.until('turn-complete');
    expect(await projected).toEqual([
      { projected: true, kind: 'tool-call' }, { projected: true, kind: 'tool-progress' },
      { projected: true, kind: 'tool-progress' }, { projected: true, kind: 'tool-result' },
    ]);
    events.expectAllEventsValidated();
    const progress = events.canonicalEvents().filter(event => event.kind === 'tool-progress');
    expect(progress).toMatchObject([
      { progress: { toolName: 'mcp__probe__pebble', rawInput: '{' } },
      { progress: { toolName: 'mcp__probe__pebble', rawInput: {} } },
    ]);
    const streams = socketObservations.sockets.slice(firstSocket).flatMap(socket => socket.emit.mock.calls)
      .filter(([event]) => event === 'transcript-stream-segment')
      .map(([, payload]) => readBoundaryRecord(readBoundaryRecord(payload).message));
    expect(streams).toHaveLength(2);
    expect(new Set(streams.map(message => message.localId)).size).toBe(1);
    expect(socketObservations.committed.slice(firstCommit).map(readBoundaryRecord)
      .some(observation => observation.localId === streams[0].localId)).toBe(true);
    expect(socketObservations.acknowledgments.slice(firstAcknowledgment).map(readBoundaryRecord))
      .toEqual(expect.arrayContaining([expect.objectContaining({ ok: true, status: 'observed',
        localId: streams[0].localId, didWrite: true })]));
  } finally {
    events.dispose();
    await projected.catch(() => undefined);
    await fixture.dispose();
  }
});

// Socket.IO payloads are the external JSON boundary; the real client produces their content.
function readBoundaryRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

it('publishes native child custody and workflow records after the foreground turn ends', async () => {
  const recording: JsonValue = JSON.parse(await readFile(new URL('./testkit/fixtures/child-follow.json', import.meta.url), 'utf8'));
  const sessionId = 'host-admitted-muse-workflow';
  const fixture = await createAdmittedMuseSessionFixture({ native: { recording }, systemRecords: true, sessionId });
  const events = createAgentSessionRuntimeHarness();
  try {
    const session = await fixture.open({ kind: 'create', sessionId, cwd: process.cwd() });
    session.watch(events.recordRuntimeEvent);
    const rows = readMuseRecord(recording).rows;
    const sent = (Array.isArray(rows) ? rows : []).map(readMuseRecord)
      .filter(row => row.direction === 'send').map(row => readMuseRecord(row.message))
      .find(message => message.method === 'turn/start');
    const input = readMuseRecord(sent?.params).input;
    const text = (Array.isArray(input) ? input : []).map(readMuseRecord)
      .filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
    await session.send({ inputIds: ['workflow-input'], input: { text }, delivery: { kind: 'newTurn', turnId: 'workflow-parent' } });
    try { await events.until('provider-continuation-released'); }
    catch (cause) {
      throw new Error(JSON.stringify({ boundaryRequests: fixture.boundaryRequests,
        custodyCount: fixture.custodyMutations.length, workflowRecordCount: fixture.storedWrites.length,
        eventKinds: events.canonicalEvents().map(event => event.kind) }), { cause });
    }
    expect(fixture.custodyMutations.length).toBeGreaterThan(0);
    expect(new Set(fixture.custodyMutations.map(mutation => mutation.subagentId)).size).toBe(1);
    expect(fixture.custodyMutations.at(-1)).toMatchObject({ status: 'completed' });
    const childId = fixture.custodyMutations.at(-1)?.subagentId;
    if (!childId) throw new Error('Expected a host-qualified native child identity');
    expect(await fixture.run(() => fixture.context.services.sessions.current?.subagents.get(childId)))
      .toMatchObject({ id: childId, parentSessionId: sessionId, status: 'completed' });
    expect(fixture.custodyMutations.some(mutation => mutation.content.t === 'plain'
      && JSON.stringify(mutation.content.v).includes('57eb5081-f640-7bd6-8b7f-19602770febe'))).toBe(true);
    const record = fixture.storedWrites.at(-1);
    if (!record || record.content.t !== 'plain') throw new Error('Expected a host-sealed plain workflow record');
    expect(record.address.localId).toBe(buildWorkflowRunSystemRecordLocalId({
      runId: SessionWorkflowRunSnapshotV1Schema.parse(record.content.v).runId,
    }));
    expect(SessionWorkflowRunSnapshotV1Schema.parse(record.content.v)).toMatchObject({
      runId: 'workflow-run-model-tool-call_01a1bf905346757f812d3092658adbe9', status: 'complete', totalAgents: 1, completedAgents: 1,
      agents: [{ id: '01a1bf90-5807-7400-8dc6-5c1330a65971', title: 'printf-child', status: 'complete' }],
    });
    const metadata = fixture.host.getMetadataSnapshot();
    expect(SessionWorkflowActivityHeadlineV1Schema.parse(metadata?.sessionWorkflowActivityHeadlineV1)).toMatchObject({
      activeRuns: [], recentRuns: [{ runId: 'workflow-run-model-tool-call_01a1bf905346757f812d3092658adbe9',
        status: 'complete', totalAgents: 1, completedAgents: 1 }],
    });
    expect(SessionAgentActivityHeadlineV1Schema.parse(metadata?.sessionAgentActivityHeadlineV1).recentEntries)
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'workflow_agent', title: 'printf-child', status: 'succeeded' })]));
    events.expectExactlyOneTerminalEvent({ turnId: 'workflow-parent' });
  } finally {
    events.dispose();
    await fixture.dispose();
  }
});
