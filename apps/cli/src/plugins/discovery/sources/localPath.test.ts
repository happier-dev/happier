import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { createMcpServerActionExecuteV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { projectMcpPluginItemMetadataV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import { resolveLocalPathPluginSource } from './localPath';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

async function writePluginManifest(rootDir: string, manifestOverrides?: Record<string, unknown>): Promise<string> {
  const manifestDir = join(rootDir, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  const manifestPath = join(manifestDir, 'plugin.json');
  await writeFile(
    manifestPath,
    JSON.stringify(createPluginManifestV2Fixture({
      schemaVersion: 2,
      id: 'acme.ohmypi',
      version: '1.0.0',
      displayName: 'Acme Oh My Pi',
      description: 'Adds Oh My Pi support',
      engines: {
        happier: '^0.3.0',
      },
      contributes: {},
      ...(manifestOverrides ?? {}),
    }), null, 2),
    'utf8',
  );
  return manifestPath;
}

async function writeStandaloneManifest(manifestPath: string, manifestOverrides?: Record<string, unknown>): Promise<string> {
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify(createPluginManifestV2Fixture({
      schemaVersion: 2,
      id: 'acme.standalone',
      version: '1.0.0',
      displayName: 'Acme Standalone',
      description: 'Standalone manifest file',
      engines: {
        happier: '^0.3.0',
      },
      contributes: {},
      ...(manifestOverrides ?? {}),
    }), null, 2),
    'utf8',
  );
  return manifestPath;
}

describe('resolveLocalPathPluginSource', () => {
  it.each(['.claude-plugin', '.codex-plugin', '.cursor-plugin', '.'])('admits %s package content and reports omitted declarations', async (layout) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-vendor-plugin-'));
    try {
      await mkdir(join(root, 'skills', 'explain'), { recursive: true });
      await mkdir(join(root, layout), { recursive: true });
      await writeFile(join(root, layout, 'plugin.json'), JSON.stringify({
        ...(layout === '.' ? { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' } : {}),
        name: 'vendor-help', version: '1.2.3', description: 'Reference material', hooks: { Stop: [] },
      }));
      await writeFile(join(root, 'skills', 'explain', 'SKILL.md'), '---\nname: explain\ndescription: Explain the project\n---\nRead the README.\n');
      const mcpType = layout === '.' ? 'streamable-http' : 'http';
      await writeFile(join(root, layout === '.' ? 'mcp.json' : '.mcp.json'), JSON.stringify({
        ...(layout === '.' ? { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' } : {}), mcpServers: {
        reference: { type: mcpType, url: 'https://example.com/mcp' },
        template: { type: mcpType, url: 'https://example.com/mcp', headers: { Authorization: '\${TOKEN}' } },
      } }));
      const result = await resolveLocalPathPluginSource({ locator: root });
      expect(result).toMatchObject({ ok: true, manifest: { version: '1.2.3', contributes: {
        skills: [{ id: 'explain', directory: 'skills/explain' }],
        mcp: { servers: [{ id: 'reference', kind: 'static', transport: { kind: 'http', url: 'https://example.com/mcp' } }] },
      } }, vendorContent: { notImported: { hooks: layout === '.' ? 0 : 1, commands: 0, mcpServers: 1, agents: 0,
        ...(layout === '.' ? { other: ['hooks'] } : {}) } } });
      expect(result.ok && result.manifest.entrypoints).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('validates portable manifest metadata and reports an incompatible MCP file independently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-portable-plugin-'));
    try {
      const manifest = { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'portable' };
      const manifestPath = join(root, 'plugin.json');
      await writeFile(manifestPath, JSON.stringify({ ...manifest, version: 1 }));
      expect(await resolveLocalPathPluginSource({ locator: root })).toMatchObject({
        ok: false, diagnostics: [{ code: 'plugin_manifest_invalid' }],
      });
      await writeFile(manifestPath, JSON.stringify({ ...manifest, extensions: { 'example.vendor': { feature: true } } }));
      await writeFile(join(root, 'mcp.json'), JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.1.0/mcp.schema.json',
        mcpServers: { reference: { type: 'streamable-http', url: 'https://example.com/mcp' } },
      }));
      expect(await resolveLocalPathPluginSource({ locator: root })).toMatchObject({
        ok: true, manifest: { contributes: { mcp: { servers: [] } } },
        vendorContent: { notImported: { mcpServers: 1, other: ['extensions.example.vendor'] } },
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('admits private Workflow and HTTP MCP declarations from an Agent Plugins manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-vendor-extension-'));
    const workflow = { id: 'review-changes', title: 'Review changes', definition: { version: 1, inputs: [], defaults: {},
      blocks: [{ kind: 'step', id: 'review', document: { text: 'Review changes', references: [], attachments: [] } }] } };
    const oauth = { kind: 'oauth' };
    const endpoint = 'https://example.com/review';
    try {
      await writeFile(join(root, 'plugin.json'), JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'portable',
        extensions: { 'dev.happier': { contributes: {
          workflows: [workflow],
          mcp: { servers: [{ id: 'review', title: 'Review', kind: 'static', transport: { kind: 'http', url: endpoint, auth: oauth } }] },
          hooks: [{ id: 'ignored' }],
        }, entrypoints: { daemon: './ignored.js' } }, 'other.vendor': {} },
      }));
      await writeFile(join(root, 'mcp.json'), JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: {
          review: { type: 'streamable-http', url: endpoint },
          docs: { type: 'streamable-http', url: 'https://example.com/docs' },
        },
      }));
      const result = await resolveLocalPathPluginSource({ locator: root });
      expect(result).toMatchObject({ ok: true, manifest: { contributes: { workflows: [workflow] } }, vendorContent: {
        notImported: { mcpServers: 0, other: expect.arrayContaining([
          'extensions.other.vendor', 'extensions.dev.happier.contributes.hooks', 'extensions.dev.happier.entrypoints',
        ]) },
      } });
      if (!result.ok) return;
      expect(result.manifest.entrypoints).toBeUndefined();
      const servers = result.manifest.contributes?.mcp?.servers ?? [];
      expect(servers.map(server => server.id)).toEqual(['review', 'docs']);
      const remote = servers.map(server => projectMcpPluginItemMetadataV1({ pluginId: result.manifest.id, pluginName: result.manifest.displayName, server }).remote);
      expect(remote).toEqual([{ url: endpoint, auth: oauth }, undefined]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('projects vendor-declared HTTP OAuth through the same MCP sign-in metadata as native plugins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-vendor-oauth-'));
    try {
      await mkdir(join(root, '.claude-plugin'));
      await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'vendor' }));
      const protectedUrl = 'https://example.com/protected';
      await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
        protected: { type: 'http', url: protectedUrl, oauth: { callbackPort: 8080 } },
        anonymous: { type: 'http', url: 'https://example.com/public' },
      } }));
      const result = await resolveLocalPathPluginSource({ locator: root });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const metadata = (result.manifest.contributes?.mcp?.servers ?? []).map(server => projectMcpPluginItemMetadataV1({
        pluginId: result.manifest.id, pluginName: result.manifest.displayName, server,
      }));
      const [protectedServer, anonymousServer] = metadata;
      expect(metadata.map(({ remote }) => remote)).toEqual([{ url: protectedUrl, auth: { kind: 'oauth' } }, undefined]);
      expect(result.vendorContent?.notImported.other).toContain('mcpServers.protected.oauth');

      const execute = createMcpServerActionExecuteV1({
        readPluginItems: async () => metadata,
        resolveAdministrationMachine: async () => 'fixture-machine',
        describeConnectedService: async () => { throw new Error('fixture daemon RPC disconnected'); },
        readCatalog: async () => { throw new Error('unexpected Account catalog read'); },
        mutate: async () => { throw new Error('unexpected Account catalog write'); },
        machine: async () => { throw new Error('unexpected MCP test'); },
      });
      const start = (serverId: string) => execute({ actionId: 'mcp.servers.signIn.start', input: { serverId },
        context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } });
      expect(await start(protectedServer!.id)).toMatchObject({ ok: false, details: { stage: 'service_description' } });
      expect(await start(anonymousServer!.id)).toMatchObject({ ok: false, errorCode: 'mcp_sign_in_not_supported' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('loads an npm first-party materialization while retaining archive namespace refusal', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-first-party-npm-'));
    try {
      await writePluginManifest(pluginRoot, { id: 'happier.asciinema' });
      expect(await resolveLocalPathPluginSource({ locator: pluginRoot, installedSourceKind: 'package',
        registryPackageName: '@happier-dev/plugins-asciinema', purpose: 'installedRead' }))
        .toMatchObject({ ok: true, manifest: { id: 'happier.asciinema' } });
      expect(await resolveLocalPathPluginSource({ locator: pluginRoot, installedSourceKind: 'archive',
        purpose: 'installedRead' })).toMatchObject({ ok: false });
    } finally { await rm(pluginRoot, { recursive: true, force: true }); }
  });

  it('resolves a plugin root directory into a parsed local-path plugin source', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    const manifestPath = await writePluginManifest(pluginRoot);
    const canonicalPluginRoot = await realpath(pluginRoot);
    const canonicalManifestPath = await realpath(manifestPath);

    const result = await resolveLocalPathPluginSource({ locator: pluginRoot });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pluginRootPath).toBe(canonicalPluginRoot);
    expect(result.manifestPath).toBe(canonicalManifestPath);
    expect(result.manifest.id).toBe('acme.ohmypi');
    expect(result.sourceSpec).toMatchObject({
      kind: 'path',
      locator: canonicalPluginRoot,
      trustPolicy: 'prompt',
      installPolicy: 'link',
    });
    expect(result).not.toHaveProperty('manifestDigest');
    expect(result.sourceSpec).not.toHaveProperty('resolvedDigest');
  });

  it.each(['package', 'marketplace', 'archive'] as const)(
    'still refuses a %s artifact that claims the reserved happier namespace',
    async (installedSourceKind) => {
      const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-registry-reserved-'));
      await writePluginManifest(pluginRoot, { id: 'happier.agent.codex' });

      expect(await resolveLocalPathPluginSource({ locator: pluginRoot, installedSourceKind })).toEqual(
        expect.objectContaining({
          ok: false,
          diagnostics: [expect.objectContaining({
            message: expect.stringContaining('reserved happier.* namespace'),
          })],
        }),
      );
      // Same bytes, same path: only the record's provenance decided the rule. A working tree
      // (a recorded path install, or a path the person names with no record) may develop the id.
      for (const workingTreeKind of ['path', undefined] as const) {
        expect(await resolveLocalPathPluginSource({ locator: pluginRoot, installedSourceKind: workingTreeKind }))
          .toEqual(expect.objectContaining({ ok: true, manifest: expect.objectContaining({ id: 'happier.agent.codex' }) }));
      }
    },
  );

  it('enforces the engine range at admission while allowing authoring of a local working tree', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-engine-'));
    await writePluginManifest(pluginRoot, { engines: { happier: '>=9999.0.0' } });

    for (const installedSourceKind of ['archive', 'git', undefined] as const) {
      expect(await resolveLocalPathPluginSource({ locator: pluginRoot, installedSourceKind })).toMatchObject({
        ok: false,
        diagnostics: [{ code: 'plugin_manifest_engine_incompatible' }],
      });
    }

    expect(await resolveLocalPathPluginSource({ locator: pluginRoot, purpose: 'authoring' }))
      .toEqual(expect.objectContaining({ ok: true }));
  });

  it('preserves an explicit standalone manifest-file locator instead of rewriting it to the parent directory', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    const manifestPath = await writeStandaloneManifest(join(pluginRoot, 'standalone-plugin.json'));
    const canonicalPluginRoot = await realpath(pluginRoot);
    const canonicalManifestPath = await realpath(manifestPath);

    const result = await resolveLocalPathPluginSource({ locator: manifestPath });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pluginRootPath).toBe(canonicalPluginRoot);
    expect(result.manifestPath).toBe(canonicalManifestPath);
    expect(result.sourceSpec.locator).toBe(canonicalManifestPath);
  });

  it('resolves a .happier-plugin directory locator into the same canonical local-path source', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    const manifestPath = await writePluginManifest(pluginRoot);
    const manifestDir = join(pluginRoot, '.happier-plugin');
    const canonicalPluginRoot = await realpath(pluginRoot);
    const canonicalManifestPath = await realpath(manifestPath);

    const result = await resolveLocalPathPluginSource({ locator: manifestDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pluginRootPath).toBe(canonicalPluginRoot);
    expect(result.manifestPath).toBe(canonicalManifestPath);
    expect(result.sourceSpec.locator).toBe(canonicalPluginRoot);
  });

  it('returns a compatibility diagnostic when the local path does not contain a plugin manifest', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));

    const result = await resolveLocalPathPluginSource({ locator: pluginRoot });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_missing',
      }),
    ]);
  });

  it('returns a source-missing diagnostic when the local path does not exist', async () => {
    const missingPluginRoot = join(tmpdir(), 'happier-plugin-missing-path', 'missing-plugin');

    const result = await resolveLocalPathPluginSource({ locator: missingPluginRoot });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'plugin_source_missing',
      }),
    ]);
  });

  it('fails closed on remote URL locators instead of treating them as local paths', async () => {
    const result = await resolveLocalPathPluginSource({ locator: 'https://example.test/plugins/acme.sample' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'plugin_source_kind_unsupported',
        message: expect.stringMatching(/https?:\/\//i),
      }),
    ]);
  });
});
