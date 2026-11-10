import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { AgentExecutionRunEvent, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { applyProjectedCredentialKindRestrictions, isConnectedServiceProfileOptionSelectable } from '@happier-dev/agents';
import { createKimiNativeConnectedAccountRuntime } from '../../../../../../packages/plugins/kimi/src/connectedAccounts/nativeRuntime';
import { createKimiAgentRuntime } from '../../../../../../packages/plugins/kimi/src/agent/runtime/factory';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/kimi/src/manifest';
import { createAcpSessionRuntimeContextFixture, createAcpExecutionRunRuntimeContextFixture } from '@/agent/acp/testkit/runtimeContextFixture';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { withAgentPreflightCatalog } from '@/capabilities/probes/withAgentPreflightCatalog';
import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from '@/capabilities/probes/agentModelsProbe';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createPublicAcpSession, createPublicAcpExecutionRun, type PublicAcpComposerDependencies } from '@/agent/acp/runtime/publicSession/createPublicAcpSession';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { loadEnabledBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { projectBuiltInContributionInputs } from '@/plugins/projection/registry/builtIn/project';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { resolveAgentSpawnPurposeDeclarations } from '../requestAuth/agentPurposeDeclarations';
import { verifyResumeReachableThroughCatalog } from '../catalogHooks';
import { resolveConnectedServiceNativeHomeTargetRoot } from './resolveConnectedServiceNativeHomeTarget';
import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';
import { KIMI_CONNECTED_ACCOUNT_LAUNCH } from '../../../../../../packages/plugins/kimi/src/agent/connectedAccount';
import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';
import { writeKimiNativeProcessFixture } from './kimiNativeProcess.testkit';

type Materialized = NonNullable<Awaited<ReturnType<typeof materializeConnectedServicesForSpawn>>>;
type AccountContext = Parameters<ConnectedAccountRuntime['materialize']>[1];

let runtimeFixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
let fixtureHome: string;
beforeAll(async () => {
  fixtureHome = await mkdtemp(join(tmpdir(), 'happier-kimi-materialization-runtime-'));
  const bundled = loadEnabledBundledPluginLocatorResult({ pluginIds: [PLUGIN_MANIFEST.id] });
  const projected = projectLoadedPluginContributes({
    loadResult: { loadedPlugins: bundled.loadedPlugins,
      diagnosticsByPluginId: Object.fromEntries(bundled.pluginFailures.map(failure => [failure.pluginId, [failure.diagnostic]])) },
    provenance: 'first_party', admittedGraph: bundled.admittedGraph,
  });
  // Inventory launches the declared native tool, so retain the whole plugin's
  // admitted tools/settings while excluding unrelated dependency installation.
  const contributes = createResolvedContributionRegistry(projectBuiltInContributionInputs(projected, {
    agentIdentity: { pluginId: PLUGIN_MANIFEST.id, localId: 'kimi' },
  }));
  runtimeFixture = await createAdmittedPluginRuntimeFixture({
    happyHomeDir: fixtureHome,
    controller: pluginReloadController,
    runtimeOptions: { pluginIds: [PLUGIN_MANIFEST.id], contributes,
      scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() },
    },
  });
});
afterAll(async () => {
  await runtimeFixture?.dispose();
  if (fixtureHome) await rm(fixtureHome, { recursive: true, force: true });
});

