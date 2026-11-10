// Muse 1.4.14 control frames are captured; the new effort label and refusal are
// schema-derived boundary variations. The admitted Session and model publisher stay real.
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { AgentSessionConfigurationUpdate } from '@happier-dev/plugin-sdk/agents/runtime';
import { createNativeAgentSessionInteractionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';
import { readMuseRecord } from './events.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import type { MuseMspPlaybackStep } from './testkit/mspProcess.js';

const configuration: AgentSessionConfigurationUpdate = {
  model: { value: 'default', updatedAtMs: 0, selectionSource: 'explicit' },
  mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: null, updatedAtMs: 0 }, options: {},
};

async function controlRecording(refuse?: 'model' | 'effort'): Promise<{ recording: JsonValue; playbackSteps: MuseMspPlaybackStep[] }> {
  const startup = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/login-smoke.json', import.meta.url), 'utf8')));
  const advanced = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/advanced.json', import.meta.url), 'utf8')));
  if (!Array.isArray(startup.rows) || !Array.isArray(advanced.rows)) throw new Error('Captured native rows are unavailable');
  // Preserve captured success envelopes and ordering, with a model offering fewer efforts.
  const modelRows = advanced.rows.slice(123, 126).map(row => {
    const frame = readMuseRecord(row);
    const message = readMuseRecord(frame.message);
    const params = readMuseRecord(message.params);
    if (message.method === 'session/setModel') return { ...frame, message: { ...message,
      params: { ...params, model: { modelId: 'muse-spark-1.2', providerId: 'meta' } } } };
    if (message.method === 'session/modelChanged') return { ...frame, message: { ...message,
      params: { ...params, modelId: 'muse-spark-1.2' } } };
    return frame;
  });
  const effortRows = advanced.rows.slice(113, 116).map(row => {
    const frame = readMuseRecord(row);
    const message = readMuseRecord(frame.message);
    const params = readMuseRecord(message.params);
    return message.method === 'session/setReasoningEffort' || message.method === 'session/reasoningEffortChanged'
      ? { ...frame, message: { ...message, params: { ...params, reasoningEffort: 'native-orbit' } } } : frame;
  });
  if (refuse) {
    // A native JSON-RPC refusal has no changed fact and cannot become effective state.
    const rows = refuse === 'model' ? modelRows : effortRows;
    const request = readMuseRecord(rows[0].message);
    rows.splice(1, 2, { direction: 'recv', message: { jsonrpc: '2.0', id: request.id,
      error: { code: -32030, message: 'Native model selection refused' } } });
  }
  const recording = { ...startup, rows: [...startup.rows, ...modelRows, ...effortRows] };
  // The native catalog's effort identifiers are strings, not a host-owned tier enum.
  const nativeSessionId = startup.rows.map(row => readMuseRecord(readMuseRecord(readMuseRecord(row).message).result).session)
    .map(session => readMuseRecord(session).sessionId).find(id => typeof id === 'string');
  const controlSessionId = readMuseRecord(readMuseRecord(readMuseRecord(advanced.rows[113]).message).params).sessionId;
  if (typeof nativeSessionId !== 'string' || typeof controlSessionId !== 'string') throw new Error('Captured Session identities are unavailable');
  // Composed schema-derived interleaving: selected advanced control frames address the
  // login capture's opened Session. Playback itself never invents Session routing.
  const text = JSON.stringify(recording).replaceAll('"xhigh"', '"native-orbit"')
    .replaceAll(JSON.stringify(controlSessionId), JSON.stringify(nativeSessionId));
  const composed = JSON.parse(text) as JsonValue;
  const rows = readMuseRecord(composed).rows;
  if (!Array.isArray(rows)) throw new Error('Composed native rows are unavailable');
  const playbackSteps: MuseMspPlaybackStep[] = [];
  for (let index = 0; index < rows.length; index++) {
    const frame = readMuseRecord(rows[index]);
    const message = readMuseRecord(frame.message);
    if (frame.direction !== 'send' || !['model/list', 'session/start', 'turn/start', 'session/setModel', 'session/setReasoningEffort'].includes(String(message.method))) continue;
    const nextSend = rows.findIndex((row, next) => next > index && readMuseRecord(row).direction === 'send');
    playbackSteps.push({ requestRow: index, receiveUntilRow: nextSend === -1 ? rows.length : nextSend });
  }
  return { recording: composed, playbackSteps };
}

