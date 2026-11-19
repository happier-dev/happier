import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createAgentSessionRuntimeHarness } from '@happier-dev/plugin-sdk/testing';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';
import { readMuseRecord } from './events.js';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';

let admittedRuntime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => {
  admittedRuntime = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
    pluginIds: ['happier.agent.muse'],
    scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() },
  } });
});
afterAll(async () => { await admittedRuntime?.dispose(); });

it.each([
  { entry: 'explicit owner Resume', code: -32021, kind: 'sessionInUse' },
  { entry: 'resume to deliver a retained request', code: -32021, kind: 'sessionInUse' },
  { entry: 'resume with missing native state', code: -32020, kind: 'sessionNotFound' },
])('distinguishes native writer contention on $entry', async ({ code, kind }) => {
  const capture = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/isolated-resume-fork-after.json', import.meta.url), 'utf8')));
  if (!Array.isArray(capture.rows)) throw new Error('Expected captured native resume');
  const frame = readMuseRecord(capture.rows[4]);
  const fixture = await createAdmittedMuseSessionFixture({ admittedRuntime, native: {
    recording: { rows: [...capture.rows.slice(0, 4), { ...frame, message: {
      jsonrpc: '2.0', id: readMuseRecord(frame.message).id,
      error: { code, message: 'Native fixture detail /private/session', data: { kind, retryable: false } },
    } }] },
    playbackSteps: [{ requestRow: 3, receiveUntilRow: 5 }],
  } });
  try {
    const open = fixture.open({ kind: 'resume', sessionId: 'host-admitted-muse', cwd: process.cwd(),
      providerSessionId: '00000000-0000-7000-8000-000000000002', strictNativeResumeIdentity: true });
    if (kind === 'sessionInUse') {
      await expect(open).rejects.toMatchObject({ code: 'agent_resume_session_in_use', retryable: false,
        details: { failureCause: { code: 'agent_resume_session_in_use', phase: 'thread_open', providerErrorCode: -32021 } },
      });
    } else {
      await expect(open).rejects.toMatchObject({ code });
    }
    expect((await fixture.readAudit()).methods).toEqual(['initialize', 'initialized', 'session/resume']);
  } finally {
    await fixture.dispose();
  }
});

