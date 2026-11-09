import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentSessionConfigurationSnapshot, AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import { createFxAgentRuntime } from '../../../../../../../packages/plugins/fx/src/agent/runtime/factory';
import { FX_PLUGIN } from '../../../../../../../packages/plugins/fx/src/manifest';
import { createKiloAgentRuntime } from '../../../../../../../packages/plugins/kilo/src/agent/runtime/factory';
import { KILO_PLUGIN } from '../../../../../../../packages/plugins/kilo/src/manifest';
import { createCodeBuddyAgentRuntime } from '../../../../../../../packages/plugins/codebuddy/src/agent/runtime/factory';
import { CODEBUDDY_PLUGIN } from '../../../../../../../packages/plugins/codebuddy/src/manifest';
import { createDroidAgentRuntime } from '../../../../../../../packages/plugins/droid/src/agent/runtime/factory';
import { createOhMyPiAgentRuntime } from '../../../../../../../packages/plugins/ohmypi/src/agent/runtime/engine';
import { OH_MY_PI_PLUGIN } from '../../../../../../../packages/plugins/ohmypi/src/manifest';
import { DROID_PLUGIN } from '../../../../../../../packages/plugins/droid/src/manifest';
import { createCopilotAgentRuntime } from '../../../../../../../packages/plugins/copilot/src/agent/runtime/factory';
import { COPILOT_PLUGIN } from '../../../../../../../packages/plugins/copilot/src/manifest';
import { COPILOT_GITHUB_PURPOSE_ID } from '../../../../../../../packages/plugins/copilot/src/agent/auth/services/accountPurposes';
import { COPILOT_PROVIDER_BINDING_ADAPTER_V1 } from '../../../../../../../packages/plugins/copilot/src/agent/providerBinding';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV } from '@happier-dev/plugin-sdk/connected-accounts';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createFxConfigOptionsFixture } from '@/agent/acp/testkit/fxConfigOptionsFixture';
import { createAcpSessionRuntimeContextFixture } from '@/agent/acp/testkit/runtimeContextFixture';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from './createPublicAcpSession';

