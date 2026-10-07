import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, sep } from 'node:path';
import {
  FeaturesResponseSchema, PluginManifestV2Schema, QualifiedConnectedAccountCredentialSnapshotV4Schema,
  QualifiedConnectedAccountListResponseV4Schema, sealQualifiedConnectedAccountContentEnvelope,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { ApiClient } from '@/api/api';
import type { Machine } from '@/api/types';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { configuration, reloadConfiguration } from '@/configuration';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { writeCredentialsLegacy } from '@/persistence';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { bindPluginRuntimeSourceAuthority } from '@/plugins/runtime/sourceAuthority';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { registerCapabilitiesHandlers } from '@/rpc/handlers/capabilities';
import { createEncryptedRpcTestClient } from '@/rpc/handlers/encryptedRpc.testkit';
import { ApiMachineClient } from './apiMachine';
import { resolveConnectedServiceAuthForSpawn } from '@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { createPreflightCatalogCleanupScope } from '@/capabilities/probes/preflightCatalogCleanupScope';
import { generateConnectedServiceMaterializationIdentityV1 } from '@/daemon/connectedServices/materialization/identity';
import { materializeSamplePluginFixture, SAMPLE_PLUGIN_ID } from '@/plugins/testkit/samplePackage';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';

const filesystemBoundary = vi.hoisted(() => ({
  gate: undefined as Readonly<{ kind: 'mkdir' | 'open'; wait: Promise<void>; entered(path: string): void }> | undefined,
  rejectedRemoval: undefined as string | undefined,
}));
// Delay/fail only actual OS operations; the real custody/materialization owners remain loaded.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    async mkdir(...args: Parameters<typeof actual.mkdir>) {
      const path = String(args[0]);
      if (filesystemBoundary.gate?.kind === 'mkdir' && path.includes(`${sep}.attempts${sep}`)) {
        const gate = filesystemBoundary.gate; gate.entered(path); await gate.wait;
      }
      return actual.mkdir(...args);
    },
    async open(...args: Parameters<typeof actual.open>) {
      const path = String(args[0]);
      if (filesystemBoundary.gate?.kind === 'open' && path.endsWith('.credential')) {
        const gate = filesystemBoundary.gate; gate.entered(path); await gate.wait;
      }
      return actual.open(...args);
    },
    async rm(...args: Parameters<typeof actual.rm>) {
      if (String(args[0]) === filesystemBoundary.rejectedRemoval) {
        throw Object.assign(new Error('OS denied artifact removal'), { code: 'EACCES' });
      }
      return actual.rm(...args);
    },
  };
});