async function completeThroughNativeFactory(result: Materialized, directory: string, route: 'session' | 'finite') {
  const capture = join(directory, `${route}-launch.json`);
  // This subprocess is the external native CLI boundary. The real ACP parser,
  // process launch, Kimi journal source and both public lifecycle owners run.
  const script = writeKimiNativeProcessFixture(directory, route, capture);
  const expectedModels = Object.keys(parse(await readFile(join(result.env.KIMI_CODE_HOME!, 'config.toml'), 'utf8')).models as object);
  const [initialModel, nextModel] = expectedModels;
  if (!initialModel || !nextModel) throw new Error('Selected Kimi fixture requires two account models');
  const toolDirectory = join(directory, `${route}-bin`);
  await mkdir(toolDirectory);
  const executable = await writeExecutableShim({ dir: toolDirectory, fileName: process.platform === 'win32' ? 'kimi.cmd' : 'kimi',
    contents: process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\nexit /b %errorlevel%\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
  });
  const probe = (environment = result.env) => withAgentPreflightCatalog({ agentId: 'kimi' }, async context => probeAgentModelsBestEffort({
    agentId: 'kimi', cwd: directory, env: { PATH: `${toolDirectory}${delimiter}${process.env.PATH ?? ''}`, HAPPIER_KIMI_PATH: executable },
    materializedEnv: environment, bypassCache: true, catalogEntry: context.catalogEntry,
    registrySnapshot: context.registrySnapshot, runtimeCacheKey: context.runtimeCacheKey,
  }));
  try {
    const models = await probe();
    const boundary = await readFile(capture, 'utf8').then(value => {
      const captured = JSON.parse(value);
      return { requests: captured.requests, homePresent: Boolean(captured.home), tokenPresent: Boolean(captured.accessToken) };
    }).catch(() => null);
    expect(models.source, JSON.stringify({ models, boundary })).toBe('dynamic');
    expect(models.availableModels.map(model => model.id).filter(id => id !== 'default')).toEqual(expectedModels);
    // A failed refresh in a verified scope deliberately retains its last good
    // catalog. Test an unverified cold scope rather than that recovery contract.
    resetAgentModelsProbeCacheForTests();
    const unverified = await probe({ ...result.env, HAPPIER_KIMI_ACCESS_TOKEN: '' });
    expect(unverified).toMatchObject({ source: 'unavailable', availableModels: [] });
  } finally { resetAgentModelsProbeCacheForTests(); }
  const lifetime = new AbortController();
  const publications = createNativeAgentSessionPublications({ agentId: 'kimi', session: null,
    signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted, supportsInFlightSteer: false });
  const dependencies: PublicAcpComposerDependencies = {
    pluginId: PLUGIN_MANIFEST.id, agentId: 'kimi', signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted,
    systemTools: { resolve: async () => ({ toolId: 'kimi-cli', launch: { kind: 'binary', executablePath: process.execPath, args: [script] } }) },
    interactions: { async request() { throw new Error('Unexpected native interaction'); } },
    media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
    models: publications.services.models, modes: publications.services.modes,
  };
  const protocols = { acp: {
    open: (request: Parameters<typeof createPublicAcpSession>[0], options: Parameters<typeof createPublicAcpSession>[1]) => createPublicAcpSession(request, options, dependencies),
    openExecutionRunV1: (request: Parameters<typeof createPublicAcpExecutionRun>[0], options: Parameters<typeof createPublicAcpExecutionRun>[1]) => createPublicAcpExecutionRun(request, options, dependencies),
  } };
  const factory = await createKimiAgentRuntime({ plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, agent: { id: 'kimi' }, signal: lifetime.signal });
  if (!factory.sessions) throw new Error('Kimi native Session factory missing');
  const launchEnvironment = { values: result.env, unset: [...(result.unsetEnvKeys ?? [])] };
  try {
    if (route === 'session') {
      const agent = PluginAgentContributionV2Schema.parse(PLUGIN_MANIFEST.contributes.agents?.find(value => value.id === 'kimi'));
      const context = createAcpSessionRuntimeContextFixture({ agent, pluginId: PLUGIN_MANIFEST.id,
        sessionId: 'selected-session', directory, signal: lifetime.signal, protocols, publications });
      try {
        const runtime = await factory.sessions.open({ kind: 'resume', providerSessionId: 'native-session',
          sessionId: 'selected-session', cwd: directory, launchEnvironment }, context.context);
        const events: AgentSessionRuntimeEvent[] = [];
        const subscription = runtime.watch(event => { events.push(event); });
        try {
          expect(await runtime.send({ inputIds: ['selected-input'], input: { text: 'Complete the selected native turn.' }, delivery: { kind: 'newTurn', turnId: 'selected-turn' } })).toEqual({ status: 'admitted' });
          await expect.poll(() => events.some(event => event.kind === 'turn-complete' && event.turnId === 'selected-turn')).toBe(true);
          expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', text: 'NATIVE_SELECTED_COMPLETE' }));
          expect(events).toContainEqual(expect.objectContaining({ kind: 'provider-session-id', providerSessionId: 'native-session' }));
          expect(publications.modelsSource.read().currentModelId).toBe(initialModel);
          const changedModel = await runtime.updateConfiguration?.({ model: { value: nextModel, updatedAtMs: 1, selectionSource: 'explicit' },
            mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: null, updatedAtMs: 0 }, options: {},
          });
          expect(changedModel, JSON.stringify(changedModel)).toMatchObject({ status: 'applied' });
          await runtime.send({ inputIds: ['changed-model-input'], input: { text: 'Use the selected next model.' },
            delivery: { kind: 'newTurn', turnId: 'changed-model-turn' } });
          await expect.poll(() => events.some(event => event.kind === 'turn-complete' && event.turnId === 'changed-model-turn')).toBe(true);
          expect(publications.modelsSource.read().currentModelId).toBe(nextModel);
        } finally { subscription.dispose(); await runtime.dispose(); }
      } finally { await context.dispose(); }
    } else {
      if (!factory.sessions.executionRunContextV1) throw new Error('Kimi native finite factory missing');
      const context = createAcpExecutionRunRuntimeContextFixture({ pluginId: PLUGIN_MANIFEST.id, agentId: 'kimi',
        executionRunId: 'selected-finite', directory, signal: lifetime.signal, protocols });
      try {
        const runtime = await factory.sessions.executionRunContextV1.open({ kind: 'create', runId: 'selected-finite', cwd: directory,
          profile: { pluginId: 'happier.core', localId: 'delegate' }, input: { text: 'Complete the selected finite turn.' }, launchEnvironment }, context.context);
        const events: AgentExecutionRunEvent[] = [];
        const subscription = runtime.watch(event => { events.push(event); });
        try {
          await expect.poll(() => events.some(event => event.kind === 'run-complete')).toBe(true);
          expect(events).toContainEqual(expect.objectContaining({ kind: 'output-delta', text: 'NATIVE_SELECTED_COMPLETE' }));
        } finally { subscription.dispose(); await runtime.dispose(); }
      } finally { await context.dispose(); }
    }
    const observed: unknown = JSON.parse(await readFile(capture, 'utf8'));
    expect(observed).toMatchObject({ home: result.env.KIMI_CODE_HOME,
      accessToken: result.env.HAPPIER_KIMI_ACCESS_TOKEN, credentialsExist: false,
      config: await readFile(join(result.env.KIMI_CODE_HOME!, 'config.toml'), 'utf8'),
    });
    expect(observed).not.toHaveProperty('inheritedKey');
    if (route === 'session') expect(observed).toMatchObject({ requests: expect.arrayContaining([
      { method: 'session/prompt', currentModelId: initialModel },
      { method: 'session/prompt', currentModelId: nextModel },
    ]) });
  } finally { publications.dispose(); lifetime.abort(); }
}

