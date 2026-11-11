import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { createAcpMcpPolicyFixture } from '@/agent/acp/testkit/mcpToolPolicyHarness';
import { projectAgentConnectedAccountLaunchCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import { activate } from '../../activate.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { AgentAcpRuntimeOptions, AgentSessionOpenRequest, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ConnectedAccountRuntime, ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import { createKimiConnectedAccountRuntime } from '../../../../kimi/src/connectedAccounts/runtime.js';
import { createXaiConnectedAccountRuntime } from '../../../../grok/src/connectedAccounts/runtime.js';
import { anthropicConnectedAccountRuntime } from '../../../../claude/src/connectedAccounts/anthropicRuntime.js';
import { openAiConnectedAccountRuntime } from '../../../../openai/src/auth/connectedAccountRuntime.js';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import { DROID_PLUGIN } from '../../manifest.js';
import { DROID_PROVIDER_SECRET_ENV } from '../providerBinding/settings.js';
import { createDroidAgentRuntime } from './factory.js';

const configuration = { mode: { value: null, updatedAtMs: 1 }, model: { value: 'selected-model', updatedAtMs: 1 }, permissionIntent: { value: 'default' as const, updatedAtMs: 1 }, options: {} };
const rows = [
  { purpose: 'kimi-api-key', service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, runtime: createKimiConnectedAccountRuntime(), credentials: { accessToken: 'fake-kimi-key', credentialKind: 'token', apiKind: 'code', apiBase: 'https://api.kimi.ai/coding/v1' }, key: 'fake-kimi-key', base: 'https://api.kimi.ai/coding/v1', provider: 'generic-chat-completion-api' },
  { purpose: 'xai-api-key', service: { pluginId: 'happier.agent.grok', localId: 'xai' }, runtime: createXaiConnectedAccountRuntime(), credentials: { xaiCredential: JSON.stringify({ mode: 'api-key', accessToken: 'fake-xai-key' }) }, key: 'fake-xai-key', base: 'https://api.x.ai/v1', provider: 'generic-chat-completion-api' },
  { purpose: 'anthropic-api-key', service: { pluginId: 'happier.agent.claude', localId: 'anthropic' }, runtime: anthropicConnectedAccountRuntime, credentials: { token: 'fake-anthropic-key' }, key: 'fake-anthropic-key', base: 'https://api.anthropic.com', provider: 'anthropic' },
  { purpose: 'openai-api-key', service: { pluginId: 'happier.voice.openai', localId: 'openai' }, runtime: openAiConnectedAccountRuntime, credentials: { token: 'fake-openai-key' }, key: 'fake-openai-key', base: 'https://api.openai.com/v1', provider: 'generic-chat-completion-api' },
];

describe('Droid selected native key launch', () => {
  it('preserves Factory authentication while delivering the selected Kimi key and model through the public composer to a real child', async () => {
    const row = rows[0]!;
    const account = { service: row.service, accountId: 'selected' };
    const materializationContext = { account, signal: new AbortController().signal, invokedAtMs: 0, services: {},
      configuration: { target: { kind: 'account', account, modeId: 'api-key' }, revision: 'r', values: {}, async getSecret() { return null; } },
      credentials: { async get(key: string) { return row.credentials[key as keyof typeof row.credentials] ?? null; } },
    } as Parameters<ConnectedAccountRuntime['materialize']>[1];
    const activation = await createPluginTestkit({ manifest: DROID_PLUGIN.manifest, module: { activate } });
    const cwd = await mkdtemp(join(tmpdir(), 'happier-droid-composed-key-'));
    let fixture: ReturnType<typeof createAcpMcpPolicyFixture> | undefined;
    let session: AgentSessionRuntime | undefined;
    try {
      const registration = activation.registration('agents', 'droid')!;
      projectAgentConnectedAccountLaunchCatalogEntry({ pluginId: DROID_PLUGIN.manifest.id, agentId: 'droid',
        connectedAccountLaunch: registration.connectedAccountLaunch!, hostAccess: DROID_PLUGIN.manifest.hostAccess, isCurrent: () => true });
      const parsed = parsePluginManifest(DROID_PLUGIN.manifest);
      if (!parsed.ok) throw new Error('Invalid authored manifest');
      const declaration = parsed.manifest.contributes.agents?.find(agent => agent.id === 'droid');
      if (!declaration) throw new Error('Missing Agent declaration');
      fixture = createAcpMcpPolicyFixture({ agent: declaration, pluginId: DROID_PLUGIN.manifest.id, toolWireFormat: 'underscore',
        models: { currentModelId: 'custom:Happier-provider-selected-model-0',
          availableModels: [{ modelId: 'custom:Happier-provider-selected-model-0', name: 'Happier provider: selected-model' }] },
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
      expect(launch.env.HAPPIER_DROID_PROVIDER_API_KEY).toBe(row.key);
      expect(launch.env.FACTORY_API_KEY).toBe('ambient');
      const settingsIndex = launch.argv.indexOf('--settings');
      expect(settingsIndex).toBeGreaterThanOrEqual(0);
      const settings = await readFile(launch.argv[settingsIndex + 1]!, 'utf8');
      expect(JSON.parse(settings).customModels[0]).toMatchObject({ model: 'selected-model', baseUrl: row.base, provider: row.provider });
      expect(settings).not.toContain(row.key);
    } finally {
      try { await session?.dispose(); } finally {
        try { await fixture?.fixtureServer.dispose(); } finally {
          await activation.dispose(); await rm(cwd, { recursive: true, force: true });
        }
      }
    }
  });

  it('admits the emitted credential environment through the production process scope', async () => {
    // Executable resolution is the OS boundary; host scope authorization and spawning stay real.
    const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, exec: {
      resolveExecutable: async () => ({ command: process.execPath }),
      resolvePath: async () => { throw new Error('Operation owns its workspace'); },
    } });
    const services = owners.createOperationServices({ plugin: { id: DROID_PLUGIN.manifest.id, version: DROID_PLUGIN.manifest.version },
      contribution: { id: 'droid', qualifiedId: 'happier.agent.droid/agents/droid' }, occurrenceId: 'fixture',
      correlationId: 'native-key-environment', surface: 'agent', signal: new AbortController().signal, isOccurrenceCurrent: () => true,
    }, { filesystemRoots: { pluginData: process.cwd(), workspace: process.cwd(), projects: new Map() },
      hostAccessRequests: DROID_PLUGIN.manifest.hostAccess.required.map(request => ({ required: true, request })),
    });
    const result = await services.exec.run({ executable: { kind: 'systemTool', id: 'droid-cli' },
      args: ['-e', 'process.stdout.write(process.env.HAPPIER_DROID_PROVIDER_API_KEY === "fake-selected" ? "selected" : "missing")'],
      cwd: { root: 'workspace', relativePath: '' }, env: { [DROID_PROVIDER_SECRET_ENV]: 'fake-selected' },
    });
    expect(new TextDecoder().decode(result.stdout)).toBe('selected');
  });

  it.each(rows)('uses $purpose for inference while retaining Factory authentication for a Session', async row => {
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
    const runtime = await createDroidAgentRuntime({ plugin: { id: 'happier.agent.droid', version: '0.0.0' }, agent: { id: 'droid' }, signal });
    const context = { signal, services: { connectedAccounts }, protocols: { acp: { open } } } as unknown as AgentSessionRuntimeContext;
    const request = { cwd: '/workspace', configuration,
      launchEnvironment: { values: { AMBIENT: 'retained', FACTORY_API_KEY: 'ambient', COPILOT_GITHUB_TOKEN: 'ambient', COPILOT_PROVIDERS_CONFIG: '/ambient/config', COPILOT_PROVIDER_BEARER_TOKEN: 'ambient' }, unset: [] } };
    const opened = await runtime.sessions!.open({ ...request, kind: 'resume', providerSessionId: 'native-session', sessionId: 'session' }, context);
    try {
      expect(materialize).toHaveBeenCalledTimes(1);
      const [request, options] = open.mock.calls[0]!;
      expect(request.launchEnvironment?.values.HAPPIER_DROID_PROVIDER_API_KEY).toBe(row.key);
      expect(request.launchEnvironment?.values.FACTORY_API_KEY).toBe('ambient');
      if (options.transport.kind !== 'stdio') throw new Error('Expected stdio');
      expect(options.definition?.models?.catalogConfidence).toBe('account_unverified');
      const settings = await readFile(options.transport.args!.at(-1)!, 'utf8');
      expect(settings).not.toContain(row.key);
      expect(JSON.parse(settings).customModels[0]).toMatchObject({ baseUrl: row.base, provider: row.provider, model: 'selected-model' });
    } finally { await opened.dispose(); }
  });
});
