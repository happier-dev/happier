import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { AgentExecutionRunEvent, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { devinNativeConnectedAccountRuntime } from '../../../../../../packages/plugins/devin/src/connectedAccounts/nativeRuntime';
import { DEVIN_NATIVE_GENERATION, DEVIN_NATIVE_FILE } from '../../../../../../packages/plugins/devin/src/connectedAccounts/nativeCredentials';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/devin/src/manifest';
import { DEVIN_CONNECTED_ACCOUNT_LAUNCH, createDevinConnectedAccountLaunch } from '../../../../../../packages/plugins/devin/src/agent/connectedAccount';
import { applyConnectedServiceStateSharingDescriptor } from '../stateSharing/applyConnectedServiceStateSharingDescriptor';
import { materializeConnectedServiceNativeHomeCredentials } from '../stateSharing/materializeConnectedServiceNativeHomeCredentials';
import { prepareNativeSessionConfig } from '@/agent/acp/runtime/definition/nativeSessionConfig';
import { DEVIN_ACP_RUNTIME_DECLARATION } from '../../../../../../packages/plugins/devin/src/agent/acp/runtimeDeclaration';
import { normalizePluginDeclarativeAcpRuntime } from '@/agent/acp/runtime/definition/plugin';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';
import { createPublicAcpSession, createPublicAcpExecutionRun, type PublicAcpComposerDependencies } from '@/agent/acp/runtime/publicSession/createPublicAcpSession';
import { withAgentPreflightCatalog } from '@/capabilities/probes/withAgentPreflightCatalog';
import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from '@/capabilities/probes/agentModelsProbe';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { verifyResumeReachableThroughCatalog } from '../catalogHooks';
import { resolveConnectedServiceNativeHomeTargetRoot } from './resolveConnectedServiceNativeHomeTarget';
import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';
import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';

type Materialized = NonNullable<Awaited<ReturnType<typeof materializeConnectedServicesForSpawn>>>;
type AccountContext = Parameters<ConnectedAccountRuntime['materialize']>[1];
let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
let fixtureHome: string;
beforeAll(async () => {
  fixtureHome = await mkdtemp(join(tmpdir(), 'happier-devin-runtime-'));
  fixture = await createAdmittedPluginRuntimeFixture({ happyHomeDir: fixtureHome, controller: pluginReloadController,
    runtimeOptions: { pluginIds: [PLUGIN_MANIFEST.id], scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() } } });
});
afterAll(async () => { await fixture?.dispose(); if (fixtureHome) await rm(fixtureHome, { recursive: true, force: true }); });

