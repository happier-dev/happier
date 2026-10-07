import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  FeaturesResponseSchema, PluginManifestV2Schema, QualifiedConnectedAccountCredentialSnapshotV4Schema,
  QualifiedConnectedAccountListResponseV4Schema, sealQualifiedConnectedAccountContentEnvelope,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { ApiClient } from '@/api/api';
import type { Machine } from '@/api/types';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { reloadConfiguration } from '@/configuration';
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
import { materializeSamplePluginFixture, SAMPLE_PLUGIN_ID } from '@/plugins/testkit/samplePackage';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';

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
    lease = await pluginReloadController.acquireRuntimeRegistry({ resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({
      happyHomeDir: home, pluginIds: ['happier.agent.codex', 'happier.agent.ohmypi', SAMPLE_PLUGIN_ID], connectedAccounts: purposeOwner,
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
            send({method:'session/update',params:{sessionId:'native-fixture',update:{sessionUpdate:'available_commands_update',availableCommands:[{name:'native-command'}]}}});}
          else send({id:req.id,result:{}});}});`);
    chmodSync(omp, 0o755);
    process.env.HAPPIER_CODEX_PATH = codex;
    process.env.HAPPIER_OHMYPI_PATH = omp;
    process.env.HAPPIER_OH_MY_PI_PATH = omp;
  }, 90_000);
  afterEach(async () => {
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
    return { machine, rpc: (machineClient as unknown as { rpcHandlerManager: RpcHandlerManager }).rpcHandlerManager };
  }
  it('retains selected account materialization after the final machine-owned registration', async () => {
    const { machine, rpc } = finalMachineRpc();
    const encoded = await rpc.handleRequest({ method: `${machine.id}:${RPC_METHODS.CAPABILITIES_INVOKE}`,
      params: encodeBase64(encrypt(machine.encryptionKey, machine.encryptionVariant, {
        id: 'cli.codex', method: 'probeCatalogs', params: { cwd: root, timeoutMs: 10_000, connectedServices,
          runtimeKindOverride: 'appServer' },
      })) });
    const result = decrypt(machine.encryptionKey, machine.encryptionVariant, decodeBase64(encoded));
    expect(result).toMatchObject({ ok: true, result: { skills: { supported: true,
      items: [expect.objectContaining({ name: 'selected-skill', origin: 'vendor' })] } } });
    const observation = JSON.parse(readFileSync(capture, 'utf8')) as { nativeHome: string; selected: boolean; pid: number };
    expect(observation.selected).toBe(true);
    expect(existsSync(observation.nativeHome)).toBe(false);
    expect(() => process.kill(observation.pid, 0)).toThrow();
  }, 30_000);
  it('removes the selected native auth root before a timed-out final Machine RPC returns', async () => {
    writeFileSync(join(root, 'hang-native'), 'hang');
    const { machine, rpc } = finalMachineRpc();
    const encoded = await rpc.handleRequest({ method: `${machine.id}:${RPC_METHODS.CAPABILITIES_INVOKE}`,
      params: encodeBase64(encrypt(machine.encryptionKey, machine.encryptionVariant, {
        id: 'cli.codex', method: 'probeCatalogs', params: { cwd: root, timeoutMs: 5_000, connectedServices,
          runtimeKindOverride: 'appServer' },
      })) });
    const result = decrypt(machine.encryptionKey, machine.encryptionVariant, decodeBase64(encoded));
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
  it('keeps native OhMyPi discovery available without a selected Connected Account', async () => {
    expect(await directRpc().call(RPC_METHODS.CAPABILITIES_INVOKE, { id: 'cli.ohMyPi', method: 'probeCatalogs',
      params: { cwd: root, timeoutMs: 10_000 } }))
      .toMatchObject({ ok: true, result: { commands: { supported: true, items: [{ command: 'native-command' }] },
        skills: { supported: false, items: [] } } });
    const observation = JSON.parse(readFileSync(capture, 'utf8')) as { pid: number; nativeHome: string };
    expect(observation.nativeHome).toBe(configuredNativeHome);
    expect(() => process.kill(observation.pid, 0)).toThrow();
  }, 30_000);
});
