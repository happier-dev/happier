import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentSessionConfigurationSnapshot, AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginAgentContributionV2Schema, SessionModelTransitionResultV1Schema, type SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import { createFxAgentRuntime } from '../../../../../../../packages/plugins/fx/src/agent/runtime/factory';
import { AGENT_DEFINITION as FX_DEFINITION } from '../../../../../../../packages/plugins/fx/src/agent/definition';
import { FX_PLUGIN } from '../../../../../../../packages/plugins/fx/src/manifest';
import { FX_PROVIDER_BINDING_ADAPTER } from '../../../../../../../packages/plugins/fx/src/agent/providerBinding/adapter';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION } from '@happier-dev/protocol/connect/connected-account-request-auth';
import { createStablePluginExecService, issueAgentNativeLaunchQualifierForHost } from '@/plugins/runtime/invocation/services/exec';
import { createKiloAgentRuntime } from '../../../../../../../packages/plugins/kilo/src/agent/runtime/factory';
import { KILO_PLUGIN } from '../../../../../../../packages/plugins/kilo/src/manifest';
import { createCodeBuddyAgentRuntime } from '../../../../../../../packages/plugins/codebuddy/src/agent/runtime/factory';
import { CODEBUDDY_PLUGIN } from '../../../../../../../packages/plugins/codebuddy/src/manifest';
import { AGENT_DEFINITION as CODEBUDDY_DEFINITION } from '../../../../../../../packages/plugins/codebuddy/src/agent/definition';
import { createDroidAgentRuntime } from '../../../../../../../packages/plugins/droid/src/agent/runtime/factory';
import { createOhMyPiAgentRuntime } from '../../../../../../../packages/plugins/ohmypi/src/agent/runtime/engine';
import { OH_MY_PI_PLUGIN } from '../../../../../../../packages/plugins/ohmypi/src/manifest';
import { DROID_PLUGIN } from '../../../../../../../packages/plugins/droid/src/manifest';
import { AGENT_DEFINITION as DROID_DEFINITION } from '../../../../../../../packages/plugins/droid/src/agent/definition';
import { createCopilotAgentRuntime } from '../../../../../../../packages/plugins/copilot/src/agent/runtime/factory';
import { COPILOT_PLUGIN } from '../../../../../../../packages/plugins/copilot/src/manifest';
import { AGENT_DEFINITION as COPILOT_DEFINITION } from '../../../../../../../packages/plugins/copilot/src/agent/definition';
import { COPILOT_GITHUB_PURPOSE_ID } from '../../../../../../../packages/plugins/copilot/src/agent/auth/services/accountPurposes';
import { COPILOT_PROVIDER_BINDING_ADAPTER_V1 } from '../../../../../../../packages/plugins/copilot/src/agent/providerBinding';
import { createOpenCodeAgentRuntime } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/nativeRuntime';
import { OPENCODE_PLUGIN } from '../../../../../../../packages/plugins/opencode/src/manifest';
import { OPENCODE_PROVIDER_BINDING_ADAPTER_V1 } from '../../../../../../../packages/plugins/opencode/src/agent/providerBinding/adapter';
import { OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID } from '../../../../../../../packages/plugins/opencode/src/agent/auth/services/purposes';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV } from '@happier-dev/plugin-sdk/connected-accounts';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createFxConfigOptionsFixture } from '@/agent/acp/testkit/fxConfigOptionsFixture';
import { createAcpSessionRuntimeContextFixture } from '@/agent/acp/testkit/runtimeContextFixture';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { createSessionModelTransitionAuthorizer } from '@/providers/sessions/authorizeSessionModelTransitionTarget';
import { resolveNativeAgentModelApplyPolicy } from '@/providers/sessions/resolveNativeAgentModelApplyPolicy';
import { createSessionModelTransitionCoordinator, mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult, type AuthorizedSessionModelTransitionTarget } from '@/providers/sessions/sessionModelTransitionCoordinator';
import { createModelIntentMetadataCasCandidate } from '@happier-dev/agents/session/state/metadataWriters';
import { readSessionModelSelectionV2FromMetadata } from '@happier-dev/agents/session/state/metadataReaders';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { createRuntimeOverrideSynchronizers, createRuntimeOverrideTarget } from '@/agent/runtime/createRuntimeOverrideSynchronizers';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { buildExecutionRunConfiguration, resolveExecutionRunChildSelection } from '@/agent/runtime/bridges/executionRun/runtime/openInputs';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from './createPublicAcpSession';