it.each([
  { historyMode: 'inline', permissionIntent: null },
  { historyMode: 'inline', permissionIntent: null, nativeSandbox: 'off' },
  { historyMode: 'inline', permissionIntent: null, nativeSandbox: 'off', nativeProfile: ':read-only' },
  { historyMode: 'snapshot', permissionIntent: 'read-only' },
  { historyMode: 'inline', permissionIntent: 'yolo' },
  { historyMode: 'inline', permissionIntent: 'safe-yolo' },
  { historyMode: 'inline', permissionIntent: 'default' },
] as const)('resumes the same native conversation with $historyMode history and $permissionIntent/$nativeSandbox/$nativeProfile permissions, then continues once', async selection => {
  const { historyMode, permissionIntent } = selection;
  const nativeSandbox = 'nativeSandbox' in selection ? selection.nativeSandbox : undefined;
  const nativeProfile = 'nativeProfile' in selection ? selection.nativeProfile : undefined;
  const providerSessionId = '00000000-0000-7000-8000-000000000002';
  const after = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/isolated-resume-fork-after.json', import.meta.url), 'utf8')));
  const pending = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/isolated-empty-pending.json', import.meta.url), 'utf8')));
  if (!Array.isArray(after.rows) || !Array.isArray(pending.rows)) throw new Error('Expected captured native rows');
  let resumeRows = after.rows.slice(0, 5);
  if (nativeProfile === ':read-only') {
    const readOnly = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/isolated-read-only-shell-unavailable.json', import.meta.url), 'utf8')));
    if (!Array.isArray(readOnly.rows)) throw new Error('Expected captured native read-only rows');
    const readOnlySession = readOnly.rows.map(row => readMuseRecord(readMuseRecord(readMuseRecord(row).message).result).session)
      .map(readMuseRecord).find(session => readMuseRecord(session.permissionState).profileId === ':read-only');
    if (!readOnlySession) throw new Error('Expected captured native read-only permissions');
    const frame = readMuseRecord(resumeRows[4]);
    const message = readMuseRecord(frame.message);
    const result = readMuseRecord(message.result);
    // Preserve the observed read-only native profile and approval mode on resume.
    resumeRows = [...resumeRows.slice(0, 4), { ...frame, message: { ...message, result: { ...result,
      session: { ...readMuseRecord(result.session), permissionState: readOnlySession.permissionState,
        approvalMode: readOnlySession.approvalMode },
    } } }];
  }
  if (historyMode === 'snapshot') {
    const before = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/isolated-resume-fork-before.json', import.meta.url), 'utf8')));
    if (!Array.isArray(before.rows)) throw new Error('Expected captured native usage rows');
    const frame = readMuseRecord(resumeRows[4]);
    const message = readMuseRecord(frame.message);
    const result = readMuseRecord(message.result);
    const native = readMuseRecord(result.session);
    // Explicit schema-derived HistoryMode conversion. SnapshotState.items is
    // every Item folded to its latest revision at the native snapshot cursor.
    const snapshot = { schemaVersion: 1, viewCursor: result.viewCursor,
      state: { activeTurn: null, approvalMode: native.approvalMode, branch: null,
        effectiveModel: { providerId: native.providerId, modelId: native.modelId }, goal: null,
        items: readMuseRecord(result.history).items, pendingApprovals: [], pendingUserInputs: [], queuedTurns: [],
        todoList: null, tokenUsage: readMuseRecord(readMuseRecord(readMuseRecord(before.rows[15]).message).params).cumulative,
        turnCount: native.turnCount } };
    resumeRows = [...resumeRows.slice(0, 4), { ...frame, message: { ...message,
      result: { ...result, history: { mode: 'snapshot', items: null, snapshot } } } }];
  }
  // Exact observed resume + subsequent turn; the empty pending read is an explicit
  // composition with the separate isolated no-turn capture, not a combined vendor recording.
  const recording = { rows: [...resumeRows, ...pending.rows, ...after.rows.slice(5, 23)] };
  const events = createAgentSessionRuntimeHarness();
  const fixture = await createAdmittedMuseSessionFixture({ admittedRuntime, native: { recording, playbackSteps: [
    { requestRow: 3, receiveUntilRow: 5 },
    { requestRow: 5, receiveUntilRow: 7 },
    { requestRow: 7, receiveUntilRow: 25 },
  ] } });
  try {
    const session = await fixture.open({ kind: 'resume', sessionId: 'host-admitted-muse',
      cwd: process.cwd(), providerSessionId, strictNativeResumeIdentity: true,
      launchEnvironment: { values: { MUSE_TEST_SELECTED_HOME: '/selected/native/home' }, unset: [] },
      ...(permissionIntent || nativeSandbox ? { configuration: {
        model: { value: null, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: permissionIntent, updatedAtMs: 0 }, nativeSandbox, options: {},
      } } : {}),
    });
    session.watch(events.recordRuntimeEvent);
    expect(session.runtimeDescriptorV1).toMatchObject({ v: 1, agentId: 'muse', agent: { providerSessionId } });
    expect(events.canonicalEvents().filter(event => event.kind === 'transcript-message-committed')).toMatchObject([
      { messageId: '00000000-0000-7000-8000-000000000006', role: 'user', text: 'ISOLATED-HISTORY-0000' },
      { messageId: '00000000-0000-7000-8000-00000000000a', role: 'assistant', text: 'echo: ISOLATED-HISTORY-0000' },
    ]);
    expect(events.canonicalEvents().filter(event => event.kind === 'turn-complete' || event.kind === 'usage-observed')).toEqual([]);
    await session.send({ inputIds: ['resumed-input'], input: { text: 'ISOLATED-HISTORY-0001' },
      delivery: { kind: 'newTurn', turnId: 'resumed-turn' } });
    await events.until('turn-complete', { signal: fixture.context.signal });
    events.expectExactlyOneTerminalEvent({ turnId: 'resumed-turn' });
    events.expectAllEventsValidated();
    expect(events.canonicalEvents().filter(event => event.kind === 'input-accepted')).toHaveLength(1);
    expect(events.canonicalEvents().filter(event => event.kind === 'transcript-message-committed' && event.role === 'assistant'))
      .toMatchObject([{ text: 'echo: ISOLATED-HISTORY-0000' }, { text: 'echo: ISOLATED-HISTORY-0001', turnId: 'resumed-turn' }]);
    await fixture.closeSession();
    const audit = await fixture.readAudit();
    expect(fixture.launchCount).toBe(1);
    expect(audit.initializeCount).toBe(1);
    expect(audit.methods.filter(method => method === 'session/resume')).toHaveLength(1);
    expect(audit.methods.filter(method => method === 'approval/listPending')).toHaveLength(1);
    expect(audit.methods.filter(method => method === 'turn/start')).toHaveLength(1);
    expect(audit.methods.filter(method => method === 'session/start' || method === 'session/read' || method === 'view/page')).toEqual([]);
    expect(audit.commandTargets.filter(target => target.method === 'session/resume' || target.method === 'turn/start'))
      .toMatchObject([{ sessionId: providerSessionId }, { sessionId: providerSessionId }]);
    expect(audit.selectedHome).toBe('/selected/native/home');
    expect(audit.commandTargets.find(command => command.method === 'session/resume')?.permissionProfile)
      .toBe(permissionIntent === null ? undefined : permissionIntent === 'yolo' ? ':unrestricted'
        : permissionIntent === 'read-only' ? ':read-only' : ':ask-me');
    if (nativeProfile === ':read-only') {
      expect(audit.commandTargets.filter(command => command.method === 'session/setPermissionProfile'
        || command.method === 'session/setApprovalMode')).toEqual([]);
    } else if (nativeSandbox === 'off') {
      expect(audit.commandTargets.find(command => command.method === 'session/setPermissionProfile'))
        .toMatchObject({ profileId: ':unrestricted' });
      const native = readMuseRecord(readMuseRecord(readMuseRecord(readMuseRecord(resumeRows[4]).message).result).session);
      expect(audit.commandTargets.find(command => command.method === 'session/setApprovalMode'))
        .toMatchObject({ mode: readMuseRecord(native.approvalMode).mode });
    }
  } finally {
    events.dispose();
    await fixture.dispose();
  }
});

