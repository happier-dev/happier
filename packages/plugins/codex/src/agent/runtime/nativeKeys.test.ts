import { expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { materializeKimiCredentials } from '../../../../kimi/src/connectedAccounts/runtime.js';
import { activate } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { buildCodexAppServerArgs } from './appServer/client.js';
import { prepareCodexConnectedAccountKeyRequest } from './connectedAccountKeys.js';
import { resolveCodexAcpSpawnWithOptions } from '../acp/command.js';
import type { AgentSessionModelsSource } from '@happier-dev/plugin-sdk/agents/runtime';
import { withCodexNativeAttachFixture } from './appServer/runtime.nativeAttach.test-support.js';
import { projectAgentConnectedAccountLaunchCatalogEntry } from '../../../../../../apps/cli/src/plugins/projection/registry/agentCatalogEntryHooks.js';
import { buildCodexNativeAcpRuntimeOptions } from '../acp/backend.js';

it('prepares selected Kimi Responses configuration through the registered Codex launch', async () => {
  const credentials: Record<string, string> = { accessToken: 'fake-kimi-key', credentialKind: 'token', apiKind: 'code' };
  const material = await materializeKimiCredentials({ kind: 'environment', keys: ['KIMI_API_KEY', 'KIMI_CODE_BASE_URL'] }, {
    credentials: { get: async (key: string) => credentials[key] ?? null }, signal: new AbortController().signal, invokedAtMs: 0,
    services: { http: { request: vi.fn(async () => { throw new Error('Key launch must not log in or fetch models'); }) } },
  } as unknown as Parameters<typeof materializeKimiCredentials>[1], 'https://api.kimi.com/coding/v1');
  if (material.kind !== 'environment') throw new Error('Expected environment');
  const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  try {
    const agent = activation.registration('agents', 'codex')!;
    projectAgentConnectedAccountLaunchCatalogEntry({ pluginId: PLUGIN_MANIFEST.id, agentId: 'codex',
      connectedAccountLaunch: agent.connectedAccountLaunch!, hostAccess: PLUGIN_MANIFEST.hostAccess, isCurrent: () => true });
    const prepare = agent.preflightSessionControls!.prepareLaunchEnvironment;
    expect(prepare).toBeTypeOf('function');
    if (!prepare) throw new Error('Missing native key launch preparation');
    const launch = await prepare({ modelId: 'kimi-for-coding', environment: { ...material.env, OPENAI_API_KEY: 'ambient', CODEX_API_KEY: 'stored' },
      connectedAccounts: { getBinding: async purpose => purpose === 'kimi-code-api-key' ? { purpose, target: { kind: 'account' as const, displayName: 'Selected' },
        service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, account: { service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, accountId: 'selected' },
      } : null, materialize: vi.fn(), watch: vi.fn() }, signal: new AbortController().signal });
    expect(launch.environment.HAPPIER_CODEX_PROVIDER_API_KEY).toBe('fake-kimi-key');
    expect(launch.environment.CODEX_API_KEY).toBeUndefined();
    const args = buildCodexAppServerArgs({ env: launch.environment });
    expect(args.join('\n')).toContain('https://api.kimi.com/coding/v1');
    expect(args.join('\n')).toContain('HAPPIER_CODEX_PROVIDER_API_KEY');
    expect(args.join('\n')).not.toContain('fake-kimi-key');
    expect(launch.commandArgsSuffix?.join('\n')).toContain('https://api.kimi.com/coding/v1');
    expect(launch.commandArgsSuffix).toContain('model="kimi-for-coding"');
    expect(launch.commandArgsSuffix?.join('\n')).not.toContain('fake-kimi-key');
    const acp = resolveCodexAcpSpawnWithOptions({ env: launch.environment }, { resolveExistingManagedBinPath: () => '/fake/codex-acp' });
    expect(acp.args.join('\n')).toContain('https://api.kimi.com/coding/v1');
    await launch.dispose();
  } finally { await activation.dispose(); }
});

it.each([null, 'default'])('refuses an unresolved selected account model (%s) before native launch', model => {
  expect(() => prepareCodexConnectedAccountKeyRequest({ connectedAccounts: [{ purpose: 'kimi-code-api-key',
    account: { service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, accountId: 'selected' } }],
    configuration: { model: { value: model, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {} },
  })).toThrow(expect.objectContaining({ details: { failureCause: expect.objectContaining({ failureReason: 'model_selection_required' }) } }));
});

it('leaves native login and default model untouched without a selected key account', () => {
  const request = { launchEnvironment: { values: { CODEX_HOME: '/stored-native' }, unset: [] } };
  expect(prepareCodexConnectedAccountKeyRequest(request)).toBe(request);
});

it.each(['openai-api-key', 'primary'])('refuses a selected Kimi key together with %s', purpose => {
  const account = { service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, accountId: 'selected' };
  expect(() => prepareCodexConnectedAccountKeyRequest({ connectedAccounts: [{ purpose: 'kimi-code-api-key', account }, { purpose, account }],
    launchEnvironment: { values: { KIMI_API_KEY: 'fake-key', KIMI_CODE_BASE_URL: 'https://api.kimi.com/coding/v1' }, unset: [] },
    configuration: { model: { value: 'concrete-model', updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {} },
  })).toThrow(expect.objectContaining({ code: 'codex_connected_account_provider_conflict' }));
});

it('keeps native model/list inventory unverified under the prepared alternate upstream', async () => {
  const credentials: Record<string, string> = { accessToken: 'fake-kimi-key', credentialKind: 'token', apiKind: 'code' };
  const material = await materializeKimiCredentials({ kind: 'environment', keys: ['KIMI_API_KEY', 'KIMI_CODE_BASE_URL'] }, {
    credentials: { get: async (key: string) => credentials[key] ?? null }, signal: new AbortController().signal, invokedAtMs: 0,
    services: { http: { request: vi.fn(async () => { throw new Error('No account login at key delivery'); }) } },
  } as unknown as Parameters<typeof materializeKimiCredentials>[1], 'https://api.kimi.com/coding/v1');
  if (material.kind !== 'environment') throw new Error('Expected key environment');
  const request = prepareCodexConnectedAccountKeyRequest({ connectedAccounts: [{ purpose: 'kimi-code-api-key', account: {
    service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, accountId: 'selected' } }],
    launchEnvironment: { values: material.env, unset: [] },
    configuration: { model: { value: 'kimi-for-coding', updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'default' as const, updatedAtMs: 0 }, options: {} },
  });
  let source: AgentSessionModelsSource | undefined;
  await withCodexNativeAttachFixture(async fixture => {
    const session = await fixture.openConfiguredSession();
    expect.soft(source?.read()).toMatchObject({ catalogConfidence: 'account_unverified' });
    const selectedConfig = JSON.parse(request.launchEnvironment!.values.HAPPIER_CODEX_NATIVE_UPSTREAM_CONFIG!);
    expect.soft(fixture.requests.find(row => row.method === 'thread/start')?.params).toMatchObject({
      modelProvider: selectedConfig.modelProvider, config: selectedConfig.config,
    });
    await session.dispose();
    const resumed = await fixture.openConfiguredSession('fresh-thread');
    expect.soft(fixture.requests.findLast(row => row.method === 'thread/resume')?.params).toMatchObject({
      modelProvider: selectedConfig.modelProvider, config: selectedConfig.config,
    });
    await resumed.dispose();
  }, { processEnv: request.launchEnvironment!.values,
    configuration: request.configuration, sessionConnectedAccounts: request.connectedAccounts,
    models: { bind: value => { source = value; return { dispose() {} }; } },
    modelListResponse: { data: [{ id: 'gpt-stored-native', displayName: 'Stored native catalog' }] },
  });
});

it('marks the Codex ACP catalog unverified under the prepared alternate upstream', () => {
  const request = prepareCodexConnectedAccountKeyRequest({ kind: 'create' as const, sessionId: 'acp-key', cwd: '/workspace',
    connectedAccounts: [{ purpose: 'kimi-code-api-key', account: {
      service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, accountId: 'selected' } }],
    launchEnvironment: { values: { KIMI_API_KEY: 'fake-key', KIMI_CODE_BASE_URL: 'https://api.kimi.com/coding/v1' }, unset: [] },
    configuration: { model: { value: 'kimi-for-coding', updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'default' as const, updatedAtMs: 0 }, options: {} },
  });
  expect(buildCodexNativeAcpRuntimeOptions(request).definition?.models?.catalogConfidence).toBe('account_unverified');
});
