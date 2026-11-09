import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterAll, beforeAll, expect, it } from 'vitest';
import { parse, stringify } from 'smol-toml';
import type { ConnectedAccountRuntimeConfiguration } from '@happier-dev/plugin-sdk/connected-accounts';
import { applyProjectedCredentialKindRestrictions, isConnectedServiceProfileOptionSelectable } from '@happier-dev/agents';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadEnabledBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { projectBuiltInContributionInputs } from '@/plugins/projection/registry/builtIn/project';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { selectGrokAuthentication } from '../../../../../../packages/plugins/grok/src/agent/acp/auth';
import { buildGrokAcpRuntimeDefinition } from '../../../../../../packages/plugins/grok/src/agent/acp/definition';
import { GROK_PREFLIGHT_SESSION_CONTROLS } from '../../../../../../packages/plugins/grok/src/agent/preflight/models';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';
import { createConnectedAccountPurposeBindingOwner } from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';
import { verifyResumeReachableThroughCatalog } from '../catalogHooks';
import { resolveAgentSpawnPurposeDeclarations } from '../requestAuth/agentPurposeDeclarations';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withAgentPreflightCatalog } from '@/capabilities/probes/withAgentPreflightCatalog';
import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from '@/capabilities/probes/agentModelsProbe';

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
let runtimeHome: string;
const grokAgentId = 'grok';
beforeAll(async () => {
  runtimeHome = await mkdtemp(join(tmpdir(), 'happier-grok-admission-'));
  const bundled = loadEnabledBundledPluginLocatorResult({ pluginIds: ['happier.agent.grok'] });
  const contributes = createResolvedContributionRegistry(projectBuiltInContributionInputs(projectLoadedPluginContributes({
    loadResult: { loadedPlugins: bundled.loadedPlugins, diagnosticsByPluginId: {} },
    provenance: 'first_party', admittedGraph: bundled.admittedGraph,
  }), { agentIdentity: { pluginId: 'happier.agent.grok', localId: 'grok' } }));
  runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, happyHomeDir: runtimeHome,
    runtimeOptions: { pluginIds: ['happier.agent.grok'], contributes,
      scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() } } });
});

