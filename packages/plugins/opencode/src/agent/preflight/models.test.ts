import { describe, expect, it } from 'vitest';

import type { AgentPreflightSessionControlsContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { OPENCODE_PREFLIGHT_SESSION_CONTROLS, buildOpenCodeModelCatalogFromProviders } from './models.js';

describe('OpenCode native model normalization', () => {
  it('preserves empty and fully ineligible inventories without inventing models', () => {
    expect(buildOpenCodeModelCatalogFromProviders([], Date.now()).models).toEqual([]);
    expect(buildOpenCodeModelCatalogFromProviders([{ id: 'example', models: {
      image: { id: 'image', capabilities: { input: ['image'] } },
    } }], Date.now()).models).toEqual([]);
  });

  it.each([false, true])('keeps Muse account models usable beside a ChatGPT route (%s)', withChatGpt => {
    const catalog = buildOpenCodeModelCatalogFromProviders([
      { id: 'meta', models: { 'muse-spark-1.3-contributor': {
        id: 'muse-spark-1.3-contributor', name: 'Muse Spark 1.3 Contributor',
      } } },
      ...(withChatGpt ? [{ id: 'openai', usesChatGptAccount: true as const,
        models: { 'gpt-5.4': { id: 'gpt-5.4', name: 'GPT 5.4' } } }] : []),
    ], Date.now());
    expect(catalog).toEqual({ models: [
      { id: 'meta/muse-spark-1.3-contributor', name: 'Muse Spark 1.3 Contributor' },
    ] });
  });

  it('retains native metadata, reasoning choices and supported text models without tools', () => {
    expect(buildOpenCodeModelCatalogFromProviders([{ id: 'openai', models: {
      'gpt-5.4': {
        id: 'gpt-5.4', providerID: 'openai', name: 'GPT-5.4', family: 'gpt-5.4', status: 'active',
        capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
        variants: [{ id: 'low' }, { id: 'high' }], limit: { context: 400000, output: 128000 },
      },
      'no-tools': {
        id: 'no-tools', providerID: 'openai', name: 'No Tools', status: 'active',
        capabilities: { tools: false, input: ['text'] }, variants: [], limit: { context: 100000 },
      },
    } }], Date.now()).models).toEqual([{
      id: 'openai/gpt-5.4', name: 'GPT-5.4', description: 'gpt-5.4', contextWindowTokens: 400000,
      modelOptions: [{
        id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'high',
        options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
      }],
    }, { id: 'openai/no-tools', name: 'No Tools', description: 'openai', contextWindowTokens: 100000 }]);
  });

  it('retains nested model ids and uses the provider map key when the native record omits its id', () => {
    expect(buildOpenCodeModelCatalogFromProviders([{ id: 'openrouter', models: {
      'deepseek/deepseek-v4-flash-0731': { id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash' },
      '~anthropic/claude-opus-latest': { name: 'Claude Opus Latest' },
    } }], Date.now()).models).toEqual([
      { id: 'openrouter/deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash' },
      { id: 'openrouter/~anthropic/claude-opus-latest', name: 'Claude Opus Latest' },
    ]);
  });
});


it.each([
  { purpose: 'meta-inference', service: { pluginId: 'happier.agent.muse', localId: 'muse-account' }, modelId: 'meta/muse-spark-1.3-contributor', key: 'META_API_KEY', provider: 'meta' },
  { purpose: 'xai-api-key', service: { pluginId: 'happier.agent.grok', localId: 'xai' }, modelId: 'xai/grok-4', key: 'XAI_API_KEY', provider: 'xai' },
])('prepares selected $provider catalog credentials with the explicit model', async row => {
  const controls: AgentPreflightSessionControlsContributionV1 = OPENCODE_PREFLIGHT_SESSION_CONTROLS;
  const prepare = controls.prepareLaunchEnvironment!;
  // Connected-account custody is the boundary; native qualification and auth assembly stay real.
  const prepared = await prepare({ environment: {}, modelId: row.modelId, signal: new AbortController().signal,
    connectedAccounts: {
      async getBinding(purpose) { return purpose === row.purpose ? { purpose, service: row.service,
        account: { service: row.service, accountId: 'selected' }, target: { kind: 'account', displayName: 'Selected' } } : null; },
      async materialize() { return { kind: 'environment', env: { [row.key]: 'fake-selected' } }; },
      watch(_purpose, listener) { void listener({ kind: 'resync', authorityChanged: false }); return { dispose() {} }; },
    } });
  try { expect(JSON.parse(prepared.environment.OPENCODE_AUTH_CONTENT!)[row.provider]).toEqual({ type: 'api', key: 'fake-selected' }); }
  finally { await prepared.dispose(); }
});
