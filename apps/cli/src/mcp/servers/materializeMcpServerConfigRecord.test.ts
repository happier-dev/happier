import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:https';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createEphemeralTlsServerFixture } from '../../../../../packages/tests/src/testkit/tls/ephemeralTlsServerFixture.mjs';

import {
  McpServersSettingsV1Schema,
  deriveAccountMachineKeyFromRecoverySecret,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
  resolveSessionCapabilitiesV1,
  projectMcpServerMaterializationV1,
  type McpServersSettingsV1,
  sealSavedSecretResourceStoredContentV1,
  type SavedSecretCatalogResourceV1,
} from '@happier-dev/protocol';

function resolveMcpMaterialization(settings: McpServersSettingsV1, context: { machineId: string; directory: string }) {
  return projectMcpServerMaterializationV1(resolveSessionCapabilitiesV1({ context: { ...context, machinePlatform: null, projectKey: null, agentId: null },
    mcp: settings, skills: null, selection: {}, agentAcceptsUserMcp: true }), context.directory);
}

import { projectPath } from '@/projectPath';
import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';
import { readRetainedMcpServerCatalogSourceV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { resolvePackagedRuntimeEntrypoint } from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import { resolveCliTsxTsconfigPath, resolveTsxImportHookPath } from '@/utils/spawnHappyCLI';
import {
  createSavedSecretMaterializerV1,
  type SavedSecretCatalogResourceInputV1,
} from '@/settings/secrets/savedSecretCatalog';

import { listSelectedMcpSharedSecretReferences, materializeMcpServerConfigRecord } from './materializeMcpServerConfigRecord';

function deterministicRandomBytesFactory(): (length: number) => Uint8Array {
  let counter = 1;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = counter & 0xff;
      counter++;
    }
    return out;
  };
}

