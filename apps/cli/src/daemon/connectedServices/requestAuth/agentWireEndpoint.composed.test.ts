import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';

import { createPublicAcpSession, createPublicAcpExecutionRun, type PublicAcpComposerDependencies } from '@/agent/acp/runtime/publicSession/createPublicAcpSession';
import { createAcpSessionRuntimeContextFixture } from '@/agent/acp/testkit/runtimeContextFixture';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { createStablePluginConnectedAccountsHost } from '@/plugins/runtime/invocation/services/connectedAccounts';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { withTempDir } from '@/testkit/fs/tempDir';
import { openAiCodexConnectedAccountRuntime } from '../../../../../../packages/plugins/codex/src/connectedAccounts/openAiCodexRuntime';

const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const scenarios = [
  { id: 'copilot', load: async () => (await import('@happier-dev/plugins-copilot/manifest')).COPILOT_PLUGIN },
  { id: 'droid', load: async () => (await import('@happier-dev/plugins-droid/manifest')).DROID_PLUGIN },
  { id: 'codebuddy', load: async () => (await import('@happier-dev/plugins-codebuddy/manifest')).CODEBUDDY_PLUGIN },
] as const;

for (const scenario of scenarios) {
  it(`${scenario.id} carries the real account header decoder through its writer and ACP child on create and restart/resume`, async () => {
    await withTempDir(`happier-account-wire-${scenario.id}-`, async dir => {
      const plugin = await scenario.load();
      const parsed = parsePluginManifest(plugin.manifest);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
      const agent = parsed.manifest.contributes.agents?.find(row => row.id === scenario.id);
      const declaration = agent?.connectedAccounts?.find(row => typeof row.service !== 'string' && row.service.pluginId === service.pluginId && row.service.localId === service.localId);
      if (!agent || !declaration) throw new Error('The executable Agent must declare its optional ChatGPT Account route');
      const host = await createPluginTestkit({ manifest: parsed.manifest, module: { activate: plugin.activate } });
      const factory = host.registration('agents', scenario.id)?.factory;
      if (!factory) throw new Error('The Account route requires the registered executable factory');
      const account = { service, accountId: 'selected-chatgpt-account' };
      const signal = new AbortController().signal;
      const unavailable = createUnavailablePluginServices();
      let accessToken = 'fixture-access-before-restart';
      const reads: string[] = [];
      // Only persistence and OS execution are replaced. The qualified purpose
      // owner, SDK service admission, real Codex decoder and Agent writer run.
      const fixture = createForegroundPurposeOwnerFixture({
        consumer: { pluginId: parsed.manifest.id, localId: scenario.id }, service,
        accountId: account.accountId, purpose: declaration.purpose,
        materializeAccount: ({ request }) => openAiCodexConnectedAccountRuntime.materialize(request, {
          plugin: { id: service.pluginId, version: '0.0.0' },
          contribution: { id: service.localId, qualifiedId: `${service.pluginId}/${service.localId}` },
          surface: 'agent', invokedAtMs: Date.now(), signal, services: unavailable, account,
          configuration: { target: { kind: 'account', account, modeId: 'oauth' }, revision: 'fixture-config', values: {}, async getSecret() { return null; } },
          credentials: { async get(key) {
            reads.push(key);
            return key === 'accessToken' ? accessToken : key === 'providerAccountId' ? 'fixture-provider-account'
              : key === 'refreshToken' ? 'host-only-refresh-must-never-leave' : null;
          } },
        }),
      });
      const accountHost = createStablePluginConnectedAccountsHost(fixture.owner);
      const connectedAccounts = accountHost.bind({
        plugin: { id: parsed.manifest.id, version: parsed.manifest.version },
        contribution: { id: scenario.id, qualifiedId: `${parsed.manifest.id}/agents/${scenario.id}` },
        occurrenceId: 'wire-fixture', correlationId: 'wire-fixture', surface: 'agent',
        signal, retirementSignal: signal, isOccurrenceCurrent: () => true,
      }, [{ purpose: declaration.purpose, serviceRefs: [service], operations: ['use'], materializationKinds: ['httpHeaders'] }]);
      try {
        for (const kind of ['create', 'resume'] as const) {
          if (kind === 'resume') accessToken = 'fixture-access-after-restart';
          const capture = join(dir, `${kind}.json`);
          const script = writeAcpTestAgentScript({ dir, fileName: `${kind}.mjs`, source: `
            import { createInterface } from 'node:readline';
            import { readFileSync, writeFileSync } from 'node:fs';
            const agent = ${JSON.stringify(scenario.id)};
            const settingsIndex = process.argv.indexOf('--settings');
            const settings = settingsIndex < 0 ? null : JSON.parse(readFileSync(process.argv[settingsIndex + 1], 'utf8'));
            const configured = agent === 'copilot' ? JSON.parse(readFileSync(process.env.COPILOT_PROVIDERS_CONFIG, 'utf8'))
              : agent === 'codebuddy' ? JSON.parse(process.env.ACC_PRODUCT_CONFIG_V3) : settings;
            const ownedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('HAPPIER_DROID_') || key.startsWith('HAPPIER_CODEBUDDY_') || key.startsWith('CODEBUDDY_') || key.startsWith('COPILOT_PROVIDER_')));
            const model = agent === 'copilot' ? process.env.COPILOT_MODEL : agent === 'droid' ? 'custom:fixture-native-model' : 'gpt-5.3-codex';
            const configOptions = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
              options: [{ value: model, name: settings?.customModels?.[0]?.displayName ?? 'Selected model' },
                { value: 'native-ineligible-model', name: 'Unrelated native model' }] }];
            const requests = [];
            for await (const line of createInterface({ input: process.stdin })) {
              const request = JSON.parse(line); if (request.id === undefined) continue;
              requests.push(request.method);
              writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ configured, ownedEnv, requests }));
              const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
                : request.method === 'session/new' || request.method === 'session/load' ? { sessionId: 'native-session', configOptions }
                : request.method === 'session/set_config_option' ? { configOptions } : {};
              process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
            }
          ` });
          const publications = createNativeAgentSessionPublications({ agentId: scenario.id, session: null, signal, isCurrent: () => true, supportsInFlightSteer: false });
          const dependencies: PublicAcpComposerDependencies = {
            pluginId: parsed.manifest.id, agentId: scenario.id, signal, isCurrent: () => true,
            systemTools: { resolve: async () => ({ toolId: `${scenario.id}-cli`, launch: { kind: 'binary', executablePath: process.execPath, args: [script] } }) },
            interactions: { async request() { throw new Error('Unexpected interaction'); } },
            media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
            models: publications.services.models, modes: publications.services.modes,
          };
          const context = createAcpSessionRuntimeContextFixture({
            agent, pluginId: parsed.manifest.id, publications, sessionId: 'session', directory: dir, signal,
            services: { ...unavailable, connectedAccounts, exec: { ...unavailable.exec, run: async () => ({
              termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
              stdout: new TextEncoder().encode('--acp'), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
            }) } },
            protocols: { acp: {
              open: (request, options) => createPublicAcpSession(request, options, dependencies),
              openExecutionRunV1: (request, options) => createPublicAcpExecutionRun(request, options, dependencies),
            } },
          });
          let session: AgentSessionRuntime | undefined;
          try {
            const runtime = await factory({ plugin: { id: parsed.manifest.id, version: parsed.manifest.version }, agent: { id: scenario.id }, signal });
            if (!runtime.sessions) throw new Error('Expected executable Sessions');
            const common = { sessionId: 'session', cwd: dir, launchEnvironment: { values: { HOME: dir }, unset: [] },
              configuration: { model: { value: 'gpt-5.3-codex', updatedAtMs: 1, selectionSource: 'explicit' as const }, mode: { value: null, updatedAtMs: 1 },
                permissionIntent: { value: 'default' as const, updatedAtMs: 1 }, options: {} } };
            session = await runtime.sessions.open(kind === 'create' ? { ...common, kind } : { ...common, kind, providerSessionId: 'native-session' }, context.context);
            expect(publications.modelsSource.read().models.map(model => model.id)).toEqual(['gpt-5.3-codex']);
            const captured: { configured: unknown; ownedEnv: Record<string, string>; requests: string[] } = JSON.parse(readFileSync(capture, 'utf8'));
            const serialized = JSON.stringify({ configured: captured.configured, env: captured.ownedEnv });
            expect(serialized).toContain(accessToken);
            expect(serialized).toContain('fixture-provider-account');
            expect(serialized).toContain('https://chatgpt.com/backend-api/codex');
            expect(serialized).not.toContain('host-only-refresh-must-never-leave');
            if (kind === 'resume') expect(serialized).not.toContain('fixture-access-before-restart');
            expect(captured.requests).toContain(kind === 'create' ? 'session/new' : 'session/load');
          } finally {
            await session?.dispose();
            await context.dispose();
            publications.dispose();
          }
        }
        expect(reads).not.toContain('refreshToken');
      } finally {
        accountHost.retire();
        await host.dispose();
      }
    });
  });
}
