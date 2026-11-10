import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { createAcpMcpPolicyFixture } from '@/agent/acp/testkit/mcpToolPolicyHarness';
import { projectAgentConnectedAccountLaunchCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import { activate } from '../../activate.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { AgentAcpRuntimeOptions, AgentSessionOpenRequest, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ConnectedAccountRuntime, ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import { createKimiConnectedAccountRuntime } from '../../../../kimi/src/connectedAccounts/runtime.js';
import { createXaiConnectedAccountRuntime } from '../../../../grok/src/connectedAccounts/runtime.js';
import { anthropicConnectedAccountRuntime } from '../../../../claude/src/connectedAccounts/anthropicRuntime.js';
import { openAiConnectedAccountRuntime } from '../../../../openai/src/auth/connectedAccountRuntime.js';
import { createCopilotAgentRuntime } from './factory.js';
import { COPILOT_PLUGIN } from '../../manifest.js';

const configuration = { mode: { value: null, updatedAtMs: 1 }, model: { value: 'selected-model', updatedAtMs: 1 }, permissionIntent: { value: 'default' as const, updatedAtMs: 1 }, options: {} };
const rows = [
  { purpose: 'kimi-api-key', service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, runtime: createKimiConnectedAccountRuntime(), credentials: { accessToken: 'fake-kimi-key', credentialKind: 'token', apiKind: 'code', apiBase: 'https://api.kimi.ai/coding/v1' }, key: 'fake-kimi-key', base: 'https://api.kimi.ai/coding/v1', provider: 'openai' },
  { purpose: 'xai-api-key', service: { pluginId: 'happier.agent.grok', localId: 'xai' }, runtime: createXaiConnectedAccountRuntime(), credentials: { xaiCredential: JSON.stringify({ mode: 'api-key', accessToken: 'fake-xai-key' }) }, key: 'fake-xai-key', base: 'https://api.x.ai/v1', provider: 'openai' },
  { purpose: 'anthropic-api-key', service: { pluginId: 'happier.agent.claude', localId: 'anthropic' }, runtime: anthropicConnectedAccountRuntime, credentials: { token: 'fake-anthropic-key' }, key: 'fake-anthropic-key', base: 'https://api.anthropic.com', provider: 'anthropic' },
  { purpose: 'openai-api-key', service: { pluginId: 'happier.voice.openai', localId: 'openai' }, runtime: openAiConnectedAccountRuntime, credentials: { token: 'fake-openai-key' }, key: 'fake-openai-key', base: 'https://api.openai.com/v1', provider: 'openai' },
];

describe('Copilot selected native key launch', () => {
  it('delivers the selected Kimi key and model through the public composer to a real child', async () => {
    const row = rows[0]!;
    const account = { service: row.service, accountId: 'selected' };
    const materializationContext = { account, signal: new AbortController().signal, invokedAtMs: 0, services: {},
      configuration: { target: { kind: 'account', account, modeId: 'api-key' }, revision: 'r', values: {}, async getSecret() { return null; } },
      credentials: { async get(key: string) { return row.credentials[key as keyof typeof row.credentials] ?? null; } },
    } as Parameters<ConnectedAccountRuntime['materialize']>[1];
    const activation = await createPluginTestkit({ manifest: COPILOT_PLUGIN.manifest, module: { activate } });
    const cwd = await mkdtemp(join(tmpdir(), 'happier-copilot-composed-key-'));
    let fixture: ReturnType<typeof createAcpMcpPolicyFixture> | undefined;
    let session: AgentSessionRuntime | undefined;
    try {
      const registration = activation.registration('agents', 'copilot')!;
      projectAgentConnectedAccountLaunchCatalogEntry({ pluginId: COPILOT_PLUGIN.manifest.id, agentId: 'copilot',
        connectedAccountLaunch: registration.connectedAccountLaunch!, hostAccess: COPILOT_PLUGIN.manifest.hostAccess, isCurrent: () => true });
      const parsed = parsePluginManifest(COPILOT_PLUGIN.manifest);
      if (!parsed.ok) throw new Error('Invalid authored manifest');
      const declaration = parsed.manifest.contributes.agents?.find(agent => agent.id === 'copilot');
      if (!declaration) throw new Error('Missing Agent declaration');
      fixture = createAcpMcpPolicyFixture({ agent: declaration, pluginId: COPILOT_PLUGIN.manifest.id, toolWireFormat: 'underscore',
        async factory(context) {
          const native = await registration.factory!(context);
          if (!native.sessions) throw new Error('Missing Agent Session factory');
          const sessions = native.sessions;
          return { ...native, sessions: { ...sessions, open(request, host) {
            // Fake credential persistence is the system boundary; producer decoding, native
            // serialization, public ACP composition and the child process all stay real.
            return sessions.open({ ...request, launchEnvironment: {
              values: { ...request.launchEnvironment?.values, FACTORY_API_KEY: 'ambient',
                COPILOT_GITHUB_TOKEN: 'ambient', COPILOT_PROVIDERS_CONFIG: '/ambient/providers.json' },
              unset: request.launchEnvironment?.unset ?? [],
            } }, { ...host, services: { ...host.services, connectedAccounts: { ...host.services.connectedAccounts,
              materialize: (_purpose, request, options) => row.runtime.materialize(request, materializationContext, options),
            } } });
          } } };
        },
      });
      await fixture.fixtureServer.prepare({ cwd });
      session = await fixture.openSession({ kind: 'create', sessionId: 'selected-key', cwd,
        connectedAccounts: [{ purpose: row.purpose, account }], configuration });
      const launch = fixture.observeLaunch();
      expect(launch.env).toMatchObject({ COPILOT_PROVIDER_TYPE: row.provider, COPILOT_PROVIDER_BASE_URL: row.base,
        COPILOT_MODEL: 'selected-model', COPILOT_PROVIDER_BEARER_TOKEN: row.key });
      expect(launch.env.COPILOT_GITHUB_TOKEN).toBeUndefined();
      expect(launch.env.COPILOT_PROVIDERS_CONFIG).toBeUndefined();
    } finally {
      try { await session?.dispose(); } finally {
        try { await fixture?.fixtureServer.dispose(); } finally {
          await activation.dispose(); await rm(cwd, { recursive: true, force: true });
        }
      }
    }
  });

  it.each(rows)('uses $purpose instead of ambient auth for a Session', async row => {
    const signal = new AbortController().signal;
    const account = { service: row.service, accountId: 'selected' };
    // Credential persistence and the host service are the boundary; producer decoding remains real.
    const materializationContext = { account, signal, invokedAtMs: Date.now(), services: {},
      configuration: { target: { kind: 'account', account, modeId: 'api-key' }, revision: 'r', values: {}, async getSecret() { return null; } },
      credentials: { async get(key: string) { return row.credentials[key as keyof typeof row.credentials] ?? null; } },
    } as Parameters<ConnectedAccountRuntime['materialize']>[1];
    const materialize = vi.fn<ConnectedAccountsService['materialize']>(async (_purpose, request, options) => row.runtime.materialize(request, materializationContext, options));
    const connectedAccounts = { getBinding: async (purpose: string) => purpose === row.purpose ? { purpose, service: row.service, account, target: { kind: 'account' as const } } : null, materialize };
    const open = vi.fn(async (_request: AgentSessionOpenRequest, _options: AgentAcpRuntimeOptions) => ({ dispose() {} }) as never);
    const runtime = await createCopilotAgentRuntime({ plugin: { id: 'happier.agent.copilot', version: '0.0.0' }, agent: { id: 'copilot' }, signal });
    const context = { signal, services: { connectedAccounts }, protocols: { acp: { open } } } as unknown as AgentSessionRuntimeContext;
    const request = { cwd: '/workspace', configuration,
      launchEnvironment: { values: { AMBIENT: 'retained', FACTORY_API_KEY: 'ambient', COPILOT_GITHUB_TOKEN: 'ambient', COPILOT_PROVIDERS_CONFIG: '/ambient/config', COPILOT_PROVIDER_BEARER_TOKEN: 'ambient' }, unset: [] } };
    const opened = await runtime.sessions!.open({ ...request, kind: 'resume', providerSessionId: 'native-session', sessionId: 'session' }, context);
    try {
      expect(materialize).toHaveBeenCalledTimes(1);
      const [request, options] = open.mock.calls[0]!;
      expect(options.definition?.models?.catalogConfidence).toBe('account_unverified');
      expect(request.launchEnvironment?.values).toMatchObject({ COPILOT_PROVIDER_BASE_URL: row.base, COPILOT_PROVIDER_TYPE: row.provider, COPILOT_MODEL: 'selected-model' });
      expect(request.launchEnvironment?.values[row.provider === 'anthropic' ? 'COPILOT_PROVIDER_API_KEY' : 'COPILOT_PROVIDER_BEARER_TOKEN']).toBe(row.key);
      expect(request.launchEnvironment?.values.COPILOT_GITHUB_TOKEN).toBeUndefined();
      expect(request.launchEnvironment?.values.COPILOT_PROVIDERS_CONFIG).toBeUndefined();
    } finally { await opened.dispose(); }
  });
});
