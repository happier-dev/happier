import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { AgentProviderBindingMaterializeInput, AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionModelsSnapshot } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionProviderBindingV1Schema, resolveProviderBindingCompatibilityWithFingerprintV1 } from '@happier-dev/protocol';

import { createPublicAcpSession, createPublicAcpExecutionRun, type PublicAcpComposerDependencies } from '@/agent/acp/runtime/publicSession/createPublicAcpSession';
import { createAcpSessionRuntimeContextFixture } from '@/agent/acp/testkit/runtimeContextFixture';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { composeProviderBindingMaterialization } from '@/providers/spawn/compose';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { materializeCapturedAgentProviderBinding } from './adapter';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { createStablePluginConnectedAccountsHost } from '@/plugins/runtime/invocation/services/connectedAccounts';

const cases = [
  { agentId: 'copilot', load: async () => (await import('@happier-dev/plugins-copilot/manifest')).COPILOT_PLUGIN,
    protocol: 'openai-chat', key: 'COPILOT_PROVIDER_BEARER_TOKEN', model: 'exact/native-model', settings: ['.copilot', 'config.json'] },
  { agentId: 'gemini', load: async () => (await import('@happier-dev/plugins-gemini/manifest')).GEMINI_PLUGIN,
    protocol: 'gemini', key: 'GEMINI_API_KEY', model: 'exact/native-model', settings: ['.gemini', 'settings.json'] },
  { agentId: 'kilo', load: async () => (await import('@happier-dev/plugins-kilo/manifest')).KILO_PLUGIN,
    protocol: 'anthropic', key: 'HAPPIER_KILO_PROVIDER_API_KEY', model: 'exact/native-model', settings: ['.config', 'kilo', 'kilo.json'] },
  { agentId: 'droid', load: async () => (await import('@happier-dev/plugins-droid/manifest')).DROID_PLUGIN,
    protocol: 'openai-chat', key: 'HAPPIER_DROID_PROVIDER_API_KEY', model: 'exact/native-model', settings: ['.factory', 'settings.json'] },
] as const;