// Only HTTP credential transport and native executables are simulated. Purpose
// selection, envelope opening, materialization, final registration and RPC remain real.
describe('final machine native catalog scope admission', () => {
  const originalEnvironment = { ...process.env };
  const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
  const account = { service, accountId: 'selected' };
  const credentials = { token: 'fixture-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } };
  const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
  let root: string;
  let home: string;
  let lease: PluginRuntimeRegistryLease;
  let purposeOwner: ReturnType<typeof createConnectedAccountPurposeBindingOwner>;
  let machineClient: ApiMachineClient | undefined;
  let capture: string;
  let configuredNativeHome: string;
  let holdNativeCredential = false;
  let credentialReadEntered: (() => void) | undefined;
  let releaseCredentialRead: (() => void) | undefined;
  let heldCredentialSignal: AbortSignal | undefined;
  let heldAttemptRoots: string[] = [];
  const apiBoundary = {
    getServerFeaturesSnapshot: async () => ({ status: 'ready' as const,
      features: FeaturesResponseSchema.parse({ features: { connectedServices: { enabled: true } },
        capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } } }) }),
    getAccountEncryptionMode: async () => 'e2ee' as const,
  };
  // ApiClient is a broad HTTP boundary; this test admits only the endpoints its real path consumes.
  const createApiClient = async () => apiBoundary as unknown as ApiClient;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'happier-final-machine-catalog-'));
    home = join(root, 'home');
    process.env = { ...originalEnvironment, HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'http://fixture.invalid',
      HAPPIER_JS_RUNTIME_PATH: process.execPath };
    reloadConfiguration();
    await writeCredentialsLegacy({ token: credentials.token, secret: credentials.encryption.secret });
    const content = sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'e2ee',
      material: credentials.encryption, payload: { v: 1, values: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh',
        idToken: 'fixture-id', providerAccountId: 'fixture-account', expiresAtMs: String(Date.now() + 3_600_000) } },
      randomBytes: length => new Uint8Array(length).fill(3) });
    const snapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: account,
      authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: revision,
      configurationRevision: null, content, metadata: { scopes: [] } });
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'fixture-account' } };
      if (path === '/v4/connect/qualified/accounts') return { status: 200,
        data: QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [{ ref: account,
          authenticationModeId: 'oauth', status: 'connected', kind: 'oauth', expiresAt: Date.now() + 3_600_000,
          revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision: null,
          configurationReady: true, scopes: [] }] }) };
      if (path === '/v4/connect/qualified/credential') {
        const stagingDirectory = join(home, 'daemon', 'connected-services', 'materialized', '.attempts');
        if (holdNativeCredential && existsSync(stagingDirectory) && readdirSync(stagingDirectory).length > 0) {
          heldAttemptRoots = readdirSync(stagingDirectory).map(name => join(stagingDirectory, name));
          heldCredentialSignal = options?.signal as AbortSignal | undefined;
          credentialReadEntered?.();
          // HTTP deliberately ignores cancellation until the test releases its late response.
          await new Promise<void>(resolve => { releaseCredentialRead = resolve; });
        }
        return { status: 200, data: snapshot };
      }
      throw new Error(`Unexpected HTTP fixture endpoint ${path}`);
    });
    const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({ reloadController: pluginReloadController,
      credentials, getAccountEncryptionMode: async () => 'e2ee', configuration: { read: async () => null,
        secrets: { admit: async () => undefined, has: async () => false, read: async () => null } } });
    purposeOwner = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: async mutate => mutate({ v: 1, bindings: [] }),
        subscribe: () => ({ dispose() {} }) },
      selectTarget: async () => { throw new Error('Unexpected interactive account selection'); },
      resolveTarget: async target => target.kind === 'account' ? { displayName: 'Fixture account', account: target.account } : null,
      resolveCredentialRevision: (ref, signal) => established.readCredentialRevision({ account: ref, signal }),
      materializeAccount: async ({ account: ref, request, signal, credentialRevisionBasis }) => {
        const materialized = await established.invokeWithReceipt({ account: ref, operation: { kind: 'materialize', request }, signal });
        credentialRevisionBasis?.captureCredentialRevision(materialized.basis.credentialRevision);
        return materialized.result;
      },
      projectTargetAccounts: async () => { throw new Error('Unexpected interactive account listing'); },
      assertTargetAccountMaterializable: async () => { throw new Error('Unexpected selected-account dialog'); },
    });
    configuredNativeHome = join(root, 'selected-native-home');
    const externalRoot = join(root, 'external-plugin');
    await materializeSamplePluginFixture(externalRoot);
    const manifestPath = join(externalRoot, '.happier-plugin', 'plugin.json');
    const manifest = PluginManifestV2Schema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, activation: undefined, contributes: {
      ...manifest.contributes, agents: manifest.contributes?.agents?.map(agent => ({ ...agent,
        connectedAccounts: [{ purpose: 'selected-account', service, required: false, materializationKinds: ['environment'] }],
        cli: agent.cli ? { ...agent.cli, executable: { ...agent.cli.executable, binaryName: basename(process.execPath) } } : undefined,
      })),
    } }));
    const daemonPath = join(externalRoot, 'daemon.mjs');
    writeFileSync(daemonPath, readFileSync(daemonPath, 'utf8').replace('sessionRunnerFactory: {',
      `preflightSessionControls: { probeCatalogs: async () => ({ commands: [{ name: 'external-command' }], skills: null }) },
        sessionRunnerFactory: {`));
    await seedCurrentLocalPathPluginFixture({ happyHomeDir: home, pluginRoot: externalRoot,
      pluginId: SAMPLE_PLUGIN_ID, manifestVersion: manifest.version });
    const emptyConsumerPluginIds: string[] = [];
    for (const kind of ['environment', 'file', 'native-home', 'file-success', 'undeclared'] as const) {
      const pluginId = `acme.empty-${kind}`;
      emptyConsumerPluginIds.push(pluginId);
      const pluginRoot = join(root, pluginId);
      await materializeSamplePluginFixture(pluginRoot);
      const environmentKey = 'UNSUPPORTED_CREDENTIAL';
      const connectedAccountLaunch = kind === 'environment'
        ? { environmentUses: [{ purpose: 'selected-account', environmentKey }] }
        : kind === 'file' || kind === 'file-success'
          ? { fileEnvironmentUses: [{ purpose: 'selected-account', environmentKey, fileId: kind === 'file-success' ? 'auth.json' : 'unsupported.json' }] }
          : { stateSharingDescriptor: {
            nativeHome: { environmentKey, defaultRelativePath: '.fixture' },
            providerSupportStatus: 'supported',
            config: { supported: false, modes: ['isolated'], entries: [], unavailableReason: 'not_implemented' },
            state: { supported: false, modes: ['isolated'], entries: [], unavailableReason: 'not_implemented' },
            authIsolation: { mode: 'materialized_home', secretEntries: ['unsupported.json'] },
          } };
      writeFileSync(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
        ...manifest, id: pluginId, activation: undefined,
        hostAccess: { required: [{ id: 'native-auth', capability: 'environment', reason: 'Native auth destination',
          scope: { keys: [environmentKey] } }], optional: [] },
        contributes: { ...manifest.contributes, agents: manifest.contributes?.agents?.map(agent => ({ ...agent,
          connectedAccounts: kind === 'undeclared' ? [] : [{ purpose: 'selected-account', service, required: false,
            materializationKinds: [kind === 'environment' ? 'environment' : 'files'] }],
        })) },
      }));
      const pluginDaemon = join(pluginRoot, 'daemon.mjs');
      writeFileSync(pluginDaemon, readFileSync(pluginDaemon, 'utf8').replace('sessionRunnerFactory: {',
        `connectedAccountLaunch: ${JSON.stringify(connectedAccountLaunch)},
          preflightSessionControls: { probeCatalogs: async () => ({ commands: [{ name: 'unscoped-command' }], skills: null }) },
          sessionRunnerFactory: {`));
      await seedCurrentLocalPathPluginFixture({ happyHomeDir: home, pluginRoot, pluginId, manifestVersion: manifest.version });
    }
    lease = await pluginReloadController.acquireRuntimeRegistry({ resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({
      happyHomeDir: home, pluginIds: ['happier.agent.codex', 'happier.agent.ohmypi', SAMPLE_PLUGIN_ID, ...emptyConsumerPluginIds], connectedAccounts: purposeOwner,
      accountSettingsRecordAdapter: { async bindOperation() { return {
        async readRecord(model) { return model.identity.pluginId === 'happier.agent.ohmypi'
          ? { status: 'present' as const, revision: 1, values: { ohMyPiAgentDir: configuredNativeHome } }
          : { status: 'absent' as const }; },
        async writeRecord() { return { status: 'unavailable' as const }; },
      }; } },
      qualifiedConnectedAccountEstablishedRuntimeOwner: established,
      resolveDevelopmentSourceAuthority: ({ rootPath }) => {
        const authority = bindPluginRuntimeSourceAuthority({ custody: { kind: 'development', registeredRootId: rootPath },
          resolvedRoot: rootPath, observedRevision: 0 });
        if (authority.kind !== 'development') throw new Error('Expected development authority'); return authority;
      },
    }) });
    capture = join(root, 'native-capture.json');
    const codex = join(root, 'codex.mjs');
    writeFileSync(codex, `#!${process.execPath}\nimport {existsSync,readFileSync,writeFileSync} from 'node:fs';
      const auth=JSON.parse(readFileSync(process.env.CODEX_HOME+'/auth.json','utf8'));
      writeFileSync(${JSON.stringify(capture)},JSON.stringify({nativeHome:process.env.CODEX_HOME,pid:process.pid,selected:auth.tokens.access_token==='fixture-access'}));
      let buffer=''; process.stdin.on('data',chunk=>{buffer+=chunk;const lines=buffer.split('\\n');buffer=lines.pop()||'';
        for(const line of lines){if(!line.trim())continue;const req=JSON.parse(line);if(req.id===undefined)continue;
          if(req.method==='skills/list'&&existsSync(${JSON.stringify(join(root,'hang-native'))}))continue;
          const result=req.method==='skills/list'?{data:[{skills:[{name:'selected-skill',path:'/fixture/selected/SKILL.md',enabled:true}]}]}:{};
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');}});`);
    chmodSync(codex, 0o755);
    const omp = join(root, 'omp.mjs');
    writeFileSync(omp, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
      writeFileSync(${JSON.stringify(capture)},JSON.stringify({nativeHome:process.env.PI_CODING_AGENT_DIR,pid:process.pid}));
      const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
      let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;const lines=buffer.split('\\n');buffer=lines.pop()||'';
        for(const line of lines){if(!line.trim())continue;const req=JSON.parse(line);if(req.id===undefined)continue;
          if(req.method==='initialize')send({id:req.id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{close:{}}}}});
          else if(req.method==='session/new'){send({id:req.id,result:{sessionId:'native-fixture'}});
            send({method:'session/update',params:{sessionId:'native-fixture',update:{sessionUpdate:'available_commands_update',availableCommands:[{name:'native-command',description:'Native fixture command'}]}}});}
          else send({id:req.id,result:{}});}});`);
    chmodSync(omp, 0o755);
    for (const [name, script] of [['codex', codex], ['omp', omp]]) {
      writeExecutableShimSync({ dir: root, fileName: process.platform === 'win32' ? `${name}.cmd` : name,
        contents: process.platform === 'win32'
          ? `@"${process.execPath}" "${script}" %*\r\n`
          : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
      });
    }
    process.env.PATH = `${root}${delimiter}${process.env.PATH ?? ''}`;
    process.env.HAPPIER_CODEX_PATH = codex;
    process.env.HAPPIER_OHMYPI_PATH = omp;
    process.env.HAPPIER_OH_MY_PI_PATH = omp;
  }, 90_000);
  afterEach(async () => {
    filesystemBoundary.gate = undefined; filesystemBoundary.rejectedRemoval = undefined;
    holdNativeCredential = false; releaseCredentialRead?.(); releaseCredentialRead = undefined; credentialReadEntered = undefined;
    await machineClient?.shutdown(); machineClient = undefined;
    rmSync(capture, { force: true }); rmSync(join(root, 'hang-native'), { force: true });
  });
  afterAll(async () => {
    await lease?.release(); await pluginReloadController.shutdown(); vi.restoreAllMocks();
    process.env = originalEnvironment; reloadConfiguration(); if (root) rmSync(root, { recursive: true, force: true });
  });
  const connectedServices = { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
    source: 'connected', selection: 'profile', profileId: 'selected' } } };
  function directRpc() {
    return createEncryptedRpcTestClient({ scopePrefix: 'qualified-catalog', registerHandlers: manager => registerCapabilitiesHandlers(manager, {
      createApiClient, activatePurposeBindings: input => purposeOwner.activatePurposeBindings(input),
    }) });
  }
  function finalMachineRpc() {
    const machine: Machine = { id: 'catalog-machine', encryptionKey: credentials.encryption.secret, encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
    machineClient = new ApiMachineClient(credentials.token, machine, undefined, { createCapabilitiesApiClient: createApiClient });
    machineClient.registerConnectedAccountPurposeBindingRuntime({ activatePurposeBindings: input => purposeOwner.activatePurposeBindings(input),
      listActionFormConnectedAccountOptions: async () => { throw new Error('Unexpected Action account listing'); } });
    machineClient.setRPCHandlers({ spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      stopSession: async () => true, requestShutdown: () => undefined });
    // The existing Machine test boundary exposes its real private RPC manager.
    return createEncryptedRpcTestClient({ scopePrefix: machine.id, encryptionKey: machine.encryptionKey,
      manager: (machineClient as unknown as { rpcHandlerManager: RpcHandlerManager }).rpcHandlerManager,
      registerHandlers() {},
    });
  }
  async function prepareAuth(agentId: string, signal: AbortSignal, cleanupScope: ReturnType<typeof createPreflightCatalogCleanupScope>) {
    const catalogEntry = await lease.registry.acquireAgentCatalogEntry?.(agentId);
    const consumer = lease.registry.contributes.agentDefinitionsById.get(agentId)?.identity;
    if (!consumer) throw new Error('Fixture Agent identity unavailable');
    const identity = generateConnectedServiceMaterializationIdentityV1();
    return resolveConnectedServiceAuthForSpawn({
      agentId, connectedServicesBindingsRaw: connectedServices, credentials, api: await createApiClient(),
      materializationKey: identity.id, activeServerDir: configuration.activeServerDir,
      baseDir: join(home, 'daemon', 'connected-services', 'materialized'), sessionDirectory: root,
      signal, retainCleanup: cleanupScope.retain,
      resolveQualifiedPurposeBindingSnapshot: bindings => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
        agentId, bindings, contributions: lease.registry.contributes, catalogEntry,
      }),
      activateQualifiedPurposeBindings: snapshot => purposeOwner.activatePurposeBindings({
        subject: { kind: 'operation', operationId: identity.id, consumer, isCurrent: () => !signal.aborted },
        purposes: snapshot.purposes, bindings: snapshot.bindings,
      }),
    });
  }
  it.each(['mkdir', 'open'] as const)('waits for a started host %s before cancel cleanup and prevents artifact resurrection', async kind => {
    const controller = new AbortController();
    const cleanupScope = createPreflightCatalogCleanupScope();
    let release = () => {};
    const wait = new Promise<void>(resolve => { release = resolve; });
    let enteredPath = '';
    const entered = new Promise<void>(resolve => { filesystemBoundary.gate = { kind, wait,
      entered(path) { enteredPath = path; resolve(); } }; });
    const preparation = prepareAuth(kind === 'mkdir' ? 'codex' : 'acme.empty-file-success/sample-provider', controller.signal, cleanupScope);
    const outcome = preparation.then(() => null, error => error);
    await entered;
    controller.abort();
    const disposal = cleanupScope.dispose();
    let settled = false;
    void disposal.then(() => { settled = true; }, () => { settled = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      if (kind === 'open') expect(existsSync(dirname(enteredPath))).toBe(true);
    } finally {
      filesystemBoundary.gate = undefined; release();
      await disposal;
    }
    expect(await outcome).toBeInstanceOf(Error);
    expect(existsSync(kind === 'mkdir' ? enteredPath : dirname(enteredPath))).toBe(false);
    expect(existsSync(capture)).toBe(false);
    // A subsequent selected operation must remain available after the canceled producer settles.
    expect(await directRpc().call(RPC_METHODS.CAPABILITIES_INVOKE, { id: 'cli.codex', method: 'probeCatalogs',
      params: { cwd: root, timeoutMs: 10_000, connectedServices, runtimeKindOverride: 'appServer' } }))
      .toMatchObject({ ok: true });
  }, 30_000);
  it('surfaces an OS cleanup failure and keeps a late credential response from launching discovery', async () => {
    holdNativeCredential = true;
    const entered = new Promise<void>(resolve => { credentialReadEntered = resolve; });
    const controller = new AbortController();
    const cleanupScope = createPreflightCatalogCleanupScope();
    const outcome = prepareAuth('codex', controller.signal, cleanupScope).then(() => null, error => error);
    await entered;
    const attempt = heldAttemptRoots[0]!;
    filesystemBoundary.rejectedRemoval = attempt;
    controller.abort();
    await expect(cleanupScope.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(existsSync(attempt)).toBe(true);
    filesystemBoundary.rejectedRemoval = undefined;
    releaseCredentialRead?.();
    expect(await outcome).toBeInstanceOf(Error);
    expect(existsSync(capture)).toBe(false);
    // Restore the intentionally denied OS artifact for isolation of later fixture operations.
    rmSync(attempt, { recursive: true, force: true });
    holdNativeCredential = false;
    expect(await directRpc().call(RPC_METHODS.CAPABILITIES_INVOKE, { id: 'cli.codex', method: 'probeCatalogs',
      params: { cwd: root, timeoutMs: 10_000, connectedServices, runtimeKindOverride: 'appServer' } }))
      .toMatchObject({ ok: true });
  }, 30_000);
  it('retains selected account materialization after the final machine-owned registration', async () => {
    const result = await finalMachineRpc().call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex', method: 'probeCatalogs', params: { cwd: root, timeoutMs: 10_000, connectedServices,
        runtimeKindOverride: 'appServer' },
    });
    expect(result).toMatchObject({ ok: true, result: { skills: { supported: true,
      items: [expect.objectContaining({ name: 'selected-skill', origin: 'vendor' })] } } });
    const observation = JSON.parse(readFileSync(capture, 'utf8')) as { nativeHome: string; selected: boolean; pid: number };
    expect(observation.selected).toBe(true);
    expect(existsSync(observation.nativeHome)).toBe(false);
    expect(() => process.kill(observation.pid, 0)).toThrow();
  }, 30_000);
  it('removes the selected native auth root before a timed-out final Machine RPC returns', async () => {
    writeFileSync(join(root, 'hang-native'), 'hang');
    const result = await finalMachineRpc().call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex', method: 'probeCatalogs', params: { cwd: root, timeoutMs: 5_000, connectedServices,
        runtimeKindOverride: 'appServer' },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'preflight-catalog-unavailable' } });
    const observation = JSON.parse(readFileSync(capture, 'utf8')) as { nativeHome: string; selected: boolean; pid: number };
    expect(observation.selected).toBe(true);
    expect(existsSync(observation.nativeHome)).toBe(false);
    expect(() => process.kill(observation.pid, 0)).toThrow();
  }, 30_000);
  it('removes a hanging auth staging root and prevents late credential continuation from launching native discovery', async () => {
    holdNativeCredential = true;
    heldAttemptRoots = [];
    const entered = new Promise<void>(resolve => { credentialReadEntered = resolve; });
    const response = directRpc().call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex', method: 'probeCatalogs', params: { cwd: root, timeoutMs: 5_000,
        connectedServices, runtimeKindOverride: 'appServer' },
    });
    await entered;
    expect(heldAttemptRoots.length).toBeGreaterThan(0);
    expect(await response).toMatchObject({ ok: false, error: { code: 'preflight-catalog-unavailable' } });
    for (const path of heldAttemptRoots) expect(existsSync(path)).toBe(false);
    expect(heldCredentialSignal?.aborted).toBe(true);
    expect(existsSync(capture)).toBe(false);
    releaseCredentialRead?.();
    // Let the already-returned HTTP response and its awaited promise continuations run.
    await new Promise<void>(resolve => setImmediate(resolve));
    for (const path of heldAttemptRoots) expect(existsSync(path)).toBe(false);
    expect(existsSync(capture)).toBe(false);
  }, 30_000);
  it('refuses a selected bound purpose whose native launch materialization is undeclared', async () => {
    expect(await directRpc().call(RPC_METHODS.CAPABILITIES_INVOKE, { id: 'cli.ohMyPi', method: 'probeCatalogs',
      params: { cwd: root, timeoutMs: 10_000, connectedServices } }))
      .toMatchObject({ ok: false, error: { code: 'connected-service-preflight-failed' } });
    expect(existsSync(capture)).toBe(false);
  }, 30_000);
  it('materializes qualified selection metadata for an external Agent before discovery', async () => {
    expect(await directRpc().call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: `cli.${SAMPLE_PLUGIN_ID}/sample-provider`, method: 'probeCatalogs',
      params: { cwd: root, timeoutMs: 10_000, connectedServices },
    })).toMatchObject({ ok: false, error: { code: 'connected-service-preflight-failed' } });
  }, 30_000);
  it('refuses selected native discovery when the Agent declares no Connected Account services', async () => {
    expect(await directRpc().call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.acme.empty-undeclared/sample-provider', method: 'probeCatalogs',
      params: { cwd: root, timeoutMs: 10_000, connectedServices },
    })).toMatchObject({ ok: false, error: { code: 'connected-service-preflight-failed' } });
  }, 30_000);
  it('keeps native-only binding discovery available without materializing a Connected Account', async () => {
    expect(await directRpc().call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.ohMyPi', method: 'probeCatalogs',
      params: { cwd: root, timeoutMs: 10_000, connectedServices: { v: 2,
        bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'native' } } } },
    })).toMatchObject({ ok: true, result: { commands: { supported: true, items: [{ command: 'native-command' }] } } });
    const observation = JSON.parse(readFileSync(capture, 'utf8')) as { nativeHome: string };
    expect(observation.nativeHome).toBe(configuredNativeHome);
  }, 30_000);
  it.each(['environment', 'file', 'native-home'])('refuses selected %s discovery when its declared destination receives no credential bytes', async kind => {
    expect(await directRpc().call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: `cli.acme.empty-${kind}/sample-provider`, method: 'probeCatalogs',
      params: { cwd: root, timeoutMs: 10_000, connectedServices },
    })).toMatchObject({ ok: false, error: { code: 'connected-service-preflight-failed' } });
  }, 30_000);
  it('keeps native OhMyPi discovery available without a selected Connected Account', async () => {
    expect(await directRpc().call(RPC_METHODS.CAPABILITIES_INVOKE, { id: 'cli.ohMyPi', method: 'probeCatalogs',
      params: { cwd: root, timeoutMs: 10_000 } }))
      .toMatchObject({ ok: true, result: { commands: { supported: true, items: [{ command: 'native-command' }] },
        skills: { supported: false, items: [] } } });
    const observation = JSON.parse(readFileSync(capture, 'utf8')) as { pid: number; nativeHome: string };
    expect(observation.nativeHome).toBe(configuredNativeHome);
    expect(() => process.kill(observation.pid, 0)).toThrow();
  }, 30_000);
  it('drains the retired runtime after cancellation while credential HTTP remains unsettled', async () => {
    // Release the fixture's caller lease so only the live materializer can retain this runtime.
    await lease.release();
    holdNativeCredential = true;
    const entered = new Promise<void>(resolve => { credentialReadEntered = resolve; });
    const controller = new AbortController();
    const cleanupScope = createPreflightCatalogCleanupScope();
    const outcome = prepareAuth('codex', controller.signal, cleanupScope).then(() => null, error => error);
    await entered;
    controller.abort();
    await cleanupScope.dispose();
    let drained = false;
    const shutdown = pluginReloadController.shutdown().then(() => { drained = true; });
    try {
      // Observe the real controller's lease drain; HTTP intentionally remains held.
      await expect.poll(() => drained).toBe(true);
      expect(heldCredentialSignal?.aborted).toBe(true);
      expect(existsSync(capture)).toBe(false);
    } finally {
      releaseCredentialRead?.();
      await outcome;
      await shutdown;
    }
    for (const path of heldAttemptRoots) expect(existsSync(path)).toBe(false);
    expect(existsSync(capture)).toBe(false);
  }, 30_000);
});
