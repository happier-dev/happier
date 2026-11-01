import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import axios from 'axios';

import {
  buildConnectedServiceCredentialRecord,
  sealAccountScopedBlobCiphertext,
  QualifiedConnectedAccountListResponseV4Schema,
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  PluginManifestV2Schema,
  buildBackendTargetKeyV2,
  getActionSpec,
  type TeamResourceConnectedServiceSelectionV2,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { ApiClient } from '@/api/api';
import type { StoredCredentials } from '@/persistence';
import type {
  ConnectedAccountPurposeBindingOwner,
} from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { PreparedPluginDevelopmentActivationGraph } from '@/plugins/authoring/sourceModule';
import { materializeSamplePluginFixture, SAMPLE_PLUGIN_ID } from '@/plugins/testkit/samplePackage';
import type { PluginApi } from '@happier-dev/plugin-sdk';

// Platform styling is outside the inventory contract; reuse the UI's native
// boundary so importing its real Action dependencies needs no mounted app.
await vi.hoisted(async () => {
  const { installVitestRnShim } = await import(new URL('../../../../ui/sources/dev/vitestRnShim.ts', import.meta.url).href);
  installVitestRnShim();
});
vi.mock('../../../../ui/node_modules/react-native-unistyles/lib/module/index.js', async () => {
  const { createUnistylesMock } = await import(new URL('../../../../ui/sources/dev/testkit/mocks/unistyles.ts', import.meta.url).href);
  return createUnistylesMock();
});
vi.mock('../../../../ui/node_modules/expo-updates/build/index.js', async () => {
  const { createExpoUpdatesMock } = await import(new URL('../../../../ui/sources/dev/testkit/mocks/expoUpdates.ts', import.meta.url).href);
  return createExpoUpdatesMock();
});
vi.mock('../../../../ui/node_modules/@shopify/react-native-skia/lib/module/index.js', async () => {
  const { createReactNativeSkiaMock } = await import(new URL('../../../../ui/sources/dev/testkit/mocks/reactNativeSkia.ts', import.meta.url).href);
  return createReactNativeSkiaMock();
});
vi.mock('../../../../ui/node_modules/expo-image/src/index.ts', () => ({ Image: 'Image' }));
vi.mock('../../../../ui/node_modules/expo-file-system/src/index.ts', async () => {
  const { createExpoFileSystemFileMock } = await import(new URL('../../../../ui/sources/dev/testkit/mocks/expoFileSystem.ts', import.meta.url).href);
  return createExpoFileSystemFileMock().module;
});
const uiCapabilityTransport = vi.hoisted(() => ({
  invoke: vi.fn<typeof import('../../../../ui/sources/sync/ops/capabilities')['machineCapabilitiesInvoke']>(),
}));
vi.mock('../../../../ui/sources/sync/ops/capabilities', () => ({
  machineCapabilitiesInvoke: uiCapabilityTransport.invoke,
}));

type ActivatePurposeBindingsInput = Parameters<
  ConnectedAccountPurposeBindingOwner['activatePurposeBindings']
>[0];

const originalEnv = { ...process.env };
// Load the real host graph outside the per-operation timeout, as the lazy-preflight testkit does.
const malformedSelectionModules = [
  await import('./capabilities'), await import('./encryptedRpc.testkit'),
  await import('@/configuration'), await import('@/persistence'),
] as const;
// The real UI inventory graph is shared across native cases. Loading it inside
// a timed operation can leave its import pending across the next module reset.
const { probeAgentModelsForActions } = await import('../../../../ui/sources/sync/ops/actions/agentInventoryProbe');
const { parseCapabilitiesInvokeResponse } = await import('../../../../ui/sources/sync/api/capabilities/capabilitiesProtocol');
const { createCliActionInventoryDeps } = await import('@/session/actions/cliActionDeps/createCliActionInventoryDeps');
const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
const { createUnavailableActionTransportDeps } = await import('@/testkit/actionTransportDeps');
const { ActionExecuteFailureSchema } = await import('@happier-dev/protocol/actions/actionExecutionResult');
let tempDir: string | null = null;
let releaseRuntime: (() => Promise<void>) | null = null;

afterEach(async () => {
  await releaseRuntime?.();
  releaseRuntime = null;
  vi.restoreAllMocks();
  vi.doUnmock('@/persistence');
  vi.doUnmock('@/settings/accountSettings/bootstrapAccountSettingsContext');
  vi.doUnmock('@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn');
  uiCapabilityTransport.invoke.mockReset();
  vi.resetModules();
  process.env = { ...originalEnv };
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('capabilities.invoke connected-service preflight', () => {
  it('refuses a selected account on an unsupported Agent for every discovery method without using native auth', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'happier-capability-unsupported-selection-'));
    process.env = { ...originalEnv, HAPPIER_HOME_DIR: tempDir, OPENAI_API_KEY: 'ambient-must-not-be-used' };
    const [capabilities, rpc, config, persistence] = malformedSelectionModules;
    const readStoredCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(null);
    config.reloadConfiguration();
    const { call } = rpc.createEncryptedRpcTestClient({
      scopePrefix: 'unsupported-selected-probe', encryptionKey: new Uint8Array(32).fill(7), logger: () => undefined,
      registerHandlers: (manager) => capabilities.registerCapabilitiesHandlers(manager),
    });
    for (const method of ['probeConfigOptions', 'probeModes', 'probeModels', 'probeCatalogs']) {
      const response = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
        id: 'cli.auggie', method,
        params: { cwd: tempDir, connectedServices: { v: 2, bindingsByServiceId: {
          'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'selected-work' },
        } } },
      });
      expect(response, method).toMatchObject({ ok: false, error: { code: 'connected-service-preflight-failed' } });
    }
    expect(readStoredCredentials).not.toHaveBeenCalled();
  });

  it('refuses malformed selected-account bindings for every discovery method before provider effects', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'happier-capability-invalid-selection-'));
    process.env = { ...originalEnv, HAPPIER_HOME_DIR: tempDir, OPENAI_API_KEY: 'ambient-must-not-be-used' };
    const [capabilities, rpc, config, persistence] = malformedSelectionModules;
    const readStoredCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(null);
    config.reloadConfiguration();
    const { call } = rpc.createEncryptedRpcTestClient({
      scopePrefix: 'invalid-selected-probe', encryptionKey: new Uint8Array(32).fill(7), logger: () => undefined,
      registerHandlers: (manager) => capabilities.registerCapabilitiesHandlers(manager),
    });
    for (const method of ['probeConfigOptions', 'probeModes', 'probeModels', 'probeCatalogs']) {
      const response = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
        id: 'cli.codex', method,
        params: { cwd: tempDir, timeoutMs: 1_000, connectedServices: { v: 2, bindingsByServiceId: {
          'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile' },
        } } },
      });
      expect(response, method).toMatchObject({ ok: false, error: { code: 'connected-service-preflight-failed' } });
    }
    expect(readStoredCredentials).not.toHaveBeenCalled();
  });

  it.each([
    { source: 'team_resource', resourceId: 'team-resource-brokered', deliveryMode: 'brokered' },
    {
      source: 'team_resource', resourceId: 'team-resource-direct', deliveryMode: 'direct',
      disclosedMember: {
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        accountId: 'disclosed-team-member',
      },
    },
  ] satisfies TeamResourceConnectedServiceSelectionV2[])(
    'refuses $deliveryMode Team operation probes before accessing personal credentials',
    async (selection) => {
      vi.resetModules();
      tempDir = mkdtempSync(join(tmpdir(), 'happier-capability-team-preflight-'));
      process.env = {
        ...originalEnv,
        HAPPIER_HOME_DIR: tempDir,
        OPENAI_API_KEY: 'ambient-key-must-not-be-used',
      };
      // The credential store and Account API are external boundaries. Team probes
      // have no admitted Session authority and must not read or mutate either.
      const readStoredCredentials = vi.fn(async () => null);
      const createApiClient = vi.fn(async () => { throw new Error('unexpected Account API access'); });
      vi.doMock('@/persistence', async (importOriginal) => ({
        ...(await importOriginal<typeof import('@/persistence')>()),
        readStoredCredentials,
      }));

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();
      const { registerCapabilitiesHandlers } = await import('./capabilities');
      const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');
      const { call } = createEncryptedRpcTestClient({
        scopePrefix: 'machine-test', encryptionKey: new Uint8Array(32).fill(7),
        logger: () => undefined,
        registerHandlers: (manager) => registerCapabilitiesHandlers(manager, { createApiClient }),
      });
      for (const method of ['probeModels', 'probeConfigOptions', 'probeModes', 'probeCatalogs']) {
        const response = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
          id: 'cli.codex', method,
          params: {
            cwd: tempDir,
            connectedServices: { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': selection } },
          },
        });
        expect(response, method).toMatchObject({ ok: false, error: { code: 'connected-service-preflight-failed' } });
        if (method === 'probeModels') {
          const parsed = parseCapabilitiesInvokeResponse(response);
          if (!parsed) throw new Error('Invalid real capability response');
          uiCapabilityTransport.invoke.mockResolvedValue({ supported: true, response: parsed });
          expect(await probeAgentModelsForActions({ machineId: 'machine-test', probe: { cwd: tempDir } },
            { agentId: 'codex', backendTargetParam: null })).toMatchObject({ ok: false, errorCode: 'connected-service-preflight-failed' });
          const inventory = createCliActionInventoryDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null,
            callMachineAction: async () => response });
          const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
          const failure = await executor.execute('agents.models.list', { agentId: 'codex', machineId: 'machine-test',
            probe: { cwd: tempDir } }, { surface: 'cli', authority: 'present_user' });
          expect(ActionExecuteFailureSchema.parse(failure)).toMatchObject({ errorCode: 'connected-service-preflight-failed' });
        }
      }
      expect(readStoredCredentials).not.toHaveBeenCalled();
      expect(createApiClient).not.toHaveBeenCalled();
    },
  );

  it.each(['codex', 'opencode', 'external'] as const)('materializes the selected personal account for %s native model inventory without borrowing an unselected catalog', async (targetId) => {
    let phase = 'prepare native fixture';
    let complete = false;
    onTestFinished(() => { if (!complete) console.error('Native catalog fixture failure phase', targetId, phase); });
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'happier-capability-connected-preflight-'));
    const nativeHome = join(tempDir, 'native-codex');
    mkdirSync(join(nativeHome, 'sessions'), { recursive: true });
    const agentId = targetId === 'external' ? `${SAMPLE_PLUGIN_ID}/sample-provider` : targetId;
    const fixture = join(tempDir, `${targetId}.mjs`);
    const fixtureSource = readFileSync(fileURLToPath(new URL('./__fixtures__/fakeCodexPreflightAppServer.mjs', import.meta.url)), 'utf8');
    // The real declared-tool launch clears PATH; the simulated OS executable
    // must name this test runtime directly, as native catalog fixtures do.
    writeFileSync(fixture, fixtureSource.replace(/^#![^\n]*/, `#!${process.execPath}`)
      .replace("id: 'gpt-5.4'", "id: existsSync(join(process.env.CODEX_HOME || '', 'auth.json')) ? 'gpt-6-luna' : 'unselected-model'")
      .replace("existsSync, writeFileSync", "existsSync, mkdirSync, writeFileSync")
      .replace("    captureMaterializedEnvironment();", `    captureMaterializedEnvironment();
    mkdirSync(join(process.env.CODEX_HOME, 'sessions'), { recursive: true });
    writeFileSync(join(process.env.CODEX_HOME, 'sessions', 'probe.jsonl'), 'probe');`));
    chmodSync(fixture, 0o755);
    if (agentId === 'opencode') {
      // Native CLI/process is the boundary. The real plugin must prepare the same
      // auth/config it supplies to a bound Session before this catalog is visible.
      writeFileSync(fixture, `#!${process.execPath}
        import { createServer } from 'node:http';
        const auth = JSON.parse(process.env.OPENCODE_AUTH_CONTENT || '{}');
        const ids = ['free', ...Array.from({length: 40}, (_, index) => 'model-' + index), ...(auth.openai ? ['selected-account'] : [])];
        const models = ids.map(id => ({
          id, providerID: 'native', name: id, capabilities: { input: ['text'], output: ['text'] }
        }));
        if (process.argv.includes('--version')) process.stdout.write('1.18.33');
        else if (process.argv.includes('serve')) {
          const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
          createServer((request, response) => {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify(request.url === '/provider'
              ? { all: [{id: 'native', models: Object.fromEntries(models.map(model => [model.id, model]))}], connected: ['native'], default: {} }
              : { healthy: true, version: '1.18.33' }));
          }).listen(port, '127.0.0.1');
        } else {
          // Standalone CLI discovery lacks the selected-account native extension.
          // A preflight wired to that path must fail the consumer assertion below.
          process.stdout.write(JSON.stringify({data: models.filter(model => model.id === 'free')}));
        }
      `);
    }
    const captureFile = join(tempDir, 'captured-env.json');
    process.env = {
      ...originalEnv,
      HAPPIER_HOME_DIR: tempDir,
      HAPPIER_CODEX_PATH: fixture,
      HAPPIER_OPENCODE_PATH: fixture,
      OPENAI_API_KEY: undefined,
      CODEX_API_KEY: undefined,
      CODEX_HOME: nativeHome,
      CODEX_SQLITE_HOME: undefined,
    };
    if (targetId === 'external') {
      const root = join(tempDir, 'external-agent');
      await materializeSamplePluginFixture(root);
      const manifestPath = join(root, '.happier-plugin/plugin.json');
      const manifest = PluginManifestV2Schema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, activation: undefined, contributes: { ...manifest.contributes,
        agents: manifest.contributes?.agents?.map(agent => ({ ...agent,
          connectedAccounts: [{ purpose: 'native-catalog', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            credentialKinds: ['oauth'], materializationKinds: ['httpHeaders'] }],
          cli: agent.cli ? { ...agent.cli, executable: { ...agent.cli.executable, binaryName: basename(process.execPath) } } : undefined,
        })),
      } }));
      const modulePath = join(root, 'daemon.mjs');
      writeFileSync(modulePath, readFileSync(modulePath, 'utf8').replace('sessionRunnerFactory: {', `preflightSessionControls: {
        prepareLaunchEnvironment: async ({environment, connectedAccounts}) => {
          const binding = await connectedAccounts.getBinding('native-catalog');
          return {environment: {...environment,
            SELECTED_NATIVE_ACCOUNT: binding?.account.accountId === 'leeroy' ? 'selected' : '',
            OTHER_NATIVE_ACCOUNT: binding && binding.account.accountId !== 'leeroy' ? 'other' : ''}, unset: ['CODEX_HOME'], dispose() {}};
        },
        probeModels: context => [{id:'native/free',name:'free',description:'native'},
          ...(context.nonblankEnvironment.SELECTED_NATIVE_ACCOUNT ? [{id:'native/selected-account',name:'selected-account',description:'native'}] : []),
          ...(context.nonblankEnvironment.OTHER_NATIVE_ACCOUNT || context.nonblankEnvironment.CODEX_HOME ? [{id:'native/other-account',name:'other-account',description:'native'}] : [])],
      }, sessionRunnerFactory: {`));
      const { seedCurrentLocalPathPluginFixture } = await import('@/plugins/store/registry/currentState.testkit');
      await seedCurrentLocalPathPluginFixture({ happyHomeDir: tempDir, pluginRoot: root, pluginId: SAMPLE_PLUGIN_ID, manifestVersion: manifest.version });
    }

    const credentials: StoredCredentials = {
      token: 'test-happier-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now: 1_800_000_000_000,
      serviceId: 'openai-codex',
      profileId: 'leeroy',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'selected-access-token',
        refreshToken: 'selected-refresh-token',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'acct_selected',
        providerEmail: null,
      },
    });
    if (credentials.encryption.type !== 'legacy') throw new Error('test expects legacy credentials');
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
    const account = { service, accountId: 'leeroy' };
    const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({
      service,
      accounts: [{ ref: account, authenticationModeId: 'oauth', status: 'connected',
        revisionSemantics: 'revisioned', credentialRevision: revision,
        configurationReady: true, configurationRevision: null, scopes: [] },
        { ref: { service, accountId: 'unselected' }, authenticationModeId: 'oauth', status: 'connected',
          revisionSemantics: 'revisioned', credentialRevision: revision,
          configurationReady: true, configurationRevision: null, scopes: [] }],
    });
    const snapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: account, authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
      credentialRevision: revision, configurationRevision: null,
      content: { t: 'encrypted', c: ciphertext }, metadata: { scopes: [] },
    });
    // HTTP is the external boundary. V4 parsing, encrypted credential opening,
    // purpose authority, plugin invocation and launch-file materialization stay real.
    const credentialReads: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {
        schemaVersion: 6, connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'linked', stateMode: 'shared' }, byAgentId: { codex: { stateMode: 'shared' } },
        },
      } } } };
      if (path === '/v4/connect/qualified/accounts') return { status: 200, data: accounts };
      if (path === '/v4/connect/qualified/credential') {
        credentialReads.push(path);
        return { status: 200, data: snapshot };
      }
      throw new Error(`Unexpected capability HTTP read: ${path}`);
    });
    const api = {
      getAccountEncryptionMode: async () => 'e2ee' as const,
    } as unknown as ApiClient;

    vi.doMock('@/persistence', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/persistence')>()),
      readStoredCredentials: vi.fn(async () => credentials),
    }));
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
    const { resolveExecutablePluginRuntimeRegistry } = await import('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry');
    const { getResolvedContributionRegistry, createResolvedContributionRegistry, resolveMergedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
    const { createQualifiedConnectedAccountEstablishedRuntimeOwner } = await import('@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner');
    const { createDaemonConnectedAccountPurposeBindingRuntime } = await import('@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime');
    const { bindPluginRuntimeSourceAuthority } = await import('@/plugins/runtime/sourceAuthority');
    const opencodeTarget = getResolvedContributionRegistry().activationTargets.find(target => target.pluginId === 'happier.agent.opencode');
    // Module loading is a boundary: exercise the current source activation graph,
    // not the ignored bundled daemon emitted by a different lane's prior build.
    const preparedDevelopmentActivationGraphsByPluginId = new Map<string, PreparedPluginDevelopmentActivationGraph>();
    if (agentId === 'opencode') {
      if (!opencodeTarget?.daemonEntryPath || !opencodeTarget.sourceSpec || opencodeTarget.sourceSpec.kind !== 'bundled') throw new Error('Missing native source fixture');
      const rootPath = realpathSync(fileURLToPath(new URL('../../../../../packages/plugins/opencode', import.meta.url)));
      const sourceAuthority = bindPluginRuntimeSourceAuthority({ custody: { kind: 'development', registeredRootId: rootPath },
        resolvedRoot: rootPath, observedRevision: 1 });
      if (sourceAuthority.kind !== 'development') throw new Error('Missing source authority');
      const { loadVerifiedPluginModule, createPluginTypeScriptCandidateScope } = await import('@/plugins/runtime/loadPluginModule');
      const candidateScope = await createPluginTypeScriptCandidateScope({ rootPath });
      const entryPath = join(rootPath, 'src/activate.ts');
      const source = await loadVerifiedPluginModule({ entryPath, loadMode: 'source-ts', generationScope: candidateScope });
      const activate = source.activate;
      if (typeof activate !== 'function') throw new Error('Missing source activation');
      preparedDevelopmentActivationGraphsByPluginId.set('happier.agent.opencode', { module: {
        activate: (api: PluginApi) => activate({ ...api, agents: { ...api.agents,
          // Source activation and its runner must share this loader graph. The
          // packaged locator otherwise resolves a different compiled factory.
          register: (id, factory, options) => api.agents.register(id, factory, { ...options,
            sessionRunnerFactory: { ...options!.sessionRunnerFactory!, module: './agent/runtime/nativeRuntime.js' },
          }),
        } } satisfies PluginApi),
      }, rootPath, entryPath, candidateScope, sourceAuthority });
    }
    const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: pluginReloadController, credentials,
      getAccountEncryptionMode: async () => 'e2ee',
      configuration: {
        read: async () => null,
        secrets: { admit: async () => undefined, has: async () => false, read: async () => null },
      },
    });
    const createPurposeRuntime = () => createDaemonConnectedAccountPurposeBindingRuntime({
      reloadController: pluginReloadController, establishedRuntimeOwner: established,
      resolveQualifiedConnectedAccountV4Support: () => 'advertised',
      qualifiedApi: {
        listAccounts: async () => accounts,
        listGroups: async () => ({ groups: [] }), readGroup: async () => null,
      },
      store: {
        // A saved purpose deliberately points at another account. Only the
        // selected operation's exact custody may supply its native catalog.
        read: async () => ({ v: 1, bindings: targetId === 'external' ? [{
          purpose: { consumer: { pluginId: SAMPLE_PLUGIN_ID, localId: 'sample-provider' }, purpose: 'native-catalog' },
          target: { kind: 'account', account: { service, accountId: 'unselected' } },
        }] : [] }),
        update: async (mutate) => mutate({ v: 1, bindings: [] }),
        subscribe: () => ({ dispose() {} }),
      },
    });
    const purposeRuntime = createPurposeRuntime();
    phase = 'admit plugin runtime';
    const selectedPluginIds = ['happier.agent.codex', 'happier.agent.opencode', ...(targetId === 'external' ? [SAMPLE_PLUGIN_ID] : [])];
    const lease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: async () => {
        const base = await resolveMergedContributionRegistry({ happyHomeDir: tempDir! });
        return resolveExecutablePluginRuntimeRegistry({
        contributes: createResolvedContributionRegistry({ ...base,
          // This native-account fixture admits only its real Agent sources;
          // unrelated UI release declarations are outside the exercised runtime.
          pluginDeclarations: base.pluginDeclarations?.filter(target => selectedPluginIds.includes(target.pluginId)),
          activationTargets: base.activationTargets.filter(target => selectedPluginIds.includes(target.pluginId))
            .map(target => preparedDevelopmentActivationGraphsByPluginId.has(target.pluginId)
            ? { ...target, daemonEntryPath: preparedDevelopmentActivationGraphsByPluginId.get(target.pluginId)!.entryPath,
              devDaemonEntryPath: preparedDevelopmentActivationGraphsByPluginId.get(target.pluginId)!.entryPath }
            : target) }), pluginIds: selectedPluginIds,
        preparedDevelopmentActivationGraphsByPluginId,
        // Account plugin settings are persistent storage. An absent record uses
        // the real declaration defaults without attempting a real Account read.
        accountSettingsRecordAdapter: {
          async bindOperation() {
            return {
              async readRecord() { return { status: 'absent' }; },
              async writeRecord() { return { status: 'unavailable' }; },
            };
          },
        },
        resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({
          kind: 'development', registeredRootId: `capability-account:${pluginId}`, canonicalRoot: rootPath, observedRevision: 1,
        }),
        connectedAccounts: purposeRuntime.owner, qualifiedConnectedAccountEstablishedRuntimeOwner: established,
      }); },
    });
    releaseRuntime = async () => {
      await lease.release();
      await pluginReloadController.shutdown();
    };
    if (agentId === 'opencode') {
      expect(await lease.registry.acquireAgentCatalogEntry?.(agentId), JSON.stringify(lease.registry.pluginDiagnosticsByPluginId['happier.agent.opencode']))
        .toHaveProperty('preparePreflightLaunchEnvironment', expect.any(Function));
    }
    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');
    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager, {
        createApiClient: async () => api,
        activatePurposeBindings: purposeRuntime.activatePurposeBindings,
      }),
    });

    phase = 'probe selected native catalog';
    const response = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: `cli.${agentId}`,
      method: 'probeModels',
      params: {
        cwd: tempDir,
        timeoutMs: 5_000,
        ...(targetId === 'codex' ? { runtimeKindOverride: 'appServer' } : {}),
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'leeroy',
            },
          },
        },
      },
    });

    if (targetId !== 'codex') {
      phase = 'CLI inventory';
      const { createCliActionInventoryDeps } = await import('@/session/actions/cliActionDeps/createCliActionInventoryDeps');
      const { createActionExecutor } = await import('@happier-dev/protocol');
      const { createCliActionDeps } = await import('@/session/actions/createCliActionDeps');
      const inventory = createCliActionInventoryDeps({ token: credentials.token, sessionId: '', mode: 'plain', ctx: null,
        rawSession: { machineId: 'selected-machine', path: tempDir },
        callMachineAction: async request => await call(request.method, request.request),
      });
      const connectedServices = { v: 2, bindingsByServiceId: {
        'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'leeroy' },
      } } as const;
      const input = { agentId, machineId: 'selected-machine', probe: { cwd: tempDir, connectedServices } };
      expect(response).toMatchObject({ ok: true, result: { source: 'dynamic',
        availableModels: expect.arrayContaining([expect.objectContaining({ id: 'native/selected-account' })]) } });
      expect(response).toMatchObject({ result: { availableModels: expect.not.arrayContaining([
        expect.objectContaining({ id: 'native/other-account' }),
      ]) } });
      expect(await inventory.agentsModelsList(input)).toMatchObject({ items: expect.arrayContaining([
        { id: 'native/selected-account', label: 'selected-account', description: 'native' },
      ]) });
      const executor = createActionExecutor({ ...createCliActionDeps({ token: credentials.token, sessionId: '', mode: 'plain', ctx: null }), ...inventory });
      phase = 'Action options';
      const options = await executor.execute('action.options.resolve', { optionsSourceId: 'agents.models.available', draftInput: input, limit: 100 },
        { surface: 'cli', authority: 'present_user' });
      expect(options).toMatchObject({ ok: true, result: { options: expect.arrayContaining([
        { value: 'native/selected-account', label: 'selected-account', description: 'native' },
      ]) } });
      if (!options.ok) throw new Error('Native options unavailable');
      const optionsSpec = getActionSpec('action.options.resolve');
      if (!optionsSpec?.outputSchema) throw new Error('Native options Action unavailable');
      const nativeResult = optionsSpec.outputSchema.parse(options.result);
      if (!nativeResult || typeof nativeResult !== 'object' || !('options' in nativeResult)) throw new Error('Native options unavailable');
      const nativeOptions = nativeResult.options;
      const agentTarget = { kind: 'agent', identity: {
        pluginId: targetId === 'external' ? SAMPLE_PLUGIN_ID : 'happier.agent.opencode',
        localId: targetId === 'external' ? 'sample-provider' : 'opencode',
      } } as const;
      const backendTargetKey = buildBackendTargetKeyV2(agentTarget);
      // The production spawn resolver and inventory dependencies retain the same
      // selected native catalog across every public address of this Agent.
      for (const request of [
        { optionsSourceId: 'agents.models.available', draftInput: { ...input, backendTargetKey }, limit: 100 },
        { actionId: 'session.spawn_new', fieldPath: 'modelSelection', agentTarget,
          executionTarget: { serverId: 'selected-home', machineId: input.machineId },
          directory: { kind: 'path', path: tempDir }, connectedServices, limit: 100 },
      ]) {
        const resolved = await executor.execute('action.options.resolve', request, { surface: 'cli', authority: 'present_user' });
        expect(resolved).toMatchObject({ ok: true, result: { options: nativeOptions } });
      }
      const queried = await executor.execute('action.options.resolve', {
        optionsSourceId: 'agents.models.available', draftInput: { ...input, backendTargetKey }, query: 'selected-account', limit: 100,
      }, { surface: 'cli', authority: 'present_user' });
      expect(queried).toMatchObject({ ok: true, result: { options: [
        { value: 'native/selected-account', label: 'selected-account', description: 'native' },
      ] } });
      const unselected = await inventory.agentsModelsList({ ...input, probe: { cwd: tempDir, connectedServices: { v: 2, bindingsByServiceId: {} } } });
      expect(unselected).toMatchObject({ source: 'dynamic', items: expect.not.arrayContaining([
        expect.objectContaining({ id: 'native/selected-account' }),
      ]) });
      uiCapabilityTransport.invoke.mockImplementation(async (_machineId, request) => {
        const response = parseCapabilitiesInvokeResponse(await call(RPC_METHODS.CAPABILITIES_INVOKE, request));
        if (!response) throw new Error('Invalid capability RPC response');
        return { supported: true, response };
      });
      phase = 'UI inventory';
      expect(await probeAgentModelsForActions(input, { agentId, backendTargetParam: null })).toMatchObject({
        source: 'dynamic', items: expect.arrayContaining([{ modelId: 'native/selected-account', label: 'selected-account', description: 'native' }]),
      });
      complete = true;
      return;
    }
    expect(response).toMatchObject({
      ok: true,
      result: { source: 'dynamic', availableModels: expect.arrayContaining([expect.objectContaining({ id: 'gpt-6-luna' })]) },
    });
    phase = 'selected-account structured Run admission';
    const { assertExecutionRunStructuredOutputModelAllowed } = await import('@/agent/runtime/bridges/executionRun/structuredOutputAdmission');
    const { createRunnerExecutionRunSnapshots } = await import('@/daemon/agentRuntime/runnerExecutionRunSnapshots');
    const { AgentRuntimeDaemonServiceRequestV1Schema, AgentRuntimeDaemonServiceResponseV1Schema } = await import('@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol');
    const connectedServices = { v: 2, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'leeroy' },
    } } as const;
    const retainedAgent = lease.registry.agentRuntimesByAgentId.get('codex')?.sessionRunnerFactoryBinding;
    if (!retainedAgent) throw new Error('Missing selected Codex runtime');
    const context = { sessionId: 'selected-codex-review', runner: { pid: 123, processStartTimeMs: 1,
      processCommandHash: 'a'.repeat(64), snapshotIdentity: 'selected-codex-review' }, retainedAgent,
      invocationContext: { cwd: tempDir, environment: {}, providerBindingActive: false },
      trackedSession: { pid: 123, startedBy: 'daemon' as const, happySessionId: 'selected-codex-review' },
      isCurrent: async () => true };
    const requesterPurposeRuntime = createPurposeRuntime();
    const snapshots = createRunnerExecutionRunSnapshots({ machineId: 'selected-machine', controller: pluginReloadController,
      // A Session requester has its own Account runtime, even on the same Home.
      // Activation and credential materialization must use that same owner.
      withNativeModelAccount: async (_context, read) => read({ accountSettings: {}, promptCredentials: credentials,
        preflightDependencies: { createApiClient: async () => api,
          activatePurposeBindings: requesterPurposeRuntime.activatePurposeBindings,
          connectedAccountsOwner: requesterPurposeRuntime.owner } }),
    });
    const dispatch = async (operation: unknown, snapshotId?: string) => AgentRuntimeDaemonServiceResponseV1Schema.parse(
      await snapshots.dispatch(AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1,
        context: { token: 'A'.repeat(43), sessionId: context.sessionId,
          ...(snapshotId ? { executionRunSnapshotId: snapshotId } : {}) }, operation }), context));
    const backendTarget = { kind: 'backend', backendId: 'codex' };
    const acquired = await dispatch({ kind: 'execution_run.snapshot.acquire_v1', backendTarget });
    if (!acquired.ok || acquired.result.kind !== 'execution_run.snapshot') throw new Error('Missing selected Codex snapshot');
    const snapshotId = acquired.result.snapshotId;
    const nativeRequest = { backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' },
      modelId: 'gpt-6-luna', cwd: tempDir, connectedServices,
      modelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-6-luna' } };
    // The retained Session requester must remain authoritative even when the
    // daemon's foreground credential store has no usable Account.
    const persistence = await import('@/persistence');
    const foregroundCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(null);
    try {
      await expect(assertExecutionRunStructuredOutputModelAllowed({ ...nativeRequest,
        readNativeOfferedModel: async request => {
          const result = await dispatch({ ...request, kind: 'execution_run.native_offered_model.read_v1', backendTarget }, snapshotId);
          if (!result.ok || result.result.kind !== 'execution_run.native_offered_model') throw new Error('Missing selected native model');
          return result.result.model ?? undefined;
        },
      })).resolves.toBeUndefined();
    } finally { foregroundCredentials.mockRestore(); await snapshots.dispose(); }
    expect(credentialReads).not.toHaveLength(0);
    const captured = JSON.parse(readFileSync(captureFile, 'utf8')) as Record<string, unknown>;
    expect(captured.CODEX_HOME).toEqual(expect.any(String));
    expect(captured.CODEX_AUTH_FILE_PRESENT).toBe(true);
    expect(readdirSync(join(nativeHome, 'sessions'))).toEqual([]);
    expect(captured.CODEX_HOME).not.toBe(nativeHome);
    const methods = JSON.parse(readFileSync(join(tempDir, 'captured-methods.json'), 'utf8')) as string[];
    expect(methods).toContain('model/list');
    expect(methods.some((method) => method.startsWith('thread/') || method.startsWith('realtime/'))).toBe(false);
    complete = true;
  }, 90_000);

  it('threads the canonical purpose owner into a qualified capability preflight and disposes its exact lease', async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'happier-capability-qualified-purpose-'));
    const fixture = fileURLToPath(new URL('./__fixtures__/fakeCodexPreflightAppServer.mjs', import.meta.url));
    chmodSync(fixture, 0o755);
    process.env = {
      ...originalEnv,
      HAPPIER_HOME_DIR: tempDir,
      HAPPIER_CODEX_PATH: fixture,
      OPENAI_API_KEY: undefined,
      CODEX_API_KEY: undefined,
      CODEX_HOME: undefined,
      CODEX_SQLITE_HOME: undefined,
    };

    const credentials: StoredCredentials = {
      token: 'test-happier-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    vi.doMock('@/persistence', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/persistence')>()),
      readStoredCredentials: vi.fn(async () => credentials),
    }));
    vi.doMock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
      bootstrapAccountSettingsContext: vi.fn(async () => ({
        settings: { codexBackendMode: 'appServer' },
      })),
    }));

    const disposePurposeLease = vi.fn();
    const unavailableMaterial = async (): Promise<never> => { throw new Error('No credential materialization is requested by this capability fixture'); };
    const purposeOwner = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unavailableMaterial, subscribe: () => ({ dispose() {} }) },
      selectTarget: unavailableMaterial, resolveTarget: async () => null, materializeAccount: unavailableMaterial,
      projectTargetAccounts: unavailableMaterial, assertTargetAccountMaterializable: unavailableMaterial,
    });
    const activatePurposeBindings = vi.fn((input: ActivatePurposeBindingsInput) => {
      const lease = purposeOwner.activatePurposeBindings(input);
      return { ...lease, dispose() { disposePurposeLease(); lease.dispose(); } };
    });
    const purpose = {
      consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
      purpose: 'codex-native-auth',
    } as const;
    const binding = {
      purpose,
      target: {
        kind: 'account',
        account: {
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          accountId: 'leeroy',
        },
      },
    } as const;
    const resolveAuthForSpawn = vi.fn(async (input: Readonly<{
      activateQualifiedPurposeBindings?: (snapshot: unknown) => Readonly<{
        subjectId: string;
        dispose(): void | Promise<void>;
      }>;
      connectedServicesBindingsRaw: unknown;
    }>) => {
      const snapshot = {
        purposes: [purpose],
        bindings: [binding],
        authorizedPurposes: [],
        fileMaterializationPurposes: [],
        requestAuthUses: [],
        fileEnvironmentUses: [],
        environmentUses: [],
      } as const;
      const materializationPurposeLease = input.activateQualifiedPurposeBindings?.(snapshot);
      if (!materializationPurposeLease) {
        throw new Error('qualified capability purpose activation missing');
      }
      return {
        env: { CODEX_HOME: tempDir! },
        cleanupOnFailure: null,
        cleanupOnExit: null,
        connectedServicesBindings: input.connectedServicesBindingsRaw,
        qualifiedPurposeBindingSnapshot: snapshot,
        requestAuthPurposeBindings: [],
        materializationPurposeLease,
      };
    });
    vi.doMock('@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn', () => ({
      resolveConnectedServiceAuthForSpawn: resolveAuthForSpawn,
    }));

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');
    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager, {
        createApiClient: async () => ({} as ApiClient),
        activatePurposeBindings,
        isAgentRegistryCurrent: () => true,
      }),
    });

    const response = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probeModels',
      params: {
        cwd: tempDir,
        timeoutMs: 5_000,
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'leeroy',
            },
          },
        },
      },
    });

    expect(response).toMatchObject({ ok: true });
    expect(resolveAuthForSpawn).toHaveBeenCalledOnce();
    expect(activatePurposeBindings).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.objectContaining({
        kind: 'operation',
        consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
      }),
      purposes: [purpose],
      bindings: [binding],
    }));
    const activationSubject = activatePurposeBindings.mock.calls[0]?.[0].subject;
    // The capability probe owns one correlation-scoped operation subject; its
    // currentness must be live rather than a constant.
    if (activationSubject?.kind !== 'operation') {
      throw new Error(`capability_probe_subject_kind:${activationSubject?.kind ?? 'missing'}`);
    }
    expect(activationSubject.isCurrent()).toBe(true);
    expect(disposePurposeLease).toHaveBeenCalledOnce();
  }, 90_000);

  it('fails closed instead of probing ambient auth when selected credentials are unavailable', async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'happier-capability-connected-preflight-no-credentials-'));
    process.env = {
      ...originalEnv,
      HAPPIER_HOME_DIR: tempDir,
      OPENAI_API_KEY: 'ambient-key-must-not-be-used',
    };
    vi.doMock('@/persistence', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/persistence')>()),
      readStoredCredentials: vi.fn(async () => null),
    }));
    vi.doMock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
      bootstrapAccountSettingsContext: vi.fn(async () => null),
    }));

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');
    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
    });

    const response = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probeModels',
      params: {
        cwd: tempDir,
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
            },
          },
        },
      },
    });

    expect(response).toEqual({
      ok: false,
      error: {
        code: 'connected-service-preflight-failed',
        message: 'Could not prepare the selected connected-service account for this probe.',
      },
    });
  }, 90_000);
});