it('withholds unverified selected-account model rows through the registered authenticated ACP preflight', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-grok-account-catalog-'));
  const capture = join(root, 'auth-methods.json');
  const script = join(root, 'grok.cjs');
  const executableName = process.platform === 'win32' ? 'grok.cmd' : 'grok';
  const environment = createEnvKeyScope(['PATH']);
  try {
    // The native executable is the OS boundary; admission, Agent callback,
    // ACP authentication, observation normalization and cache remain real.
    await writeFile(script, `
      const fs = require('node:fs');
      if (process.argv.includes('models')) {
        process.stdout.write('Available models:\\n  * bundled-grok (default)\\n');
      } else {
        const rl = require('node:readline').createInterface({ input: process.stdin });
        rl.on('line', line => {
          const r = JSON.parse(line); if (r.id === undefined) return;
          let result = {};
          if (r.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {},
            authMethods: [{id:'cached_token',name:'Subscription'},{id:'xai.api_key',name:'API key'}],
            _meta: { defaultAuthMethodId: 'xai.api_key' } };
          if (r.method === 'authenticate') {
            const path = ${JSON.stringify(capture)};
            const methods = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path,'utf8')) : [];
            methods.push(r.params); fs.writeFileSync(path, JSON.stringify(methods));
          }
          if (r.method === 'session/new') result = { sessionId:'fake-catalog-session',
            models:{currentModelId:'bundled-grok',availableModels:[{modelId:'bundled-grok',name:'Bundled Grok'}]} };
          process.stdout.write(JSON.stringify({ jsonrpc:'2.0',id:r.id,result })+'\\n');
        });
      }
    `);
    await writeExecutableShim({ dir: root, fileName: executableName, contents: process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\nexit /b %errorlevel%\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n` });
    const env = { PATH: `${root}${delimiter}${process.env.PATH ?? ''}`, GROK_HOME: root };
    // The shared missing-CLI admission reads the host PATH before the scoped probe.
    environment.patch({ PATH: env.PATH });
    const probe = (materializedEnv?: Record<string, string>) => withAgentPreflightCatalog({ agentId: grokAgentId }, async context =>
      probeAgentModelsBestEffort({ agentId: grokAgentId, cwd: root, env, materializedEnv, bypassCache: true,
        catalogEntry: context.catalogEntry, registrySnapshot: context.registrySnapshot, runtimeCacheKey: context.runtimeCacheKey }));
    const nativeModels = await probe();
    if (!nativeModels.availableModels.some(model => model.id === 'bundled-grok')) {
      throw new Error(`Fake Grok native catalog unavailable: ${JSON.stringify(nativeModels)}`);
    }
    for (const mode of ['subscription', 'api-key'] as const) {
      const selected = await probe({ ...env, GROK_CONNECTED_ACCOUNT_MODE: mode,
        ...(mode === 'subscription' ? { GROK_OAUTH2_ISSUER: 'https://auth.x.ai' } : {}) });
      expect(selected).toMatchObject({ source: 'unavailable', availableModels: [], refreshError: true, cacheable: false });
    }
    expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual([
      { methodId: 'cached_token', _meta: { headless: true } },
      { methodId: 'xai.api_key', _meta: { headless: true } },
    ]);
  } finally { environment.restore(); resetAgentModelsProbeCacheForTests(); await rm(root, { recursive: true, force: true }); }
});
afterAll(async () => {
  try { await runtime?.dispose(); }
  finally { if (runtimeHome) await rm(runtimeHome, { recursive: true, force: true }); }
});

it('keeps unknown and both supported credential kinds selectable through the real Grok declaration', () => {
  const declaration = resolveAgentSpawnPurposeDeclarations({ agentId: grokAgentId, contributions: runtime.registry.contributes });
  if (!declaration) throw new Error(`Grok purpose declaration unavailable: ${JSON.stringify(runtime.registry.pluginDiagnosticsByPluginId)}`);
  const connectedAccounts = declaration.declarations.map(purpose => ({
    service: typeof purpose.service === 'string' ? { pluginId: declaration.consumer.pluginId, localId: purpose.service } : purpose.service,
    credentialKinds: purpose.credentialKinds,
  }));
  const key = buildQualifiedPluginContributionKey(connectedAccounts[0].service);
  const rows = [null, 'oauth', 'token'] as const;
  const projected = applyProjectedCredentialKindRestrictions({ connectedAccounts,
    optionsByServiceId: { [key]: rows.map((kind, index) => ({ profileId: `fake-${index}`, status: 'connected', kind })) } });
  expect(projected[key].map(option => ({ kind: option.kind, selectable: isConnectedServiceProfileOptionSelectable(option) })))
    .toEqual(rows.map(kind => ({ kind, selectable: true })));
});

it('keeps Grok native session state reachable through the registered resume hook and requires its summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-grok-native-resume-'));
  const id = 'fake-session-b';
  const directory = join(root, 'sessions', 'cwd-group', id);
  try {
    await mkdir(directory, { recursive: true });
    const history = join(directory, 'chat_history.jsonl');
    const summary = join(directory, 'summary.json');
    await writeFile(history, JSON.stringify({ type: 'user', content: 'fake native message' }) + '\n');
    await writeFile(summary, JSON.stringify({ info: { id, cwd: '/workspace' } }));
    const verify = () => verifyResumeReachableThroughCatalog(grokAgentId, { targetMaterializedRoot: root, vendorResumeId: id });
    await expect(verify()).resolves.toEqual({ ok: true, resolvedPath: history,
      requiredPaths: [history, summary, directory] });
    await rm(summary);
    await expect(verify()).resolves.toMatchObject({ ok: false, reason: 'grok_session_state_not_found' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['subscription', 'api-key'] as const)('launches selected Grok %s B over cached A and ambient paid key C through the admitted runtime', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'happier-selected-grok-'));
  const native = join(root, 'native');
  const leases: Array<{ dispose(): void }> = [];
  const cleanups: Array<() => Promise<void>> = [];
  try {
    const agentId = grokAgentId;
    const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId, contributions: runtime.registry.contributes });
    if (!declaration) throw new Error(`Grok purpose declaration unavailable: ${JSON.stringify(runtime.registry.pluginDiagnosticsByPluginId)}`);
    const scope = declaration.fileMaterializationPurposes[0];
    const service = scope?.serviceRefs[0];
    if (!scope || !service) throw new Error('Grok native materialization declaration unavailable');
    const account = { service, accountId: 'fake-selected-b' };
    const binding = { purpose: scope.purpose, target: { kind: 'account' as const, account } };
    const unavailableInventory = async (): Promise<never> => { throw new Error('Unexpected account inventory I/O'); };
    const credential = { mode, accessToken: 'fake-selected-b', refreshToken: 'fake-daemon-only-refresh',
      subject: 'fake-user-b', email: 'b@example.test' };
    const owner = createConnectedAccountPurposeBindingOwner({
      store: { read: unavailableInventory, update: unavailableInventory, subscribe: () => ({ dispose() {} }) },
      selectTarget: unavailableInventory, resolveTarget: async () => ({ displayName: 'B', account }),
      projectTargetAccounts: unavailableInventory, assertTargetAccountMaterializable: unavailableInventory,
      // Sealed credential persistence is the boundary. Admission, materialization and home custody remain real.
      materializeAccount: async input => {
        const accountRuntime = await runtime.registry.resolveConnectedAccountRuntime!(input.account.service);
        if (!accountRuntime) throw new Error(`Admitted Grok account runtime unavailable: ${JSON.stringify(runtime.registry.pluginDiagnosticsByPluginId)}`);
        const configuration: ConnectedAccountRuntimeConfiguration = {
          target: { kind: 'account', account: input.account, modeId: mode === 'subscription' ? 'device' : 'api-key' },
          revision: 'fake-configuration', values: {}, getSecret: async () => null,
        };
        return runtime.registry.connectedAccountRuntimeInvoker!.invokeEstablished({
          target: { account: input.account, expectedCredentialRevision: 'fake-credential', expectedRuntimeConfigurationRevision: configuration.revision },
          operation: { kind: 'materialize', request: input.request },
          context: { account: input.account, configuration, credentials: { get: async key => key === 'xaiCredential' ? JSON.stringify(credential) : null } },
          isConfigurationCurrent: async candidate => candidate === configuration && accountRuntime.isCurrent(),
          isCredentialRevisionCurrent: async () => accountRuntime.isCurrent(), signal: input.signal,
        });
      },
    });
    await mkdir(join(native, 'sessions', 'cwd-group', 'fake-session'), { recursive: true });
    await writeFile(join(native, 'sessions', 'cwd-group', 'fake-session', 'chat_history.jsonl'), 'native-history');
    const nativeAuth = JSON.stringify({ 'cached-account-a': { key: 'fake-cached-a' } });
    await writeFile(join(native, 'auth.json'), nativeAuth);
    const config = stringify({ theme: 'dark', trust: { workspace: 'trusted' },
      auth: { preferred_method: 'api_key', auth_provider_command: 'fake-external-a' },
      grok_com_config: { preferred_method: 'api_key', auth_provider_command: 'fake-external-a', oauth2: { issuer: 'https://enterprise.example.test', client_id: 'external' } },
      model: { first: { api_key: 'fake-paid-c', env_key: 'FAKE_PAID_KEY', max_tokens: 123 } } });
    await writeFile(join(native, 'config.toml'), config);
    const inherited = { GROK_HOME: native, GROK_AUTH_PATH: join(native, 'auth.json'), XAI_API_KEY: 'fake-paid-c', GROK_AUTH: 'fake-cached-a',
      GROK_OAUTH2_ISSUER: 'https://enterprise.example.test', GROK_OAUTH2_CLIENT_ID: 'fake-ambient-client' };
    const launch = async (key: string) => {
      const bindings = [binding];
      leases.push(owner.activateSessionPurposeBindings({ sessionId: key, purposes: declaration.purposes, bindings }));
      const result = await materializeConnectedServicesForSpawn({
        agentId, materializationKey: key, purposeBindingSessionId: key,
        processEnv: inherited,
        activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'), recordsByServiceId: new Map(), connectedAccountsOwner: owner,
        connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: bindings, requestAuthPurposeBindings: [] },
        qualifiedPurposeBindingSnapshot: { ...declaration, bindings },
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'copied', stateMode: 'shared' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
      });
      if (result?.cleanupOnExit) cleanups.push(result.cleanupOnExit);
      return result;
    };
    const selected = await launch('selected');
    if (!selected?.targetMaterializedRoot) throw new Error('Selected Grok home unavailable');
    expect(selected.targetMaterializedRoot).not.toBe(native);
    const child = buildScopedProcessEnv({ baseEnv: inherited, explicitEnv: selected.env, unsetEnvKeys: selected.unsetEnvKeys });
    expect(child).not.toHaveProperty('XAI_API_KEY');
    expect(child).not.toHaveProperty('GROK_AUTH_PATH');
    expect(child).not.toHaveProperty('GROK_AUTH');
    const auth = JSON.parse(await readFile(join(child.GROK_HOME, 'auth.json'), 'utf8'));
    expect(Object.values(auth)).toEqual([expect.objectContaining({ key: 'fake-selected-b', auth_mode: mode === 'subscription' ? 'oidc' : 'api_key' })]);
    expect(JSON.stringify(auth)).not.toContain('fake-daemon-only-refresh');
    expect(parse(await readFile(join(child.GROK_HOME, 'config.toml'), 'utf8'))).toEqual({ theme: 'dark', trust: { workspace: 'trusted' },
      auth: { preferred_method: mode === 'subscription' ? 'oidc' : 'api_key' },
      grok_com_config: { preferred_method: mode === 'subscription' ? 'oidc' : 'api_key' }, model: { first: { max_tokens: 123 } } });
    expect(await realpath(join(child.GROK_HOME, 'sessions'))).toBe(await realpath(join(native, 'sessions')));
    const context = { advertisedMethodIds: ['cached_token', 'xai.api_key'], initializeMetadata: { defaultAuthMethodId: 'xai.api_key' } };
    expect(buildGrokAcpRuntimeDefinition(child).auth?.selectMethod?.(context)).toEqual({ methodId: mode === 'subscription' ? 'cached_token' : 'xai.api_key', metadata: { headless: true } });
    expect(GROK_PREFLIGHT_SESSION_CONTROLS.catalogs.selectAuthentication({
      initializeResult: { authMethods: context.advertisedMethodIds.map(id => ({ id })), _meta: context.initializeMetadata },
      probe: { accountSettings: null, environment: Object.fromEntries(Object.keys(child).map(key => [key, true])),
        nonblankEnvironment: Object.fromEntries(Object.entries(child).map(([key, value]) => [key, value.trim().length > 0])) },
    })).toEqual({ methodId: mode === 'subscription' ? 'cached_token' : 'xai.api_key', metadata: { headless: true } });
    if (mode === 'api-key') expect(child).not.toHaveProperty('GROK_OAUTH2_ISSUER');
    else expect(child.GROK_OAUTH2_ISSUER).toBe('https://auth.x.ai');
    expect(selectGrokAuthentication(context, inherited)).toMatchObject({ methodId: 'xai.api_key' });
    expect(await readFile(join(native, 'auth.json'), 'utf8')).toBe(nativeAuth);
    expect(await readFile(join(native, 'config.toml'), 'utf8')).toBe(config);
  } finally {
    for (const cleanup of cleanups) await cleanup();
    for (const lease of leases) lease.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