describe('materializeMcpServerConfigRecord', () => {
  it('hydrates URL template secrets and resolves them only inside the private bridge configuration', async () => {
    const secretRef = 'happier:shared-secret:v1:url-key';
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{ id: 'remote', name: 'remote',
      transport: 'http', remote: { url: 'https://example.test/mcp', headers: {}, urlTemplate: {
        t: 'template', template: 'https://example.test/mcp?api_key={key}', vars: { key: { t: 'savedSecret', secretId: secretRef } },
      } }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [{ id: 'on', serverId: 'remote', enabled: true,
        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] });
    const resolved = resolveMcpMaterialization(settings, { machineId: 'machine', directory: '/repo' });
    expect(listSelectedMcpSharedSecretReferences(resolved.serversByName)).toEqual([{ ref: secretRef }]);
    const savedSecretMaterializer = createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [],
      resourceCatalogState: 'ready', resources: [{ resourceId: 'url-key', ownerAccountId: 'owner', displayName: 'key',
        kind: 'token', encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'url-key', mode: 'plain',
          content: { v: 1, name: 'key', kind: 'token', value: 'private-url-key' } }) }] });
    const result = await materializeMcpServerConfigRecord({ resolved, savedSecretMaterializer, processEnv: {}, tmpDir: null,
      deps: { resolveRemoteBridgeCommand: () => ({ command: 'fixture-bridge', args: [] }) } });
    try {
      expect(JSON.stringify(result.mcpServers)).not.toContain('private-url-key');
      const path = result.mcpServers.remote!.env!.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE!;
      expect(JSON.parse(await readFile(path, 'utf8')).url).toBe('https://example.test/mcp?api_key=private-url-key');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(result.sanitizeDiagnosticText('private-url-key')).toBe('[REDACTED]');
    } finally { result.cleanup(); }
    await expect(materializeMcpServerConfigRecord({ resolved, processEnv: {}, tmpDir: null, strictMode: false,
      savedSecretMaterializer: createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [],
        resourceCatalogState: 'ready', resources: [] }) })).rejects.toMatchObject({
      code: 'saved_secret_resolution_failed', field: 'url', reference: secretRef,
    });
  });

  it('refuses a resolved OAuth URL template outside its request-auth resource', async () => {
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{ id: 'oauth', name: 'oauth',
      transport: 'http', remote: { url: 'https://example.test/mcp', headers: {}, auth: { kind: 'oauth' }, urlTemplate: {
        t: 'template', template: 'https://example.test/{tenant}/mcp', vars: { tenant: { t: 'literal', v: 'different' } },
      } }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [{ id: 'on', serverId: 'oauth', enabled: true,
        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] });
    const resolved = resolveMcpMaterialization(settings, { machineId: 'machine', directory: '/repo' });
    await expect(materializeMcpServerConfigRecord({ resolved, processEnv: {}, tmpDir: null,
      requestAuthByServerId: { oauth: { capabilityFile: '/private/capability', resource: 'https://example.test/mcp' } },
    }).then(result => { result.cleanup(); return result; })).rejects.toThrow('mcp_resource_mismatch');
    const matching = await materializeMcpServerConfigRecord({ resolved, processEnv: {}, tmpDir: null,
      requestAuthByServerId: { oauth: { capabilityFile: '/private/capability', resource: 'https://example.test/different/mcp' } },
      deps: { resolveRemoteBridgeCommand: () => ({ command: 'fixture-bridge', args: [] }) } });
    matching.cleanup();
  });
  it('preserves strict-mode handling for an unavailable URL template variable', async () => {
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: false, servers: [{ id: 'remote', name: 'remote',
      transport: 'http', remote: { url: 'https://example.test/mcp', headers: {}, urlTemplate: {
        t: 'template', template: 'https://example.test/{tenant}/mcp', vars: { tenant: { t: 'literal', v: '${TENANT}' } },
      } }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [{ id: 'on', serverId: 'remote', enabled: true,
        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] });
    const resolved = resolveMcpMaterialization(settings, { machineId: 'machine', directory: '/repo' });
    const result = await materializeMcpServerConfigRecord({ resolved, processEnv: {}, tmpDir: null });
    expect(result.mcpServers).toEqual({});
    expect(result.warnings).toEqual([{ serverName: 'remote', code: 'missing_value_ref', detail: 'url' }]);
    result.cleanup();
    await expect(materializeMcpServerConfigRecord({ resolved, processEnv: {}, tmpDir: null, strictMode: true }))
      .rejects.toThrow('missing url');
  });
  it('redacts a used Saved Secret template atom through the materialization diagnostic lifetime', async () => {
    const savedSecretMaterializer = createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [],
      resourceCatalogState: 'ready', resources: [{ resourceId: 'diagnostic-key', ownerAccountId: 'owner', displayName: 'key',
        kind: 'token', encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'diagnostic-key', mode: 'plain',
          content: { v: 1, name: 'key', kind: 'token', value: 'saved-template-private-atom' } }) }] });
    const config = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{ id: 'remote', name: 'remote',
      transport: 'http', remote: { url: 'https://fixture.example.test/mcp', headers: { Authorization: {
        t: 'template', template: 'Bearer {key}', vars: { key: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:diagnostic-key' } },
      } } }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [{ id: 'on', serverId: 'remote', enabled: true,
        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] });
    const out = await materializeMcpServerConfigRecord({ savedSecretMaterializer, processEnv: {}, tmpDir: null,
      resolved: resolveMcpMaterialization(config, { machineId: 'machine', directory: '/repo' }),
      deps: { resolveRemoteBridgeCommand: () => ({ command: 'fixture-bridge', args: [] }) },
    });
    try {
      expect(out.sanitizeDiagnosticText('echoed saved-template-private-atom')).toBe('echoed [REDACTED]');
      expect(out.sanitizeDiagnosticText('Bearer saved-template-private-atom')).toBe('[REDACTED]');
    } finally { out.cleanup(); }
    expect(out.sanitizeDiagnosticText('saved-template-private-atom')).toBe('saved-template-private-atom');
  });
  it('starts the remote bridge with private startup-sensitive TLS environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-remote-ca-'));
    const tls = await createEphemeralTlsServerFixture();
    const https = createServer({ key: await readFile(tls.privateKeyPath), cert: await readFile(tls.leafCertificatePath) });
    https.on('request', async (request, response) => {
      const mcp = new McpServer({ name: 'tls-boundary', version: '1' });
      mcp.registerTool('ready', {}, async () => ({ content: [{ type: 'text', text: 'ready' }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.once('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    });
    await new Promise<void>(resolve => https.listen(0, '127.0.0.1', resolve));
    const address = https.address();
    if (!address || typeof address === 'string') throw new Error('TLS fixture address unavailable');
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{
      id: 'remote', name: 'remote', transport: 'http', remote: { url: `https://127.0.0.1:${address.port}`, headers: {} },
      env: { NODE_EXTRA_CA_CERTS: { t: 'literal', v: tls.caCertificatePath } }, createdAt: 0, updatedAt: 0,
    }], bindings: [{ id: 'on', serverId: 'remote', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }] });
    // OS executable resolution is the boundary; both bridge and launcher execute current source.
    const invocation = async (entry: 'bridge' | 'launcher') => {
      const command = await resolveNodeBackedMcpServerCommand({
        distEntrypointSegments: ['mcp', entry === 'bridge' ? 'bridges' : 'launchers',
          entry === 'bridge' ? 'remoteMcpStdioBridge.mjs' : 'stdioMcpServerLauncher.mjs'],
        sourceEntrypointSegments: ['mcp', entry === 'bridge' ? 'bridges' : 'launchers',
          entry === 'bridge' ? 'remoteMcpStdioBridge.ts' : 'stdioMcpServerLauncher.ts'], preferSourceEntrypoint: true,
      });
      return { ...command, args: ['--conditions=happier-source', ...command.args] };
    };
    const result = await materializeMcpServerConfigRecord({
      resolved: resolveMcpMaterialization(settings, { machineId: 'm', directory: root }), tmpDir: root, processEnv: {},
      deps: { resolveRemoteBridgeCommand: () => invocation('bridge'), resolveStdioLauncherCommand: () => invocation('launcher') },
    });
    const config = result.mcpServers.remote!;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...config.env })) {
      if (typeof value === 'string') env[key] = value;
    }
    delete env.NODE_EXTRA_CA_CERTS;
    const transport = new StdioClientTransport({ command: config.command, args: config.args, env, stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr += String(chunk); });
    const client = new Client({ name: 'private-env-test', version: '1' }, { capabilities: {} });
    try {
      expect(JSON.stringify(config)).not.toContain(tls.caCertificatePath);
      try { await client.connect(transport); }
      catch (error) { throw new Error(`Private TLS bridge failed; child stderr: ${stderr}`, { cause: error }); }
    } finally {
      await client.close(); await transport.close(); result.cleanup();
      await new Promise<void>(resolve => https.close(() => resolve()));
      await tls.cleanup(); await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
  it('materializes the retained 0.2 winning-binding configuration after canonical transfer', async () => {
    // ../0.2 cd2bb4d853a259ae00ebc3e5981224e3e4bb5380: the winning binding
    // patches the original base, so narrower bindings never inherit Everywhere overrides.
    const opened = readRetainedMcpServerCatalogSourceV1({ mcpServersSettingsV1: { v: 1, servers: [{
      id: 'local', name: 'local', transport: 'stdio', stdio: { command: 'example-mcp', args: ['base'] },
      env: { REGION: { t: 'literal', v: 'original' } }, createdAt: 1, updatedAt: 1,
    }], bindings: [
      { id: 'all', serverId: 'local', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1,
        overrides: { stdio: { args: ['everywhere'] }, envPatch: {
          REGION: { t: 'literal', v: 'everywhere' }, NEW: { t: 'literal', v: 'new' },
        } } },
      { id: 'm1', serverId: 'local', enabled: true, target: { t: 'machine', machineId: 'm1' }, createdAt: 1, updatedAt: 1,
        overrides: { envPatch: { REGION: { t: 'literal', v: 'machine' } } } },
      { id: 'm2', serverId: 'local', enabled: true, target: { t: 'machine', machineId: 'm2' }, createdAt: 1, updatedAt: 1 },
    ] } });
    if (opened.status !== 'opened') throw new Error('Expected complete retained catalog');
    for (const [machineId, args, env] of [
      ['m1', ['base'], { REGION: 'machine' }], ['m2', ['base'], { REGION: 'original' }],
      ['other', ['everywhere'], { REGION: 'everywhere', NEW: 'new' }],
    ] as const) {
      const out = await materializeMcpServerConfigRecord({ tmpDir: null, processEnv: {}, resolved:
        resolveMcpMaterialization({ ...opened.catalog, strictMode: true }, { machineId, directory: '/repo' }),
      });
      try {
        const path = out.mcpServers.local!.env!.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE!;
        expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ command: 'example-mcp', args, env });
      } finally { out.cleanup(); }
    }
  });
  it('starts normalized node stdio in the configured folder through a private config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-session-cwd-'));
    const resolved = resolveMcpMaterialization({ v: 1, strictMode: true, servers: [{
      id: 'local', name: 'local', transport: 'stdio', stdio: { command: process.execPath,
        args: ['-e', 'process.stdout.write(process.cwd())'], cwd: { t: 'path', path: root } },
      env: {}, createdAt: 0, updatedAt: 0,
    }], bindings: [{ id: 'on', serverId: 'local', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }] },
    { machineId: 'm1', directory: tmpdir() });
    const out = await materializeMcpServerConfigRecord({ resolved, tmpDir: root, processEnv: {}, deps: {
      resolveStdioLauncherCommand: () => resolveNodeBackedMcpServerCommand({
        distEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.mjs'],
        sourceEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.ts'], preferSourceEntrypoint: true,
      }),
    } });
    try {
      const config = out.mcpServers.local!;
      expect(config.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE).toBeDefined();
      const child = spawn(config.command, config.args ?? [], { env: { ...process.env, ...config.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject); child.once('close', resolve);
      });
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      expect(stdout).toBe(realpathSync(root));
    } finally { out.cleanup(); await rm(root, { recursive: true, force: true }); }
  });
  it('uses the launcher for ordinary stdio with session cwd even without env', async () => {
    const resolved = resolveMcpMaterialization({ v: 1, strictMode: true, servers: [{
      id: 'local', name: 'local', transport: 'stdio', stdio: {
        command: 'example-mcp', args: [], cwd: { t: 'session' },
      }, env: {}, createdAt: 0, updatedAt: 0,
    }], bindings: [{ id: 'on', serverId: 'local', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }] },
    { machineId: 'm1', directory: '/repo' });
    const out = await materializeMcpServerConfigRecord({ resolved, tmpDir: null, processEnv: {} });
    try {
      const path = out.mcpServers.local!.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
      expect(path).toBeDefined();
      expect(JSON.parse(await readFile(path!, 'utf8'))).toMatchObject({ command: 'example-mcp', args: [], cwd: '/repo', env: {} });
    } finally { out.cleanup(); }
  });
  it('includes shared template variables in the selected hydration census and preserves typed missing-secret failures', async () => {
    const shared = 'happier:shared-secret:v1:template-key';
    const enabled = { id: 'template', name: 'template', transport: 'http' as const,
      remote: { url: 'https://mcp.example.test', headers: { Authorization: {
        t: 'template' as const, template: 'Bearer {key}', vars: { key: { t: 'savedSecret' as const, secretId: shared } },
      } } }, env: {}, createdAt: 0, updatedAt: 0 };
    const resolved = { strictMode: false, directory: '/repo', serversByName: {
      template: { enabled: true, config: enabled, serverId: enabled.id, name: enabled.name, bindingId: 'on' },
      off: { enabled: false, config: { ...enabled, id: 'off', name: 'off', env: {
        OFF_TOKEN: { t: 'template' as const, template: '{key}', vars: {
          key: { t: 'savedSecret' as const, secretId: 'happier:shared-secret:v1:disabled-key' },
        } },
      } }, serverId: 'off', name: 'off', bindingId: 'off' },
    } };
    expect(listSelectedMcpSharedSecretReferences(resolved.serversByName)).toEqual([{ ref: shared }]);
    await expect(materializeMcpServerConfigRecord({ resolved, tmpDir: null, processEnv: {},
      savedSecretMaterializer: createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [],
        resources: [{ resourceId: 'template-key', ownerAccountId: 'owner', displayName: 'key', kind: 'token',
          encryptionMode: 'plain', revision: 1, materialStatus: 'deleted', storedContent: null }], resourceCatalogState: 'ready' }),
    })).rejects.toMatchObject({ code: 'saved_secret_resolution_failed', status: 'deleted', reference: shared,
      consumer: 'mcp', field: 'header:Authorization' });
  });
  it('keeps personal Saved Secret env out of plain stdio and remote Agent configurations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-private-env-'));
    const key = deriveSettingsSecretsKeyV1(new Uint8Array(32).fill(3));
    const secret = 'private-mcp-env-value';
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [
      { id: 'local', name: 'local', transport: 'stdio', stdio: { command: 'example-mcp', args: ['serve'] },
        env: { API_KEY: { t: 'savedSecret', secretId: 'personal-key' } }, createdAt: 0, updatedAt: 0 },
      { id: 'remote', name: 'remote', transport: 'http', remote: { url: 'https://mcp.example.test', headers: {} },
        env: { API_KEY: { t: 'savedSecret', secretId: 'personal-key' } }, createdAt: 0, updatedAt: 0 },
    ], bindings: ['local', 'remote'].map(id => ({ id: `on-${id}`, serverId: id, enabled: true,
      target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 })) });
    const out = await materializeMcpServerConfigRecord({
      resolved: resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' }), tmpDir: dir,
      savedSecretMaterializer: createSavedSecretMaterializerV1({ resources: [], resourceCatalogState: undefined,
        accountSettings: { secrets: [{ id: 'personal-key', encryptedValue: {
          _isSecretValue: true, encryptedValue: encryptSecretStringV1(secret, key, deterministicRandomBytesFactory()),
        } }] }, settingsSecretsReadKeys: [key],
      }), processEnv: {},
    });
    try {
      expect(JSON.stringify(out.mcpServers)).not.toContain(secret);
      for (const name of ['local', 'remote'] as const) {
        const path = out.mcpServers[name]!.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
        expect(path).toBeDefined();
        const launch = JSON.parse(await readFile(path!, 'utf8'));
        expect(launch.env).toMatchObject({ API_KEY: secret });
        expect((await stat(path!)).mode & 0o777).toBe(0o600);
        if (name === 'remote') {
          const bridgePath = launch.env.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE;
          expect(JSON.parse(await readFile(bridgePath, 'utf8'))).not.toHaveProperty('env');
          expect((await stat(bridgePath)).mode & 0o777).toBe(0o600);
        }
      }
    } finally { out.cleanup(); await rm(dir, { recursive: true, force: true }); }
  });
  it('refuses an OAuth server without a resource-bound request-auth capability', async () => {
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{
      id: 'oauth', name: 'oauth', transport: 'http', remote: { url: 'https://mcp.example.test/path', headers: {}, auth: { kind: 'oauth' } },
      env: {}, createdAt: 0, updatedAt: 0,
    }], bindings: [{ id: 'on', serverId: 'oauth', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }] });
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-auth-refusal-'));
    try {
      await expect(materializeMcpServerConfigRecord({
        resolved: resolveMcpMaterialization(settings, { machineId: 'm', directory: '/repo' }), tmpDir: root,
      })).rejects.toThrow('mcp_sign_in_required');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps the OAuth capability only in the private bridge configuration and refuses a different resource', async () => {
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{
      id: 'oauth', name: 'oauth', transport: 'http', remote: { url: 'https://mcp.example.test/path', headers: {}, auth: { kind: 'oauth' } },
      env: {}, createdAt: 0, updatedAt: 0,
    }], bindings: [{ id: 'on', serverId: 'oauth', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }] });
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-auth-config-'));
    const resolved = resolveMcpMaterialization(settings, { machineId: 'm', directory: '/repo' });
    try {
      const auth = { capabilityFile: join(root, 'capability.json'), resource: 'https://mcp.example.test/path' };
      const result = await materializeMcpServerConfigRecord({ resolved, tmpDir: root, requestAuthByServerId: { oauth: auth } });
      try {
        const bridge = result.mcpServers.oauth!;
        expect(JSON.stringify(bridge)).not.toContain(auth.capabilityFile);
        const config = JSON.parse(await readFile(bridge.env!.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE!, 'utf8'));
        expect(config.auth).toEqual(auth);
      } finally { result.cleanup(); }
      await expect(materializeMcpServerConfigRecord({ resolved, tmpDir: root,
        requestAuthByServerId: { oauth: { ...auth, resource: 'https://mcp.example.test/another' } },
      })).rejects.toThrow('mcp_resource_mismatch');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each([
    ['missing', 'personal_missing', null],
    ['temporarily_unavailable', 'happier:shared-secret:v1:resource_1', 'temporarily_unavailable'],
    ['forbidden', 'happier:shared-secret:v1:resource_1', 'access_removed'],
    ['repair_required', 'happier:shared-secret:v1:resource_1', 'update_required'],
    ['deleted', 'happier:shared-secret:v1:resource_1', 'deleted'],
    ['mode_incompatible', 'happier:shared-secret:v1:resource_1', 'recipient_mode_unsupported'],
    ['corrupt', 'happier:shared-secret:v1:resource_1', 'ready'],
  ] as const)('fails an explicitly enabled Saved Secret ref with typed status %s even in non-strict mode', async (
    expectedStatus,
    secretId,
    materialStatus,
  ) => {
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [{
        id: 's1',
        name: 'alpha',
        transport: 'stdio',
        stdio: { command: 'node', args: [] },
        env: { API_KEY: { t: 'savedSecret', secretId } },
        createdAt: 0,
        updatedAt: 0,
      }],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });
    const resources: SavedSecretCatalogResourceInputV1[] = materialStatus === null ? [] : [{
      resourceId: 'resource_1',
      ownerAccountId: 'owner',
      displayName: 'shared',
      kind: 'token',
      encryptionMode: 'plain',
      revision: 1,
      materialStatus: materialStatus satisfies SavedSecretCatalogResourceV1['materialStatus'],
      storedContent: materialStatus === 'ready' ? null : sealSavedSecretResourceStoredContentV1({
        resourceId: 'resource_1',
        mode: 'plain',
        content: { v: 1, name: 'shared', kind: 'token', value: 'unused' },
      }),
    }];
    const savedSecretMaterializer = createSavedSecretMaterializerV1({
      accountSettings: {},
      settingsSecretsReadKeys: [],
      resources,
      resourceCatalogState: 'ready',
    });

    const promise = materializeMcpServerConfigRecord({
      resolved: resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' }),
      savedSecretMaterializer,
      processEnv: {},
      tmpDir: null,
      strictMode: false,
    });

    await expect(promise).rejects.toMatchObject({
      code: 'saved_secret_resolution_failed',
      status: expectedStatus,
      consumer: 'mcp',
      field: 'env:API_KEY',
    });
  });

  it('preserves typed Saved Secret failures for remote header refs', async () => {
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [{
        id: 's1',
        name: 'remote',
        transport: 'http',
        remote: {
          url: 'https://mcp.example.com',
          headers: {
            Authorization: {
              t: 'savedSecret',
              secretId: 'happier:shared-secret:v1:resource_1',
            },
          },
        },
        env: {},
        createdAt: 0,
        updatedAt: 0,
      }],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });
    const savedSecretMaterializer = createSavedSecretMaterializerV1({
      accountSettings: {},
      settingsSecretsReadKeys: [],
      resources: [{
        resourceId: 'resource_1',
        ownerAccountId: 'owner',
        displayName: 'shared',
        kind: 'token',
        encryptionMode: 'plain',
        revision: 1,
        materialStatus: 'deleted',
        storedContent: sealSavedSecretResourceStoredContentV1({
          resourceId: 'resource_1',
          mode: 'plain',
          content: { v: 1, name: 'shared', kind: 'token', value: 'unused' },
        }),
      }],
      resourceCatalogState: 'ready',
    });

    await expect(materializeMcpServerConfigRecord({
      resolved: resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' }),
      savedSecretMaterializer,
      processEnv: {},
      tmpDir: null,
      strictMode: false,
    })).rejects.toMatchObject({
      code: 'saved_secret_resolution_failed',
      status: 'deleted',
      consumer: 'mcp',
      field: 'header:Authorization',
    });
  });

  it('materializes stdio servers and expands env templates', async () => {
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'alpha',
          transport: 'stdio',
          stdio: { command: 'example-mcp', args: ['server.js'] },
          env: { API_KEY: { t: 'literal', v: '${TOKEN}' } },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });

    const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' });
    const out = await materializeMcpServerConfigRecord({
      resolved,
      processEnv: { TOKEN: 'sk-test' },
      tmpDir: null,
    });

    try {
      expect(JSON.stringify(out.mcpServers)).not.toContain('sk-test');
      const config = JSON.parse(await readFile(out.mcpServers.alpha.env!.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE!, 'utf8'));
      expect(config).toMatchObject({ command: 'example-mcp', args: ['server.js'], env: { API_KEY: 'sk-test' } });
    } finally { out.cleanup(); }
  });

  it('decrypts savedSecret env values using the settings secrets key', async () => {
    const masterSecret = new Uint8Array(32).fill(9);
    const settingsSecretsKey = deriveSettingsSecretsKeyV1(masterSecret);
    const randomBytes = deterministicRandomBytesFactory();
    const enc = encryptSecretStringV1('sk-real', settingsSecretsKey, randomBytes);

    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'alpha',
          transport: 'stdio',
          stdio: { command: 'example-mcp', args: [] },
          env: { API_KEY: { t: 'savedSecret', secretId: 'sec1' } },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });

    const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' });
    const out = await materializeMcpServerConfigRecord({
      resolved,
      savedSecretMaterializer: createSavedSecretMaterializerV1({ resources: [], resourceCatalogState: undefined,
        accountSettings: { secrets: [{ id: 'sec1', encryptedValue: { _isSecretValue: true, encryptedValue: enc } }] },
        settingsSecretsReadKeys: [settingsSecretsKey],
      }),
      processEnv: {},
      tmpDir: null,
    });

    try {
      expect(JSON.stringify(out.mcpServers)).not.toContain('sk-real');
      const config = JSON.parse(await readFile(out.mcpServers.alpha.env!.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE!, 'utf8'));
      expect(config.env).toEqual({ API_KEY: 'sk-real' });
    } finally { out.cleanup(); }
  });

  it('decrypts savedSecret env values using read-key fallbacks when legacy credentials read canonicalized settings', async () => {
    const recoverySecret = new Uint8Array(32).fill(6);
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);
    const canonicalSettingsKey = deriveSettingsSecretsKeyV1(machineKey);
    const legacySettingsKey = deriveSettingsSecretsKeyV1(recoverySecret);
    const randomBytes = deterministicRandomBytesFactory();
    const enc = encryptSecretStringV1('sk-legacy', legacySettingsKey, randomBytes);

    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'alpha',
          transport: 'stdio',
          stdio: { command: 'example-mcp', args: [] },
          env: { API_KEY: { t: 'savedSecret', secretId: 'sec1' } },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });

    const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' });
    const out = await materializeMcpServerConfigRecord({
      resolved,
      savedSecretMaterializer: createSavedSecretMaterializerV1({ resources: [], resourceCatalogState: undefined,
        accountSettings: { secrets: [{ id: 'sec1', encryptedValue: { _isSecretValue: true, encryptedValue: enc } }] },
        settingsSecretsReadKeys: [canonicalSettingsKey, legacySettingsKey],
      }),
      processEnv: {},
      tmpDir: null,
    });

    try {
      expect(JSON.stringify(out.mcpServers)).not.toContain('sk-legacy');
      const config = JSON.parse(await readFile(out.mcpServers.alpha.env!.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE!, 'utf8'));
      expect(config.env).toEqual({ API_KEY: 'sk-legacy' });
    } finally { out.cleanup(); }
  });

  it('skips unresolved literal refs when strictMode=false and throws when strictMode=true', async () => {
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'alpha',
          transport: 'stdio',
          stdio: { command: 'node', args: [] },
          env: { API_KEY: { t: 'literal', v: '${MISSING}' } },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });

    const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' });

    const nonStrict = await materializeMcpServerConfigRecord({
      resolved,
      processEnv: {},
      tmpDir: null,
      strictMode: false,
    });
    expect(nonStrict.mcpServers).toEqual({});
    expect(nonStrict.warnings.length).toBeGreaterThan(0);

    await expect(
      materializeMcpServerConfigRecord({
        resolved,
        processEnv: {},
        tmpDir: null,
        strictMode: true,
      }),
    ).rejects.toThrow(/missing/i);
  });

  it('materializes remote servers via a stdio bridge config file (no secrets in argv)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-remote-test-'));
    try {
      const masterSecret = new Uint8Array(32).fill(4);
      const settingsSecretsKey = deriveSettingsSecretsKeyV1(masterSecret);
      const randomBytes = deterministicRandomBytesFactory();
      const enc = encryptSecretStringV1('Bearer SECRET', settingsSecretsKey, randomBytes);

      const settings = McpServersSettingsV1Schema.parse({
        v: 1,
        strictMode: false,
        servers: [
          {
            id: 's1',
            name: 'alpha',
            transport: 'http',
            remote: { url: 'https://mcp.example.com', headers: { Authorization: { t: 'savedSecret', secretId: 'sec1' } } },
            env: {},
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
      });

      const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' });
      const out = await materializeMcpServerConfigRecord({
        resolved,
        savedSecretMaterializer: createSavedSecretMaterializerV1({ resources: [], resourceCatalogState: undefined,
          accountSettings: { secrets: [{ id: 'sec1', encryptedValue: { _isSecretValue: true, encryptedValue: enc } }] },
          settingsSecretsReadKeys: [settingsSecretsKey],
        }),
        processEnv: {},
        tmpDir: dir,
        deps: {
          resolveRemoteBridgeCommand: () => ({ command: 'node', args: ['bridge.js'] }),
        },
      });

      const cfg = out.mcpServers.alpha;
      expect(cfg.command).toBe('node');
      expect(cfg.args).toEqual(['bridge.js']);
      expect(cfg.env?.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE).toBeTruthy();

      const argvJoined = (cfg.args ?? []).join(' ');
      expect(argvJoined).not.toContain('SECRET');

      const configPath = String(cfg.env?.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE ?? '');
      const raw = await readFile(configPath, 'utf8');
      expect(raw).toContain('mcp.example.com');
      expect(raw).toContain('Bearer SECRET');

      const st = await stat(configPath);
      expect(st.mode & 0o777).toBe(0o600);
      out.cleanup();
      expect(existsSync(configPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('normalizes package-runner stdio servers through managed pnpm with a neutral launch cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-stdio-launcher-test-'));
    try {
      const fakePnpmPath = join(dir, 'pnpm');
      await writeFile(fakePnpmPath, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(fakePnpmPath, 0o755);
      const settings = McpServersSettingsV1Schema.parse({
        v: 1,
        strictMode: false,
        servers: [
          {
            id: 's1',
            name: 'alpha',
            transport: 'stdio',
            stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
            env: { API_KEY: { t: 'literal', v: '${TOKEN}' } },
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
      });

      const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' });
      const out = await materializeMcpServerConfigRecord({
        resolved,
        processEnv: { HOME: '/safe-home', TOKEN: 'sk-test', HAPPIER_PNPM_BIN: fakePnpmPath },
        tmpDir: dir,
      });

      const cfg = out.mcpServers.alpha;
      expect(cfg.command).toBe(process.execPath);
      expect(cfg.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE).toBeTruthy();
      expect(cfg.env?.API_KEY).toBeUndefined();

      const sourceEntrypoint = join(projectPath(), 'src', 'mcp', 'launchers', 'stdioMcpServerLauncher.ts');
      const tsxHookPath = resolveTsxImportHookPath();
      // `resolvePackagedRuntimeEntrypoint` owns the candidate order (package-dist,
      // then dist, across every packaged runtime root), so ask it rather than
      // re-deriving one directory here: a checkout that carries only one of them
      // must not read as "no packaged entrypoint".
      const packagedEntrypoint = resolvePackagedRuntimeEntrypoint('mcp/launchers/stdioMcpServerLauncher.mjs');
      const expectedArgs =
        !existsSync(packagedEntrypoint) && existsSync(sourceEntrypoint) && typeof tsxHookPath === 'string' && tsxHookPath.length > 0
          ? [
              '--no-warnings',
              '--no-deprecation',
              '--import',
              tsxHookPath,
              sourceEntrypoint,
            ]
          : ['--no-warnings', '--no-deprecation', packagedEntrypoint];
      expect(cfg.args).toEqual(expectedArgs);
      if (expectedArgs.includes('--import')) {
        expect(cfg.env?.TSX_TSCONFIG_PATH).toBe(resolveCliTsxTsconfigPath());
      } else {
        expect(cfg.env?.TSX_TSCONFIG_PATH).toBeUndefined();
      }

      const configPath = String(cfg.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE ?? '');
      const raw = await readFile(configPath, 'utf8');
      expect(raw).toContain(`"command":"${fakePnpmPath}"`);
      expect(raw).toContain('"args":["dlx","@modelcontextprotocol/server-sequential-thinking"]');
      expect(raw).toContain('"cwd":"/safe-home"');
      expect(raw).toContain('"API_KEY":"sk-test"');
      expect(raw).not.toContain('happier-mcp-stdio-launcher.mjs');
      out.cleanup();
      expect(existsSync(configPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves workspace cwd for package-manager run and exec stdio servers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-stdio-workspace-cwd-test-'));
    try {
      const fakePnpmPath = join(dir, 'pnpm');
      await writeFile(fakePnpmPath, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(fakePnpmPath, 0o755);
      const settings = McpServersSettingsV1Schema.parse({
        v: 1,
        strictMode: false,
        servers: [
          {
            id: 's1',
            name: 'alpha',
            transport: 'stdio',
            stdio: { command: 'pnpm', args: ['exec', 'tsx', 'server.ts'] },
            env: {},
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
      });

      const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo/worktree' });
      const out = await materializeMcpServerConfigRecord({
        resolved,
        processEnv: { HOME: '/safe-home', HAPPIER_PNPM_BIN: fakePnpmPath },
        tmpDir: dir,
      });

      const configPath = String(out.mcpServers.alpha.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE ?? '');
      const raw = await readFile(configPath, 'utf8');
      expect(raw).toContain(`"command":"${fakePnpmPath}"`);
      expect(raw).toContain('"args":["exec","tsx","server.ts"]');
      expect(raw).toContain('"cwd":"/repo/worktree"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips package-runner stdio servers when managed pnpm is unavailable in non-strict mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-package-runner-unavailable-'));
    const originalFetch = globalThis.fetch;
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'alpha',
          transport: 'stdio',
          stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
          env: {},
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });

    const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' });
    try {
      globalThis.fetch = async () => {
        throw new Error('offline');
      };

      const out = await materializeMcpServerConfigRecord({
        resolved,
        processEnv: { PATH: '', HAPPIER_HOME_DIR: join(dir, 'home'), HAPPIER_MANAGED_PNPM_BOOTSTRAP: '0' },
        tmpDir: null,
        strictMode: false,
      });

      expect(out.mcpServers).toEqual({});
      expect(out.warnings).toContainEqual(expect.objectContaining({
        serverName: 'alpha',
        code: 'invalid_server',
      }));
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed for package-runner stdio servers when managed pnpm is unavailable in strict mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-package-runner-unavailable-strict-'));
    const originalFetch = globalThis.fetch;
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: true,
      servers: [
        {
          id: 's1',
          name: 'alpha',
          transport: 'stdio',
          stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
          env: {},
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });

    const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' });

    try {
      globalThis.fetch = async () => {
        throw new Error('offline');
      };

      await expect(
        materializeMcpServerConfigRecord({
          resolved,
          processEnv: { PATH: '', HAPPIER_HOME_DIR: join(dir, 'home'), HAPPIER_MANAGED_PNPM_BOOTSTRAP: '0' },
          tmpDir: null,
          strictMode: true,
        }),
      ).rejects.toThrow(Error);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
