import { readFile, writeFile } from 'node:fs/promises';
import fs, { promises as filesystem } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { createInstalledMachineRpcRelay } from '@/daemon/testkit/installedMachineRpcRelay.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';
import { createDeferred } from '@/testkit/async/deferred';

const filesystemBoundary = vi.hoisted(() => ({
  afterDirectory: null as ((prefix: unknown, directory: unknown) => Promise<void>) | null,
  beforePublication: null as ((path: unknown) => void) | null,
}));
// Named fs/promises imports are distinct from fs.promises properties. Replace
// only the actual OS boundary exports, delegating every operation to the OS.
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs,
    mkdtemp: async (...args: Parameters<typeof fs.mkdtemp>) => {
      const directory = await fs.mkdtemp(...args);
      await filesystemBoundary.afterDirectory?.(args[0], directory);
      return directory;
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      filesystemBoundary.beforePublication?.(args[1]);
      return await fs.rename(...args);
    },
  };
});
afterEach(() => {
  filesystemBoundary.afterDirectory = null;
  filesystemBoundary.beforePublication = null;
});

// Real server socket registration/forwarding reads its own persistence boundary.
// The installed receiver retains actual Home signatures/currentness verification.
vi.mock('../../../../server/sources/storage/db', () => ({ db: { machine: {
  findFirst: async () => ({ revokedAt: null, replacedByMachineId: null }),
  findUnique: async () => ({ id: 'machine-1', kind: 'persistent', accountId: 'account-1', installationId: null }),
} } }));

const child = String.raw`
const fs = require('node:fs');
fs.writeFileSync(process.argv[1], 'started');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize' ? {
    protocolVersion:request.params.protocolVersion, capabilities:{tools:{}},
    serverInfo:{name:'admitted-probe',version:'1'}
  } : {tools:[{name:'useful_owner_tool',inputSchema:{type:'object'}}]};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
`;

