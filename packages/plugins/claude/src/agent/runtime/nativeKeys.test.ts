import { expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { materializeKimiCredentials } from '../../../../kimi/src/connectedAccounts/runtime.js';
import { activate } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { prepareClaudeConnectedAccountKeyRequest } from './connectedAccountKeys.js';
import { projectAgentConnectedAccountLaunchCatalogEntry } from '../../../../../../apps/cli/src/plugins/projection/registry/agentCatalogEntryHooks.js';
import { createClaudeAgentSdkTurnOperations } from './remote/sdk/session.js';
import { createEventsFixture, createPluginContextFixture, createSdkExecFixture, createSessionHooksFixture, createTerminalHostFixture } from './engine.testkit.js';

it('prepares selected Kimi Code material for the registered Claude native launch', async () => {
  const credentials: Record<string, string> = { accessToken: 'fake-kimi-key', credentialKind: 'token', apiKind: 'code' };
  const material = await materializeKimiCredentials({ kind: 'environment', keys: ['KIMI_API_KEY', 'KIMI_CODE_ANTHROPIC_BASE_URL'] }, {
    credentials: { get: async (key: string) => credentials[key] ?? null }, signal: new AbortController().signal, invokedAtMs: 0,
    services: { http: { request: vi.fn(async () => { throw new Error('Key launch must not log in or fetch models'); }) } },
  } as unknown as Parameters<typeof materializeKimiCredentials>[1], 'https://api.kimi.com/coding/v1');
  if (material.kind !== 'environment') throw new Error('Expected environment');
  const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  try {
    const agent = activation.registration('agents', 'claude')!;
    const catalog = projectAgentConnectedAccountLaunchCatalogEntry({ pluginId: PLUGIN_MANIFEST.id, agentId: 'claude',
      connectedAccountLaunch: agent.connectedAccountLaunch!, hostAccess: PLUGIN_MANIFEST.hostAccess, isCurrent: () => true });
    expect(catalog.connectedAccountEnvironmentUses).toEqual(expect.arrayContaining([{ purpose: 'kimi-code-api-key', environmentKey: 'KIMI_API_KEY' }]));
    const prepare = agent.preflightSessionControls!.prepareLaunchEnvironment;
    expect(prepare).toBeTypeOf('function');
    if (!prepare) throw new Error('Missing native key launch preparation');
    const launch = await prepare({ modelId: 'kimi-for-coding', environment: { ...material.env, ANTHROPIC_API_KEY: 'ambient', CLAUDE_CODE_OAUTH_TOKEN: 'stored' },
      connectedAccounts: { getBinding: async purpose => purpose === 'kimi-code-api-key' ? { purpose, target: { kind: 'account' as const, displayName: 'Selected' },
        service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, account: { service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, accountId: 'selected' },
      } : null, materialize: vi.fn(), watch: vi.fn() }, signal: new AbortController().signal });
    expect(launch.environment.ANTHROPIC_API_KEY).toBe('fake-kimi-key');
    expect(launch.environment.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding/');
    expect(launch.environment.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-for-coding');
    expect(launch.environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(launch.unset).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    const request = prepareClaudeConnectedAccountKeyRequest({ connectedAccounts: [{ purpose: 'kimi-code-api-key', account: {
      service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, accountId: 'selected' } }],
      launchEnvironment: { values: material.env, unset: [] },
      configuration: { model: { value: 'kimi-for-coding', updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {} },
    });
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
      exec: exec.service, sessionHooks: createSessionHooksFixture().service,
    });
    const operations = createClaudeAgentSdkTurnOperations({ ctx, directory: '/tmp/claude-selected-key',
      launchEnv: request.launchEnvironment.values, permissionMode: 'default', happierSessionId: 'key', initialModelId: 'kimi-for-coding' });
    try {
      await operations.sendProviderTurnPrompt('Observe the selected native launch');
      expect(exec.spawnClient.mock.calls).toContainEqual(expect.arrayContaining([expect.objectContaining({ launch: expect.objectContaining({
        env: expect.objectContaining({ ANTHROPIC_API_KEY: 'fake-kimi-key', ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/' }),
        args: expect.arrayContaining(['--model', 'kimi-for-coding']),
      }) })]));
    } finally { await operations.disposeProviderSession(); }
    await launch.dispose();
  } finally { await activation.dispose(); }
});

it.each([null, 'default'])('refuses an unresolved selected account model (%s) before native launch', model => {
  expect(() => prepareClaudeConnectedAccountKeyRequest({ connectedAccounts: [{ purpose: 'kimi-code-api-key',
    account: { service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, accountId: 'selected' } }],
    configuration: { model: { value: model, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {} },
  })).toThrow(expect.objectContaining({ details: { failureCause: expect.objectContaining({ failureReason: 'model_selection_required' }) } }));
});

it('leaves native login and default model untouched without a selected key account', () => {
  const request = { launchEnvironment: { values: { CLAUDE_CODE_OAUTH_TOKEN: 'stored-native' }, unset: [] } };
  expect(prepareClaudeConnectedAccountKeyRequest(request)).toBe(request);
});

it.each(['model_upstream', 'model_upstream_api_key'])('refuses a selected Kimi key together with %s', purpose => {
  const account = { service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, accountId: 'selected' };
  expect(() => prepareClaudeConnectedAccountKeyRequest({ connectedAccounts: [{ purpose: 'kimi-code-api-key', account }, { purpose, account }],
    launchEnvironment: { values: { KIMI_API_KEY: 'fake-key', KIMI_CODE_ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/' }, unset: [] },
    configuration: { model: { value: 'concrete-model', updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {} },
  })).toThrow(expect.objectContaining({ code: 'claude_connected_account_provider_conflict' }));
});