describe('selected Kimi native Account through the spawn materializer', () => {
  it('keeps unknown and both supported credential kinds selectable through the real Kimi declaration', () => {
    const declaration = resolveAgentSpawnPurposeDeclarations({ agentId: 'kimi', contributions: runtimeFixture.registry.contributes });
    if (!declaration) throw new Error(`Kimi selected Account declaration missing: ${JSON.stringify(runtimeFixture.registry.pluginDiagnosticsByPluginId)}`);
    const connectedAccounts = declaration.declarations.map(purpose => ({
      service: typeof purpose.service === 'string' ? { pluginId: declaration.consumer.pluginId, localId: purpose.service } : purpose.service,
      credentialKinds: purpose.credentialKinds,
    }));
    const service = connectedAccounts[0]?.service;
    if (!service) throw new Error('Kimi service missing');
    const key = buildQualifiedPluginContributionKey(service);
    const kinds = [null, 'oauth', 'token'] as const;
    const projected = applyProjectedCredentialKindRestrictions({ connectedAccounts,
      optionsByServiceId: { [key]: kinds.map((kind, index) => ({ profileId: `fake-${index}`, status: 'connected', kind })) },
    });
    expect(projected[key].map(option => ({ kind: option.kind, selectable: isConnectedServiceProfileOptionSelectable(option) })))
      .toEqual(kinds.map(kind => ({ kind, selectable: true })));
  });

  it('isolates selected credentials and models while retaining native tools and resumable state across launches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-kimi-selected-native-'));
    const nativeHome = join(root, 'native-A');
    const results: Materialized[] = [];
    const leases: Array<{ dispose(): void }> = [];
    const networkRequests: Array<{ url: string; authorization: string | undefined }> = [];
    const credentialReads: string[] = [];
    try {
      await mkdir(join(nativeHome, 'sessions', 'native-session'), { recursive: true });
      await mkdir(join(nativeHome, 'credentials'));
      await writeFile(join(nativeHome, 'sessions', 'native-session', 'state.json'), JSON.stringify({ sessionId: 'native-session' }));
      await writeFile(join(nativeHome, 'session_index.jsonl'), JSON.stringify({ sessionId: 'native-session',
        sessionDir: join(nativeHome, 'sessions', 'native-session'), workDir: root,
      }) + '\n');
      const nativeConfig = [
        'default_model = "native-A"',
        '[providers.native]', 'type = "kimi"', 'base_url = "https://native-a.invalid/v1"',
        '[providers.native.oauth]', 'storage = "file"', 'key = "native-A"',
        '[models.native-A]', 'provider = "native"', 'model = "model-A"',
        '[mcp.client.fixture]', 'command = "fixture-tool"',
      ].join('\n');
      await writeFile(join(nativeHome, 'config.toml'), nativeConfig);
      await writeFile(join(nativeHome, 'credentials', 'native-A.json'), JSON.stringify({ access_token: 'fake-native-access-A', refresh_token: 'fake-native-root-A' }));

      const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
        agentId: 'kimi', contributions: runtimeFixture.registry.contributes,
      });
      if (!declaration) throw new Error(`Kimi selected Account declaration missing: ${JSON.stringify(runtimeFixture.registry.pluginDiagnosticsByPluginId)}`);
      const scope = declaration.fileMaterializationPurposes[0];
      if (!scope) throw new Error('Kimi native credential purpose missing');
      const service = scope.serviceRefs[0];
      if (!service) throw new Error('Kimi service missing');
      const runtime = createKimiNativeConnectedAccountRuntime();
      const launch = async (accountId: string, modelStatus = 200, selectedDefaultModel?: string) => {
        const account = { service, accountId };
        const credentials: Record<string, string> = {
          accessToken: `fake-access-${accountId}`, refreshToken: `fake-root-${accountId}`,
          credentialKind: 'oauth', apiBase: 'https://api.kimi.ai/coding/v1', deviceId: `fake-device-${accountId}`,
          ...(selectedDefaultModel ? { nativeConfig: JSON.stringify({ default_model: 'selected',
            models: { selected: { model: selectedDefaultModel } },
          }) } : {}),
        };
        const services = createUnavailablePluginServices();
        const fixture = createForegroundPurposeOwnerFixture({
          consumer: scope.purpose.consumer, purpose: scope.purpose.purpose, service, accountId,
          // Substitute only stored credential reads and vendor HTTP. Both the
          // actual plugin materializer and generic purpose/home owners run.
          materializeAccount: async ({ request, existingFiles, signal }) => {
            const context: AccountContext = {
              account, plugin: { id: service.pluginId, version: '0.0.0' },
              contribution: { id: service.localId, qualifiedId: `${service.pluginId}/${service.localId}` },
              surface: 'background', invokedAtMs: 1_800_000_000_000, signal,
              credentials: { async get(key) { credentialReads.push(key); return credentials[key] ?? null; } },
              configuration: { target: { kind: 'account', account, modeId: 'device' }, revision: '1',
                values: { region: 'global' }, async getSecret() { return null; } },
              services: { ...services, http: { ...services.http, async request(input) {
                networkRequests.push({ url: input.url, authorization: input.headers?.Authorization });
                if (input.url !== `${credentials.apiBase}/models`) throw new Error('Launch must not log in or refresh');
                return { status: modelStatus, headers: {}, finalUrl: input.url,
                  body: new TextEncoder().encode(JSON.stringify({ data: [
                    { id: `model-${accountId}`, limit: { context: 32768 } },
                    { id: `model-${accountId}-next`, limit: { context: 65536 } },
                  ] })) };
              } } },
            };
            return await runtime.materialize(request, context, { signal, existingFiles });
          },
        });
        const sessionId = `kimi-${accountId}`;
        leases.push(fixture.owner.activateSessionPurposeBindings({ sessionId, purposes: declaration.purposes, bindings: [fixture.binding] }));
        const result = await materializeConnectedServicesForSpawn({
          agentId: 'kimi', materializationKey: sessionId, purposeBindingSessionId: sessionId,
          activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'), recordsByServiceId: new Map(),
          connectedAccountsOwner: fixture.owner,
          connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: [fixture.binding], requestAuthPurposeBindings: [] },
          qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [fixture.binding] },
          processEnv: { KIMI_CODE_HOME: nativeHome, KIMI_API_KEY: 'fake-inherited-A', MOONSHOT_API_KEY: 'fake-inherited-A' },
          accountSettings: { connectedServicesProviderStateSharingSettingsV1: { v: 1,
            defaults: { configMode: 'copied', stateMode: 'shared' }, byAgentId: {},
            acknowledgedRisksByAgentId: { kimi: { sharedStatePrivacy: true } },
          } },
          agentLaunchTarget: { runtimeHome: join(root, 'isolated-agent', sessionId) },
        });
        if (!result) throw new Error('Selected Kimi home was not materialized');
        results.push(result);
        return result;
      };

      const first = await launch('B');
      const second = await launch('C');
      for (const [result, accountId] of [[first, 'B'], [second, 'C']] as const) {
        const selectedHome = result.env.KIMI_CODE_HOME;
        expect(selectedHome).toBeTruthy();
        const config = parse(await readFile(join(selectedHome!, 'config.toml'), 'utf8'));
        expect(config).toMatchObject({ default_model: `kimi-code/model-${accountId}`,
          providers: { 'happier:kimi-code': { base_url: 'https://api.kimi.ai/coding/v1', api_key_env: 'HAPPIER_KIMI_ACCESS_TOKEN' } },
          mcp: { client: { fixture: { command: 'fixture-tool' } } },
        });
        expect(Object.keys(config.models as object)).toEqual([`kimi-code/model-${accountId}`, `kimi-code/model-${accountId}-next`]);
        expect(JSON.stringify(config)).not.toContain('native-A');
        expect(JSON.stringify(config)).not.toContain('oauth');
        expect(result.env.HAPPIER_KIMI_ACCESS_TOKEN).toBe(`fake-access-${accountId}`);
        expect(result.agentLaunchMaterials?.environment.HAPPIER_KIMI_ACCESS_TOKEN).toBe(`fake-access-${accountId}`);
        expect(result.unsetEnvKeys).toEqual(expect.arrayContaining(['KIMI_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_CODE_BASE_URL']));
        expect(JSON.stringify(result)).not.toContain('fake-root-');
        await expect(lstat(join(selectedHome!, 'credentials'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await realpath(join(selectedHome!, 'sessions'))).toBe(await realpath(join(nativeHome, 'sessions')));
        await expect(verifyResumeReachableThroughCatalog('kimi', {
          targetMaterializedRoot: selectedHome!, vendorResumeId: 'native-session',
        })).resolves.toMatchObject({ ok: true });
        await expect(verifyResumeReachableThroughCatalog('kimi', {
          targetMaterializedRoot: selectedHome!, vendorResumeId: 'not-the-selected-session',
        })).resolves.toMatchObject({ ok: false, reason: 'kimi_session_state_not_found' });
      }
      expect(first.env.KIMI_CODE_HOME).not.toBe(second.env.KIMI_CODE_HOME);
      expect(await readFile(join(first.env.KIMI_CODE_HOME!, 'config.toml'), 'utf8')).not.toContain('model-C');
      expect(await readFile(join(nativeHome, 'config.toml'), 'utf8')).toBe(nativeConfig);
      expect(networkRequests).toEqual(['B', 'C'].map(accountId => ({ url: 'https://api.kimi.ai/coding/v1/models', authorization: `Bearer fake-access-${accountId}` })));
      expect(credentialReads).not.toContain('refreshToken');
      await completeThroughNativeFactory(first, root, 'session');
      await completeThroughNativeFactory(second, root, 'finite');

      await expect(launch('failed', 503)).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true,
        response: { status: 503 }, details: { httpStatus: 503, limitCategory: 'capacity' } });
      await expect(launch('auth-failed', 401)).rejects.toMatchObject({ code: 'provider_unavailable', retryable: false,
        response: { status: 401 }, details: { httpStatus: 401, limitCategory: 'auth_invalid' } });
      await expect(launch('throttled', 429)).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true,
        response: { status: 429 }, details: { httpStatus: 429, limitCategory: 'rate_limit' } });
      await expect(launch('invalid-default', 200, 'not-in-selected-catalog')).rejects.toMatchObject({ code: 'model_selection_required' });
      expect(networkRequests.slice(2)).toEqual(['failed', 'auth-failed', 'throttled', 'invalid-default'].map(accountId => ({
        url: 'https://api.kimi.ai/coding/v1/models', authorization: `Bearer fake-access-${accountId}`,
      })));
      for (const accountId of ['failed', 'auth-failed', 'throttled', 'invalid-default']) {
        const failedRoot = resolveConnectedServiceMaterializedRootDir({ baseDir: join(root, 'materialized'),
          agentId: 'kimi', materializationKey: `kimi-${accountId}` });
        await expect(lstat(failedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
        const failedHome = resolveConnectedServiceNativeHomeTargetRoot({ agentId: 'kimi', activeServerDir: join(root, 'server'),
          nativeHome: KIMI_CONNECTED_ACCOUNT_LAUNCH.stateSharingDescriptor.nativeHome,
          target: { kind: 'account', account: { service, accountId } },
        });
        if (!failedHome) throw new Error('Kimi durable native-home target missing');
        await expect(lstat(join(failedHome, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(credentialReads).not.toContain('refreshToken');
      expect(await readFile(join(nativeHome, 'config.toml'), 'utf8')).toBe(nativeConfig);
    } finally {
      for (const result of results) await result.cleanupOnExit?.();
      for (const lease of leases) lease.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
