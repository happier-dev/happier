import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { PLUGIN_MANIFEST } from '../../../../../../../packages/plugins/grok/src/manifest';
import { createGrokAgentRuntime } from '../../../../../../../packages/plugins/grok/src/agent/runtime/factory';
import { createAcpSessionRuntimeContextFixture } from '@/agent/acp/testkit/runtimeContextFixture';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createSessionRuntimeModelsPublisher } from '@/agent/runtime/controls/sessionRuntimeModelsPublisher';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from './createPublicAcpSession';

it.each([
  { mode: 'subscription', configChoices: false, catalogPresent: true },
  { mode: 'api-key', configChoices: false, catalogPresent: true },
  { mode: 'provider-binding', configChoices: false, catalogPresent: false },
  { mode: 'subscription', configChoices: true, catalogPresent: true },
  { mode: 'subscription', configChoices: false, catalogPresent: false },
] as const)('authenticates $mode while preserving native prompts and model controls (config choices: $configChoices, catalog present: $catalogPresent)', async ({ mode, configChoices, catalogPresent }) => {
  await withTempDir('grok-default-model-', async directory => {
    const capture = join(directory, 'requests.json');
    // Only the native process is fake. The Grok factory, shared ACP model
    // update/acknowledgement, prompt delivery and publications remain real.
    const script = writeAcpTestAgentScript({ dir: directory, fileName: 'grok.mjs', source: `
      import { createInterface } from 'node:readline';
      import { writeFileSync } from 'node:fs';
      let currentModelId = 'native-default'; const requests = [];
      const configOptions = () => [{id:'model',category:'model',name:'Model',type:'select',currentValue:currentModelId,
        options:[{group:'native',name:'Native',options:[{value:'native-default',name:'Native default'},{value:'native-next',name:'Native next'}]}]}];
      for await (const line of createInterface({ input:process.stdin })) {
        const r = JSON.parse(line); if (r.id === undefined) continue;
        requests.push({ method:r.method, params:r.params, currentModelId });
        writeFileSync(${JSON.stringify(capture)}, JSON.stringify(requests));
        let result = {};
        if (r.method === 'initialize') result = { protocolVersion:1, agentCapabilities:{},
          authMethods:${JSON.stringify(mode === 'provider-binding' ? [{id:'xai.api_key',name:'API key'}] : [{id:'cached_token',name:'Subscription'},{id:'xai.api_key',name:'API key'}])},
          _meta:{defaultAuthMethodId:'xai.api_key'} };
        if (r.method === 'authenticate' && ${mode === 'provider-binding'} && process.env.XAI_API_KEY !== 'selected-fixture-key') throw new Error('Selected Provider key missing');
        if (r.method === 'session/new') result = { sessionId:'native-grok',
          ...(${catalogPresent} ? {models:{ currentModelId,
            availableModels:[{modelId:'native-default',name:'Native default'},{modelId:'native-next',name:'Native next'}] }} : {}),
          ...(${configChoices} ? {configOptions:configOptions()} : {}) };
        if (r.method === 'session/set_model') {
          currentModelId = r.params.modelId; result = { _meta:{model:{Ok:currentModelId}} };
        }
        if (r.method === 'session/set_config_option') {
          currentModelId = r.params.value; result = {configOptions:configOptions()};
        }
        if (r.method === 'session/prompt') result = {stopReason:'end_turn'};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
      }
    ` });
    const signal = new AbortController().signal;
    const publications = createNativeAgentSessionPublications({ agentId:'grok', session:null,
      signal, isCurrent:() => true, supportsInFlightSteer:false });
    const dependencies: PublicAcpComposerDependencies = {
      pluginId:PLUGIN_MANIFEST.id, agentId:'grok', signal, isCurrent:() => true,
      systemTools:{ resolve:async () => ({toolId:'grok-cli',launch:{kind:'binary',executablePath:process.execPath,args:[script]}}) },
      ...(mode === 'provider-binding' ? { resolveHostLaunch: async () => ({ command:process.execPath, args:[script],
        env:{XAI_API_KEY:'selected-fixture-key'}, unsetEnv:[], timeouts:{} }) } : {}),
      interactions:{async request() {throw new Error('Unexpected interaction');}},
      media:{async registerSourceRoot() {throw new Error('Unexpected media');}},
      models:publications.services.models, modes:publications.services.modes,
    };
    const agent = PluginAgentContributionV2Schema.parse(PLUGIN_MANIFEST.contributes.agents?.find(value => value.id === 'grok'));
    const context = createAcpSessionRuntimeContextFixture({ agent, pluginId:PLUGIN_MANIFEST.id,
      sessionId:'grok-model-session', directory, signal, publications,
      protocols:{acp:{open:(request,options) => createPublicAcpSession(request,options,dependencies),
        async openExecutionRunV1() {throw new Error('Unexpected finite request');}}} });
    let metadata = createTestMetadata({ sessionModelsV1: { v: 1, agentId: 'grok', updatedAt: 1,
      currentModelId: 'native-default', availableModels: [{id:'old-global',name:'Previous global catalog'}] } });
    const publisher = catalogPresent || mode === 'provider-binding' ? null : createSessionRuntimeModelsPublisher({
      agentId: 'grok', source: publications.modelsSource,
      session: { getMetadataSnapshot: () => metadata,
        updateMetadataAsCurrentPublisher: updater => { metadata = updater(metadata); },
        on() {}, off() {}, },
    });
    const factory = await createGrokAgentRuntime({plugin:{id:PLUGIN_MANIFEST.id,version:PLUGIN_MANIFEST.version},agent:{id:'grok'},signal});
    try {
      if (!factory.sessions) throw new Error('Grok sessions unavailable');
      const session = await factory.sessions.open({kind:'create',sessionId:'grok-model-session',cwd:directory,
        ...(mode === 'provider-binding' ? { providerBinding:{ connectionId:'selected-provider',
          upstream:{protocol:'openai-chat',normalizedUrl:'https://provider.example/v1',credential:'apiKey'},
          model:{id:'native-default',name:'Native default'},materialization:{v:1,kind:'spawnEnv'} } }
          : { launchEnvironment:{values:{GROK_CONNECTED_ACCOUNT_MODE:mode},unset:[]} })},context.context);
      const events: AgentSessionRuntimeEvent[] = [];
      const watch = session.watch(event => events.push(event));
      try {
        if (catalogPresent) expect(publications.modelsSource.read().currentModelId).toBe('native-default');
        if (mode !== 'provider-binding') expect.soft(publications.modelsSource.read().models).toEqual([]);
        if (publisher) {
          await publisher.flush();
          expect(metadata.sessionModelsV1).toMatchObject({ currentModelId: 'native-default', availableModels: [] });
        }
        await session.send({inputIds:['first'],input:{text:'Use the native default'},delivery:{kind:'newTurn',turnId:'first'}});
        await expect.poll(() => events.some(event => event.kind === 'turn-complete' && event.turnId === 'first')).toBe(true);
        if (!catalogPresent) {
          const requests = JSON.parse(await readFile(capture,'utf8')) as Array<{method:string;params:{methodId?:string};currentModelId:string}>;
          expect(requests.filter(request => request.method === 'authenticate').map(request => request.params.methodId))
            .toEqual([mode === 'subscription' ? 'cached_token' : 'xai.api_key']);
          expect(requests.filter(request => request.method === 'session/prompt').map(request => request.currentModelId)).toEqual(['native-default']);
          return;
        }
        const updated = await session.updateConfiguration?.({model:{value:'native-next',updatedAtMs:1,selectionSource:'explicit'},
          mode:{value:null,updatedAtMs:0},permissionIntent:{value:null,updatedAtMs:0},options:{}});
        expect(updated).toMatchObject({status:'applied'});
        await session.send({inputIds:['next'],input:{text:'Use the changed model'},delivery:{kind:'newTurn',turnId:'next'}});
        await expect.poll(() => events.some(event => event.kind === 'turn-complete' && event.turnId === 'next')).toBe(true);
        const requests = JSON.parse(await readFile(capture,'utf8')) as Array<{method:string;params:{methodId?:string};currentModelId:string}>;
        expect(requests.filter(request => request.method === 'authenticate').map(request => request.params.methodId))
          .toEqual([mode === 'subscription' ? 'cached_token' : 'xai.api_key']);
        expect(requests.filter(request => request.method === 'session/prompt').map(request => request.currentModelId))
          .toEqual(['native-default','native-next']);
        expect(publications.modelsSource.read().currentModelId).toBe('native-next');
        expect(publications.modelsSource.read().models).toEqual([]);
        if (configChoices) {
          const options = events.filter(event => event.kind === 'config-options').at(-1);
          expect(options).toMatchObject({configOptions:[{id:'model',currentValue:'native-next',options:[],groups:[]}]});
        }
      } finally {watch.dispose(); await session.dispose();}
    } finally {publisher?.dispose(); publications.dispose(); await context.dispose();}
  });
});