it('recovers an unknown native snapshot through the shared demanded history pages without replaying old custody or spend', async () => {
  const after = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/isolated-resume-fork-after.json', import.meta.url), 'utf8')));
  const long = readMuseRecord(JSON.parse(gunzipSync(await readFile(new URL('./testkit/fixtures/isolated-long-history-reader.json.gz', import.meta.url))).toString('utf8')));
  const pending = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/isolated-empty-pending.json', import.meta.url), 'utf8')));
  if (!Array.isArray(after.rows) || !Array.isArray(long.rows) || !Array.isArray(pending.rows)) throw new Error('Expected captured native history rows');
  const result = readMuseRecord(readMuseRecord(readMuseRecord(long.rows[8]).message).result);
  const native = readMuseRecord(result.session);
  if (typeof native.sessionId !== 'string') throw new Error('Expected captured long native Session identity');
  const providerSessionId = native.sessionId;
  const originalResume = readMuseRecord(readMuseRecord(after.rows[3]).message);
  const originalReply = readMuseRecord(readMuseRecord(after.rows[4]).message);
  const firstPage = readMuseRecord(readMuseRecord(readMuseRecord(long.rows[10]).message).result);
  if (!Array.isArray(firstPage.events)) throw new Error('Expected captured native page events');
  const usage = firstPage.events.map(value => readMuseRecord(value)).find(message => message.method === 'session/tokenUsage');
  const tokenUsage = readMuseRecord(usage?.params).cumulative;
  if (tokenUsage === undefined) throw new Error('Expected captured cumulative native usage');
  // Cross-capture resume of the observed long Session with an explicitly
  // schema-derived unknown snapshot version. Its four native pages stay exact.
  const snapshot = { schemaVersion: 999, viewCursor: result.viewCursor, state: {
    activeTurn: null, approvalMode: native.approvalMode, branch: null,
    effectiveModel: { providerId: native.providerId, modelId: native.modelId }, goal: null,
    items: readMuseRecord(result.history).items, pendingApprovals: [], pendingUserInputs: [], queuedTurns: [],
    todoList: null, tokenUsage, turnCount: native.turnCount,
  } };
  const rows = [...after.rows.slice(0, 3),
    { direction: 'send', message: { ...originalResume, params: { ...readMuseRecord(originalResume.params), sessionId: providerSessionId } } },
    { direction: 'recv', message: { ...originalReply, result: { ...result, history: { mode: 'snapshot', items: null, snapshot } } } },
    ...long.rows.slice(9, 17), ...pending.rows];
  const events = createAgentSessionRuntimeHarness();
  const scratch = await mkdtemp(join(tmpdir(), 'happier-muse-paged-resume-'));
  const recordingPath = join(scratch, 'native-history.json');
  await writeFile(recordingPath, JSON.stringify({ rows }));
  const fixture = await createAdmittedMuseSessionFixture({ native: { recordingPath, playbackSteps: [
    { requestRow: 3, receiveUntilRow: 5 }, { requestRow: 5, receiveUntilRow: 7 },
    { requestRow: 7, receiveUntilRow: 9 }, { requestRow: 9, receiveUntilRow: 11 },
    { requestRow: 11, receiveUntilRow: 13 }, { requestRow: 13, receiveUntilRow: 15 },
  ] } });
  try {
    const session = await fixture.open({ kind: 'resume', sessionId: 'host-admitted-muse', cwd: process.cwd(), providerSessionId });
    session.watch(events.recordRuntimeEvent);
    const restored = events.canonicalEvents().filter(event => event.kind === 'transcript-message-committed');
    expect(restored.filter(event => event.role === 'user')).toHaveLength(260);
    expect(restored.filter(event => event.role === 'assistant')).toHaveLength(260);
    expect(new Set(restored.map(event => event.messageId)).size).toBe(restored.length);
    expect(events.canonicalEvents().filter(event => event.kind === 'usage-observed' || event.kind === 'input-accepted'
      || event.kind === 'turn-start' || event.kind === 'turn-complete')).toEqual([]);
    events.expectAllEventsValidated();
    expect(session.runtimeDescriptorV1?.agent.providerSessionId).toBe(providerSessionId);
    await fixture.closeSession();
    const audit = await fixture.readAudit();
    expect(audit.viewPages).toEqual(long.rows.slice(9, 17).filter((_row, index) => index % 2 === 0).map(row => {
      const params = readMuseRecord(readMuseRecord(readMuseRecord(row).message).params);
      return { sessionId: providerSessionId, cursor: params.cursor ?? null };
    }));
    expect(audit.methods.filter(method => method === 'approval/listPending')).toHaveLength(1);
    expect(audit.methods.filter(method => method === 'session/read' || method === 'session/start' || method === 'turn/start')).toEqual([]);
    expect(fixture.launchCount).toBe(1);
  } finally { events.dispose(); await fixture.dispose(); await rm(scratch, { recursive: true, force: true }); }
});