// Protocol fixture: FX v0.0.14 session/new (2026-10-27), with constructed
// Gateway/custom-route and native-refusal variants, plus Kilo's declared model
// config-option control and Oh My Pi 18.12.3 model config options. Only the OS peer is fake.
async function fixture(dir: string, scenario: 'accept' | 'refuse' | 'current', agentId: 'fx' | 'kilo' | 'codebuddy' | 'droid' | 'ohmypi' | 'copilot' | 'opencode' = 'fx', selectedAccount = agentId !== 'fx', selectedProvider = false) {
  const plugin = { fx: FX_PLUGIN, kilo: KILO_PLUGIN, codebuddy: CODEBUDDY_PLUGIN, droid: DROID_PLUGIN, ohmypi: OH_MY_PI_PLUGIN, copilot: COPILOT_PLUGIN, opencode: OPENCODE_PLUGIN }[agentId];
  const capture = join(dir, 'requests.json');
  const script = writeAcpTestAgentScript({ dir, fileName: 'models.mjs', source: `
    import { createInterface } from 'node:readline';
    import { readFileSync, writeFileSync } from 'node:fs';
    const requests = [];
    let nativeModel = 'native-default';
    let configuredModel;
    let configOptions = ${JSON.stringify(createFxConfigOptionsFixture())};
    if (process.env.AGENT_MODE === 'ohmypi') configOptions = [{id:'model',name:'Model',category:'model',type:'select',currentValue:nativeModel,
      options:[{value:nativeModel,name:'Native default'},{value:'happier-provider/vendor/selected-model',name:'Selected'}]}];
    if (process.env.AGENT_MODE === 'kilo') configOptions = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'openai/native-default', options: ['openai/selected-initial', 'openai/selected-next', 'openai/unverified-native'].map(value => ({ value, name: value })) }];
    if (process.env.AGENT_MODE === 'codebuddy') {
      const selected = JSON.parse(process.env.ACC_PRODUCT_CONFIG_V3 || '{"models":[{"id":"openai/selected-initial"}]}').models[0].id;
      configOptions = [{ id:'model', name:'Model', category:'model', type:'select', currentValue:selected,
        options:[selected,'openai/unverified-native'].map(value => ({value,name:value})) }];
    }
    if (process.env.AGENT_MODE === 'droid') {
      const settingsIndex = process.argv.indexOf('--settings');
      const selected = settingsIndex < 0 ? 'openai/selected-initial'
        : JSON.parse(readFileSync(process.argv[settingsIndex + 1], 'utf8')).customModels[0].model;
      configuredModel = selected;
      configOptions = [{id:'model',name:'Model',category:'model',type:'select',currentValue:'custom:selected',
        options:[{value:'custom:selected',name:'Happier provider: ' + selected},{value:'native-global',name:'Global model'}]}];
    }
    if (process.env.AGENT_MODE === 'copilot') {
      const selected = process.env.COPILOT_MODEL || 'native-global';
      configOptions = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: selected,
        options: [{ value: selected, name: 'Selected' }, { value: 'native-global', name: 'Global model' }] }];
    }
    if (process.env.AGENT_MODE === 'opencode') {
      nativeModel = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}').model || 'openai/native-default';
      configOptions = [];
    }
    configOptions = configOptions.map(option => option.id === 'provider'
      ? { ...option, options: [...option.options, {value:'private-route',name:'Configured route'},
          ...(process.env.FX_PROVIDER === 'happier' ? [{value:'happier',name:'Configured Provider'}] : [])] } : option);
    if (process.env.SCENARIO === 'current') configOptions = configOptions.map(option => option.id === 'model'
      ? { ...option, currentValue: 'custom/current', options: [...option.options, {value:'custom/current',name:'Custom'}] } : option);
    for await (const line of createInterface({ input: process.stdin })) {
      const r = JSON.parse(line); if (r.id === undefined) continue;
      requests.push({ method: r.method, params: r.params,
        ...(r.method === 'session/prompt' ? { model: (['ohmypi','opencode'].includes(process.env.AGENT_MODE) ? nativeModel : configOptions.find(option => option.id === 'model').currentValue), configuredModel } : {}) });
      writeFileSync(process.env.CAPTURE, JSON.stringify(requests));
      let result = {}; let error;
      if (r.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {} };
      if (r.method === 'session/new') result = { sessionId: 'native-models', configOptions,
        ...(['ohmypi','opencode'].includes(process.env.AGENT_MODE) ? { models: { currentModelId: nativeModel,
          availableModels: [{modelId: nativeModel, name:'Native default'}, {modelId:process.env.AGENT_MODE === 'opencode' ? 'openai/selected-initial' : 'happier-provider/vendor/selected-model',name:'Selected'}] } } : {}) };
      if (r.method === 'session/set_model') nativeModel = r.params.modelId;
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
  const providerAdapter = agentId === 'fx' ? FX_PROVIDER_BINDING_ADAPTER
    : agentId === 'opencode' ? OPENCODE_PROVIDER_BINDING_ADAPTER_V1 : COPILOT_PROVIDER_BINDING_ADAPTER_V1;
  const agentTargetKey = agentId === 'fx' ? 'agent:happier.agent.fx/fx'
    : agentId === 'opencode' ? 'agent:happier.agent.opencode/opencode' : 'backend:copilot:built_in';
  const providerMaterialization = selectedProvider ? await providerAdapter.materialize({
    v: 1, binding: { v: 1, agentTargetKey,
      selection: { connectionId: 'gateway', model: { id: 'vendor/selected-model', name: 'Selected' } },
      contributionKey: null,
      endpoint: { endpointTemplateId: 'custom', normalizedUrl: 'http://127.0.0.1:7777/v1', protocol: 'openai-chat', publicHeaders: {} },
      runtimeCredentialTransport: null, compatibilityFingerprint: 'pcf1:copilot-test' },
    prepared: providerAdapter.prepare({ v: 1, agentTargetKey, connectionId: 'gateway' }),
    credential: { kind: 'none' },
  }) : null;
  if (providerMaterialization?.kind === 'configFile') for (const file of providerMaterialization.files) {
    const path = join(dir, file.relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.utf8);
  }
  const fxEnvironment = agentId === 'fx' ? { HOME: dir, ...(providerMaterialization ? Object.fromEntries(
    providerMaterialization.env.flatMap(entry => entry.value === null ? [] : [[entry.name, entry.value]]),
  ) : {}) } : null;
  let disposeFxAuth = async () => {};
  if (agentId === 'fx' && selectedAccount) {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, value: {
        headers: { authorization: 'Bearer synthetic-selected', 'chatgpt-account-id': 'synthetic-account' },
        facts: {}, expiresAt: Date.now() + 3_600_000,
        credentialContext: { account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'selected' },
          credentialRevision: `csr_${'a'.repeat(22)}` },
      } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    disposeFxAuth = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing request-auth fixture port');
    await writeFile(join(dir, 'capability.json'), JSON.stringify({ v: CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION,
      materializationId: 'fx-models', subjectScopeDigest: 'd'.repeat(64), capability: 'c'.repeat(43), httpPort: address.port }));
  }
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
  const account = { service: agentId === 'opencode' ? { pluginId: 'happier.voice.openai', localId: 'openai' }
    : { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'selected' };
  // The status child is an OS boundary; native settings and host qualification stay real.
  const fxExec = agentId === 'fx' && selectedProvider ? createStablePluginExecService({
    allowedExecutables: [{ kind: 'systemTool', id: 'fx-cli' }], allowedEnvKeys: [],
    environment: fxEnvironment!, signal, isOccurrenceCurrent: () => true,
    resolveExecutable: async () => ({ command: process.execPath, args: ['-e', `
      const {readFileSync} = require('node:fs'); const {join} = require('node:path');
      const settings = JSON.parse(readFileSync(join(process.env.HOME, '.fx/settings.json'), 'utf8'));
      process.stdout.write(JSON.stringify({kind:'status',auth:'configured provider',auth_refreshable:false,model:settings.models[process.env.FX_PROVIDER]}));
    `, '--'] }), resolvePath: async () => dir,
    // This fixture already projected the admitted private home above.
    prepareAgentNativeLaunch: async () => {},
  }) : null;
  const context = createAcpSessionRuntimeContextFixture({ agent, pluginId: plugin.manifest.id,
    sessionId: 'model-session', directory: dir, signal, publications,
    ...(fxExec ? { services: { ...services, exec: fxExec } } : {}),
    ...(agentId === 'codebuddy' || agentId === 'droid' || agentId === 'ohmypi' || agentId === 'copilot' || agentId === 'opencode' ? { services: { ...services, connectedAccounts: {
      ...services.connectedAccounts,
      ...(agentId === 'ohmypi' || agentId === 'opencode' ? { watch: (_purpose: string, listener: (event: {kind:'resync';authorityChanged:boolean}) => void) => {
        queueMicrotask(() => listener({kind:'resync',authorityChanged:false})); return {dispose() {}};
      } } : {}),
      // This host port is the external credential boundary of the plugin leaf.
      getBinding: async purpose => agentId !== 'ohmypi' && selectedAccount && purpose !== COPILOT_GITHUB_PURPOSE_ID
        && (agentId !== 'opencode' || purpose === OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID) ? { purpose, service: account.service, account,
        target: { kind: 'account' as const, displayName: 'Selected' } } : null,
      materialize: async () => agentId === 'opencode' ? { kind: 'environment' as const, env: { OPENAI_API_KEY: 'synthetic-selected' } }
        : ({ kind: 'httpHeaders' as const, headers: { authorization: 'Bearer synthetic-selected', 'chatgpt-account-id': 'synthetic-account' } }),
    } } } : {}),
    protocols: { acp: { open: (request, options) => {
      return createPublicAcpSession(request, options, dependencies);
    },
      async openExecutionRunV1() { throw new Error('Unexpected execution run'); } } } });
  const runtimeContext = fxExec && context.context.session ? { ...context.context,
    session: { ...context.context.session, services: { ...context.context.session.services,
      nativeLaunch: issueAgentNativeLaunchQualifierForHost(fxExec) } },
  } : context.context;
  const runtime = await ({ fx: createFxAgentRuntime, kilo: createKiloAgentRuntime,
    codebuddy: createCodeBuddyAgentRuntime, droid: createDroidAgentRuntime, ohmypi: createOhMyPiAgentRuntime, copilot: createCopilotAgentRuntime, opencode: createOpenCodeAgentRuntime }[agentId])({ plugin: { id: plugin.manifest.id, version: '0.0.0' }, agent: { id: agentId }, signal });
  return { publications, context,
    operations(session: AgentSessionRuntime, initial: AgentSessionConfigurationSnapshot) {
      return createNativeAgentSessionOperations(session, 'model-session', undefined, undefined, undefined, initial, undefined, {
        context: runtimeContext, cwd: dir, connectedAccounts: [],
        capabilities: readAgentSessionCapabilities(agent)!, cancellation: { declared: false }, compaction: { capability: null },
        configuration: { declared: true, updateConfiguration: update => session.updateConfiguration!(update) },
      }, publications);
    },
    providerNativeModelId: providerMaterialization?.kind === 'configFile' ? String(JSON.parse(providerMaterialization.files[0]!.utf8).model) : 'vendor/selected-model',
    async open(configuration?: AgentSessionConfigurationSnapshot) {
    try {
      return await runtime.sessions!.open({ kind: 'create', sessionId: 'model-session', cwd: dir,
        ...(configuration ? { configuration } : {}),
        ...(selectedProvider && providerMaterialization ? { providerBinding: { connectionId: 'gateway',
          upstream: { protocol: 'openai-chat' as const, normalizedUrl: 'http://127.0.0.1:7777/v1', credential: 'none' as const },
          model: { id: 'vendor/selected-model', name: 'Selected' }, materialization: providerMaterialization.kind === 'configFile'
            ? { v: 1 as const, kind: 'configFile' as const, rootPath: dir, relativePaths: providerMaterialization.files.map(file => file.relativePath) }
            : providerMaterialization },
          ...(providerMaterialization.kind === 'spawnEnv' ? { launchEnvironment: {
            values: Object.fromEntries(providerMaterialization.env.flatMap(entry => entry.value === null ? [] : [[entry.name, entry.value]])),
            unset: providerMaterialization.env.filter(entry => entry.value === null).map(entry => entry.name),
          } } : {}),
        } : {}),
        ...(agentId === 'ohmypi' ? { providerBinding: { connectionId:'gateway',
          upstream:{protocol:'openai-responses' as const,normalizedUrl:'http://127.0.0.1:7777/v1',credential:'apiKey' as const},
          model:{id:'vendor/selected-model',name:'Selected'},
          materialization:{v:1 as const,kind:'configFile' as const,rootPath:dir,relativePaths:['provider.mjs']} } } : {}),
        ...(agentId === 'fx' && (selectedAccount || selectedProvider) ? { launchEnvironment: { values: {
          ...fxEnvironment!, ...(selectedAccount ? { [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]: join(dir, 'capability.json') } : {}),
        }, unset: [] } } : {}),
        ...(agentId === 'kilo' ? { launchEnvironment: { values: {
          [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]: join(dir, 'capability.json'),
        }, unset: [] } } : {}) }, runtimeContext);
    } catch (error) {
      publications.dispose();
      await context.dispose();
      await disposeFxAuth();
      throw error;
    }
  },
  setters: () => (JSON.parse(readFileSync(capture, 'utf8')) as Array<{method: string; params: {configId?: string; value?: string}}>)
    .filter(request => request.method === 'session/set_config_option').map(request => request.params),
  promptModels: () => (JSON.parse(readFileSync(capture, 'utf8')) as Array<{method: string; model?: string}>)
    .filter(request => request.method === 'session/prompt').map(request => request.model),
  promptConfiguredModels: () => (JSON.parse(readFileSync(capture, 'utf8')) as Array<{method: string; model?: string; configuredModel?: string}>)
    .filter(request => request.method === 'session/prompt').map(request => request.configuredModel ?? request.model),
  async dispose() { publications.dispose(); try { await context.dispose(); } finally { await disposeFxAuth(); } } };
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
  it.each(['codebuddy', 'droid', 'copilot'] as const)('retains the %s selected-account model on the next native prompt when a model transition requires restart', async agentId => {
    await withTempDir(`${agentId}-model-restart-`, async dir => {
      const f = await fixture(dir, 'accept', agentId);
      const initialConfiguration = { ...configuration('openai/selected-initial', 'explicit'), options: {} };
      const session = await f.open(initialConfiguration);
      const operations = f.operations(session, initialConfiguration);
      const agentTargetKey = `agent:happier.agent.${agentId}/${agentId}`;
      const initialSelection = { agentTargetKey, providerConnectionId: null, modelId: 'openai/selected-initial' };
      const requestedSelection = { ...initialSelection, modelId: 'openai/selected-next' };
      const nativeModelApplyPolicy = resolveNativeAgentModelApplyPolicy({ codebuddy: CODEBUDDY_DEFINITION,
        droid: DROID_DEFINITION, copilot: COPILOT_DEFINITION }[agentId].modelConfig);
      let metadata = createTestMetadata({ flavor: agentId });
      let active: AuthorizedSessionModelTransitionTarget = { selection: initialSelection, policy: nativeModelApplyPolicy,
        providerBinding: null, sessionBindingMetadata: null, runtimeBindingBasis: null, revalidateBeforeEffect: async () => true };
      const authorize = createSessionModelTransitionAuthorizer({ sessionId: 'model-session', machineId: 'fixture',
        agentId, agentTargetKey, nativeModelApplyPolicy, readActiveTarget: () => active });
      let runtimeOutcome: Awaited<ReturnType<typeof operations.updateSessionRuntimeConfig>> | undefined;
      const coordinator = createSessionModelTransitionCoordinator({ runId: 'original-run', agentTargetKey,
        initialActiveTarget: authorize.bindCurrentAuthorizationProof(active), initialActiveTargetConfirmed: true,
        readModelSelectionIntent: () => readSessionModelSelectionV2FromMetadata(metadata),
        isCurrentRun: () => true, checkCurrentPublisherAuthority: async () => true, authorize,
        publishIntent: async selection => {
          const candidate = createModelIntentMetadataCasCandidate({ selection, nowMs: () => 2 });
          metadata = candidate.update(metadata);
          const state = candidate.readState();
          return { accepted: state.accepted, updatedAt: state.updatedAt ?? 0 };
        },
        applyRuntime: async target => {
          runtimeOutcome = await operations.updateSessionRuntimeConfig({ modelId: target.selection.modelId, modelSelectionSource: 'explicit' });
          return mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult(runtimeOutcome);
        },
        publishActive: async target => { active = target; }, revokeActiveSelectionProof: async () => {},
        fencePromptAdmission: async () => {}, clearPromptAdmission: async () => {},
        transferPromptAdmission: async (_epoch, input) => { await input.dispatch(); return { status: 'dispatched', value: undefined }; },
      });
      try {
        await sendCompletedPrompt(session, 'before-model-restart', 'Run the current model');
        expect(await coordinator.submit(requestedSelection, { source: 'command' })).toMatchObject({
          ok: false, status: 'restart_required', activeSelection: initialSelection, requestedSelection });
        expect(runtimeOutcome).toMatchObject({ status: 'requires_restart', diagnostic: {
          code: 'acp_configuration_update_failed', details: { status: 'requires_restart' } } });
        expect(coordinator.readActiveTarget().selection).toEqual(initialSelection);
        expect(f.publications.modelsSource.read().currentModelId).toBe(initialSelection.modelId);
        await sendCompletedPrompt(session, 'after-refused-model-transition', 'Continue using the current model');
        expect(f.promptConfiguredModels()).toEqual([0, 1].map(() => agentId === 'copilot'
          ? 'happier-chatgpt/openai/selected-initial' : 'openai/selected-initial'));
        expect(f.publications.modelsSource.read().currentModelId).toBe(initialSelection.modelId);
      } finally { await coordinator.dispose(); await session.dispose(); await f.dispose(); }
    });
  });
  it.each(['inherited', 'undeclared'] as const)('runs a concrete OpenCode helper model with %s selection provenance', async provenance => {
    await withTempDir('opencode-helper-model-', async dir => {
      const backendTarget = { kind: 'backend' as const, backendId: 'opencode' };
      const selected = resolveExecutionRunChildSelection({ backendTarget, lifecycle: 'attached',
        parent: { status: 'applied', backendTarget, modelId: 'openai/selected-initial', connectedServices: null } });
      const { configuration: inherited } = buildExecutionRunConfiguration({ backendTarget,
        modelId: selected.modelId, modelSelectionSource: selected.modelSelectionSource,
        permissionMode: 'read-only', updatedAtMs: 1 });
      const { selectionSource: _source, ...model } = inherited.model;
      const f = await fixture(dir, 'accept', 'opencode');
      const session = await f.open({ ...inherited, ...(provenance === 'undeclared' ? { model } : {}),
        options: { opencodeBackendMode: { value: 'acp', updatedAtMs: 1 } } });
      try {
        await sendCompletedPrompt(session, 'helper-model-prompt', 'Run the inherited concrete model');
        expect(f.promptModels()).toEqual(['openai/selected-initial']);
        expect(f.publications.modelsSource.read().currentModelId).toBe('openai/selected-initial');
      } finally { await session.dispose(); await f.dispose(); }
    });
  });

  it.each(['codebuddy', 'droid', 'copilot'] as const)('withholds the %s generated account overlay from public catalogs while its explicit model still runs', async agentId => {
    await withTempDir(`${agentId}-account-catalog-`, async dir => {
      const f = await fixture(dir, 'accept', agentId);
      const { configuration: helperConfiguration } = buildExecutionRunConfiguration({
        backendTarget: { kind: 'backend', backendId: agentId }, modelId: 'openai/selected-initial',
        modelSelectionSource: 'inherited', permissionMode: 'read-only', updatedAtMs: 1 });
      const session = await f.open(helperConfiguration);
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

  it('withholds OpenCode ACP Provider-bound ambient choices while the selected model still runs', async () => {
    await withTempDir('opencode-acp-provider-catalog-', async dir => {
      const f = await fixture(dir, 'accept', 'opencode', false, true);
      const session = await f.open({ ...configuration('vendor/selected-model', 'explicit'),
        options: { opencodeBackendMode: { value: 'acp', updatedAtMs: 1 } } });
      try {
        await sendCompletedPrompt(session, 'opencode-provider-prompt', 'Run the selected model');
        expect(f.promptModels()).toEqual([f.providerNativeModelId]);
        expect(f.publications.modelsSource.read().currentModelId).toBe(f.providerNativeModelId);
        expect(f.publications.modelsSource.read().models).toEqual([]);
      } finally { await session.dispose(); await f.dispose(); }
    });
  });

  it.each([true, false])('projects the OpenCode ACP native catalog for a qualified account selection: %s', async selectedAccount => {
    await withTempDir('opencode-acp-native-account-', async dir => {
      const f = await fixture(dir, 'accept', 'opencode', selectedAccount);
      const session = await f.open({ ...configuration('openai/selected-initial', 'explicit'),
        options: { opencodeBackendMode: { value: 'acp', updatedAtMs: 1 } } });
      try {
        await sendCompletedPrompt(session, 'opencode-native-prompt', 'Run the explicit native model');
        expect(f.promptModels()).toEqual(['openai/selected-initial']);
        expect(f.publications.modelsSource.read().currentModelId).toBe('openai/selected-initial');
        if (selectedAccount) expect(f.publications.modelsSource.read().models).toEqual([]);
        else expect(f.publications.modelsSource.read().models?.length).toBeGreaterThan(0);
      } finally { await session.dispose(); await f.dispose(); }
    });
  });
});

describe('FX model selection through the public ACP owner', () => {
  it.each(['account', 'provider'] as const)('withholds FX %s inventory while explicit model changes reach the next native prompt', async route => {
    await withTempDir(`fx-${route}-catalog-`, async dir => {
      const f = await fixture(dir, 'accept', 'fx', route === 'account', route === 'provider');
      const initial = route === 'provider' ? 'vendor/selected-model' : 'selected-initial';
      const provider = route === 'account' ? 'codex' : 'happier';
      const session = await f.open(configuration(initial, 'explicit', provider));
      const events: AgentSessionRuntimeEvent[] = [];
      try {
        await sendCompletedPrompt(session, 'fx-selected-initial', 'Run the selected model', event => events.push(event));
        expect(f.promptModels()).toEqual([initial]);
        expect.soft(f.publications.modelsSource.read().models).toEqual([]);
        expect(events.filter(event => event.kind === 'config-options').flatMap(event => event.configOptions)
          .find(option => option.id === 'model')?.options).toEqual([]);
        expect(await session.updateConfiguration!({ ...configuration('selected-next', 'explicit', provider),
          model: { value: 'selected-next', selectionSource: 'explicit', updatedAtMs: 2 } }))
          .toMatchObject({ status: 'applied' });
        await sendCompletedPrompt(session, 'fx-selected-next', 'Run the next selected model');
        expect(f.promptModels()).toEqual([initial, 'selected-next']);
        expect(f.publications.modelsSource.read().currentModelId).toBe('selected-next');
      } finally { await session.dispose(); await f.dispose(); }
    });
  });

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
          details: { requestErrorCode: -32602 },
        } });
        expect(f.publications.modelsSource.read().currentModelId).toBe('gpt-6.1-sol');
        await sendCompletedPrompt(session, 'after-model-refusal', 'Keep the working model');
        expect(f.promptModels()).toEqual(['gpt-6.1-sol']);
      } finally { await session.dispose(); await f.dispose(); }
    });
  });

  it('retains the native model refusal cause through a strict transition result and the prompt issue', async () => {
    await withTempDir('fx-model-refusal-cause-', async dir => {
      const f = await fixture(dir, 'refuse');
      const nativeSession = await f.open();
      const initialConfiguration = configuration('gpt-6.1-sol', 'explicit');
      const operations = f.operations(nativeSession, initialConfiguration);
      const agentTargetKey = 'agent:happier.agent.fx/fx';
      const initialSelection = { agentTargetKey, providerConnectionId: null, modelId: 'gpt-6.1-sol' };
      const requestedSelection = { ...initialSelection, modelId: 'custom/new' };
      const nativeModelApplyPolicy = resolveNativeAgentModelApplyPolicy(FX_DEFINITION.modelConfig);
      const session = createMutableApiSessionClientFixture({ sessionId: 'model-session',
        metadata: createTestMetadata({ flavor: 'fx', permissionMode: 'default', permissionModeUpdatedAt: 0 }),
        // Home transport boundary; native configuration, coordination and prompt custody stay real.
        overrides: { enqueueAgentMessageCommitted: async () => ({ persisted: true, delivered: false }) },
      });
      let active: AuthorizedSessionModelTransitionTarget = { selection: initialSelection, policy: nativeModelApplyPolicy,
        providerBinding: null, sessionBindingMetadata: null, runtimeBindingBasis: null, revalidateBeforeEffect: async () => true };
      const authorize = createSessionModelTransitionAuthorizer({ sessionId: 'model-session', machineId: 'fixture',
        agentId: 'fx', agentTargetKey, nativeModelApplyPolicy, readActiveTarget: () => active });
      const coordinator = createSessionModelTransitionCoordinator({ runId: 'model-refusal', agentTargetKey,
        initialActiveTarget: authorize.bindCurrentAuthorizationProof(active), initialActiveTargetConfirmed: true,
        readModelSelectionIntent: () => readSessionModelSelectionV2FromMetadata(session.getMetadataSnapshot()),
        isCurrentRun: () => true, checkCurrentPublisherAuthority: async () => true, authorize,
        publishIntent: async selection => {
          const candidate = createModelIntentMetadataCasCandidate({ selection, nowMs: () => 2 });
          session.__setMetadata(candidate.update(session.getMetadataSnapshot()!));
          const state = candidate.readState();
          return { accepted: state.accepted, updatedAt: state.updatedAt ?? 0 };
        },
        applyRuntime: async target => mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult(
          await operations.updateSessionRuntimeConfig({ modelId: target.selection.modelId, modelSelectionSource: 'explicit' })),
        publishActive: async target => { active = target; }, revokeActiveSelectionProof: async () => {},
        fencePromptAdmission: async () => {}, clearPromptAdmission: async () => {},
        transferPromptAdmission: async (_epoch, input) => { await input.dispatch(); return { status: 'dispatched', value: undefined }; },
      });
      const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(mode => JSON.stringify(mode),
        { batcher: combinePermissionModeQueuedPrompts });
      queue.push({ text: 'Use the requested model', localId: 'model-refusal' },
        { permissionMode: 'default', modelSelection: requestedSelection });
      const abort = new AbortController();
      let transition: Awaited<ReturnType<typeof coordinator.submit>> | undefined;
      let issue: SessionRuntimeIssueV1 | undefined;
      try {
        await runPermissionModePromptLoop({ providerName: 'FX', agentMessageType: 'fx', explicitPermissionMode: undefined,
          session, messageQueue: queue, runtime: operations,
          permissionHandler: { setPermissionMode() {}, reset() {} },
          readActiveModelSelection: () => coordinator.readActiveTarget().selection,
          transitionModelSelectionBeforePrompt: async (selection, runWithActiveSelection, restartRuntime) => {
            // Exercise the actual closed transport reader, rather than an in-memory extra property.
            transition = SessionModelTransitionResultV1Schema.parse(JSON.parse(JSON.stringify(await coordinator.submit(selection,
              { source: 'prompt', runWithActiveSelection, restartRuntime }))));
            return transition;
          },
          createOverrideSynchronizer: isStarted => createRuntimeOverrideSynchronizers({ agentTargetKey, session, isStarted,
            runtime: createRuntimeOverrideTarget({ runtime: operations,
              transitionModelSelection: selection => coordinator.submit(selection, { source: 'metadata' }) }) }),
          messageBuffer: new MessageBuffer(), shouldExit: () => abort.signal.aborted, getAbortSignal: () => abort.signal,
          keepAlive() {}, setThinking() {}, sendReady: () => { abort.abort(); }, currentPermissionModeUpdatedAt: 0,
          setCurrentPermissionMode() {}, setCurrentPermissionModeUpdatedAt() {}, formatPromptErrorMessage: String,
          registerProviderAcceptedEffect: () => undefined,
          onPromptFailure: (error, context) => {
            if (!context) throw new Error('Prompt failure must carry its startup context');
            issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error, startupPhase: context.startupPhase });
          },
        });
        const expectedCause = { phase: 'turn_start', failureReason: 'unclassified_provider_error', providerErrorCode: -32602 };
        expect.soft(transition).toMatchObject({ ok: false, status: 'apply_failed', failureCause: expectedCause });
        expect.soft(issue).toMatchObject({ source: 'agent_session_error', failureCause: expectedCause });
        await expect(createRuntimeOverrideTarget({ runtime: operations,
          transitionModelSelection: selection => coordinator.submit(selection, { source: 'metadata' }),
        }).setSessionModelSelection(requestedSelection)).rejects.toMatchObject({ details: { failureCause: expectedCause } });
        expect(f.promptModels()).toEqual([]);
        expect(coordinator.readActiveTarget().selection).toEqual(initialSelection);
      } finally {
        abort.abort();
        await coordinator.dispose(); await nativeSession.dispose(); await f.dispose();
      }
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
    const { configuration: helperConfiguration } = buildExecutionRunConfiguration({
      backendTarget: { kind: 'backend', backendId: 'kilo' }, modelId: 'openai/selected-initial',
      modelSelectionSource: 'inherited', permissionMode: 'read-only', updatedAtMs: 1 });
    const session = await f.open(helperConfiguration);
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