describe('Machine MCP Test through Home relay and installed admission', () => {
  it('rechecks withdrawn Machine custody inside private MCP materialization before publishing bytes or spawning (S0-6)', async () => {
    const f = await createInstalledFilesystemMachineFixture();
    const marker = join(f.directory, 'withdrawn-mcp-child');
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    let privateDirectory: string | undefined;
    let publishedFiles = 0;
    let holdPreparation = false;
    // Hold genuine filesystem preparation, not the materializer or its policy.
    // The prefix belongs to the real secure writer selected by literal env.
    filesystemBoundary.afterDirectory = async (prefix, directory) => {
      if (holdPreparation && String(prefix).includes('happier-mcp-stdio-launcher-')) {
        if (typeof directory !== 'string') throw new Error('Expected string temporary directory');
        privateDirectory = directory;
        entered.resolve();
        await release.promise;
      }
    };
    filesystemBoundary.beforePublication = path => {
      if (privateDirectory && dirname(String(path)) === privateDirectory) publishedFiles++;
    };
    registerMachineMcpServersRpcHandlers({ rpcHandlerManager: f.rpcHandlerManager, deps: {
      hostHomeServerIdentityId: f.homeServerIdentityId, serverHttpBaseUrl: f.serverHttpBaseUrl,
      env: { PATH: process.env.PATH }, readCredentials: async () => f.bootstrap.credentials,
    } });
    const relay = await createInstalledMachineRpcRelay({ manager: f.rpcHandlerManager,
      machineId: f.machineId, transportOwnerAccountId: 'account-1', methods: [RPC_METHODS.DAEMON_MCP_SERVERS_TEST] });
    const invoke = () => relay.invoke(RPC_METHODS.DAEMON_MCP_SERVERS_TEST,
      { t: 'draft', machineId: f.machineId, directory: f.directory, binding: null,
        server: { id: 'private-probe', name: 'private-probe', transport: 'stdio',
          stdio: { command: process.execPath, args: ['-e', child, marker] },
          env: { PRIVATE_INPUT: { t: 'literal', v: 'private-fixture-input' } }, createdAt: 1, updatedAt: 1 } },
      { callerAuthority: 'account_automation', machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester',
        machineId: f.machineId, installationId: f.installation.installationId, role: 'manage', encryptionMode: 'plain' } });
    try {
      await expect(invoke()).resolves.toMatchObject({ ok: true, toolNamesSample: ['useful_owner_tool'] });
      expect(await readFile(marker, 'utf8')).toBe('started');
      await writeFile(marker, 'settled-before-withdrawal');
      holdPreparation = true;
      const response = invoke();
      // Observe immediately so failed setup cannot leave a rejection orphaned.
      const settled = Promise.allSettled([response]);
      try {
        await Promise.race([entered.promise, response.then(() => { throw new Error('Private preparation was not reached'); })]);
        f.retire();
        release.resolve();
        const result = await response;
        expect({ publishedFiles, result }).toMatchObject({ publishedFiles: 0,
          result: { errorCode: 'agent_isolation_unavailable' } });
        expect(await readFile(marker, 'utf8')).toBe('settled-before-withdrawal');
        await expect(filesystem.stat(privateDirectory!)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { release.resolve(); await settled; }
    } finally { await relay.close(); }
  }, 120_000); // Same installed/native composition lifetime as the attach corridor; no product timeout.

  it('detects useful native configuration for the owner but discloses none after member or mid-read Home withdrawal', async () => {
    const f = await createInstalledFilesystemMachineFixture();
    const env = createEnvKeyScope(['CODEX_HOME']);
    env.patch({ CODEX_HOME: f.directory });
    onTestFinished(() => env.restore());
    const configPath = join(f.directory, 'config.toml');
    await writeFile(configPath, '[mcp_servers.admitted_native]\ncommand = "native-config-only"\nargs = []\nenv = { PRIVATE_VALUE = "synthetic-private-value" }\n');
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
    onTestFinished(() => runtime.dispose());
    await runtime.registry.activateContributionsOnDemand((runtime.registry.contributes.mcpDiscoverySources ?? []).flatMap(source =>
      source.pluginId ? [{ pluginId: source.pluginId, family: 'mcp.discoverySources' as const, localId: source.definition.id }] : []));
    registerMachineMcpServersRpcHandlers({ rpcHandlerManager: f.rpcHandlerManager, deps: {
      hostHomeServerIdentityId: f.homeServerIdentityId, serverHttpBaseUrl: f.serverHttpBaseUrl,
      env: { CODEX_HOME: f.directory },
    } });
    let nativeReads = 0;
    let retireAfterRead = false;
    // The actual native filesystem boundary is observed; discovery, plugin
    // admission and Home authority verification remain production logic.
    const readNativeFile = fs.readFileSync;
    // Codex's actual config reader uses synchronous builtin IO. Synchronize the
    // builtin named export too for the admitted native plugin loader.
    const readBoundary = vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
      const bytes = readNativeFile(...args);
      if (args[0] === configPath) {
        nativeReads++;
        if (retireAfterRead) f.retire();
      }
      return bytes;
    });
    syncBuiltinESMExports();
    onTestFinished(() => { readBoundary.mockRestore(); syncBuiltinESMExports(); });
    const relay = await createInstalledMachineRpcRelay({ manager: f.rpcHandlerManager,
      machineId: f.machineId, transportOwnerAccountId: 'account-1', methods: [RPC_METHODS.DAEMON_MCP_SERVERS_DETECT] });
    const invoke = (actorAccountId = 'requester') => relay.invoke(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT,
      { machineId: f.machineId, providers: ['codex'] },
      { callerAuthority: 'present_user', machineAdmission: { actorAccountId, custodianAccountId: 'requester',
        machineId: f.machineId, installationId: f.installation.installationId, role: 'manage', encryptionMode: 'plain' } });
    try {
      const positive = await invoke();
      expect(positive).toMatchObject({ ok: true, servers: expect.arrayContaining([
        expect.objectContaining({ name: 'admitted_native', envKeys: ['PRIVATE_VALUE'] }),
      ]) });
      expect(JSON.stringify(positive)).not.toContain('synthetic-private-value');
      expect(nativeReads).toBeGreaterThan(0);
      const readsAfterPositive = nativeReads;
      await expect(invoke('member')).resolves.toMatchObject({ errorCode: 'agent_isolation_unavailable' });
      expect(nativeReads).toBe(readsAfterPositive);
      retireAfterRead = true;
      const withdrawn = await invoke();
      expect(nativeReads).toBeGreaterThan(readsAfterPositive);
      expect(withdrawn).toMatchObject({ errorCode: 'agent_isolation_unavailable' });
      expect(JSON.stringify(withdrawn)).not.toContain('admitted_native');
    } finally { await relay.close(); }
  });

  it.each(['present_user', 'account_automation'] as const)(
    'preserves useful %s probes and refuses member or withdrawn preparation before the actual child', async callerAuthority => {
      const f = await createInstalledFilesystemMachineFixture();
      const marker = join(f.directory, 'mcp-probe-started');
      let retireOnCredentialRead = false;
      let credentialReads = 0;
      registerMachineMcpServersRpcHandlers({ rpcHandlerManager: f.rpcHandlerManager, deps: {
        hostHomeServerIdentityId: f.homeServerIdentityId, serverHttpBaseUrl: f.serverHttpBaseUrl,
        env: { PATH: process.env.PATH },
        // The admitted fixture's original credentials are the persistent-file
        // boundary result. No internal catalog/material/launch owner is mocked.
        readCredentials: async () => {
          credentialReads++;
          await Promise.resolve();
          if (retireOnCredentialRead) f.retire();
          return f.bootstrap.credentials;
        },
      } });
      const relay = await createInstalledMachineRpcRelay({ manager: f.rpcHandlerManager,
        machineId: f.machineId, transportOwnerAccountId: 'account-1', methods: [RPC_METHODS.DAEMON_MCP_SERVERS_TEST] });
      const invoke = (actorAccountId = 'requester', role: 'use' | 'manage' = 'manage') => relay.invoke(
        RPC_METHODS.DAEMON_MCP_SERVERS_TEST, { t: 'draft', machineId: f.machineId, directory: f.directory,
          binding: null, server: { id: 'probe', name: 'probe', transport: 'stdio',
            stdio: { command: process.execPath, args: ['-e', child, marker] }, env: {}, createdAt: 1, updatedAt: 1 } },
        { callerAuthority, machineAdmission: { actorAccountId, custodianAccountId: 'requester',
          machineId: f.machineId, installationId: f.installation.installationId, role, encryptionMode: 'plain' } });
      try {
        await expect(invoke()).resolves.toMatchObject({ ok: true, toolNamesSample: ['useful_owner_tool'] });
        expect(await readFile(marker, 'utf8')).toBe('started');
        await writeFile(marker, 'settled-before-next-probe');
        const readsAfterPositive = credentialReads;
        for (const role of ['use', 'manage'] as const) {
          await expect(invoke('member', role)).resolves.toMatchObject({ errorCode: 'agent_isolation_unavailable' });
        }
        expect(credentialReads).toBe(readsAfterPositive);
        expect(await readFile(marker, 'utf8')).toBe('settled-before-next-probe');
        retireOnCredentialRead = true;
        await expect(invoke()).resolves.toMatchObject({ errorCode: 'agent_isolation_unavailable' });
        expect(credentialReads).toBe(readsAfterPositive + 1);
        expect(await readFile(marker, 'utf8')).toBe('settled-before-next-probe');
        expect(f.admissionChecks()).toBeGreaterThan(0);
      } finally { await relay.close(); }
    });
});
