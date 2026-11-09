import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentSessionConfigurationSnapshot, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import { createFxAgentRuntime } from '../../../../../../../packages/plugins/fx/src/agent/runtime/factory';
import { FX_PLUGIN } from '../../../../../../../packages/plugins/fx/src/manifest';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createFxConfigOptionsFixture } from '@/agent/acp/testkit/fxConfigOptionsFixture';
import { createAcpSessionRuntimeContextFixture } from '@/agent/acp/testkit/runtimeContextFixture';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from './createPublicAcpSession';

// Protocol fixture: FX v0.0.14 session/new (2026-10-27), with constructed
// Gateway/custom-route and native-refusal variants. Only the OS peer is fake.
async function fixture(dir: string, scenario: 'accept' | 'refuse' | 'current') {
  const capture = join(dir, 'requests.json');
  const script = writeAcpTestAgentScript({ dir, fileName: 'models.mjs', source: `
    import { createInterface } from 'node:readline';
    import { writeFileSync } from 'node:fs';
    const requests = [];
    let configOptions = ${JSON.stringify(createFxConfigOptionsFixture())};
    configOptions = configOptions.map(option => option.id === 'provider'
      ? { ...option, options: [...option.options, {value:'private-route',name:'Configured route'}] } : option);
    if (process.env.SCENARIO === 'current') configOptions = configOptions.map(option => option.id === 'model'
      ? { ...option, currentValue: 'custom/current', options: [...option.options, {value:'custom/current',name:'Custom'}] } : option);
    for await (const line of createInterface({ input: process.stdin })) {
      const r = JSON.parse(line); if (r.id === undefined) continue;
      requests.push({ method: r.method, params: r.params,
        ...(r.method === 'session/prompt' ? { model: configOptions.find(option => option.id === 'model').currentValue } : {}) });
      writeFileSync(process.env.CAPTURE, JSON.stringify(requests));
      let result = {}; let error;
      if (r.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {} };
      if (r.method === 'session/new') result = { sessionId: 'native-models', configOptions };
      if (r.method === 'session/prompt') result = { stopReason: 'end_turn' };
      if (r.method === 'session/set_config_option') {
        if (r.params.configId === 'model' && process.env.SCENARIO === 'refuse') {
          error = { code: -32602, message: 'Model was refused by the native route' };
        } else {
          // FX's writeModelConfigOption appends an accepted current model when
          // absent from its cached catalog (sessions.zig, pinned v0.0.14).
          configOptions = configOptions.map(option => option.id === r.params.configId
            ? { ...option, currentValue: r.params.value,
                ...(option.id === 'model' && !option.options.some(choice => choice.value === r.params.value)
                  ? { options: [...option.options, { value: r.params.value, name: r.params.value }] } : {}) }
            : option);
          result = { configOptions };
        }
      }
      process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:r.id, ...(error ? {error} : {result}) }) + '\\n');
    }
  ` });
  const signal = new AbortController().signal;
  const publications = createNativeAgentSessionPublications({ agentId: 'fx', session: null,
    signal, isCurrent: () => true, supportsInFlightSteer: false });
  const dependencies: PublicAcpComposerDependencies = {
    pluginId: FX_PLUGIN.manifest.id, agentId: 'fx', signal, isCurrent: () => true,
    systemTools: { resolve: async () => ({ toolId: 'fx-cli', launch: {
      kind: 'binary', executablePath: process.execPath, args: [script], env: { CAPTURE: capture, SCENARIO: scenario },
    } }) },
    interactions: { async request() { throw new Error('Unexpected interaction'); } },
    media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
    models: publications.services.models, modes: publications.services.modes,
  };
  const agent = PluginAgentContributionV2Schema.parse(FX_PLUGIN.manifest.contributes.agents?.find(entry => entry.id === 'fx'));
  const context = createAcpSessionRuntimeContextFixture({ agent, pluginId: FX_PLUGIN.manifest.id,
    sessionId: 'model-session', directory: dir, signal, publications,
    protocols: { acp: { open: (request, options) => {
      return createPublicAcpSession(request, options, dependencies);
    },
      async openExecutionRunV1() { throw new Error('Unexpected execution run'); } } } });
  const runtime = await createFxAgentRuntime({ plugin: { id: FX_PLUGIN.manifest.id, version: '0.0.0' }, agent: { id: 'fx' }, signal });
  return { publications, context, async open(configuration?: AgentSessionConfigurationSnapshot) {
    try {
      return await runtime.sessions!.open({ kind: 'create', sessionId: 'model-session', cwd: dir,
        ...(configuration ? { configuration } : {}) }, context.context);
    } catch (error) {
      publications.dispose();
      await context.dispose();
      throw error;
    }
  },
  setters: () => (JSON.parse(readFileSync(capture, 'utf8')) as Array<{method: string; params: {configId?: string; value?: string}}>)
    .filter(request => request.method === 'session/set_config_option').map(request => request.params),
  promptModels: () => (JSON.parse(readFileSync(capture, 'utf8')) as Array<{method: string; model?: string}>)
    .filter(request => request.method === 'session/prompt').map(request => request.model),
  async dispose() { publications.dispose(); await context.dispose(); } };
}

