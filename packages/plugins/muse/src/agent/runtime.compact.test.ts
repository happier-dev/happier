import { expect, it } from 'vitest';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Disposable, JsonValue } from '@happier-dev/plugin-sdk';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { createAgentSessionRuntimeHarness } from '@happier-dev/plugin-sdk/testing';
import { createNativeAgentSessionInteractionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createManualCompactionQueue } from '@/agent/runtime/queueSpecialCommands';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { createDeferred } from '@/testkit/async/deferred';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';
import { readMuseRecord } from './events.js';

async function recordingRows(name: string) {
  const recording = readMuseRecord(JSON.parse(await readFile(new URL(`./testkit/fixtures/${name}.json`, import.meta.url), 'utf8')));
  if (!Array.isArray(recording.rows)) throw new Error('Expected sanitized wire recording');
  return recording.rows.map(readMuseRecord).filter(row => row.message !== undefined);
}

async function compactRecording() {
  const login = await recordingRows('login-smoke');
  const compact = await recordingRows('resume-compact');
  const requestIndex = compact.findIndex(row => readMuseRecord(row.message).method === 'session/compact');
  const request = compact[requestIndex];
  const acknowledgment = compact[requestIndex + 1];
  if (!request || !acknowledgment) throw new Error('Captured compaction command is unavailable');
  return {
    // Schema-derived composition: captured create handshake followed by the
    // captured compact command. Native item contents and token counts are exact.
    recording: { rows: [...login, request, acknowledgment] },
    started: readMuseRecord(compact.find(row => readMuseRecord(row.message).method === 'item/started')?.message),
    completed: readMuseRecord(compact.find(row => readMuseRecord(row.message).method === 'item/completed')?.message),
  };
}

it('keeps admitted native compaction pending through acknowledgement until the captured item completes', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-muse-compact-'));
  const nativeNotificationPath = join(scratch, 'native-notification.json');
  const capture = await compactRecording();
  const fixture = await createAdmittedMuseSessionFixture({ native: { recording: capture.recording, nativeNotificationPath } });
  const events = createAgentSessionRuntimeHarness();
  const started = createDeferred<Extract<AgentSessionRuntimeEvent, { kind: 'context-compaction' }>>();
  const completed = createDeferred<Extract<AgentSessionRuntimeEvent, { kind: 'context-compaction' }>>();
  const queue = new MessageQueue2<string, { text: string }>(mode => mode, { batcher: messages => messages[0]! });
  let unsubscribe: (() => void) | undefined;
  try {
    const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
    const nativeId = session.runtimeDescriptorV1?.agent.providerSessionId;
    if (typeof nativeId !== 'string') throw new Error('Expected admitted native Session identity');
    const capabilities = readAgentSessionCapabilities(PLUGIN_MANIFEST.contributes.agents?.find(agent => agent.id === 'muse'));
    if (!capabilities) throw new Error('Admitted Muse declaration is unavailable');
    const operations = createNativeAgentSessionInteractionOperations({ session, sessionId: 'host-admitted-muse',
      cwd: process.cwd(), context: fixture.context, capabilities });
    const manual = createManualCompactionQueue({ queue, readText: message => message.text,
      isAvailable: () => operations.readSessionCompactionCapability?.()?.manual === true });
    unsubscribe = operations.subscribeRuntimeEvents(event => {
      events.recordRuntimeEvent(event);
      if (event.kind !== 'context-compaction') return;
      if (event.phase === 'started') started.resolve(event);
      if (event.phase === 'completed') completed.resolve(event);
    });
    // The same admission owner used by the session.compact RPC reports the
    // outward unsupported/admitted result, rather than inspecting a method.
    expect(manual.enqueue({ text: '/compact' }, 'default')).toEqual({ status: 'admitted' });
    const command = await queue.waitForMessagesAndGetAsString();
    if (!command) throw new Error('Host compact admission lost its queued command');
    await operations.compactContext!(command.message.text);
    const acknowledgment = await fixture.waitForAudit(audit => audit.methods.includes('session/compact'));
    expect(acknowledgment.methods.filter(method => method === 'session/compact')).toHaveLength(1);
    expect(events.canonicalEvents().filter(event => event.kind === 'context-compaction')).toEqual([]);

    async function emit(frame: Readonly<Record<string, JsonValue>>) {
      const completePath = `${nativeNotificationPath}.complete`;
      await writeFile(completePath, JSON.stringify({ ...frame,
        params: { ...readMuseRecord(frame.params), sessionId: nativeId } }));
      await rename(completePath, nativeNotificationPath);
    }
    await emit(capture.started);
    const running = await started.promise;
    expect(running).toMatchObject({ phase: 'started', trigger: 'manual', tokenCountBefore: 22446,
      tokenCountSource: 'providerReported' });
    expect(events.canonicalEvents().filter(event => event.kind === 'context-compaction' && event.phase === 'completed')).toEqual([]);
    await emit(capture.completed);
    expect(await completed.promise).toMatchObject({ phase: 'completed', compactionId: running.compactionId,
      trigger: 'manual', tokenCountBefore: 22446, tokenCountAfter: 21963, tokenCountSource: 'providerReported' });
    expect(running.compactionId).toMatch(/^host-compact-/u);
    events.expectAllEventsValidated();
    expect(events.canonicalEvents().filter(event => event.kind === 'context-compaction')).toHaveLength(2);
    expect(events.canonicalEvents().filter(event => event.kind === 'turn-complete')).toEqual([]);
    expect(events.canonicalEvents().filter(event => event.kind === 'tool-call' || event.kind === 'tool-result')).toEqual([]);
  } finally {
    unsubscribe?.();
    queue.close();
    events.dispose();
    await fixture.dispose();
    await rm(scratch, { recursive: true, force: true });
  }
});

