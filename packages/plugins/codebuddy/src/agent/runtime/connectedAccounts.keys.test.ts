import { describe, expect, it } from 'vitest';
import type { ConnectedAccountRuntime, ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type { AgentAcpRuntimeOptions, AgentRuntimeContext, AgentSessionOpenRequest, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcpMcpPolicyFixture } from '@/agent/acp/testkit/mcpToolPolicyHarness';
import { CODEBUDDY_PLUGIN } from '../../manifest.js';
import { openAiConnectedAccountRuntime } from '../../../../openai/src/auth/connectedAccountRuntime.js';
import { createKimiConnectedAccountRuntime } from '../../../../kimi/src/connectedAccounts/runtime.js';
import { createXaiConnectedAccountRuntime } from '../../../../grok/src/connectedAccounts/runtime.js';
import { CODEBUDDY_KEY_ACCOUNTS } from './connectedAccounts.js';
import { CODEBUDDY_ACP_RUNTIME_DECLARATION } from '../acp/runtimeDeclaration.js';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { projectConnectedAccountHostAccessScopes } from '@happier-dev/cli-common/connectedAccounts';
import { createStablePluginConnectedAccountsHost } from '@/plugins/runtime/invocation/services/connectedAccounts';
import { projectConnectedAccountPurposeDeclarationsToHostAccess } from '@/plugins/runtime/hostAccess/resolve';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { projectAgentConnectedAccountLaunchCatalogEntry } from '../../../../../../apps/cli/src/plugins/projection/registry/agentCatalogEntryHooks.js';

describe('CodeBuddy selected native API keys', () => {
  it.each(['session', 'preflight', 'provider'] as const)('launches through manifest-scoped Connected Accounts and the public ACP composer (%s)', async entry => {
    const source = CODEBUDDY_KEY_ACCOUNTS.find(row => row.purpose === 'openai-api-key')!;
    const account = { service: source.service, accountId: 'selected' };
    const materializationContext = { signal: new AbortController().signal, configuration: { values: {} },
      credentials: { async get(key: string) { return key === 'token' ? 'fake-native-openai' : null; } },
    } as Parameters<ConnectedAccountRuntime['materialize']>[1];
    const purposeOwner = createForegroundPurposeOwnerFixture({
      consumer: { pluginId: CODEBUDDY_PLUGIN.manifest.id, localId: 'codebuddy' },
      service: source.service, accountId: account.accountId, purpose: source.purpose,
      materializeAccount: ({ request }) => openAiConnectedAccountRuntime.materialize(request, materializationContext),
    });
    if (entry === 'provider') await purposeOwner.store.update(() => ({ v: 1, bindings: [] }));
    const connectedHost = createStablePluginConnectedAccountsHost(purposeOwner.owner);
    const activation = await createPluginTestkit({ manifest: CODEBUDDY_PLUGIN.manifest, module: CODEBUDDY_PLUGIN });
    const cwd = await mkdtemp(join(tmpdir(), 'codebuddy-account-launch-'));
    let session: AgentSessionRuntime | undefined;
    let fixture: ReturnType<typeof createAcpMcpPolicyFixture> | undefined;
    let disposePreflight: (() => void | Promise<void>) | undefined;
    try {
      const agent = activation.registration('agents', 'codebuddy')!;
      const parsed = parsePluginManifest(CODEBUDDY_PLUGIN.manifest);
      if (!parsed.ok) throw new Error('Invalid authored manifest');
      const declaration = parsed.manifest.contributes.agents.find(row => row.id === 'codebuddy');
      if (!declaration) throw new Error('Missing CodeBuddy Agent');
      const signal = new AbortController().signal;
      const accounts = connectedHost.bind({
        plugin: { id: parsed.manifest.id, version: parsed.manifest.version },
        contribution: { id: declaration.id, qualifiedId: `${parsed.manifest.id}/agents/${declaration.id}` },
        occurrenceId: 'codebuddy-account-occurrence', correlationId: 'codebuddy-account-launch',
        surface: 'agent', session: { id: 'account' }, signal, isOccurrenceCurrent: () => true,
      }, projectConnectedAccountHostAccessScopes(parsed.manifest.id,
        projectConnectedAccountPurposeDeclarationsToHostAccess(declaration.connectedAccounts ?? [])));
      fixture = createAcpMcpPolicyFixture({ agent: declaration, pluginId: CODEBUDDY_PLUGIN.manifest.id, toolWireFormat: 'underscore',
        async factory(context) {
          const native = await agent.factory!(context);
          return { ...native, sessions: { ...native.sessions, open(request, host) {
            if (entry === 'preflight') return (async () => {
              const input = { modelId: 'selected-model', environment: { CODEBUDDY_API_KEY: 'ambient' },
                connectedAccounts: accounts, signal: materializationContext.signal };
              const prepared = await agent.preflightSessionControls!.prepareLaunchEnvironment!(input);
              if (!prepared) throw new Error('Expected prepared native launch');
              disposePreflight = prepared.dispose;
              expect(prepared.catalogConfidence).toBe('account_unverified');
              return host.protocols.acp.open(request, {
                transport: { ...CODEBUDDY_ACP_RUNTIME_DECLARATION.transport,
                  args: [...CODEBUDDY_ACP_RUNTIME_DECLARATION.transport.args, ...(prepared.commandArgsSuffix ?? [])],
                  env: prepared.environment }, definition: CODEBUDDY_ACP_RUNTIME_DECLARATION.definition,
              });
            })();
            // The OS harness replaces the outer launch environment with its isolated HOME.
            // Supply the admitted Provider environment at this native Session boundary.
            const nativeRequest = entry === 'provider' ? { ...request, launchEnvironment: {
              values: { ...request.launchEnvironment?.values, CODEBUDDY_API_KEY: 'fake-provider-bearer' },
              unset: request.launchEnvironment?.unset ?? [],
            } } : request;
            return native.sessions!.open(nativeRequest, { ...host, services: { ...host.services,
              connectedAccounts: accounts } });
          } } };
        },
      });
      await fixture.fixtureServer.prepare({ cwd });
      session = await fixture.openSession({ kind: 'create', sessionId: 'account', cwd,
        ...(entry === 'provider' ? {
          providerBinding: { connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
            model: { id: 'selected-model', name: 'Selected' }, materialization: { v: 1 as const, kind: 'spawnEnv' as const } },
        } : {}), configuration: {
        model: { value: 'selected-model', updatedAtMs: 1, selectionSource: 'explicit' }, mode: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {},
      } });
      const launch = fixture.observeLaunch();
      if (entry === 'provider') {
        expect(launch.env.CODEBUDDY_API_KEY).toBe('fake-provider-bearer');
        expect(launch.argv).not.toContain('--settings');
      } else {
        expect(JSON.parse(launch.env.ACC_PRODUCT_CONFIG_V3!).models).toEqual([expect.objectContaining({
          id: 'selected-model', apiKey: 'fake-native-openai', api: 'openai-completions',
          url: 'https://api.openai.com/v1/chat/completions',
        })]);
        expect(launch.env.CODEBUDDY_API_KEY).toBe('');
        expect(launch.argv.join(' ')).not.toContain('fake-native-openai');
        expect(launch.argv).toContain('selected-model');
      }
    } finally {
      connectedHost.retire();
      try { await session?.dispose(); } finally {
        try { await disposePreflight?.(); await fixture?.fixtureServer.dispose(); } finally { await activation.dispose(); await rm(cwd, { recursive: true, force: true }); }
      }
    }
  });
  it.each([
    { purpose: 'openai-api-key', runtime: openAiConnectedAccountRuntime, credentials: { token: 'fake-openai' }, api: 'openai-completions', url: 'https://api.openai.com/v1/chat/completions', key: 'fake-openai' },
    { purpose: 'kimi-code-api-key', runtime: createKimiConnectedAccountRuntime(), credentials: { accessToken: 'fake-kimi', credentialKind: 'token', apiKind: 'code', apiBase: 'https://api.kimi.com/coding/v1' }, api: 'openai-completions', url: 'https://api.kimi.com/coding/v1/chat/completions', key: 'fake-kimi' },
    { purpose: 'xai-api-key', runtime: createXaiConnectedAccountRuntime(), credentials: { xaiCredential: JSON.stringify({ mode: 'api-key', accessToken: 'fake-xai' }) }, api: 'openai-completions', url: 'https://api.x.ai/v1/chat/completions', key: 'fake-xai' },
  ])('materializes $purpose into the native launch without persisted secrets', async row => {
    const source = CODEBUDDY_KEY_ACCOUNTS.find(source => source.purpose === row.purpose)!;
    const account = { service: source.service, accountId: 'selected' };
    const context = { signal: new AbortController().signal, configuration: { values: {} },
      credentials: { async get(key: string) { return (row.credentials as Record<string, string>)[key] ?? null; } },
    } as Parameters<ConnectedAccountRuntime['materialize']>[1];
    let acquisitions = 0;
    const accounts: Pick<ConnectedAccountsService, 'getBinding' | 'materialize'> = {
      async getBinding(purpose) { return purpose === row.purpose ? { purpose, service: account.service, account, target: { kind: 'account', displayName: 'Selected' } } : null; },
      async materialize(_purpose, request) { acquisitions++; return row.runtime.materialize(request, context); },
    };
    const activation = await createPluginTestkit({ manifest: CODEBUDDY_PLUGIN.manifest, module: CODEBUDDY_PLUGIN });
    let options: AgentAcpRuntimeOptions | undefined;
    const runtimeContext = { services: { connectedAccounts: accounts }, protocols: { acp: {
      async open(_request: AgentSessionOpenRequest, native: AgentAcpRuntimeOptions) { options = native;
        return { async dispose() {}, async send() { return { status: 'admitted' }; }, watch() { return { dispose() {} }; } };
      },
    } } } as unknown as AgentRuntimeContext;
    const registration = activation.registration('agents', 'codebuddy')!;
    projectAgentConnectedAccountLaunchCatalogEntry({ pluginId: CODEBUDDY_PLUGIN.manifest.id, agentId: 'codebuddy',
      connectedAccountLaunch: registration.connectedAccountLaunch!, hostAccess: CODEBUDDY_PLUGIN.manifest.hostAccess,
      isCurrent: () => true });
    const runtime = await registration.factory!({ plugin: { id: CODEBUDDY_PLUGIN.manifest.id, version: '0.0.0' },
      agent: { id: 'codebuddy' }, signal: context.signal });
    const session = await runtime.sessions!.open({ kind: 'create', cwd: '/fixture', configuration: {
      model: { value: 'selected-model', updatedAtMs: 1, selectionSource: 'explicit' }, mode: { value: null, updatedAtMs: 0 },
      permissionIntent: { value: null, updatedAtMs: 0 }, options: {},
    } }, runtimeContext);
    try {
      const env = options!.transport.env!;
      const native = JSON.parse(env.ACC_PRODUCT_CONFIG_V3);
      expect(native.models).toEqual([expect.objectContaining({ id: 'selected-model', api: row.api, url: row.url, apiKey: row.key, supportsToolCall: true })]);
      expect(native.models[0].supportsReasoning).not.toBe(true);
      expect(env.CODEBUDDY_DISABLE_PRODUCT_CACHE).toBe('1');
      expect(env.CODEBUDDY_API_KEY).toBe('');
      expect(env.CODEBUDDY_CUSTOM_HEADERS).not.toContain(row.key);
      expect(options!.transport.args.join(' ')).not.toContain(row.key);
      expect(acquisitions).toBe(1);
    } finally { await session.dispose(); await activation.dispose(); }
  });
});