async function nativeTurn(result: Materialized, root: string, route: 'session' | 'finite', baseEnv: Record<string, string>) {
  const capture = join(root, `${route}-capture.json`);
  // Only the vendor process is substituted. The real selected-account home,
  // config/MCP composition, ACP parser, model publications and lifecycle run.
  const script = writeAcpTestAgentScript({ dir: root, fileName: `${route}-devin.mjs`, source: `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    import { createInterface } from 'node:readline';
    import { createRequire } from 'node:module';
    import { delimiter, join } from 'node:path';
    const { parse } = createRequire(import.meta.url)(${JSON.stringify(createRequire(import.meta.url).resolve('smol-toml'))});
    const data = process.env.XDG_DATA_HOME;
    const config = process.env.XDG_CONFIG_HOME;
    writeFileSync(${JSON.stringify(capture)}, JSON.stringify({data, config, phase:'started'}));
    const credential = parse(readFileSync(join(data, 'devin/credentials.toml'), 'utf8'));
    const mcp = JSON.parse(readFileSync(join(config, 'devin/mcp_config.json'), 'utf8'));
    const account = credential.windsurf_api_key.endsWith('.B') ? 'B' : 'C';
    let currentModelId = 'model-' + account;
    const configOptions = () => [{ id:'model', name:'Model', type:'select', category:'model', currentValue:currentModelId,
      options:[{value:'model-'+account,name:'Account default'},{value:'model-'+account+'-next',name:'Next model'}] }];
    const childData = execFileSync(process.execPath, ['-e', \"process.stdout.write(require('node:fs').readFileSync(require('node:path').join(process.env.XDG_DATA_HOME,'unrelated-app/retained'),'utf8'))\"]).toString();
    const record = { home:process.env.HOME, data, config, credential, mcp, childData, inheritedKey:process.env.WINDSURF_API_KEY, requests:[] };
    const save = () => writeFileSync(${JSON.stringify(capture)}, JSON.stringify(record));
    save();
    for await (const line of createInterface({input:process.stdin})) {
      const r = JSON.parse(line); if(r.id === undefined) continue;
      record.requests.push({method:r.method, params:r.params, model:currentModelId}); save();
      let result = {};
      if(r.method === 'initialize') result = {protocolVersion:1,agentCapabilities:{loadSession:true}};
      if(r.method === 'session/load' && r.params.sessionId !== 'native-session') {
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32000,message:'Session missing'}})+'\\n'); continue;
      }
      if(r.method === 'session/new' || r.method === 'session/load') result = {sessionId:'native-session',configOptions:configOptions()};
      if(r.method === 'session/set_config_option') { currentModelId=r.params.value; result={configOptions:configOptions()}; }
      if(r.method === 'session/prompt') {
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native-session',
          update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'DEVIN_SELECTED_COMPLETE'}}}})+'\\n');
        result = {stopReason:'end_turn'};
      }
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
    }
  ` });
  if (route === 'session') {
    const bin = join(root, 'bin'); await mkdir(bin);
    const executable = await writeExecutableShim({ dir: bin, fileName: process.platform === 'win32' ? 'devin.cmd' : 'devin',
      contents: process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\nexit /b %errorlevel%\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    });
    try {
      const probeEnvironment = { ...baseEnv, HAPPIER_DEVIN_PATH: executable, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` };
      const probe = (environment = result.env) => withAgentPreflightCatalog({ agentId: 'devin' }, async context => {
        return await probeAgentModelsBestEffort({
          agentId: 'devin', cwd: root, env: probeEnvironment,
          materializedEnv: environment, bypassCache: true, catalogEntry: context.catalogEntry,
          registrySnapshot: context.registrySnapshot, runtimeCacheKey: context.runtimeCacheKey,
        });
      });
      const catalog = await probe();
      const observation = await readFile(capture, 'utf8').catch(() => 'Vendor process was not started');
      expect(catalog.source, JSON.stringify({ catalog, observation })).toBe('dynamic');
      expect(catalog.availableModels.map(model => model.id).filter(id => id !== 'default')).toEqual(['model-B', 'model-B-next']);
      // A cold selected-account failure must not adopt ambient native credentials.
      // Same-scope transient refreshes intentionally retain their last good rows.
      resetAgentModelsProbeCacheForTests();
      expect(await probe({ ...result.env, XDG_DATA_HOME: join(root, 'missing-selected-credentials') })).toMatchObject({ source: 'unavailable', availableModels: [] });
    } finally { resetAgentModelsProbeCacheForTests(); }
  }
  const lifetime = new AbortController();
  const publications = createNativeAgentSessionPublications({ agentId: 'devin', session: null,
    signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted, supportsInFlightSteer: false });
  const dependencies: PublicAcpComposerDependencies = {
    pluginId: PLUGIN_MANIFEST.id, agentId: 'devin', signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted,
    systemTools: { resolve: async () => ({ toolId: 'devin-cli', launch: { kind: 'binary', executablePath: process.execPath, args: [script] } }) },
    interactions: { async request() { throw new Error('Unexpected native interaction'); } },
    media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
    models: publications.services.models, modes: publications.services.modes,
  };
  const options = normalizePluginDeclarativeAcpRuntime(DEVIN_ACP_RUNTIME_DECLARATION);
  const launchEnvironment = { values: buildScopedProcessEnv({ baseEnv, explicitEnv: result.env,
    unsetEnvKeys: result.unsetEnvKeys }), unset: [...(result.unsetEnvKeys ?? [])] };
  const mcpServers = { session_tool: { command: 'fake-session-tool', args: [] } };
  try {
    if (route === 'session') {
      const runtime = await createPublicAcpSession({ kind: 'resume', providerSessionId: 'native-session',
        sessionId: 'selected-session', cwd: root, launchEnvironment, mcpServers }, options, dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = runtime.watch(event => { events.push(event); });
      try {
        expect(publications.modelsSource.read().currentModelId).toBe('model-B');
        expect(await runtime.send({ inputIds: ['input'], input: { text: 'Use the native default.' },
          delivery: { kind: 'newTurn', turnId: 'turn' } })).toEqual({ status: 'admitted' });
        await expect.poll(() => events.some(e => e.kind === 'turn-complete' && e.turnId === 'turn')).toBe(true);
        expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', text: 'DEVIN_SELECTED_COMPLETE' }));
        expect(await runtime.updateConfiguration?.({ model: { value: 'model-B-next', updatedAtMs: 1, selectionSource: 'explicit' },
          mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: null, updatedAtMs: 0 }, options: {},
        })).toMatchObject({ status: 'applied' });
        await runtime.send({ inputIds: ['next'], input: { text: 'Use the changed model.' }, delivery: { kind: 'newTurn', turnId: 'next-turn' } });
        await expect.poll(() => events.some(e => e.kind === 'turn-complete' && e.turnId === 'next-turn')).toBe(true);
        expect(publications.modelsSource.read().currentModelId).toBe('model-B-next');
      } finally { subscription.dispose(); await runtime.dispose(); }
    } else {
      const runtime = await createPublicAcpExecutionRun({ kind: 'create', runId: 'finite', cwd: root,
        profile: { pluginId: 'happier.core', localId: 'delegate' }, input: { text: 'Complete the selected turn.' }, launchEnvironment, mcpServers }, options, dependencies);
      const events: AgentExecutionRunEvent[] = [];
      const subscription = runtime.watch(event => { events.push(event); });
      try {
        await expect.poll(() => events.some(e => e.kind === 'run-complete')).toBe(true);
        expect(events).toContainEqual(expect.objectContaining({ kind: 'output-delta', text: 'DEVIN_SELECTED_COMPLETE' }));
      } finally { subscription.dispose(); await runtime.dispose(); }
    }
    const observed = JSON.parse(await readFile(capture, 'utf8'));
    expect(observed).toMatchObject({ home: baseEnv.HOME, data: result.env.XDG_DATA_HOME, childData: 'user-data',
      credential: { windsurf_api_key: `devin-session-token$eyJ.fake.${route === 'session' ? 'B' : 'C'}` },
      mcp: { mcpServers: { user_tool: { command: 'fake-user-tool' }, session_tool: { command: 'fake-session-tool' } } } });
    expect(observed).not.toHaveProperty('inheritedKey');
    expect(observed.config).not.toBe(baseEnv.XDG_CONFIG_HOME);
    // drop delivers MCP only in the native file, never twice through ACP.
    for (const request of observed.requests) if (request.method === 'session/new' || request.method === 'session/load') expect(request.params.mcpServers).toEqual([]);
    if (route === 'session') expect(observed.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'session/prompt', model: 'model-B' }),
      expect.objectContaining({ method: 'session/prompt', model: 'model-B-next' }),
    ]));
    // Session disposal joins cleanup; finite Runs deliberately detach best-effort
    // cleanup so native disposal cannot retain terminalization.
    if (route === 'session') await expect(lstat(observed.config)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { publications.dispose(); lifetime.abort(); }
}

describe('selected Devin native Account through production home and ACP owners', () => {
  it('delivers B/C independently of native A, composes MCP once, resumes and completes native/finite turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-devin-selected-'));
    const nativeData = join(root, 'user-data'), nativeConfig = join(root, 'user-config'), nativeHome = join(root, 'home');
    const results: Materialized[] = [], leases: Array<{ dispose(): void }> = [];
    const credentialReads: string[] = [];
    const original = 'windsurf_api_key = "fake-native-A"\napi_server_url = "https://native-a.example.test"\n';
    try {
      await mkdir(join(nativeData, 'devin', 'cli'), { recursive: true });
      await mkdir(join(nativeData, 'unrelated-app'));
      await mkdir(join(nativeConfig, 'devin'), { recursive: true });
      await mkdir(nativeHome);
      await writeFile(join(nativeData, DEVIN_NATIVE_FILE), original);
      await writeFile(join(nativeData, 'devin', 'cli', 'sessions.db'), 'sanitized-native-database-boundary');
      await writeFile(join(nativeData, 'unrelated-app', 'retained'), 'user-data');
      const userMcp = JSON.stringify({ mcpServers: { user_tool: { command: 'fake-user-tool' } } });
      await writeFile(join(nativeConfig, 'devin', 'mcp_config.json'), userMcp);
      const baseEnv = { HOME: nativeHome, USERPROFILE: nativeHome, XDG_DATA_HOME: nativeData, XDG_CONFIG_HOME: nativeConfig, WINDSURF_API_KEY: 'fake-inherited-A' };
      const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId: 'devin', contributions: fixture.registry.contributes });
      const scope = declaration?.fileMaterializationPurposes[0], service = scope?.serviceRefs[0];
      if (!declaration || !scope || !service) throw new Error('Registered Devin native purpose missing');
      for (const accountId of ['B', 'C', 'unsupported']) {
        const values: Record<string, string> = { credentialMode: 'session', sessionToken: `devin-session-token$eyJ.fake.${accountId}`,
          apiServerUrl: 'https://server.codeium.com', nativeGeneration: accountId === 'unsupported' ? 'unknown-generation' : DEVIN_NATIVE_GENERATION,
          nativeMetadata: JSON.stringify({ devin_webapp_host: 'app.devin.ai', devin_api_url: 'https://api.devin.ai' }) };
        const owner = createForegroundPurposeOwnerFixture({ consumer: scope.purpose.consumer, purpose: scope.purpose.purpose, service, accountId,
          materializeAccount: async ({ request, existingFiles, signal }) => {
            const context: AccountContext = { account: { service, accountId }, plugin: { id: service.pluginId, version: '0.0.0' },
              contribution: { id: service.localId, qualifiedId: `${service.pluginId}/${service.localId}` }, surface: 'background', invokedAtMs: 1, signal,
              credentials: { async get(key) { credentialReads.push(key); return values[key] ?? null; } },
              configuration: { target: { kind: 'account', account: { service, accountId }, modeId: 'browser-session' }, revision: '1', values: {}, async getSecret() { return null; } },
              services: createUnavailablePluginServices() };
            return devinNativeConnectedAccountRuntime.materialize(request, context, { signal, existingFiles });
          } });
        const sessionId = `devin-${accountId}`;
        leases.push(owner.owner.activateSessionPurposeBindings({ sessionId, purposes: declaration.purposes, bindings: [owner.binding] }));
        const pending = materializeConnectedServicesForSpawn({ agentId: 'devin', materializationKey: sessionId, purposeBindingSessionId: sessionId,
          activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'), recordsByServiceId: new Map(), connectedAccountsOwner: owner.owner,
          connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: [owner.binding], requestAuthPurposeBindings: [] },
          qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [owner.binding] },
          processEnv: baseEnv,
          accountSettings: { connectedServicesProviderStateSharingSettingsV1: { v: 1, defaults: { configMode: 'copied', stateMode: 'shared' }, byAgentId: {},
            acknowledgedRisksByAgentId: { devin: { sharedStatePrivacy: true } } } },
          agentLaunchTarget: { runtimeHome: join(root, 'agent', sessionId) } });
        if (accountId === 'unsupported') {
          await expect(pending).rejects.toMatchObject({ code: 'unsupported' });
          const failedRoot = resolveConnectedServiceMaterializedRootDir({ baseDir: join(root, 'materialized'), agentId: 'devin', materializationKey: sessionId });
          await expect(lstat(failedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
          const nativeHomeDeclaration = DEVIN_CONNECTED_ACCOUNT_LAUNCH.stateSharingDescriptor?.nativeHome;
          if (!nativeHomeDeclaration) throw new Error('Devin native declaration missing');
          const failedHome = resolveConnectedServiceNativeHomeTargetRoot({ agentId: 'devin', activeServerDir: join(root, 'server'),
            nativeHome: nativeHomeDeclaration,
            target: { kind: 'account', account: { service, accountId } } });
          if (!failedHome) throw new Error('Devin native target missing');
          await expect(lstat(join(failedHome, DEVIN_NATIVE_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
          continue;
        }
        const result = await pending;
        if (!result) throw new Error('Devin native home missing');
        results.push(result);
        expect(parse(await readFile(join(result.env.XDG_DATA_HOME!, DEVIN_NATIVE_FILE), 'utf8'))).toMatchObject({ windsurf_api_key: values.sessionToken });
        expect(await realpath(join(result.env.XDG_DATA_HOME!, 'unrelated-app'))).toBe(await realpath(join(nativeData, 'unrelated-app')));
        expect(await realpath(join(result.env.XDG_DATA_HOME!, 'devin', 'cli'))).toBe(await realpath(join(nativeData, 'devin', 'cli')));
        expect({ ...baseEnv, ...result.env }.HOME).toBe(nativeHome);
        expect({ ...baseEnv, ...result.env }.XDG_CONFIG_HOME).toBe(nativeConfig);
        expect(result.unsetEnvKeys).toContain('WINDSURF_API_KEY');
        // Isolated Agent launches project the selected secret to their own
        // runtime root; direct native launches use the durable selected home.
        expect(result.agentLaunchMaterials?.environment.XDG_DATA_HOME).not.toBe(nativeData);
        const projectedCredential = result.agentLaunchMaterials?.selectedMaterials.find(entry => entry.relativePath.endsWith(DEVIN_NATIVE_FILE));
        if (!projectedCredential) throw new Error('Selected Devin Agent credential missing');
        expect(parse(Buffer.from(projectedCredential.contentBase64, 'base64').toString('utf8'))).toMatchObject({ windsurf_api_key: values.sessionToken });
        await expect(verifyResumeReachableThroughCatalog('devin', { targetMaterializedRoot: result.env.XDG_DATA_HOME!, vendorResumeId: 'native-session' })).resolves.toMatchObject({ ok: true });
      }
      expect(results[0]!.env.XDG_DATA_HOME).not.toBe(results[1]!.env.XDG_DATA_HOME);
      await nativeTurn(results[0]!, root, 'session', baseEnv);
      await nativeTurn(results[1]!, root, 'finite', baseEnv);
      expect(credentialReads).not.toContain('refreshToken');
      expect(await readFile(join(nativeData, DEVIN_NATIVE_FILE), 'utf8')).toBe(original);
      expect(await readFile(join(nativeConfig, 'devin', 'mcp_config.json'), 'utf8')).toBe(userMcp);
    } finally {
      for (const result of results) await result.cleanupOnExit?.();
      for (const lease of leases) lease.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('composes Windows APPDATA data and config overlays without linking native credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-devin-appdata-'));
    let config: Awaited<ReturnType<typeof prepareNativeSessionConfig>> | undefined;
    try {
      const source = join(root, 'native-appdata'), selected = join(root, 'selected-appdata'), home = join(root, 'home');
      await mkdir(join(source, 'devin', 'cli'), { recursive: true });
      await mkdir(join(source, 'other-app'));
      await mkdir(home);
      await writeFile(join(source, DEVIN_NATIVE_FILE), 'windsurf_api_key = "fake-native-A"\n');
      await writeFile(join(source, 'devin', 'config.toml'), 'theme = "retained"\n');
      const originalMcp = JSON.stringify({ mcpServers: { user_tool: { command: 'fake-user-tool' } } });
      await writeFile(join(source, 'devin', 'mcp_config.json'), originalMcp);
      const launch = createDevinConnectedAccountLaunch('win32');
      const descriptor = launch.stateSharingDescriptor;
      if (!descriptor) throw new Error('Windows descriptor missing');
      const state = await applyConnectedServiceStateSharingDescriptor({ descriptor: { ...descriptor, providerId: 'devin' },
        nativeSourceContext: { sourceRoot: source, sourceEnv: { APPDATA: source } },
        target: { targetMaterializedRoot: selected, targetMaterializedEnv: { APPDATA: selected } },
        configMode: 'copied', requestedStateMode: 'shared', effectiveStateMode: 'shared', cwd: root });
      await materializeConnectedServiceNativeHomeCredentials({ targetRoot: selected, declaredSecretEntries: descriptor.authIsolation.secretEntries,
        files: { [DEVIN_NATIVE_FILE]: new TextEncoder().encode('windsurf_api_key = "fake-selected-B"\napi_server_url = "https://enterprise.example.test"\n') } });
      config = await prepareNativeSessionConfig({ declaration: DEVIN_ACP_RUNTIME_DECLARATION.definition.mcp.nativeSessionConfig,
        cwd: root, platform: 'win32', env: { HOME: home, USERPROFILE: home, APPDATA: selected, ...state.envOverrides },
        mcpServers: { session_tool: { command: 'fake-session-tool', args: [] } } });
      // Windows path selection runs against real filesystem owners on Linux;
      // only the external CLI is substituted, never a real user home.
      const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
        import { readFileSync } from 'node:fs'; import {join} from 'node:path';
        process.stdout.write(JSON.stringify({home:process.env.HOME,
          credentials:readFileSync(join(process.env.APPDATA,'devin/credentials.toml'),'utf8'),
          mcp:JSON.parse(readFileSync(join(process.env.APPDATA,'devin/mcp_config.json'),'utf8'))}));
      `], { env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: selected, ...state.envOverrides, ...config.env } });
      expect(JSON.parse(child.stdout)).toMatchObject({ home,
        credentials: 'windsurf_api_key = "fake-selected-B"\napi_server_url = "https://enterprise.example.test"\n',
        mcp: { mcpServers: { user_tool: { command: 'fake-user-tool' }, session_tool: { command: 'fake-session-tool' } } } });
      expect(await realpath(join(config.env.APPDATA!, 'other-app'))).toBe(await realpath(join(source, 'other-app')));
      expect(await readFile(join(config.env.APPDATA!, 'devin', 'config.toml'), 'utf8')).toBe('theme = "retained"\n');
      expect((await lstat(join(selected, DEVIN_NATIVE_FILE))).isSymbolicLink()).toBe(false);
      expect(await readFile(join(source, DEVIN_NATIVE_FILE), 'utf8')).toBe('windsurf_api_key = "fake-native-A"\n');
      expect(await readFile(join(source, 'devin', 'mcp_config.json'), 'utf8')).toBe(originalMcp);
    } finally { config?.cleanup(); await rm(root, { recursive: true, force: true }); }
  });
});