function configuration(model: string, selectionSource: 'explicit' | 'inherited' | undefined, provider = 'gateway'): AgentSessionConfigurationSnapshot {
  return { mode: { value: null, updatedAtMs: 0 }, model: { value: model, updatedAtMs: 1,
    ...(selectionSource ? { selectionSource } : {}) },
    permissionIntent: { value: null, updatedAtMs: 0 }, options: { provider: { value: provider, updatedAtMs: 1 } } };
}

async function sendCompletedPrompt(session: AgentSessionRuntime, turnId: string, text: string) {
  let complete!: () => void;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  const subscription = session.watch(event => {
    if (event.kind === 'turn-complete' && event.turnId === turnId) complete();
  });
  try {
    expect(await session.send({ inputIds: [turnId], input: { text }, delivery: { kind: 'newTurn', turnId } }))
      .toMatchObject({ status: 'admitted' });
    await completed;
  } finally { subscription.dispose(); }
}

describe('FX model selection through the public ACP owner', () => {
  it.each(['inherited', undefined] as const)('clears a foreign choice with %s provenance even on a custom-model route', async source => {
    await withTempDir('fx-inherited-model-', async dir => {
      const f = await fixture(dir, 'accept');
      const session = await f.open(configuration('foreign-model', source));
      try {
        expect(f.setters()).toEqual([{ configId: 'provider', value: 'gateway', sessionId: 'native-models' }]);
        expect(f.publications.modelsSource.read().currentModelId).toBe('gpt-6.1-sol');
      } finally { await session.dispose(); await f.dispose(); }
    });
  });

  it.each(['gateway', 'private-route', 'codex', 'grok'])('sends an explicit initial unlisted choice to the native %s route', async provider => {
    await withTempDir('fx-explicit-model-', async dir => {
      const f = await fixture(dir, 'accept');
      const session = await f.open(configuration('custom/new', 'explicit', provider));
      try {
        expect(f.setters().map(params => params.value)).toEqual([provider, 'custom/new']);
        expect(f.publications.modelsSource.read().currentModelId).toBe('custom/new');
      } finally { await session.dispose(); await f.dispose(); }
    });
  });

  it('uses an accepted explicit live model for the next native prompt without reapplying unchanged configuration', async () => {
    await withTempDir('fx-live-model-', async dir => {
      const f = await fixture(dir, 'accept');
      const session = await f.open();
      try {
        await sendCompletedPrompt(session, 'before-model-change', 'Use the native default');
        expect(await session.updateConfiguration?.(configuration('custom/new', 'explicit')))
          .toMatchObject({ status: 'applied' });
        expect(f.setters().map(params => params.value)).toEqual(['gateway', 'custom/new']);
        expect(f.publications.modelsSource.read().currentModelId).toBe('custom/new');
        await session.updateConfiguration?.(configuration('custom/new', 'explicit'));
        expect(f.setters().map(params => params.value)).toEqual(['gateway', 'custom/new']);
        await sendCompletedPrompt(session, 'after-model-change', 'Use the selected model');
        expect(f.promptModels()).toEqual(['gpt-6.1-sol', 'custom/new']);
      } finally { await session.dispose(); await f.dispose(); }
    });
  });

  it('fails startup visibly when the native subscription route refuses an explicit unlisted choice', async () => {
    await withTempDir('fx-initial-refused-model-', async dir => {
      const f = await fixture(dir, 'refuse');
      try {
        await expect(f.open(configuration('custom/new', 'explicit', 'codex'))).rejects.toMatchObject({
          code: 'acp_configuration_update_failed',
          message: expect.stringContaining('Model was refused by the native route'),
        });
        expect(f.setters().map(params => params.value)).toEqual(['codex', 'custom/new']);
      } finally { await f.dispose(); }
    });
  });

  it('preserves a visible native refusal for an explicit live unlisted choice', async () => {
    await withTempDir('fx-refused-model-', async dir => {
      const f = await fixture(dir, 'refuse');
      const session = await f.open();
      try {
        const result = await session.updateConfiguration?.(configuration('custom/new', 'explicit'));
        expect(f.setters().map(params => params.value)).toEqual(['gateway', 'custom/new']);
        expect(result).toMatchObject({ status: 'rejected', diagnostic: {
          code: 'acp_configuration_update_failed', message: expect.stringContaining('Model was refused by the native route'),
        } });
        expect(f.publications.modelsSource.read().currentModelId).toBe('gpt-6.1-sol');
        await sendCompletedPrompt(session, 'after-model-refusal', 'Keep the working model');
        expect(f.promptModels()).toEqual(['gpt-6.1-sol']);
      } finally { await session.dispose(); await f.dispose(); }
    });
  });

  it('keeps an inherited already-current custom model appended by the native bound route', async () => {
    await withTempDir('fx-current-model-', async dir => {
      const f = await fixture(dir, 'current');
      const session = await f.open(configuration('custom/current', 'inherited'));
      try {
        expect(f.publications.modelsSource.read().currentModelId).toBe('custom/current');
      } finally { await session.dispose(); await f.dispose(); }
    });
  });
});