it('changes accepted model and native effort through the bound Session model source', async () => {
  const fixture = await createAdmittedMuseSessionFixture({ native: await controlRecording() });
  let operations: ReturnType<typeof createNativeAgentSessionInteractionOperations> | undefined;
  try {
    const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd(), configuration });
    const capabilities = readAgentSessionCapabilities(PLUGIN_MANIFEST.contributes.agents?.find(agent => agent.id === 'muse'));
    if (!capabilities) throw new Error('Admitted Muse declaration is unavailable');
    operations = createNativeAgentSessionInteractionOperations({ session, sessionId: 'host-admitted-muse',
      cwd: process.cwd(), context: fixture.context, capabilities, initialConfiguration: configuration,
      expectedProviderSessionId: session.runtimeDescriptorV1?.agent.providerSessionId, publications: fixture.publications });
    const source = fixture.publications.modelsSource;
    const before = source.read();
    const initial = before.models?.find(model => model.id === before.currentModelId);
    expect(initial?.modelOptions?.[0].options?.map(option => option.value)).toContain('max');
    expect(initial?.modelOptions?.[0].currentValue).toBeNull();
    expect(await operations.updateSessionRuntimeConfig({ modelId: 'meta/muse-spark-1.2', modelSelectionSource: 'explicit' }))
      .toMatchObject({ status: 'applied' });
    const selected = source.read();
    expect(selected.currentModelId).toBe('meta/muse-spark-1.2');
    const efforts = selected.models?.find(model => model.id === selected.currentModelId)?.modelOptions?.[0];
    expect(efforts?.options?.map(option => option.value)).toContain('native-orbit');
    expect(efforts?.options?.map(option => option.value)).not.toContain('max');
    expect(efforts?.currentValue).toBeNull();
    expect(await operations.updateSessionRuntimeConfig({ configOption: { id: 'reasoning_effort', value: 'native-orbit' } }))
      .toMatchObject({ status: 'applied' });
    const effective = source.read();
    expect(effective.models?.find(model => model.id === effective.currentModelId)?.modelOptions?.[0].currentValue).toBe('native-orbit');
    const publications: unknown[] = [];
    const subscription = source.subscribe(value => publications.push(value));
    const initialPublicationCount = publications.length;
    try {
      expect(await operations.updateSessionRuntimeConfig({ configOption: { id: 'reasoning_effort', value: 'native-orbit' } }))
        .toMatchObject({ status: 'applied' });
      expect(source.read()).toBe(effective);
      expect(publications).toHaveLength(initialPublicationCount);
    } finally { subscription.dispose(); }
    const beforeUnsupported = await fixture.readAudit();
    expect(await operations.updateSessionRuntimeConfig({ configOption: { id: 'uncharacterized-option', value: true } }))
      .toMatchObject({ status: 'unsupported' });
    expect((await fixture.readAudit()).methods).toEqual(beforeUnsupported.methods);
    expect(source.read()).toBe(effective);
    // Native standing model/effort controls apply to the following turn. TurnStartParams
    // has no model field; omission of its optional effort override uses that standing default.
    expect(await session.send({ inputIds: ['configuration-input'], input: { text: 'Reply with exactly PEBBLE. Do not use tools.' },
      delivery: { kind: 'newTurn', turnId: 'configuration-turn' } })).toMatchObject({ status: 'admitted' });
    await fixture.closeSession();
    const audit = await fixture.readAudit();
    expect(audit.methods.filter(method => method === 'session/setModel')).toHaveLength(1);
    expect(audit.methods.filter(method => method === 'session/setReasoningEffort')).toHaveLength(1);
    expect(audit.methods.filter(method => method === 'turn/start')).toHaveLength(1);
    const nativeSessionId = session.runtimeDescriptorV1?.agent.providerSessionId;
    expect(audit.commandTargets).toMatchObject([
      { method: 'session/start' },
      { method: 'session/setModel', sessionId: nativeSessionId, providerId: 'meta', modelId: 'muse-spark-1.2' },
      { method: 'session/setReasoningEffort', sessionId: nativeSessionId, reasoningEffort: 'native-orbit' },
      { method: 'turn/start', sessionId: nativeSessionId },
    ]);
  } finally { await operations?.resetOrDisposeRuntime(); await fixture.dispose(); }
});

