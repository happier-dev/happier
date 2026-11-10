import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV } from '@happier-dev/plugin-sdk/connected-accounts';
import { materializeKimiCredentials } from '../../../../kimi/src/connectedAccounts/runtime.js';
import { activate } from '../../activate.js';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { createAcpMcpPolicyFixture } from '@/agent/acp/testkit/mcpToolPolicyHarness';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareKiloConnectedAccount } from './connectedAccounts.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { projectAgentConnectedAccountLaunchCatalogEntry } from '../../../../../../apps/cli/src/plugins/projection/registry/agentCatalogEntryHooks.js';

describe('Kilo native Connected Account keys', () => {
  it('refuses a selected key and an admitted ChatGPT capability during preflight', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const prepare = activation.registration('agents', 'kilo')!.preflightSessionControls!.prepareLaunchEnvironment!;
      await expect(prepare({ modelId: 'kimi-for-coding', environment: {
        KIMI_API_KEY: 'fake-key', KIMI_CODE_BASE_URL: 'https://api.kimi.com/coding/v1',
        [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/private/capability.json',
      }, connectedAccounts: { getBinding: async purpose => purpose === 'kimi-code-api-key' ? { purpose,
        target: { kind: 'account' as const, displayName: 'Selected' }, service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' },
        account: { service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, accountId: 'selected' } } : null,
        materialize: vi.fn(), watch: vi.fn() }, signal: new AbortController().signal })).rejects.toMatchObject({
        code: 'plugin_kilo_subscription_provider_conflict',
      });
    } finally { await activation.dispose(); }
  });
  it('reports the existing restart contract when a selected key overlay changes models', async () => {
    const prepared = await prepareKiloConnectedAccount({ connectedAccounts: [{ purpose: 'kimi-code-api-key', account: {
      service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, accountId: 'selected' } }],
      launchEnvironment: { values: { KIMI_API_KEY: 'fake-key', KIMI_CODE_BASE_URL: 'https://api.kimi.com/coding/v1' }, unset: [] },
      modelId: 'first-model',
    });
    expect(() => prepared.models!.resolveModelUpdate!({ modelId: 'second-model' })).toThrow(expect.objectContaining({
      details: { status: 'requires_restart' },
    }));
  });
  it.each([
    { purpose: 'anthropic-api-key', service: { pluginId: 'happier.agent.claude', localId: 'anthropic' }, key: 'ANTHROPIC_API_KEY', base: 'https://api.anthropic.com/v1', driver: '@ai-sdk/anthropic' },
    { purpose: 'openai-api-key', service: { pluginId: 'happier.voice.openai', localId: 'openai' }, key: 'HAPPIER_CONNECTED_OPENAI_API_KEY', base: 'https://api.openai.com/v1', driver: '@ai-sdk/openai' },
    { purpose: 'gemini-api-key', service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' }, key: 'GEMINI_API_KEY', base: 'https://generativelanguage.googleapis.com/v1beta', driver: '@ai-sdk/google' },
    { purpose: 'xai-api-key', service: { pluginId: 'happier.agent.grok', localId: 'xai' }, key: 'HAPPIER_CONNECTED_XAI_API_KEY', base: 'https://api.x.ai/v1', driver: '@ai-sdk/openai-compatible' },
  ])('uses the selected $purpose native driver', async row => {
    const prepared = await prepareKiloConnectedAccount({
      connectedAccounts: [{ purpose: row.purpose, account: { service: row.service, accountId: 'selected' } }],
      launchEnvironment: { values: { [row.key]: 'fake-selected-key' }, unset: [] },
      modelId: 'concrete-model',
    });
    const config = JSON.parse(prepared.env.KILO_CONFIG_CONTENT!);
    const provider = config.provider[config.enabled_providers[0]];
    expect(provider.npm).toBe(row.driver);
    expect(provider.options.baseURL).toBe(row.base);
    expect(provider.options.apiKey).toBe('{env:HAPPIER_KILO_PROVIDER_API_KEY}');
    expect(prepared.models?.catalogConfidence).toBe('account_unverified');
    expect(prepared.env.HAPPIER_KILO_PROVIDER_API_KEY).toBe('fake-selected-key');
  });

  it('launches the selected Kimi Code key and native model instead of stored OpenAI auth', async () => {
    const credentials: Record<string, string> = { accessToken: 'fake-kimi-key', credentialKind: 'token', apiKind: 'code' };
    const material = await materializeKimiCredentials({ kind: 'environment', keys: ['KIMI_API_KEY', 'KIMI_CODE_BASE_URL'] }, {
      credentials: { get: async (key: string) => credentials[key] ?? null },
      services: { http: { request: vi.fn(async () => { throw new Error('No model/login request at key delivery'); }) } },
      signal: new AbortController().signal, invokedAtMs: 0,
    } as unknown as Parameters<typeof materializeKimiCredentials>[1], 'https://api.kimi.com/coding/v1');
    if (material.kind !== 'environment') throw new Error('Expected native environment');
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const cwd = await mkdtemp(join(tmpdir(), 'happier-kilo-key-'));
    let session: AgentSessionRuntime | undefined;
    let fixture: ReturnType<typeof createAcpMcpPolicyFixture> | undefined;
    try {
      const agent = activation.registration('agents', 'kilo')!;
      projectAgentConnectedAccountLaunchCatalogEntry({ pluginId: PLUGIN_MANIFEST.id, agentId: 'kilo',
        connectedAccountLaunch: agent.connectedAccountLaunch!, hostAccess: PLUGIN_MANIFEST.hostAccess, isCurrent: () => true });
      const prepare = agent.preflightSessionControls!.prepareLaunchEnvironment!;
      const preflight = await prepare({ modelId: 'kimi-for-coding', environment: material.env,
        connectedAccounts: { getBinding: async purpose => purpose === 'kimi-code-api-key' ? { purpose,
          target: { kind: 'account' as const, displayName: 'Selected' }, service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' },
          account: { service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, accountId: 'selected' } } : null,
          materialize: vi.fn(), watch: vi.fn() }, signal: new AbortController().signal });
      const preflightConfig = JSON.parse(preflight.environment.KILO_CONFIG_CONTENT!);
      expect.soft(preflightConfig.model).toBe(`${preflightConfig.enabled_providers[0]}/kimi-for-coding`);
      await preflight.dispose();
      const parsed = parsePluginManifest(PLUGIN_MANIFEST);
      if (!parsed.ok) throw new Error('Invalid authored manifest');
      const declaration = parsed.manifest.contributes.agents?.find(row => row.id === 'kilo');
      if (!declaration) throw new Error('Missing Kilo Agent');
      fixture = createAcpMcpPolicyFixture({ agent: declaration, pluginId: PLUGIN_MANIFEST.id, toolWireFormat: 'underscore',
        async factory(context) {
          const native = await agent.factory!(context);
          return { ...native, sessions: { ...native.sessions,
            open(request, host) {
              return native.sessions.open({ ...request, launchEnvironment: {
                values: { ...request.launchEnvironment?.values, ...material.env, OPENAI_API_KEY: 'ambient',
                  KILO_AUTH_CONTENT: '{"openai":{"type":"api","key":"stored"}}' },
                unset: request.launchEnvironment?.unset ?? [],
              } }, host);
            },
          } };
        },
      });
      await fixture.fixtureServer.prepare({ cwd });
      session = await fixture.openSession({ kind: 'create', sessionId: 'key', cwd,
        connectedAccounts: [{ purpose: 'kimi-code-api-key', account: { service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, accountId: 'selected' } }],
        configuration: { model: { value: 'kimi-for-coding', updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {} },
      });
      const launch = fixture.observeLaunch();
      const config = JSON.parse(launch.env.KILO_CONFIG_CONTENT!);
      const provider = config.provider[config.enabled_providers[0]];
      expect(provider.options.baseURL).toBe('https://api.kimi.com/coding/v1');
      expect(provider.npm).toBe('@ai-sdk/openai-compatible');
      expect(config.model).toBe(`${config.enabled_providers[0]}/kimi-for-coding`);
      expect(launch.env.HAPPIER_KILO_PROVIDER_API_KEY).toBe('fake-kimi-key');
      expect(launch.env.KILO_AUTH_CONTENT).toBe('{}');
      expect(launch.env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      try { await session?.dispose(); } finally {
        try { await fixture?.fixtureServer.dispose(); } finally {
          await activation.dispose(); await rm(cwd, { recursive: true, force: true });
        }
      }
    }
  });
});