// Protocol fixture: FX v0.0.14 session/new (2026-10-27), with constructed
// Gateway/custom-route and native-refusal variants, plus Kilo's declared model
// config-option control and Oh My Pi 18.12.3 model config options. Only the OS peer is fake.
async function fixture(dir: string, scenario: 'accept' | 'refuse' | 'current', agentId: 'fx' | 'kilo' | 'codebuddy' | 'droid' | 'ohmypi' | 'copilot' = 'fx', selectedAccount = true, selectedProvider = false) {
  const plugin = { fx: FX_PLUGIN, kilo: KILO_PLUGIN, codebuddy: CODEBUDDY_PLUGIN, droid: DROID_PLUGIN, ohmypi: OH_MY_PI_PLUGIN, copilot: COPILOT_PLUGIN }[agentId];
  const capture = join(dir, 'requests.json');
  const script = writeAcpTestAgentScript({ dir, fileName: 'models.mjs', source: `
    import { createInterface } from 'node:readline';
    import { writeFileSync } from 'node:fs';
    const requests = [];
    let nativeModel = 'native-default';
    let configOptions = ${JSON.stringify(createFxConfigOptionsFixture())};
    if (process.env.AGENT_MODE === 'ohmypi') configOptions = [{id:'model',name:'Model',category:'model',type:'select',currentValue:nativeModel,
      options:[{value:nativeModel,name:'Native default'},{value:'happier-provider/vendor/selected-model',name:'Selected'}]}];
    if (process.env.AGENT_MODE === 'kilo') configOptions = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'openai/native-default', options: ['openai/selected-initial', 'openai/selected-next', 'openai/unverified-native'].map(value => ({ value, name: value })) }];
    if (process.env.AGENT_MODE === 'codebuddy') configOptions = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'openai/selected-initial', options: ['openai/selected-initial', 'openai/unverified-native'].map(value => ({ value, name: value })) }];
    if (process.env.AGENT_MODE === 'droid') configOptions = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'custom:selected', options: [{ value: 'custom:selected', name: 'Happier provider: openai/selected-initial' }, { value: 'native-global', name: 'Global model' }] }];
    if (process.env.AGENT_MODE === 'copilot') {
      const selected = process.env.COPILOT_MODEL || 'native-global';
      configOptions = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: selected,
        options: [{ value: selected, name: 'Selected' }, { value: 'native-global', name: 'Global model' }] }];
    }
    configOptions = configOptions.map(option => option.id === 'provider'
      ? { ...option, options: [...option.options, {value:'private-route',name:'Configured route'}] } : option);
    if (process.env.SCENARIO === 'current') configOptions = configOptions.map(option => option.id === 'model'
      ? { ...option, currentValue: 'custom/current', options: [...option.options, {value:'custom/current',name:'Custom'}] } : option);
    for await (const line of createInterface({ input: process.stdin })) {
      const r = JSON.parse(line); if (r.id === undefined) continue;
      requests.push({ method: r.method, params: r.params,
        ...(r.method === 'session/prompt' ? { model: (process.env.AGENT_MODE === 'ohmypi' ? nativeModel : configOptions.find(option => option.id === 'model').currentValue) } : {}) });
      writeFileSync(process.env.CAPTURE, JSON.stringify(requests));
      let result = {}; let error;
      if (r.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {} };
      if (r.method === 'session/new') result = { sessionId: 'native-models', configOptions,
        ...(process.env.AGENT_MODE === 'ohmypi' ? { models: { currentModelId: nativeModel,
          availableModels: [{modelId: nativeModel, name:'Native default'}, {modelId:'happier-provider/vendor/selected-model',name:'Selected'}] } } : {}) };
      if (r.method === 'session/prompt') result = { stopReason: 'end_turn' };
      if (r.method === 'session/set_config_option') {
        if (r.params.configId === 'model' && process.env.SCENARIO === 'refuse') {
          error = { code: -32602, message: 'Model was refused by the native route' };
        } else {
          if (process.env.AGENT_MODE === 'ohmypi' && r.params.configId === 'model') nativeModel = r.params.value;
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
  const providerMaterialization = selectedProvider ? await COPILOT_PROVIDER_BINDING_ADAPTER_V1.materialize({
    v: 1, binding: { v: 1, agentTargetKey: 'backend:copilot:built_in',
      selection: { connectionId: 'gateway', model: { id: 'vendor/selected-model', name: 'Selected' } },
      contributionKey: null,
      endpoint: { endpointTemplateId: 'custom', normalizedUrl: 'http://127.0.0.1:7777/v1', protocol: 'openai-chat', publicHeaders: {} },
      runtimeCredentialTransport: null, compatibilityFingerprint: 'pcf1:copilot-test' },
    prepared: COPILOT_PROVIDER_BINDING_ADAPTER_V1.prepare({ v: 1, agentTargetKey: 'backend:copilot:built_in', connectionId: 'gateway' }),
    credential: { kind: 'none' },
  }) : null;
  const publications = createNativeAgentSessionPublications({ agentId, session: null,
    signal, isCurrent: () => true, supportsInFlightSteer: false });
  const dependencies: PublicAcpComposerDependencies = {
    pluginId: plugin.manifest.id, agentId, signal, isCurrent: () => true,
    systemTools: { resolve: async () => ({ toolId: `${agentId}-cli`, launch: {
      kind: 'binary', executablePath: process.execPath, args: [script], env: { CAPTURE: capture, SCENARIO: scenario, AGENT_MODE: agentId },
    } }) },
    interactions: { async request() { throw new Error('Unexpected interaction'); } },
    media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
    models: publications.services.models, modes: publications.services.modes,
  };
  const agent = PluginAgentContributionV2Schema.parse(plugin.manifest.contributes.agents?.find(entry => entry.id === agentId));
  const services = createUnavailablePluginServices();
  const account = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'selected' };
  const context = createAcpSessionRuntimeContextFixture({ agent, pluginId: plugin.manifest.id,
    sessionId: 'model-session', directory: dir, signal, publications,
    ...(agentId === 'codebuddy' || agentId === 'droid' || agentId === 'ohmypi' || agentId === 'copilot' ? { services: { ...services, connectedAccounts: {
      ...services.connectedAccounts,
      ...(agentId === 'ohmypi' ? { watch: (_purpose: string, listener: (event: {kind:'resync';authorityChanged:boolean}) => void) => {
        queueMicrotask(() => listener({kind:'resync',authorityChanged:false})); return {dispose() {}};
      } } : {}),
      // This host port is the external credential boundary of the plugin leaf.
      getBinding: async purpose => agentId !== 'ohmypi' && selectedAccount && purpose !== COPILOT_GITHUB_PURPOSE_ID ? { purpose, service: account.service, account,
        target: { kind: 'account' as const, displayName: 'Selected' } } : null,
      materialize: async () => ({ kind: 'httpHeaders' as const,
        headers: { authorization: 'Bearer synthetic-selected', 'chatgpt-account-id': 'synthetic-account' } }),
    } } } : {}),
    protocols: { acp: { open: (request, options) => {
      return createPublicAcpSession(request, options, dependencies);
    },
      async openExecutionRunV1() { throw new Error('Unexpected execution run'); } } } });
  const runtime = await ({ fx: createFxAgentRuntime, kilo: createKiloAgentRuntime,
    codebuddy: createCodeBuddyAgentRuntime, droid: createDroidAgentRuntime, ohmypi: createOhMyPiAgentRuntime, copilot: createCopilotAgentRuntime }[agentId])({ plugin: { id: plugin.manifest.id, version: '0.0.0' }, agent: { id: agentId }, signal });
  return { publications, context, async open(configuration?: AgentSessionConfigurationSnapshot) {
    try {
      return await runtime.sessions!.open({ kind: 'create', sessionId: 'model-session', cwd: dir,
        ...(configuration ? { configuration } : {}),
        ...(selectedProvider && providerMaterialization ? { providerBinding: { connectionId: 'gateway',
          upstream: { protocol: 'openai-chat' as const, normalizedUrl: 'http://127.0.0.1:7777/v1', credential: 'none' as const },
          model: { id: 'vendor/selected-model', name: 'Selected' }, materialization: providerMaterialization },
          ...(providerMaterialization.kind === 'spawnEnv' ? { launchEnvironment: {
            values: Object.fromEntries(providerMaterialization.env.flatMap(entry => entry.value === null ? [] : [[entry.name, entry.value]])),
            unset: providerMaterialization.env.filter(entry => entry.value === null).map(entry => entry.name),
          } } : {}),
        } : {}),
        ...(agentId === 'ohmypi' ? { providerBinding: { connectionId:'gateway',
          upstream:{protocol:'openai-responses' as const,normalizedUrl:'http://127.0.0.1:7777/v1',credential:'apiKey' as const},
          model:{id:'vendor/selected-model',name:'Selected'},
          materialization:{v:1 as const,kind:'configFile' as const,rootPath:dir,relativePaths:['provider.mjs']} } } : {}),
        ...(agentId === 'kilo' ? { launchEnvironment: { values: {
          [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]: join(dir, 'capability.json'),
        }, unset: [] } } : {}) }, context.context);
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

async function sendCompletedPrompt(session: AgentSessionRuntime, turnId: string, text: string, observe?: (event: AgentSessionRuntimeEvent) => void) {
  let complete!: () => void;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  const subscription = session.watch(event => {
    observe?.(event);
    if (event.kind === 'turn-complete' && event.turnId === turnId) complete();
  });
  try {
    expect(await session.send({ inputIds: [turnId], input: { text }, delivery: { kind: 'newTurn', turnId } }))
      .toMatchObject({ status: 'admitted' });
    await completed;
  } finally { subscription.dispose(); }
}

describe('selected account native model catalog provenance', () => {
  it.each(['codebuddy', 'droid', 'copilot'] as const)('withholds the %s generated account overlay from public catalogs while its explicit model still runs', async agentId => {
    await withTempDir(`${agentId}-account-catalog-`, async dir => {
      const f = await fixture(dir, 'accept', agentId);
      const session = await f.open({ ...configuration('openai/selected-initial', 'explicit'), options: {} });
      const events: AgentSessionRuntimeEvent[] = [];
      try {
        await sendCompletedPrompt(session, 'selected-overlay-prompt', 'Run the explicit model', event => events.push(event));
        expect(f.promptModels()).toEqual([agentId === 'droid' ? 'custom:selected' : agentId === 'copilot' ? 'happier-chatgpt/openai/selected-initial' : 'openai/selected-initial']);
        expect(f.publications.modelsSource.read().currentModelId).toBe('openai/selected-initial');
        expect.soft(f.publications.modelsSource.read().models).toEqual([]);
        const options = events.filter(event => event.kind === 'config-options').flatMap(event => event.configOptions);
        expect(options.length).toBeGreaterThan(0);
        expect(options.find(option => option.id === 'model')?.options).toEqual([]);
      } finally { await session.dispose(); await f.dispose(); }
    });
  });

  it.each(['codebuddy', 'droid', 'copilot'] as const)('preserves the unbound %s native catalog', async agentId => {
    await withTempDir(`${agentId}-native-catalog-`, async dir => {
      const f = await fixture(dir, 'accept', agentId, false);
      const session = await f.open(agentId === 'copilot' ? { ...configuration('native-global', 'explicit'), options: {} } : undefined);
      try { expect(f.publications.modelsSource.read().models?.length).toBeGreaterThan(0); }
      finally { await session.dispose(); await f.dispose(); }
    });
  });

  it('withholds Copilot Provider-bound ambient choices while the selected model still runs', async () => {
    await withTempDir('copilot-provider-catalog-', async dir => {
      const f = await fixture(dir, 'accept', 'copilot', false, true);
      const session = await f.open({ ...configuration('vendor/selected-model', 'explicit'), options: {} });
      const events: AgentSessionRuntimeEvent[] = [];
      try {
        await sendCompletedPrompt(session, 'provider-prompt', 'Run the selected model', event => events.push(event));
        expect(f.promptModels()).toEqual(['vendor/selected-model']);
        expect(f.publications.modelsSource.read().currentModelId).toBe('vendor/selected-model');
        expect.soft(f.publications.modelsSource.read().models).toEqual([]);
        expect(events.filter(event => event.kind === 'config-options').flatMap(event => event.configOptions)
          .find(option => option.id === 'model')?.options).toEqual([]);
      } finally { await session.dispose(); await f.dispose(); }
    });
  });
});

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


it('uses the selected Kilo account model on the next native prompt and withholds unverified native inventory', async () => {
  await withTempDir('kilo-live-account-model-', async dir => {
    const f = await fixture(dir, 'accept', 'kilo');
    const session = await f.open({ ...configuration('openai/selected-initial', 'explicit'), options: {} });
    try {
      await sendCompletedPrompt(session, 'kilo-before-model-change', 'Use the initial selected model');
      expect(await session.updateConfiguration?.({ ...configuration('openai/selected-next', 'explicit'), model: { value: 'openai/selected-next', selectionSource: 'explicit', updatedAtMs: 2 }, options: {} }))
        .toMatchObject({ status: 'applied' });
      await sendCompletedPrompt(session, 'kilo-after-model-change', 'Use the next selected model');
      expect(f.promptModels()).toEqual(['openai/selected-initial', 'openai/selected-next']);
      expect(f.publications.modelsSource.read().currentModelId).toBe('openai/selected-next');
      expect(f.publications.modelsSource.read().models).toEqual([]);
    } finally { await session.dispose(); await f.dispose(); }
  });
});


describe('Oh My Pi selected Provider model through the public ACP owner', () => {
  it.each(['accept', 'refuse'] as const)('keeps native model acknowledgement authoritative on %s before the next prompt', async scenario => {
    await withTempDir('omp-provider-model-', async dir => {
      const f = await fixture(dir, scenario, 'ohmypi');
      const session = await f.open();
      try {
        await sendCompletedPrompt(session, 'before-model-change', 'Use the current native model');
        const result = await session.updateConfiguration?.({ ...configuration('vendor/selected-model', 'explicit'), options: {} });
        expect(result).toMatchObject(scenario === 'accept' ? {status:'applied'} : {status:'rejected', diagnostic:{code:'acp_configuration_update_failed'}});
        expect(f.publications.modelsSource.read().currentModelId).toBe(scenario === 'accept' ? 'vendor/selected-model' : 'native-default');
        expect(f.publications.modelsSource.read().models).toEqual([]);
        if (scenario === 'accept') {
          expect(await session.updateConfiguration?.({ ...configuration('native-default', 'explicit'),
            model: { value: 'native-default', selectionSource: 'explicit', updatedAtMs: 2 }, options: {} }))
            .toMatchObject({ status: 'rejected' });
          expect(f.publications.modelsSource.read().currentModelId).toBe('vendor/selected-model');
        }
        await sendCompletedPrompt(session, 'after-model-change', 'Use the acknowledged model');
        expect(f.promptModels()).toEqual(['native-default', scenario === 'accept' ? 'happier-provider/vendor/selected-model' : 'native-default']);
      } finally { await session.dispose(); await f.dispose(); }
    });
  });
});