it('applies an explicit resumed model through the shared native configuration owner after restoring identity', async () => {
  const providerSessionId = '00000000-0000-7000-8000-000000000002';
  const readCapture = async (name: string) => {
    const capture = readMuseRecord(JSON.parse(await readFile(new URL(`./testkit/fixtures/${name}.json`, import.meta.url), 'utf8')));
    if (!Array.isArray(capture.rows)) throw new Error('Expected captured native rows');
    return capture.rows;
  };
  const [after, pending, startup, advanced] = await Promise.all([
    readCapture('isolated-resume-fork-after'), readCapture('isolated-empty-pending'),
    readCapture('login-smoke'), readCapture('advanced'),
  ]);
  // Cross-capture composition: native model catalog/setter envelopes address the
  // resumed echo Session. This tests host ordering, not echo-provider entitlement.
  const modelRows = advanced.slice(123, 126).map(row => {
    const frame = readMuseRecord(row);
    const message = readMuseRecord(frame.message);
    if (!message.params) return frame;
    const params = readMuseRecord(message.params);
    return { ...frame, message: { ...message, params: { ...params, sessionId: providerSessionId,
      ...(message.method === 'session/setModel' ? { model: { providerId: 'meta', modelId: 'muse-wonder-1.0' } } : {}),
    } } };
  });
  const events = createAgentSessionRuntimeHarness();
  const fixture = await createAdmittedMuseSessionFixture({ native: {
    recording: { rows: [...after.slice(0, 5), ...pending, ...startup.slice(5, 7), ...modelRows, ...after.slice(5, 23)] },
    playbackSteps: [{ requestRow: 3, receiveUntilRow: 5 }, { requestRow: 5, receiveUntilRow: 7 },
      { requestRow: 7, receiveUntilRow: 9 }, { requestRow: 9, receiveUntilRow: 12 }, { requestRow: 12, receiveUntilRow: 30 }],
  } });
  try {
    const session = await fixture.open({ kind: 'resume', sessionId: 'host-admitted-muse', cwd: process.cwd(), providerSessionId,
      configuration: { model: { value: 'meta/muse-wonder-1.0', updatedAtMs: 1, selectionSource: 'explicit' },
        mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: null, updatedAtMs: 0 }, options: {} },
    });
    session.watch(events.recordRuntimeEvent);
    expect(session.runtimeDescriptorV1?.agent.providerSessionId).toBe(providerSessionId);
    expect(fixture.publications.modelsSource.read().currentModelId).toBe('meta/muse-wonder-1.0');
    expect(await session.send({ inputIds: ['resumed-model-input'], input: { text: 'ISOLATED-HISTORY-0001' },
      delivery: { kind: 'newTurn', turnId: 'resumed-model-turn' } })).toMatchObject({ status: 'admitted' });
    await events.until('turn-complete', { signal: fixture.context.signal });
    events.expectExactlyOneTerminalEvent({ turnId: 'resumed-model-turn' });
    events.expectAllEventsValidated();
    await fixture.closeSession();
    const audit = await fixture.readAudit();
    expect(audit.methods.filter(method => method !== 'initialize' && method !== 'initialized'))
      .toEqual(['session/resume', 'usage/refresh', 'approval/listPending', 'model/list', 'session/setModel', 'turn/start']);
    expect(audit.commandTargets.filter(target => target.method === 'session/setModel'))
      .toEqual([expect.objectContaining({ sessionId: providerSessionId, providerId: 'meta', modelId: 'muse-wonder-1.0' })]);
    expect(audit.modelSelections).toEqual([]);
  } finally { events.dispose(); await fixture.dispose(); }
});