it('retains native terminal failure, cancellation and unknown outcomes instead of completing on admission', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-muse-compact-outcomes-'));
  const nativeNotificationPath = join(scratch, 'native-notification.json');
  const capture = await compactRecording();
  const fixture = await createAdmittedMuseSessionFixture({ native: { recording: capture.recording, nativeNotificationPath } });
  const events = createAgentSessionRuntimeHarness();
  let subscription: Disposable | undefined;
  try {
    const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
    const nativeId = session.runtimeDescriptorV1?.agent.providerSessionId;
    // Schema-derived terminal variants of the captured Item and CompactionOutcome
    // open enums. These are not claims of vendor-observed failure interleavings.
    const variants = [
      { status: 'completed', outcome: 'failed', phase: 'failed' },
      { status: 'cancelled', outcome: 'cancelled', phase: 'cancelled' },
      { status: 'futureTerminal', outcome: 'compacted', phase: 'outcomeUnknown' },
      { status: 'completed', outcome: 'futureOutcome', phase: 'outcomeUnknown' },
      { status: 'completed', outcome: 'noop', phase: 'completed' },
    ] as const;
    let terminal = createDeferred<Extract<AgentSessionRuntimeEvent, { kind: 'context-compaction' }>>();
    subscription = session.watch(event => {
      events.recordRuntimeEvent(event);
      if (event.kind === 'context-compaction' && event.phase !== 'started' && event.phase !== 'progress') terminal.resolve(event);
    });
    for (const [index, variant] of variants.entries()) {
      const compactionId = `host-terminal-${index}`;
      expect(await session.compact!({ compactionId, trigger: 'manual' })).toEqual({ status: 'admitted' });
      const itemId = `01a1bf8c-7a00-7751-8f49-28e65960b66${index}`;
      const item = readMuseRecord(readMuseRecord(capture.completed.params).item);
      const frame = { ...capture.completed, params: { ...readMuseRecord(capture.completed.params), sessionId: nativeId,
        item: { ...item, itemId, status: variant.status, outcome: variant.outcome,
          tokensAfter: variant.outcome === 'noop' ? item.tokensBefore : item.tokensAfter } } };
      const completePath = `${nativeNotificationPath}.complete`;
      await writeFile(completePath, JSON.stringify(frame));
      await rename(completePath, nativeNotificationPath);
      expect(await terminal.promise).toMatchObject({ compactionId, trigger: 'manual', phase: variant.phase });
      terminal = createDeferred();
    }
    events.expectAllEventsValidated();
    expect(events.canonicalEvents().filter(event => event.kind === 'context-compaction')).toHaveLength(variants.length);
    expect(events.canonicalEvents().filter(event => event.kind === 'tool-call' || event.kind === 'tool-result')).toEqual([]);
  } finally {
    subscription?.dispose();
    events.dispose();
    await fixture.dispose();
    await rm(scratch, { recursive: true, force: true });
  }
});