for (const scenario of cases) {
  it.each(['create', 'resume'] as const)(`${scenario.agentId} applies its activated Provider binding to a %s ACP process`, async kind => {
    await withTempDir(`happier-provider-${scenario.agentId}-`, async dir => {
      const plugin = await scenario.load();
      const parsed = parsePluginManifest(plugin.manifest);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
      const agent = parsed.manifest.contributes.agents?.find(row => row.id === scenario.agentId);
      if (!agent?.providerRequirements) throw new Error('Expected the admitted Agent Provider requirements');
      const support = agent.providerRequirements;
      const host = await createPluginTestkit({ manifest: parsed.manifest, module: { activate: plugin.activate } });
      const nativeHome = join(dir, 'native-home');
      await mkdir(nativeHome);
      const sharedConfig = join(nativeHome, ...scenario.settings);
      await mkdir(join(nativeHome, ...scenario.settings.slice(0, -1)), { recursive: true });
      const retained = JSON.stringify({ retained: 'native-user-setting', ...(scenario.agentId === 'gemini'
        ? { security: { auth: { selectedType: 'oauth-personal' } } } : {}) });
      await writeFile(sharedConfig, retained);
      const capture = join(dir, 'launch.json');
      const transcript = join(dir, 'requests.json');
      const script = writeAcpTestAgentScript({ dir, fileName: 'agent.mjs', source: `
        import { createInterface } from 'node:readline';
        import { readFileSync, writeFileSync } from 'node:fs';
        const keys = ${JSON.stringify([...support.authIsolation.ownedEnvKeys, 'GEMINI_CLI_HOME', 'GEMINI_CLI_SYSTEM_SETTINGS_PATH'])};
        writeFileSync(process.env.CAPTURE, JSON.stringify({ env: Object.fromEntries(keys.map(key => [key, process.env[key] ?? null])), argv: process.argv.slice(2) }));
        const settingsIndex = process.argv.indexOf('--settings');
        const droidModel = settingsIndex < 0 ? null : JSON.parse(readFileSync(process.argv[settingsIndex + 1], 'utf8')).customModels[0];
        const nativeModel = droidModel ? 'custom:opaque-advertised-id' : process.env.KILO_CONFIG_CONTENT ? JSON.parse(process.env.KILO_CONFIG_CONTENT).model : ${JSON.stringify(scenario.model)};
        const modelSelector = value => ({ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: value,
          options: [{ value: nativeModel, name: droidModel?.displayName ?? 'Selected model' }] });
        const gemini = ${JSON.stringify(scenario.agentId === 'gemini')};
        const requests = [];
        for await (const line of createInterface({ input: process.stdin })) {
          const r = JSON.parse(line); if (r.id === undefined) continue;
          requests.push({ method: r.method, params: r.params });
          writeFileSync(process.env.TRANSCRIPT, JSON.stringify(requests));
          // Gemini's native ACP dispatcher implements session/set_model, not
          // session/set_config_option (google-gemini/gemini-cli acpRpcDispatcher.ts).
          if (gemini && r.method === 'session/set_config_option') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'Method not found' } }) + '\\n');
            continue;
          }
          const result = r.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
            : r.method === 'session/new' || r.method === 'session/load' ? { sessionId: 'native-session', ...(gemini
              // Native buildAvailableModels reports the configured current id
              // separately from its built-in catalog; it does not add custom ids.
              ? { models: { currentModelId: nativeModel, availableModels: [{ modelId: 'auto', name: 'Auto' }] } }
              : { configOptions: [modelSelector(nativeModel)] }) }
            : r.method === 'session/set_config_option' ? { configOptions: [modelSelector(nativeModel)] }
            : r.method === 'session/prompt' ? { stopReason: 'end_turn' } : {};
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }) + '\\n');
        }
      ` });
      let cleanup: (() => void) | null = null;
      let contextFixture: ReturnType<typeof createAcpSessionRuntimeContextFixture> | undefined;
      let session: AgentSessionRuntime | undefined;
      let publications: ReturnType<typeof createNativeAgentSessionPublications> | undefined;
      let observedSubscription: Readonly<{ dispose(): void }> | undefined;
      let accountHost: ReturnType<typeof createStablePluginConnectedAccountsHost> | undefined;
      try {
        const registration = host.registration('agents', scenario.agentId);
        const adapter = registration?.providerBinding;
        const factory = registration?.factory;
        if (!adapter || !factory) throw new Error('Expected the activated Provider adapter and native factory');
        const protocol = scenario.protocol;
        const transport = { id: 'selected-key', protocols: [protocol], uses: ['runtime'] as const,
          destination: { kind: 'httpHeader' as const,
            name: protocol === 'gemini' ? 'x-goog-api-key' : protocol === 'anthropic' ? 'x-api-key' : 'authorization',
            format: protocol === 'gemini' || protocol === 'anthropic' ? 'raw' as const : 'bearer' as const } };
        const binding: AgentProviderBindingMaterializeInput['binding'] = {
          v: 1, agentTargetKey: `agent:${parsed.manifest.id}/${scenario.agentId}`,
          selection: { connectionId: 'pc_composed', model: { id: scenario.model, name: 'Selected model' } }, contributionKey: null,
          endpoint: { endpointTemplateId: 'custom', normalizedUrl: 'https://provider.example/v1', protocol, publicHeaders: {} },
          runtimeCredentialTransport: transport, compatibilityFingerprint: 'pcf1:composed',
        };
        const secret = `selected-${scenario.agentId}-test-secret`;
        const materialization = await materializeCapturedAgentProviderBinding({
          resolved: { pluginId: parsed.manifest.id, adapter, support, isCurrent: () => true }, binding,
          prepared: adapter.prepare({ v: 1, agentTargetKey: binding.agentTargetKey, connectionId: 'pc_composed', model: binding.selection.model }),
          credential: { kind: 'apiKey', value: secret, transport },
        });
        const composed = await composeProviderBindingMaterialization({ materialization, materializationBaseDir: join(dir, 'providers') });
        cleanup = composed.cleanup;
        expect(JSON.stringify(composed.launchMaterialization)).not.toContain(secret);
        if (materialization.kind === 'configFile') {
          expect(JSON.stringify(materialization.files)).not.toContain(secret);
        }
        const values: Record<string, string> = { HOME: nativeHome, GEMINI_CLI_HOME: nativeHome, XDG_CONFIG_HOME: join(nativeHome, '.config') };
        const unset: string[] = [];
        for (const row of composed.providerEnvironmentOverlay) {
          if (row.value === null) unset.push(row.name);
          else values[row.name] = row.value;
        }
        const signal = new AbortController().signal;
        publications = createNativeAgentSessionPublications({ agentId: scenario.agentId, session: null,
          signal, isCurrent: () => true, supportsInFlightSteer: false });
        const modelPublications: AgentSessionModelsSnapshot[] = [];
        observedSubscription = publications.modelsSource.subscribe(snapshot => { modelPublications.push(snapshot); });
        // Executable resolution and --help are OS boundaries. All registration,
        // materialization, native factory and ACP transport/parser logic is real.
        const ambient = Object.fromEntries(support.authIsolation.ownedEnvKeys.map(key => [key, 'ambient-override']));
        const dependencies: PublicAcpComposerDependencies = {
          pluginId: parsed.manifest.id, agentId: scenario.agentId, signal, isCurrent: () => true,
          systemTools: { resolve: async () => ({ toolId: `${scenario.agentId}-cli`, launch: {
            kind: 'binary', executablePath: process.execPath, args: [script],
            env: { ...ambient, CAPTURE: capture, TRANSCRIPT: transcript },
          } }) },
          interactions: { async request() { throw new Error('Unexpected interaction'); } },
          media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
          models: publications.services.models, modes: publications.services.modes,
        };
        const unavailable = createUnavailablePluginServices();
        const purposes = agent.connectedAccounts ?? [];
        const firstPurpose = purposes[0];
        if (firstPurpose) {
          const service = typeof firstPurpose.service === 'string' ? { pluginId: parsed.manifest.id, localId: firstPurpose.service } : firstPurpose.service;
          const fixture = createForegroundPurposeOwnerFixture({ consumer: { pluginId: parsed.manifest.id, localId: scenario.agentId }, service,
            purpose: firstPurpose.purpose, materializeAccount: async () => { throw new Error('Unbound Provider launch must not read an Account credential'); } });
          await fixture.store.update(() => ({ v: 1, bindings: [] }));
          accountHost = createStablePluginConnectedAccountsHost(fixture.owner);
        }
        const connectedAccounts = accountHost?.bind({ plugin: { id: parsed.manifest.id, version: parsed.manifest.version },
          contribution: { id: scenario.agentId, qualifiedId: `${parsed.manifest.id}/agents/${scenario.agentId}` }, occurrenceId: 'provider-fixture', correlationId: 'provider-fixture',
          surface: 'agent', signal, retirementSignal: signal, isOccurrenceCurrent: () => true }, purposes.map(purpose => ({
          purpose: purpose.purpose, serviceRefs: [typeof purpose.service === 'string' ? { pluginId: parsed.manifest.id, localId: purpose.service } : purpose.service],
          operations: ['use' as const], materializationKinds: purpose.materializationKinds,
        })));
        let helpProbes = 0;
        // Use the host's captured-environment service rather than the unavailable
        // placeholder. Keep this fixture independent of the worker's login state.
        const capturedExec = createStablePluginExecService({
          signal, isOccurrenceCurrent: () => true,
          inheritedEnvironment: scenario.agentId === 'gemini'
            ? { GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(dir, 'native-system-settings.json') } : {},
          resolvePath: async () => dir,
          resolveExecutable: async () => { throw new Error('Unexpected executable resolution'); },
        });
        contextFixture = createAcpSessionRuntimeContextFixture({ agent, pluginId: parsed.manifest.id, publications,
          sessionId: 'session', directory: dir, signal,
          services: { ...unavailable, ...(connectedAccounts ? { connectedAccounts } : {}), exec: { ...unavailable.exec, readEnvironment: capturedExec.readEnvironment, run: async request => {
            helpProbes++;
            expect(request.args).toEqual(['--help']);
            return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
              stdout: new TextEncoder().encode('--acp'), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
          } } },
          protocols: { acp: {
            open: (request, options) => createPublicAcpSession(request, options, dependencies),
            openExecutionRunV1: (request, options) => createPublicAcpExecutionRun(request, options, dependencies),
          } },
        });
        const runtime = await factory({ plugin: { id: parsed.manifest.id, version: parsed.manifest.version },
          agent: { id: scenario.agentId }, signal });
        if (!runtime.sessions) throw new Error('Expected a native Session factory');
        const common = { sessionId: 'session', cwd: dir, launchEnvironment: { values, unset },
          providerBinding: AgentSessionProviderBindingV1Schema.parse({ connectionId: 'pc_composed', model: binding.selection.model,
            upstream: { protocol, normalizedUrl: binding.endpoint.normalizedUrl, credential: 'apiKey' }, materialization: composed.launchMaterialization }),
          configuration: { model: { value: scenario.model, updatedAtMs: 1 }, mode: { value: null, updatedAtMs: 1 },
            permissionIntent: { value: 'default' as const, updatedAtMs: 1 }, options: {} },
        };
        const request: AgentSessionOpenRequest = kind === 'create' ? { ...common, kind }
          : { ...common, kind, providerSessionId: 'native-session' };
        let admittedRequest = request;
        if (scenario.agentId === 'gemini') {
          const systemPolicy = join(dir, 'native-system-settings.json');
          const policy = JSON.stringify({ security: { auth: { selectedType: 'oauth-personal', enforcedType: 'oauth-personal' } } });
          await writeFile(systemPolicy, policy);
          await expect(runtime.sessions.open(request, contextFixture.context)).rejects.toMatchObject({
            code: 'gemini_provider_auth_policy_conflict', retryable: false,
          });
          expect(helpProbes).toBe(0);
          expect(existsSync(capture)).toBe(false);
          expect(readFileSync(systemPolicy, 'utf8')).toBe(policy);
          admittedRequest = { ...request, launchEnvironment: { values, unset: [...unset, 'GEMINI_CLI_SYSTEM_SETTINGS_PATH'] } };
        }
        session = await runtime.sessions.open(admittedRequest, contextFixture.context);
        const captured: { env: Record<string, string | null>; argv: string[] } = JSON.parse(readFileSync(capture, 'utf8'));
        const launched = captured.env;
        expect(launched[scenario.key]).toBe(secret);
        for (const row of composed.providerEnvironmentOverlay) expect(launched[row.name]).toBe(row.value);
        const requests: { method: string; params?: unknown }[] = JSON.parse(readFileSync(transcript, 'utf8'));
        expect(requests.map(row => row.method)).toContain(kind === 'create' ? 'session/new' : 'session/load');
        const nativeModel = scenario.agentId === 'kilo' ? JSON.parse(values.KILO_CONFIG_CONTENT!).model
          : scenario.agentId === 'droid' ? 'custom:opaque-advertised-id' : scenario.model;
        expect(requests).toContainEqual(scenario.agentId === 'gemini'
          ? { method: 'session/set_model', params: { sessionId: 'native-session', modelId: nativeModel } }
          : { method: 'session/set_config_option', params: { sessionId: 'native-session', configId: 'model', value: nativeModel } });
        expect(publications.modelsSource.read()).toMatchObject({ currentModelId: scenario.model });
        expect(modelPublications).toContainEqual(expect.objectContaining({ currentModelId: scenario.model }));
        if (scenario.agentId === 'copilot') {
          expect(publications.modelsSource.read().models).toEqual([]);
        } else {
          expect(publications.modelsSource.read().models).toEqual(expect.arrayContaining([expect.objectContaining({ id: scenario.model })]));
        }
        expect(readFileSync(sharedConfig, 'utf8')).toBe(retained);
        if (scenario.agentId === 'gemini') {
          expect(launched.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBeNull();
          const copied = JSON.parse(readFileSync(join(launched.GEMINI_CLI_HOME!, '.gemini', 'settings.json'), 'utf8'));
          expect(copied.security.auth.selectedType).toBe('gemini-api-key');
          expect(copied.retained).toBe('native-user-setting');
        }
        if (composed.launchMaterialization.kind === 'configFile') {
          const settingsPath = join(composed.launchMaterialization.rootPath, ...composed.launchMaterialization.relativePaths[0]!.split('/'));
          if (scenario.agentId === 'droid') expect(captured.argv.slice(-2)).toEqual(['--settings', settingsPath]);
          for (const relativePath of composed.launchMaterialization.relativePaths) {
            expect(readFileSync(join(composed.launchMaterialization.rootPath, relativePath), 'utf8')).not.toContain(secret);
          }
        } else expect(existsSync(join(dir, 'providers'))).toBe(false);
      } finally {
        try { await session?.dispose(); }
        finally {
          try { await contextFixture?.dispose(); }
          finally { observedSubscription?.dispose(); publications?.dispose(); accountHost?.retire(); cleanup?.(); await host.dispose(); }
        }
      }
    });
  });
}

it('refuses a Copilot Responses-only Provider through the canonical typed compatibility policy', async () => {
  const { COPILOT_PLUGIN } = await import('@happier-dev/plugins-copilot/manifest');
  const agent = COPILOT_PLUGIN.manifest.contributes.agents?.[0]?.providerRequirements;
  if (!agent) throw new Error('Expected Copilot Provider requirements');
  const result = resolveProviderBindingCompatibilityWithFingerprintV1({
    agentTargetKey: 'agent:happier.agent.copilot/copilot', adapterVersion: 1, agent,
    endpoints: [{ id: 'responses', protocol: 'openai-responses', baseUrl: 'https://provider.example/v1', capabilities: {
      streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'unknown',
    } }], credential: undefined, model: { id: 'selected', name: 'Selected' },
  });
  expect(result.result).toEqual({ status: 'incompatible', reasons: ['no_compatible_protocol'] });
});
