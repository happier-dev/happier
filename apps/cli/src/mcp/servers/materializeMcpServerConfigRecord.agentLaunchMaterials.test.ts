import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  McpServersSettingsV1Schema,
  projectMcpServerMaterializationV1,
  resolveSessionCapabilitiesV1,
  sealSavedSecretResourceStoredContentV1,
  type McpServersSettingsV1,
} from '@happier-dev/protocol';

import { createSavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
import { writeConnectedAccountRequestAuthCapabilityFile } from '@/daemon/connectedServices/requestAuth/capabilityFile';
import { materializeMcpServerConfigRecord } from './materializeMcpServerConfigRecord';

function resolveMaterialization(settings: McpServersSettingsV1) {
  return projectMcpServerMaterializationV1(resolveSessionCapabilitiesV1({
    context: { machineId: 'machine', directory: '/repo', machinePlatform: null, projectKey: null, agentId: null },
    mcp: settings, skills: null, selection: {}, agentAcceptsUserMcp: true,
  }), '/repo');
}

describe('MCP selected Agent launch materials', () => {
  it('projects incumbent OAuth capability bytes into the native bridge frame without moving issuer cleanup ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-selected-oauth-'));
    const runtimeHome = join(root, 'member-runtime');
    const issuerRoot = join(root, 'daemon-issuer');
    await mkdir(issuerRoot, { mode: 0o700 });
    const issued = await writeConnectedAccountRequestAuthCapabilityFile({ rootDir: issuerRoot,
      materializationId: 'selected-profile', subjectScopeDigest: 'a'.repeat(64), httpPort: 12345 });
    const issuedBytes = await readFile(issued.path, 'utf8');
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{
      id: 'remote', name: 'remote', transport: 'http',
      remote: { url: 'https://fixture.example.test/mcp', headers: {}, auth: { kind: 'oauth' } },
      env: {}, createdAt: 1, updatedAt: 1,
    }], bindings: [{ id: 'on', serverId: 'remote', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] });
    try {
      const result = await materializeMcpServerConfigRecord({ resolved: resolveMaterialization(settings), processEnv: {},
        tmpDir: null, agentLaunchTarget: { runtimeHome },
        requestAuthByServerId: { remote: { capabilityFile: issued.path, resource: 'https://fixture.example.test/mcp' } },
        deps: { resolveRemoteBridgeCommand: () => ({ command: '/fixture/bridge-runtime', args: [] }) },
      });
      try {
        const files = new Map(result.selectedMaterials?.map(file => [join(runtimeHome, file.relativePath),
          Buffer.from(file.contentBase64, 'base64').toString('utf8')]));
        const bridge = JSON.parse(files.get(result.mcpServers.remote!.env!.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE!) ?? 'null');
        expect(bridge?.auth?.capabilityFile?.startsWith(`${runtimeHome}/files/`)).toBe(true);
        expect(bridge?.auth?.capabilityFile === issued.path).toBe(false);
        expect(bridge?.auth?.resource).toBe('https://fixture.example.test/mcp');
        expect(JSON.stringify(JSON.parse(files.get(bridge?.auth?.capabilityFile) ?? 'null')) === JSON.stringify(JSON.parse(issuedBytes))).toBe(true);
        expect(JSON.stringify(result.mcpServers).includes(JSON.parse(issuedBytes).capability)).toBe(false);
        result.cleanup();
        // Projection never owns the issuer's capability or active purpose lease.
        expect(await readFile(issued.path, 'utf8') === issuedBytes).toBe(true);
        expect(existsSync(runtimeHome)).toBe(false);
      } finally { result.cleanup(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['plain', 'e2ee'] as const)('projects %s selected secret and nested bridge paths without daemon-private files', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-selected-materials-'));
    const runtimeHome = join(root, 'member');
    const daemonPrivate = join(root, 'daemon-private');
    const secret = 'selected-member-secret-fixture';
    const resourceDataKey = new Uint8Array(32).fill(11);
    const content = { v: 1 as const, name: 'selected', kind: 'token' as const, value: secret };
    const savedSecretMaterializer = createSavedSecretMaterializerV1({
      accountSettings: {}, settingsSecretsReadKeys: [], resourceCatalogState: 'ready',
      resources: [{ resourceId: 'selected', ownerAccountId: 'requester', displayName: 'selected', kind: 'token',
        encryptionMode: mode, revision: 1, materialStatus: 'ready', ...(mode === 'e2ee' ? { resourceDataKey } : {}),
        storedContent: mode === 'plain'
          ? sealSavedSecretResourceStoredContentV1({ resourceId: 'selected', mode: 'plain', content })
          : sealSavedSecretResourceStoredContentV1({ resourceId: 'selected', mode: 'e2ee', content, resourceDataKey,
            randomBytes: length => new Uint8Array(length).fill(13) }) }],
    });
    const selectedSecret = { t: 'savedSecret', secretId: 'happier:shared-secret:v1:selected' } as const;
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{
      id: 'remote', name: 'remote', transport: 'http',
      remote: { url: 'https://fixture.example.test/mcp', headers: { Authorization: selectedSecret } },
      env: { MEMBER_TOKEN: selectedSecret }, createdAt: 1, updatedAt: 1,
    }], bindings: [{ id: 'on', serverId: 'remote', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] });
    // These dependencies represent only platform executable resolution.
    const result = await materializeMcpServerConfigRecord({
      resolved: resolveMaterialization(settings), savedSecretMaterializer, processEnv: {}, tmpDir: daemonPrivate,
      agentLaunchTarget: { runtimeHome }, deps: {
        resolveRemoteBridgeCommand: () => ({ command: '/fixture/bridge-runtime', args: ['/fixture/bridge-entry'] }),
        resolveStdioLauncherCommand: () => ({ command: '/fixture/launcher-runtime', args: ['/fixture/launcher-entry'] }),
      },
    });
    try {
      const selected = result.selectedMaterials ?? [];
      expect(selected).toHaveLength(2);
      expect(new Set(selected.map(file => file.relativePath)).size).toBe(2);
      expect(selected.every(file => /^files\/happier-mcp-(?:stdio-launcher|remote-bridge)\.[^/]+\.json$/u.test(file.relativePath))).toBe(true);
      const filesByPath = new Map(selected.map(file => [join(runtimeHome, file.relativePath),
        Buffer.from(file.contentBase64, 'base64').toString('utf8')]));
      const launcherPath = result.mcpServers.remote!.env!.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE!;
      const launcher = JSON.parse(filesByPath.get(launcherPath) ?? 'null');
      expect(launcher?.command).toBe('/fixture/bridge-runtime');
      expect(launcher?.args).toEqual(['/fixture/bridge-entry']);
      expect(launcher?.env.MEMBER_TOKEN === secret).toBe(true);
      const bridge = JSON.parse(filesByPath.get(launcher?.env.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE) ?? 'null');
      expect(bridge?.transport).toBe('http');
      expect(bridge?.url).toBe('https://fixture.example.test/mcp');
      expect(bridge?.headers.Authorization === secret).toBe(true);
      expect(JSON.stringify(result.mcpServers).includes(secret)).toBe(false);
      expect(JSON.stringify(result.mcpServers).includes(daemonPrivate)).toBe(false);
      expect(existsSync(daemonPrivate)).toBe(false);
      expect(result.sanitizeDiagnosticText(secret) === '[REDACTED]').toBe(true);

      // The native publisher owns these files. Materializer cleanup cannot unlink them.
      await mkdir(join(runtimeHome, 'files'), { recursive: true });
      for (const [path, content] of filesByPath) await writeFile(path, content, { mode: 0o600 });
      const publishedBeforeCleanup = await Promise.all([...filesByPath].map(async ([path, content]) =>
        await readFile(path, 'utf8').then(value => value === content, () => false)));
      expect(publishedBeforeCleanup.every(Boolean)).toBe(true);
      result.cleanup();
      const retainedAfterCleanup = await Promise.all([...filesByPath].map(async ([path, content]) =>
        await readFile(path, 'utf8').then(value => value === content, () => false)));
      expect(retainedAfterCleanup.every(Boolean)).toBe(true);
      expect(result.sanitizeDiagnosticText(secret) === secret).toBe(true);
    } finally { result.cleanup(); await rm(root, { recursive: true, force: true }); }
  });

  it('uses the canonical launcher for an empty native stdio configuration while preserving the owner fast path', async () => {
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{
      id: 'local', name: 'local', transport: 'stdio', stdio: { command: 'member-tool', args: ['--stdio'] },
      env: {}, createdAt: 1, updatedAt: 1,
    }], bindings: [{ id: 'on', serverId: 'local', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] });
    const resolved = resolveMaterialization(settings);
    const owner = await materializeMcpServerConfigRecord({ resolved, processEnv: {}, tmpDir: null, deps: {
      resolveStdioLauncherCommand: () => { throw new Error('Owner fast path must not resolve a launcher'); },
    } });
    try {
      expect(owner.mcpServers).toEqual({ local: { command: 'member-tool', args: ['--stdio'] } });
      expect(owner.selectedMaterials).toBeUndefined();
    } finally { owner.cleanup(); }
    const member = await materializeMcpServerConfigRecord({ resolved, processEnv: {}, tmpDir: null,
      agentLaunchTarget: { runtimeHome: '/member/runtime' }, deps: {
        resolveStdioLauncherCommand: () => ({ command: '/fixture/runtime', args: ['/fixture/launcher'] }),
      },
    });
    try {
      expect(member.mcpServers.local?.command).toBe('/fixture/runtime');
      expect(member.mcpServers.local?.args).toEqual(['/fixture/launcher']);
      expect(member.selectedMaterials).toHaveLength(1);
      const material = member.selectedMaterials![0]!;
      expect(member.mcpServers.local?.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE)
        .toBe(join('/member/runtime', material.relativePath));
      expect(JSON.parse(Buffer.from(material.contentBase64, 'base64').toString('utf8')))
        .toEqual({ command: 'member-tool', args: ['--stdio'], env: {} });
    } finally { member.cleanup(); }
  });

  it('projects a remote bridge without an extra stdio launcher when no private environment is selected', async () => {
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{
      id: 'remote', name: 'remote', transport: 'sse',
      remote: { url: 'https://fixture.example.test/events', headers: {} }, env: {}, createdAt: 1, updatedAt: 1,
    }], bindings: [{ id: 'on', serverId: 'remote', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] });
    const result = await materializeMcpServerConfigRecord({ resolved: resolveMaterialization(settings), processEnv: {}, tmpDir: null,
      agentLaunchTarget: { runtimeHome: '/member/runtime' }, deps: {
        resolveRemoteBridgeCommand: () => ({ command: '/fixture/runtime', args: ['/fixture/bridge'] }),
        resolveStdioLauncherCommand: () => { throw new Error('Remote bridge needs no extra launcher'); },
      },
    });
    try {
      expect(result.mcpServers.remote?.command).toBe('/fixture/runtime');
      expect(result.selectedMaterials).toHaveLength(1);
      const material = result.selectedMaterials![0]!;
      expect(result.mcpServers.remote?.env?.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE)
        .toBe(join('/member/runtime', material.relativePath));
      expect(JSON.parse(Buffer.from(material.contentBase64, 'base64').toString('utf8')))
        .toEqual({ transport: 'sse', url: 'https://fixture.example.test/events', headers: {} });
    } finally { result.cleanup(); }
  });

  it('honors local cancellation after executable resolution before returning selected native payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-selected-currentness-'));
    const daemonPrivate = join(root, 'daemon-private');
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{
      id: 'local', name: 'local', transport: 'stdio', stdio: { command: 'member-tool', args: [] },
      env: { TOKEN: { t: 'literal', v: 'currentness-fixture' } }, createdAt: 1, updatedAt: 1,
    }], bindings: [{ id: 'on', serverId: 'local', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] });
    const controller = new AbortController();
    try {
      await expect(materializeMcpServerConfigRecord({ resolved: resolveMaterialization(settings), processEnv: {}, tmpDir: daemonPrivate,
        agentLaunchTarget: { runtimeHome: join(root, 'member') },
        signal: controller.signal,
        deps: { resolveStdioLauncherCommand: () => {
          controller.abort(new Error('fixture_cancelled'));
          return { command: '/fixture/runtime', args: ['/fixture/launcher'] };
        } },
      })).rejects.toThrow('fixture_cancelled');
      expect(existsSync(daemonPrivate)).toBe(false);
      expect(existsSync(join(root, 'member'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