it('preserves a native command rejection as a rejected operation with no compaction event', async () => {
  const capture = await compactRecording();
  const rows = capture.recording.rows;
  const requestRow = rows.length - 2;
  const request = readMuseRecord(rows[requestRow]?.message);
  const requestId = request.id;
  const commandId = readMuseRecord(request.params).commandId;
  if ((typeof requestId !== 'number' && typeof requestId !== 'string') || typeof commandId !== 'string') {
    throw new Error('Expected captured native compact request identity');
  }
  // Schema-derived -32030 commandRejected/missing_run from SessionCompactParams;
  // the captured successful command is refused before any native item exists.
  const refusal = { direction: 'recv', message: { jsonrpc: '2.0', id: requestId, error: {
    code: -32030, message: 'No resolvable native run', data: { kind: 'commandRejected',
      commandId, reason: 'missing_run', retryable: false },
  } } };
  const startRow = rows.findIndex(row => readMuseRecord(row.message).method === 'session/start');
  const startEnd = rows.findIndex((row, index) => index > startRow && row.direction === 'send');
  const fixture = await createAdmittedMuseSessionFixture({ native: {
    recording: { rows: [...rows.slice(0, -1), refusal] },
    playbackSteps: [{ requestRow: startRow, receiveUntilRow: startEnd },
      { requestRow, receiveUntilRow: rows.length }],
  } });
  const events = createAgentSessionRuntimeHarness();
  let subscription: Disposable | undefined;
  try {
    const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
    subscription = session.watch(events.recordRuntimeEvent);
    expect(await session.compact!({ compactionId: 'host-refused', trigger: 'manual' })).toMatchObject({
      status: 'rejected', retryable: false, diagnostic: { code: 'provider_request_rejected',
        details: { method: 'session/compact', providerErrorCode: -32030, messageClass: 'JsonRpcApplicationError' } },
    });
    expect(events.canonicalEvents().filter(event => event.kind === 'context-compaction')).toEqual([]);
    const audit = await fixture.waitForAudit(value => value.methods.includes('session/compact'));
    expect(audit.commandTargets.find(target => target.method === 'session/compact')).toMatchObject({
      sessionId: session.runtimeDescriptorV1?.agent.providerSessionId,
      commandId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
    });
  } finally { subscription?.dispose(); events.dispose(); await fixture.dispose(); }
});

it('returns unsupported without native effects for instructions and idle compaction', async () => {
  const fixture = await createAdmittedMuseSessionFixture();
  try {
    const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
    expect(await session.compact!({ compactionId: 'host-instructions', trigger: 'manual', instructions: 'preserve a topic' }))
      .toMatchObject({ status: 'unsupported', retryable: false });
    expect(await session.compact!({ compactionId: 'host-idle', trigger: 'idle' }))
      .toMatchObject({ status: 'unsupported', retryable: false });
    await fixture.closeSession();
    expect((await fixture.readAudit()).methods.filter(method => method === 'session/compact')).toEqual([]);
  } finally { await fixture.dispose(); }
});