it.each(['model', 'effort'] as const)('keeps the effective model snapshot unchanged when native %s selection is refused', async refuse => {
  const fixture = await createAdmittedMuseSessionFixture({ native: await controlRecording(refuse) });
  let operations: ReturnType<typeof createNativeAgentSessionInteractionOperations> | undefined;
  try {
    const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd(), configuration });
    const capabilities = readAgentSessionCapabilities(PLUGIN_MANIFEST.contributes.agents?.find(agent => agent.id === 'muse'));
    if (!capabilities) throw new Error('Admitted Muse declaration is unavailable');
    operations = createNativeAgentSessionInteractionOperations({ session, sessionId: 'host-admitted-muse',
      cwd: process.cwd(), context: fixture.context, capabilities, initialConfiguration: configuration,
      expectedProviderSessionId: session.runtimeDescriptorV1?.agent.providerSessionId, publications: fixture.publications });
    const before = fixture.publications.modelsSource.read();
    expect(await operations.updateSessionRuntimeConfig(refuse === 'model'
      ? { modelId: 'meta/muse-spark-1.2', modelSelectionSource: 'explicit' }
      : { configOption: { id: 'reasoning_effort', value: 'native-orbit' } }))
      .toMatchObject({ status: 'failed' });
    expect(fixture.publications.modelsSource.read()).toBe(before);
    expect((await fixture.readAudit()).methods.filter(method => method === (refuse === 'model' ? 'session/setModel' : 'session/setReasoningEffort'))).toHaveLength(1);
  } finally { await operations?.resetOrDisposeRuntime(); await fixture.dispose(); }
});

it.each([undefined, 'native-orbit'])('applies launch-selected effort %s before the first native prompt', async effort => {
  const fixture = await createAdmittedMuseSessionFixture({ native: await controlRecording() });
  try {
    const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd(),
      configuration: { ...configuration, model: { value: null, updatedAtMs: 0 },
        options: effort ? { reasoning_effort: { value: effort, updatedAtMs: 1 } } : {} },
    });
    const effective = fixture.publications.modelsSource.read();
    expect(await session.send({ inputIds: ['initial-effort-input'], input: { text: 'Reply with exactly PEBBLE. Do not use tools.' },
      delivery: { kind: 'newTurn', turnId: 'initial-effort-turn' } })).toMatchObject({ status: 'admitted' });
    await fixture.closeSession();
    const audit = await fixture.readAudit();
    expect(audit.modelSelections).toEqual([{}]);
    expect(audit.methods.filter(method => method === 'model/list')).toHaveLength(effort ? 1 : 0);
    expect(audit.commandTargets.map(target => target.method)).toEqual(effort
      ? ['session/start', 'session/setReasoningEffort', 'turn/start'] : ['session/start', 'turn/start']);
    if (effort) {
      expect(audit.commandTargets[1]).toMatchObject({ reasoningEffort: effort,
        sessionId: session.runtimeDescriptorV1?.agent.providerSessionId });
      expect(effective.models?.find(model => model.id === effective.currentModelId)?.modelOptions?.[0].currentValue).toBe(effort);
    } else expect(effective.models).toBeNull();
  } finally { await fixture.dispose(); }
});
