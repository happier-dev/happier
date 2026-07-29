import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, realpath, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '@/configuration';
import { createDaemonArchivePluginChangePreparer } from '@/plugins/daemon/archiveChangePreparer';
import { createDaemonNpmPluginChangePreparer } from '@/plugins/daemon/npmChangePreparer';
import { createDaemonPathPluginChangePreparer } from '@/plugins/daemon/pathChangePreparer';
import { createDaemonPluginChangeService, type DaemonPluginChangeService } from '@/plugins/daemon/changeService';
import { createMarketplaceCatalogDocument, createMarketplaceCatalogEntry } from '@/plugins/testkit/marketplaceCatalog';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';
import { materializeSamplePluginFixture, SAMPLE_PLUGIN_ID } from '@/plugins/testkit/samplePackage';
import { createPluginStateStore } from '@/plugins/store/state.testkit';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createMarketplaceSourceRegistryStore } from '@/plugins/store/marketplace/sources/store';
import { createMarketplaceIndex } from '@/plugins/store/marketplace/index';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { packLocalPlugin } from '@/plugins/packaging/pack';
import { readInstalledPluginCatalog } from '@/plugins/projection/catalog/installed';
import { createPluginSecretStore } from '@/plugins/runtime/context/secrets';
import { createPluginStorageOwner } from '@/plugins/runtime/context/storage';
import { createDaemonPluginRegistryRuntimeLifecycle } from '@/plugins/runtime/reload/registryRuntimeLifecycle';
import {
  createPluginReloadController,
  type PluginReloadController,
} from '@/plugins/runtime/reload/controller';

import { handlePluginsCommand } from './plugins';

const daemonBoundary = vi.hoisted(() => ({
  ensureRunning: vi.fn(async () => undefined),
  requestChange: vi.fn(),
  decideChange: vi.fn(),
  readCatalog: vi.fn(),
}));
const promptBoundary = vi.hoisted(() => ({
  confirm: vi.fn(),
}));

vi.mock('@/daemon/ensureDaemon', () => ({
  ensureDaemonRunningForSessionCommand: daemonBoundary.ensureRunning,
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestDaemonPluginChange: daemonBoundary.requestChange,
  decideDaemonPluginChange: daemonBoundary.decideChange,
  readDaemonPluginCatalog: daemonBoundary.readCatalog,
}));
vi.mock('@/terminal/prompts/promptConfirmYesNo', () => ({
  promptConfirmYesNo: promptBoundary.confirm,
}));

let activePluginChangeService: DaemonPluginChangeService | null = null;
let activePluginReloadController: PluginReloadController | null = null;

function createPluginChangeService(): DaemonPluginChangeService {
  const reloadController = createPluginReloadController({
    happyHomeDir: configuration.happyHomeDir,
  });
  activePluginReloadController = reloadController;
  const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({
    happyHomeDir: configuration.happyHomeDir,
    reloadController,
  });
  const preparePath = createDaemonPathPluginChangePreparer({ happyHomeDir: configuration.happyHomeDir, runtimeLifecycle });
  const prepareArchive = createDaemonArchivePluginChangePreparer({ happyHomeDir: configuration.happyHomeDir, runtimeLifecycle });
  const prepareNpm = createDaemonNpmPluginChangePreparer({ happyHomeDir: configuration.happyHomeDir, runtimeLifecycle });
  return createDaemonPluginChangeService({
    prepare: async (request) => {
      if (request.kind === 'installArchive') return await prepareArchive(request);
      if (request.kind === 'installNpm') return await prepareNpm(request);
      return await preparePath(request);
    },
  });
}

async function materializeStrictIntrospectionPluginFixture(targetRoot: string): Promise<void> {
  await mkdir(join(targetRoot, '.happier-plugin'), { recursive: true });
  await writeFile(join(targetRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
    schemaVersion: 2,
    id: SAMPLE_PLUGIN_ID,
    version: '1.0.0',
    displayName: 'Acme Sample',
    description: 'Strict list/show introspection fixture',
    engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
    contributes: {
      ui: {
        translations: [{ locale: 'en-US', messages: { greeting: 'Hello' } }],
      },
    },
  }, null, 2), 'utf8');
}

async function createRemoteMarketplaceServer(): Promise<Readonly<{
  catalogUrl: string;
  archiveUrl: string;
  close: () => Promise<void>;
}>> {
  const pluginSourceRoot = await mkdtemp(join(tmpdir(), `happier-marketplace-source-${randomUUID()}-`));
  const archiveRoot = join(pluginSourceRoot, 'sample-plugin');
  await materializeSamplePluginFixture(archiveRoot);
  await writeFile(join(archiveRoot, 'package.json'), JSON.stringify({
    name: '@acme/sample',
    version: '1.0.0',
    keywords: ['happier-plugin'],
    happier: { manifest: '.happier-plugin/plugin.json' },
    files: ['.happier-plugin', 'daemon.mjs'],
  }), 'utf8');
  const archivePath = join(pluginSourceRoot, 'sample-plugin.tar.gz');
  const packed = await packLocalPlugin({ locator: archiveRoot, outPath: archivePath });
  if (!packed.ok) throw new Error(packed.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
  const archiveBytes = await readFile(archivePath);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (url.pathname === '/catalog.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(createMarketplaceCatalogDocument({
        sourceUrl: `${url.origin}/catalog.json`,
        title: 'Curated Marketplace',
        description: 'Curated plugin discovery feed',
        entries: [
          createMarketplaceCatalogEntry({
            pluginId: SAMPLE_PLUGIN_ID,
            title: 'Acme Sample',
            description: 'Sample plugin from the marketplace',
            sourceUrl: `${url.origin}/entries/acme.sample.json`,
            packageUrl: `${url.origin}/plugins/acme.sample.tar.gz`,
            categories: ['providers'],
          }),
        ],
      })));
      return;
    }

    if (url.pathname === '/plugins/acme.sample.tar.gz') {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(archiveBytes);
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind marketplace test server');
  }

  return {
    catalogUrl: `http://127.0.0.1:${address.port}/catalog.json`,
    archiveUrl: `http://127.0.0.1:${address.port}/plugins/acme.sample.tar.gz`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
      await rm(pluginSourceRoot, { recursive: true, force: true });
    },
  } as const;
}

async function seedExactCuratedMarketplaceListing(params: Readonly<{
  happyHomeDir: string;
  sourceUrl: string;
  reviewStatus?: 'approved' | 'withdrawn' | 'blocked';
  registryProfileId?: string;
  freshnessState?: 'fresh' | 'stale' | 'stale-offline';
}>) {
  const source = (await createMarketplaceSourceRegistryStore({ happyHomeDir: params.happyHomeDir }).read()).sources[0];
  if (!source || source.origin !== 'curated' || source.sourceUrl !== params.sourceUrl) {
    throw new Error('Expected the configured curated marketplace source');
  }
  const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
  const manifestDigest = `sha256:${'a'.repeat(64)}`;
  const fetchedAtMs = Date.now();
  const snapshot = {
    source: { id: source.id, title: source.title, kind: 'curated' as const, sourceUrl: source.sourceUrl },
    freshness: {
      state: params.freshnessState ?? 'fresh',
      fetchedAtMs,
      ...(params.freshnessState && params.freshnessState !== 'fresh' ? { staleSinceMs: fetchedAtMs } : {}),
    },
    entries: [{
      pluginId: SAMPLE_PLUGIN_ID,
      publisher: { id: 'acme', displayName: 'Acme' },
      display: { title: 'Acme Sample', description: 'Reviewed curated plugin' },
      distribution: {
        kind: 'npm' as const,
        registryOrigin: 'https://registry.npmjs.org',
        packageName: '@acme/sample',
        version: '1.0.0',
        integrity,
        ...(params.registryProfileId ? { registryProfileId: params.registryProfileId } : {}),
      },
      manifestDigest,
      compatibility: { happier: '>=1.0.0', platforms: ['darwin' as const, 'linux' as const, 'windows' as const] },
      summary: { contributions: ['actions'], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon' as const] },
      review: { status: params.reviewStatus ?? 'approved', reviewedAt: '2026-07-21T00:00:00.000Z' },
      categories: ['actions'],
      media: [],
      updatePolicy: 'curated-auto' as const,
      links: {},
    }],
    diagnostics: [],
  };
  const cacheDir = join(resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir }).cacheDir, 'marketplace-index');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    join(cacheDir, `${createHash('sha256').update(source.sourceUrl).digest('hex')}.json`),
    JSON.stringify({
      t: 'happier_marketplace_index_source_cache_v1',
      sourceUrl: source.sourceUrl,
      fetchedAtMs,
      etag: null,
      lastModified: null,
      snapshot,
    }),
    'utf8',
  );
  return { sourceId: source.id, integrity, manifestDigest, snapshot };
}

function marketplaceIndexServiceForSnapshot(snapshot: Awaited<ReturnType<typeof seedExactCuratedMarketplaceListing>>['snapshot']) {
  return {
    querySources: async (raw: unknown) => createMarketplaceIndex({ revision: 1, sources: [snapshot], query: raw }),
  };
}

async function writeDisposableActivationPlugin(rootDir: string, disposeMarkerPath: string): Promise<void> {
  await mkdir(join(rootDir, '.happier-plugin'), { recursive: true });
  await writeFile(
    join(rootDir, 'daemon.mjs'),
    [
      'export async function activate(api) {',
      '  return async () => {',
      '      const { appendFile } = await import("node:fs/promises");',
      `      await appendFile(${JSON.stringify(disposeMarkerPath)}, "disposed\\n", "utf8");`,
      '  };',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(rootDir, '.happier-plugin', 'plugin.json'),
    JSON.stringify(
      createPluginManifestV2Fixture({
        schemaVersion: 2,
        id: 'acme.reload-disposable',
        version: '1.0.0',
        displayName: 'Acme Reload Disposable',
        description: 'Exercises reload lifecycle ownership',
        engines: {
          happier: '^0.2.0',
        },
        entrypoints: {
          daemon: './daemon.mjs',
          development: './daemon.mjs',
        },
        activation: { events: [{ kind: 'startup' }] },
        hostAccess: {
          required: [],
          optional: [],
        },
        contributes: {},
      }),
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(join(rootDir, 'package.json'), JSON.stringify({
    name: '@acme/reload-disposable',
    version: '1.0.0',
    keywords: ['happier-plugin'],
    happier: { manifest: '.happier-plugin/plugin.json' },
    files: ['.happier-plugin', 'daemon.mjs'],
  }), 'utf8');
}

async function writeCliActionPlugin(
  rootDir: string,
  pluginId = 'acme.cli-actions',
): Promise<Readonly<{
  pluginId: string;
  actionId: string;
  toolId: string;
  actionLocalId: string;
  toolLocalId: string;
}>> {
  const actionLocalId = 'echo';
  const toolLocalId = 'note';
  const actionId = `${pluginId}/${actionLocalId}`;
  const toolId = `${pluginId}/${toolLocalId}`;
  await mkdir(join(rootDir, '.happier-plugin'), { recursive: true });
  await writeFile(
    join(rootDir, 'daemon.mjs'),
    [
      'export async function activate(api) {',
      `  api.actions.register(${JSON.stringify(actionLocalId)}, async (input, context) => ({`,
      `    actionId: ${JSON.stringify(actionId)},`,
      '    surface: context.surface,',
      '    input,',
      '  }));',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(rootDir, '.happier-plugin', 'plugin.json'),
    JSON.stringify(createPluginManifestV2Fixture({
      id: pluginId,
      displayName: 'Acme CLI Actions',
      activation: { events: [{ kind: 'startup' }] },
      contributes: {
        actions: [
          {
            id: actionLocalId,
            title: 'Echo Action',
            scopes: ['global'],
            surfaces: ['cli'],
            placement: 'commandPalette',
            dangerLevel: 'safe',
          },
        ],
        tools: [
          {
            id: toolLocalId,
            name: 'acme_cli_actions_note',
            title: 'Note Tool',
            description: 'Adds a note',
            safety: 'safe',
            surfaces: ['cli', 'agent'],
            action: actionLocalId,
          },
        ],
      },
    }), null, 2),
    'utf8',
  );
  await writeFile(join(rootDir, 'package.json'), JSON.stringify({
    name: `happier-plugin-${pluginId.replace(/\./gu, '-')}`,
    version: '1.0.0',
    keywords: ['happier-plugin'],
    happier: { manifest: '.happier-plugin/plugin.json' },
    files: ['.happier-plugin', 'daemon.mjs'],
  }), 'utf8');
  return { pluginId, actionId, toolId, actionLocalId, toolLocalId };
}

async function writeImportSideEffectPlugin(rootDir: string, importMarkerPath: string): Promise<void> {
  await mkdir(join(rootDir, '.happier-plugin'), { recursive: true });
  await writeFile(
    join(rootDir, 'daemon.mjs'),
    [
      'import { appendFile } from "node:fs/promises";',
      `await appendFile(${JSON.stringify(importMarkerPath)}, "imported\\n", "utf8");`,
      'export async function activate() {',
      '  return {};',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(rootDir, '.happier-plugin', 'plugin.json'),
    JSON.stringify(
      createPluginManifestV2Fixture({
        schemaVersion: 2,
        id: 'acme.pack-smoke',
        version: '1.2.3',
        displayName: 'Acme Pack Smoke',
        description: 'Exercises plugin pack output',
        engines: {
          happier: '^0.2.0',
        },
        entrypoints: {
          daemon: './daemon.mjs',
        },
        hostAccess: {
          required: [],
          optional: [],
        },
        contributes: {},
      }),
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(join(rootDir, 'package.json'), JSON.stringify({
    name: 'happier-plugin-acme-pack-smoke',
    version: '1.2.3',
    keywords: ['happier-plugin'],
    happier: { manifest: '.happier-plugin/plugin.json' },
    files: ['.happier-plugin', 'daemon.mjs'],
  }), 'utf8');
}

async function readPackedManifest(archivePath: string): Promise<Record<string, unknown>> {
  const extractDir = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-extract-'));
  try {
    await tar.x({
      file: archivePath,
      cwd: extractDir,
    });
    const [rootEntry] = await readdir(extractDir);
    if (!rootEntry) {
      throw new Error('Packed plugin archive did not contain a root directory');
    }
    return JSON.parse(
      await readFile(join(extractDir, rootEntry, '.happier-plugin', 'plugin.json'), 'utf8'),
    ) as Record<string, unknown>;
  } finally {
    await rm(extractDir, { recursive: true, force: true });
  }
}

async function installPluginThroughPresentUserTerminal(
  locator: string,
  flags: readonly string[] = [],
): Promise<void> {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  promptBoundary.confirm.mockResolvedValueOnce(true);
  const output = captureConsoleText();
  try {
    await handlePluginsCommand(
      ['install', locator, ...flags],
      { isInteractiveTerminal: () => true },
    );
    expect(output.text()).toContain('Installed ');
    expect(process.exitCode).toBeUndefined();
  } finally {
    output.restore();
    process.exitCode = previousExitCode;
  }
}

describe('handlePluginsCommand', () => {
  beforeEach(() => {
    activePluginChangeService = null;
    activePluginReloadController = null;
    daemonBoundary.ensureRunning.mockClear();
    daemonBoundary.requestChange.mockReset();
    daemonBoundary.decideChange.mockReset();
    daemonBoundary.readCatalog.mockReset();
    promptBoundary.confirm.mockReset();
    promptBoundary.confirm.mockResolvedValue(false);
    daemonBoundary.readCatalog.mockResolvedValue({
      kind: 'unavailable',
      code: 'daemon_unavailable',
    });
    daemonBoundary.requestChange.mockImplementation(async (request) => {
      activePluginChangeService ??= createPluginChangeService();
      return await activePluginChangeService.requestPluginChange(request);
    });
    daemonBoundary.decideChange.mockImplementation(async (decision) => {
      if (!activePluginChangeService) throw new Error('Plugin change decision arrived before its request');
      return await activePluginChangeService.decidePluginChange(decision);
    });
  });

  afterEach(async () => {
    await activePluginChangeService?.shutdown();
    await activePluginReloadController?.shutdown();
    activePluginChangeService = null;
    activePluginReloadController = null;
  });

  it('renders the plugins help page', async () => {
    const output = captureConsoleText();
    try {
      await handlePluginsCommand(['help']);

      expect(output.text()).toContain('happier plugins');
      expect(output.text()).toContain('happier plugins list [--json]');
      expect(output.text()).toContain('happier plugins install <path|archive|package> [--kind path|archive|npm]');
      expect(output.text()).toContain('happier plugins rollback <pluginId> [--json]');
      expect(output.text()).toContain('happier plugins uninstall <pluginId> [--delete-data --yes] [--json]');
      expect(output.text()).toContain('happier plugins create <name> [--id <plugin.id>] [--sdk-version <exact>] [--json]');
      expect(output.text()).toContain('happier plugins dev [path] [--json]');
      expect(output.text()).toContain('happier plugins test [path] [--packed] [--json]');
      expect(output.text()).toContain('happier plugins scaffold <target-dir> --id <plugin.id> --name <display name> [--sdk-version <exact>] [--ui hostedWeb|reactNative] [--json]');
      expect(output.text()).toContain('happier plugins author install <path> [--json]');
      expect(output.text()).toContain('happier plugins pack <path> [--out <archive.tgz>] [--json]');
      expect(output.text()).toContain('happier plugins reload <developmentPluginId> [--json]');
      expect(output.text()).toContain('happier plugins marketplace sources list [--json]');
      expect(output.text()).toContain('happier plugins marketplace list [<sourceRef>] [--json]');
      expect(output.text()).not.toContain('happier plugins call');
      expect(output.text()).not.toContain('happier plugins trust');
      expect(output.text()).not.toContain('--sdk-registry');
      expect(output.text()).not.toMatch(/\b(?:generation|fence|last-known-good|LKG)\b/iu);
      expect(output.text()).toContain('plugin-provided agent CLI surfaces');
      expect(output.text()).not.toContain('plugin-provided provider CLI surfaces');
    } finally {
      output.restore();
    }
  });

  it.each(['call', 'trust'])('does not route the retired plugins %s surface', async (subcommand) => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const output = captureConsoleJsonOutput();
    try {
      await handlePluginsCommand([subcommand, 'acme.example', '--json']);

      expect(output.json()).toMatchObject({
        ok: false,
        kind: `plugins_${subcommand}`,
        error: { code: 'unknown_subcommand' },
      });
      expect(process.exitCode).toBe(1);
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('creates the minimal normal-path plugin from only a project name', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'happier-plugin-create-parent-'));
    const canonicalParentDir = await realpath(parentDir);
    const previousCwd = process.cwd();
    try {
      process.chdir(parentDir);
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['create', 'my-plugin', '--json']);
        expect(output.json()).toMatchObject({
          ok: true,
          kind: 'plugins_create',
          data: {
            plugin: { pluginId: 'local.my-plugin', title: 'My Plugin' },
            scaffold: { targetDir: join(canonicalParentDir, 'my-plugin') },
          },
        });
      } finally {
        output.restore();
      }

      const manifest = JSON.parse(
        await readFile(join(parentDir, 'my-plugin', '.happier-plugin', 'plugin.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        entrypoints: { daemon: './dist/index.js', development: './src/index.ts' },
        contributes: { actions: [expect.objectContaining({ id: 'save-note' })] },
      });
      expect(manifest).not.toHaveProperty('activation');
      const packageJson = JSON.parse(
        await readFile(join(parentDir, 'my-plugin', 'package.json'), 'utf8'),
      ) as { dependencies?: Record<string, string> };
      expect(packageJson.dependencies?.['@happier-dev/plugin-sdk']).toBe('0.1.0');
    } finally {
      process.chdir(previousCwd);
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid development source before materializing dependencies or contacting the daemon', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-dev-invalid-'));
    await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
    await writeFile(
      join(projectRoot, '.happier-plugin', 'plugin.json'),
      JSON.stringify({ schemaVersion: 2, id: 'acme.invalid' }),
      'utf8',
    );
    const runPluginAuthorToolchain = vi.fn(async () => ({
      ok: true as const,
      operation: 'install' as const,
      projectRoot,
    }));
    const startPluginDevelopmentSourceObserver = vi.fn(async () => ({ stop: vi.fn() }));
    const requestDevelopmentChange = vi.fn(async () => ({ ok: true as const }));
    const controller = new AbortController();
    controller.abort();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const output = captureConsoleJsonOutput();
    try {
      await handlePluginsCommand(['dev', projectRoot, '--json'], {
        runPluginAuthorToolchain,
        startPluginDevelopmentSourceObserver,
        requestDevelopmentChange,
      }, { signal: controller.signal });

      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'plugins_dev',
        error: {
          code: 'plugin_dev_source_invalid',
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: 'plugin_dev_manifest_invalid' }),
          ]),
        },
      });
      expect(process.exitCode).toBe(1);
      expect(runPluginAuthorToolchain).not.toHaveBeenCalled();
      expect(startPluginDevelopmentSourceObserver).not.toHaveBeenCalled();
      expect(requestDevelopmentChange).not.toHaveBeenCalled();
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('materializes dependencies then submits only the canonical development source request', async () => {
    const controller = new AbortController();
    const inspectPluginDevelopmentSource = vi.fn(async () => ({
      ok: true as const,
      request: { kind: 'development' as const, pluginId: 'acme.example', projectRoot: '/canonical/plugin' },
      developmentEntryPath: '/canonical/plugin/src/index.ts',
      observedRelativePaths: ['.happier-plugin/plugin.json', 'src/index.ts'],
      declaredDependencies: { '@happier-dev/plugin-sdk': '0.1.0' },
      observedDirectoryPaths: ['/canonical/plugin', '/canonical/plugin/src'],
    }));
    const runPluginAuthorToolchain = vi.fn(async () => ({
      ok: true as const,
      operation: 'install' as const,
      projectRoot: '/canonical/plugin',
    }));
    const requestDevelopmentChange = vi.fn(async () => {
      setTimeout(() => controller.abort(), 0);
      return { ok: true as const, diagnostics: [] };
    });
    const stop = vi.fn();
    const startPluginDevelopmentSourceObserver = vi.fn(async (input: {
      onObservation(observation: Readonly<{
        ok: true;
        request: Readonly<{ kind: 'development'; pluginId: string; projectRoot: string }>;
        developmentEntryPath: string;
        observedRelativePaths: readonly string[];
        declaredDependencies: Readonly<Record<string, string>>;
        observedDirectoryPaths: readonly string[];
      }>): void | Promise<void>;
    }) => {
      await input.onObservation({
        ok: true,
        request: { kind: 'development', pluginId: 'acme.example', projectRoot: '/canonical/plugin' },
        developmentEntryPath: '/canonical/plugin/src/index.ts',
        observedRelativePaths: ['.happier-plugin/plugin.json', 'src/index.ts'],
        declaredDependencies: { '@happier-dev/plugin-sdk': '0.1.0' },
        observedDirectoryPaths: ['/canonical/plugin', '/canonical/plugin/src'],
      });
      return { stop };
    });
    const output = captureConsoleText();
    try {
      await handlePluginsCommand(['dev', '/fixture/plugin'], {
        inspectPluginDevelopmentSource,
        runPluginAuthorToolchain,
        startPluginDevelopmentSourceObserver,
        requestDevelopmentChange,
      }, { signal: controller.signal });

      expect(inspectPluginDevelopmentSource).toHaveBeenCalledWith({ projectRoot: '/fixture/plugin' });
      expect(runPluginAuthorToolchain).toHaveBeenCalledWith({
        operation: 'install',
        projectRoot: '/fixture/plugin',
        signal: controller.signal,
      });
      expect(inspectPluginDevelopmentSource.mock.invocationCallOrder[0]).toBeLessThan(
        runPluginAuthorToolchain.mock.invocationCallOrder[0]!,
      );
      expect(requestDevelopmentChange).toHaveBeenCalledWith({
        kind: 'development',
        pluginId: 'acme.example',
        projectRoot: '/canonical/plugin',
      }, { signal: controller.signal });
      expect(stop).toHaveBeenCalledTimes(1);
      expect(output.text()).toContain('Development candidate accepted');
    } finally {
      output.restore();
    }
  });

  it('keeps the watch loop alive and reports a coded candidate diagnostic when the daemon request fails', async () => {
    const controller = new AbortController();
    const inspectPluginDevelopmentSource = vi.fn(async () => ({
      ok: true as const,
      request: { kind: 'development' as const, pluginId: 'acme.example', projectRoot: '/canonical/plugin' },
      developmentEntryPath: '/canonical/plugin/src/index.ts',
      observedRelativePaths: ['.happier-plugin/plugin.json', 'src/index.ts'],
      declaredDependencies: {},
      observedDirectoryPaths: ['/canonical/plugin', '/canonical/plugin/src'],
    }));
    const runPluginAuthorToolchain = vi.fn(async () => ({
      ok: true as const,
      operation: 'install' as const,
      projectRoot: '/canonical/plugin',
    }));
    let requestCount = 0;
    const requestDevelopmentChange = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        throw new Error('daemon transport closed');
      }
      setTimeout(() => controller.abort(), 0);
      return { ok: true };
    });
    const stop = vi.fn();
    const startPluginDevelopmentSourceObserver = vi.fn(async (input: {
      onObservation(observation: Awaited<ReturnType<typeof inspectPluginDevelopmentSource>>): void | Promise<void>;
    }) => {
      await input.onObservation(await inspectPluginDevelopmentSource());
      await input.onObservation(await inspectPluginDevelopmentSource());
      return { stop };
    });
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const output = captureConsoleJsonOutput();
    try {
      await expect(handlePluginsCommand(['dev', '/fixture/plugin', '--json'], {
        inspectPluginDevelopmentSource,
        runPluginAuthorToolchain,
        startPluginDevelopmentSourceObserver,
        requestDevelopmentChange,
      }, { signal: controller.signal })).resolves.toBeUndefined();

      expect(output.logs).toHaveLength(2);
      expect(JSON.parse(output.logs[0]!) as unknown).toMatchObject({
        ok: false,
        kind: 'plugins_dev_change',
        error: {
          code: 'plugin_dev_candidate_request_failed',
          diagnostics: [{
            code: 'plugin_dev_candidate_request_failed',
            message: expect.stringContaining('daemon transport closed'),
          }],
        },
      });
      expect(JSON.parse(output.logs[1]!) as unknown).toMatchObject({
        ok: true,
        kind: 'plugins_dev_change',
        data: {
          projectRoot: '/canonical/plugin',
          observedFiles: 2,
        },
      });
      expect(requestDevelopmentChange).toHaveBeenCalledTimes(2);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('aborts a pending initial daemon submission and stops the observer promptly', async () => {
    const controller = new AbortController();
    const inspectPluginDevelopmentSource = vi.fn(async () => ({
      ok: true as const,
      request: { kind: 'development' as const, pluginId: 'acme.example', projectRoot: '/canonical/plugin' },
      developmentEntryPath: '/canonical/plugin/src/index.ts',
      observedRelativePaths: ['.happier-plugin/plugin.json', 'src/index.ts'],
      declaredDependencies: {},
      observedDirectoryPaths: ['/canonical/plugin', '/canonical/plugin/src'],
    }));
    const runPluginAuthorToolchain = vi.fn(async () => ({
      ok: true as const,
      operation: 'install' as const,
      projectRoot: '/canonical/plugin',
    }));
    const requestDevelopmentChange = vi.fn((
      _request: { kind: 'development'; pluginId: string; projectRoot: string },
      options?: { signal?: AbortSignal },
    ) => new Promise<Readonly<{ ok: boolean }>>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }));
    const stop = vi.fn();
    const startPluginDevelopmentSourceObserver = vi.fn(async (input: {
      onObservation(observation: Awaited<ReturnType<typeof inspectPluginDevelopmentSource>>): void | Promise<void>;
    }) => {
      await input.onObservation(await inspectPluginDevelopmentSource());
      return { stop };
    });

    const command = handlePluginsCommand(['dev', '/fixture/plugin'], {
      inspectPluginDevelopmentSource,
      runPluginAuthorToolchain,
      startPluginDevelopmentSourceObserver,
      requestDevelopmentChange,
    }, { signal: controller.signal });
    await vi.waitFor(() => expect(requestDevelopmentChange).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(Promise.race([
      command.then(() => 'resolved' as const),
      new Promise<'timed-out'>((resolveTimeout) => setTimeout(() => resolveTimeout('timed-out'), 250)),
    ])).resolves.toBe('resolved');
    expect(requestDevelopmentChange).toHaveBeenCalledWith(
      { kind: 'development', pluginId: 'acme.example', projectRoot: '/canonical/plugin' },
      { signal: controller.signal },
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('boots the curated marketplace source into the shared registry and uses it without an explicit source reference', async () => {
    const home = await createTempDir('happier-plugin-marketplace-curated-default-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH', 'HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '', HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: '' });
    reloadConfiguration();

    const marketplace = await createRemoteMarketplaceServer();
    const sourceUrl = 'https://marketplace.example.test/catalog.json';
    envScope.patch({ HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: sourceUrl });

    try {
      const sourcesOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'sources', 'list', '--json']);

        const parsed = sourcesOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: {
            sources: Array<{
              id: string;
              title: string;
              sourceUrl: string;
              enabled: boolean;
              origin: string;
            }>;
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_marketplace_sources_list');
        expect(parsed.data?.sources).toHaveLength(1);
        expect(parsed.data?.sources[0]).toMatchObject({
          title: 'Happier curated marketplace',
          sourceUrl,
          enabled: true,
          origin: 'curated',
        });
        expect(parsed.data?.sources[0].id).toMatch(/^marketplace:[0-9a-f]{12}$/);
      } finally {
        sourcesOutput.restore();
      }

      const installOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'install', SAMPLE_PLUGIN_ID, '--json']);

        const parsed = installOutput.json<{ v: 1; ok: boolean; kind: string; error?: { code: string } }>();

        expect(parsed.ok).toBe(false);
        expect(parsed.kind).toBe('plugins_marketplace_install');
        expect(parsed.error?.code).toBe('install_unavailable');
        expect(daemonBoundary.requestChange).not.toHaveBeenCalled();
      } finally {
        installOutput.restore();
      }

      const disableOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'sources', 'disable', sourceUrl, '--json']);

        const parsed = disableOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: {
            source: {
              id: string;
              sourceUrl: string;
              enabled: boolean;
              origin: string;
            };
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_marketplace_sources_disable');
        expect(parsed.data?.source).toMatchObject({
          sourceUrl,
          enabled: false,
          origin: 'curated',
        });
      } finally {
        disableOutput.restore();
      }

      const disabledRegistry = JSON.parse(await readFile(join(home, 'plugins', 'plugins', 'state', 'marketplace-source-registry.v1.json'), 'utf8')) as {
        sources: Array<{ enabled: boolean }>;
      };
      expect(disabledRegistry.sources[0]?.enabled).toBe(false);
    } finally {
      await marketplace.close();
      envScope.restore();
      await removeTempDir(home);
    }
  });

  it('scaffolds a packable public SDK plugin template without internal imports', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-parent-'));
    const targetDir = join(parentDir, 'acme-scaffold');
    const archivePath = join(parentDir, 'acme-scaffold.happier-plugin.tgz');

    try {
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand([
          'scaffold',
          targetDir,
          '--id',
          'acme.scaffold',
          '--name',
          'Acme Scaffold',
          '--sdk-version',
          '0.1.0-vertical-a.cli-command',
          '--json',
        ]);

        const parsed = output.json<{
          ok: boolean;
          kind: string;
          data?: {
            plugin: {
              pluginId: string;
              title: string;
              version: string;
            };
            scaffold: {
              targetDir: string;
              manifestPath: string;
              manifestSchemaPath: string;
              packageJsonPath: string;
              sourceEntryPath: string;
              uiEntryPath?: string;
            };
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_scaffold');
        expect(parsed.data?.plugin).toEqual({
          pluginId: 'acme.scaffold',
          title: 'Acme Scaffold',
          version: '0.1.0',
        });
        expect(parsed.data?.scaffold).toEqual({
          targetDir,
          manifestPath: join(targetDir, '.happier-plugin', 'plugin.json'),
          manifestSchemaPath: join(targetDir, '.happier-plugin', 'plugin.schema.json'),
          packageJsonPath: join(targetDir, 'package.json'),
          sourceEntryPath: join(targetDir, 'src', 'index.ts'),
        });
      } finally {
        output.restore();
      }

      const manifest = JSON.parse(await readFile(join(targetDir, '.happier-plugin', 'plugin.json'), 'utf8')) as {
        schemaVersion: number;
        id: string;
        version: string;
        displayName: string;
        engines?: { happier?: string };
        entrypoints?: { daemon?: string; development?: string };
        activation?: { events?: Array<{ kind?: string }> };
        hostAccess?: { required?: unknown[]; optional?: unknown[] };
        contributes?: {
          actions?: Array<{ id?: string }>;
        };
      };
      expect(manifest).toMatchObject({
        schemaVersion: 2,
        id: 'acme.scaffold',
        version: '0.1.0',
        displayName: 'Acme Scaffold',
        engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
        entrypoints: {
          daemon: './dist/index.js',
          development: './src/index.ts',
        },
      });
      expect(manifest).not.toHaveProperty('activation');
      expect(manifest).not.toHaveProperty('targets');
      expect(manifest).not.toHaveProperty('capabilities.permissions');
      expect(manifest).not.toHaveProperty('uses');
      expect(manifest).not.toHaveProperty('permissions');
      expect(manifest.entrypoints).not.toHaveProperty('main');
      expect(manifest.contributes?.actions).toEqual([
        expect.objectContaining({ id: 'save-note' }),
      ]);
      expect(manifest.contributes).not.toHaveProperty('ui');

      const packageJson = JSON.parse(await readFile(join(targetDir, 'package.json'), 'utf8')) as {
        name?: string;
        type?: string;
        private?: boolean;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        happier?: { manifest?: string };
        keywords?: string[];
        files?: string[];
      };
      expect(packageJson).toMatchObject({
        name: 'happier-plugin-acme-scaffold',
        type: 'module',
        happier: { manifest: '.happier-plugin/plugin.json' },
        keywords: ['happier-plugin'],
        files: ['.happier-plugin', 'dist'],
      });
      expect(packageJson.private).toBeUndefined();
      expect(packageJson.scripts?.['pack:plugin']).toBe('happier plugins pack .');
      expect(packageJson.scripts?.build).toBe('happier plugins author build .');
      expect(packageJson.scripts?.typecheck).toBe('happier plugins author typecheck .');
      expect(packageJson.scripts?.test).toBe('happier plugins test .');
      expect(packageJson.dependencies?.['@happier-dev/plugin-sdk']).toBe('0.1.0-vertical-a.cli-command');
      expect(packageJson.devDependencies?.['@typescript/native']).toBe('npm:typescript@7.0.2');
      expect(packageJson.devDependencies).not.toHaveProperty('typescript');
      expect({
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      }).not.toHaveProperty('@happier-dev/protocol');
      expect({
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      }).not.toHaveProperty('@happier-dev/agents');

      const sourceEntry = await readFile(join(targetDir, 'src', 'index.ts'), 'utf8');
      expect(sourceEntry).toContain('@happier-dev/plugin-sdk');
      expect(sourceEntry).not.toMatch(/@happier-dev\/(?:protocol|agents)\b|plugin-sdk\/internal\b|from ['"]@\/|import\(['"]@\//u);
      expect(sourceEntry).toContain('activate(api: PluginApi)');
      expect(sourceEntry).not.toContain('PluginActivationApi');
      expect(sourceEntry).toContain("api.actions.register('save-note'");

      await mkdir(join(targetDir, 'dist'), { recursive: true });
      await writeFile(join(targetDir, 'dist', 'index.js'), 'export function activate() {}\n', 'utf8');
      const packResult = await packLocalPlugin({
        locator: targetDir,
        outPath: archivePath,
      });
      expect(packResult.ok).toBe(true);
      if (packResult.ok) {
        expect(packResult.pluginId).toBe('acme.scaffold');
        expect(packResult.title).toBe('Acme Scaffold');
        expect(packResult.archivePath).toBe(archivePath);
      }
    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it('dispatches packed-author operations through the author toolchain owner', async () => {
    const output = captureConsoleJsonOutput();
    const runPluginAuthorToolchain = vi.fn(async () => ({
      ok: true as const,
      operation: 'install' as const,
      projectRoot: '/fixture/plugin',
    }));
    try {
      await handlePluginsCommand([
        'author',
        'install',
        '/fixture/plugin',
        '--sdk-registry',
        'http://127.0.0.1:43127',
        '--json',
      ], {
        runPluginAuthorToolchain,
      });

      expect(runPluginAuthorToolchain).toHaveBeenCalledWith({
        operation: 'install',
        projectRoot: '/fixture/plugin',
        sdkRegistryOrigin: 'http://127.0.0.1:43127',
      });
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'plugins_author_install',
        data: { operation: 'install', projectRoot: '/fixture/plugin' },
      });
    } finally {
      output.restore();
    }
  });

  it('dispatches the normal plugin test front door through the daemon-independent author test owner', async () => {
    const output = captureConsoleJsonOutput();
    const runPluginAuthorToolchain = vi.fn(async () => ({
      ok: true as const,
      operation: 'test' as const,
      projectRoot: '/fixture/plugin',
    }));
    try {
      await handlePluginsCommand(['test', '/fixture/plugin', '--json'], {
        runPluginAuthorToolchain,
      });

      expect(runPluginAuthorToolchain).toHaveBeenCalledWith({
        operation: 'test',
        projectRoot: '/fixture/plugin',
      });
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'plugins_test',
        data: { mode: 'unit', operation: 'test', projectRoot: '/fixture/plugin' },
      });
    } finally {
      output.restore();
    }
  });

  it('renders plugin test help without invoking the author toolchain', async () => {
    const output = captureConsoleText();
    const runPluginAuthorToolchain = vi.fn();
    try {
      await handlePluginsCommand(['test', '--help'], { runPluginAuthorToolchain });

      expect(runPluginAuthorToolchain).not.toHaveBeenCalled();
      expect(output.text()).toContain('happier plugins test [path] [--packed] [--json]');
    } finally {
      output.restore();
    }
  });

  it('dispatches packed plugin testing through the isolated daemon-backed author test owner', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const output = captureConsoleJsonOutput();
    const runPluginAuthorToolchain = vi.fn();
    const runPackedPluginTest = vi.fn(async () => ({
      ok: true as const,
      mode: 'packed' as const,
      projectRoot: '/fixture/plugin',
      pluginId: 'acme.packed',
      archiveDigest: `sha256:${'a'.repeat(64)}`,
      invocation: {
        actionId: 'acme.packed/verify',
        result: { verified: true },
      },
      daemon: {
        authenticatedControl: true as const,
        initialPid: 101,
        restartedPid: 102,
        initialIncarnationId: 'incarnation-1',
        restartedIncarnationId: 'incarnation-2',
        staleIncarnationRejected: true as const,
      },
    }));
    try {
      await handlePluginsCommand(['test', '/fixture/plugin', '--packed', '--json'], {
        runPluginAuthorToolchain,
        runPackedPluginTest,
      });

      expect(runPluginAuthorToolchain).not.toHaveBeenCalled();
      expect(runPackedPluginTest).toHaveBeenCalledWith({
        projectRoot: '/fixture/plugin',
      });
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'plugins_test',
        data: {
          mode: 'packed',
          projectRoot: '/fixture/plugin',
          pluginId: 'acme.packed',
          invocation: {
            actionId: 'acme.packed/verify',
            result: { verified: true },
          },
        },
      });
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('scaffolds a reactNative-ui public SDK plugin template (DEC-6 flagship mode)', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-rn-parent-'));
    const targetDir = join(parentDir, 'acme-rn-scaffold');

    try {
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand([
          'scaffold',
          targetDir,
          '--id',
          'acme.rnscaffold',
          '--name',
          'Acme RN Scaffold',
          '--ui',
          'reactNative',
          '--json',
        ]);

        const parsed = output.json<{
          ok: boolean;
          kind: string;
          data?: {
            scaffold: {
              uiEntryPath?: string;
            };
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.data?.scaffold.uiEntryPath).toBe(join(targetDir, 'src', 'ui', 'renderSurface.tsx'));
      } finally {
        output.restore();
      }

      const manifest = JSON.parse(await readFile(join(targetDir, '.happier-plugin', 'plugin.json'), 'utf8')) as {
        contributes?: {
          ui?: {
            views?: Array<{ id?: string; renderer?: string }>;
            renderers?: Array<{ id?: string; kind?: string; artifact?: string }>;
          };
        };
      };
      expect(manifest.contributes?.ui).toMatchObject({
        views: [expect.objectContaining({ id: 'main', renderer: 'main-native' })],
        renderers: [expect.objectContaining({
          id: 'main-native',
          kind: 'reactNative',
          artifact: 'main-native',
        })],
      });

      const uiEntry = await readFile(join(targetDir, 'src', 'ui', 'renderSurface.tsx'), 'utf8');
      expect(uiEntry).toContain('export function renderSurface');

      // The reactNative scaffold ships a wired Vite build (vite.config.mjs +
      // pluginUiBuild.mjs) so `npm run build:ui` produces a loadable web
      // artifact out-of-repo without repo access.
      const viteConfig = await readFile(join(targetDir, 'vite.config.mjs'), 'utf8');
      expect(viteConfig).toContain('@happier-dev/plugin-sdk/ui/build');
      const uiBuildConfig = await readFile(join(targetDir, 'pluginUiBuild.mjs'), 'utf8');
      expect(uiBuildConfig).toContain('definePluginUiBuildConfig');
      expect(uiBuildConfig).not.toContain('createManagedRuntimeBundlerRunner');
      const scaffoldPackageJson = JSON.parse(
        await readFile(join(targetDir, 'package.json'), 'utf8'),
      ) as { scripts?: Record<string, string>; devDependencies?: Record<string, string> };
      expect(scaffoldPackageJson.scripts?.['build:ui']).toBe('happier-plugin-build-ui --project-root .');
      expect(scaffoldPackageJson.devDependencies?.vite).toBe('^7.0.0');

    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it('fails closed instead of overwriting an existing scaffold target', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-collision-'));
    const targetDir = join(parentDir, 'existing-plugin');
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await mkdir(targetDir, { recursive: true });
      await writeFile(join(targetDir, 'package.json'), '{"name":"keep-me"}\n', 'utf8');

      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand([
          'scaffold',
          targetDir,
          '--id',
          'acme.collision',
          '--name',
          'Acme Collision',
          '--json',
        ]);

        const parsed = output.json<{
          ok: boolean;
          kind: string;
          error?: { code?: string; diagnostics?: Array<{ code?: string; message?: string }> };
        }>();

        expect(parsed.ok).toBe(false);
        expect(parsed.kind).toBe('plugins_scaffold');
        expect(parsed.error?.code).toBe('scaffold_failed');
        expect(parsed.error?.diagnostics?.[0]).toMatchObject({
          code: 'plugin_scaffold_target_exists',
        });
        expect(process.exitCode).toBe(1);
      } finally {
        output.restore();
      }

      expect(await readFile(join(targetDir, 'package.json'), 'utf8')).toBe('{"name":"keep-me"}\n');
      await expect(readFile(join(targetDir, '.happier-plugin', 'plugin.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      process.exitCode = previousExitCode;
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it('packs a local plugin into an installable archive and digest artifact without executing daemon code', async () => {
    const home = await createTempDir('happier-plugin-pack-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-source-'));
    const outDir = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-output-'));
    const archivePath = join(outDir, 'acme-pack-smoke.happier-plugin.tgz');
    const importMarkerPath = join(home, 'daemon-imported.log');
    await writeImportSideEffectPlugin(sourceRoot, importMarkerPath);

    try {
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['pack', sourceRoot, '--out', archivePath, '--json']);

        const parsed = output.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: {
            plugin: {
              pluginId: string;
              title: string;
              version: string;
            };
            package: {
              archivePath: string;
              digestPath: string;
              archiveDigest: string;
              manifestDigest: string;
            };
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_pack');
        expect(parsed.data?.plugin).toEqual({
          pluginId: 'acme.pack-smoke',
          title: 'Acme Pack Smoke',
          version: '1.2.3',
        });
        expect(parsed.data?.package.archivePath).toBe(archivePath);
        expect(parsed.data?.package.digestPath).toBe(`${archivePath}.sha256`);
        expect(parsed.data?.package.archiveDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
        expect(parsed.data?.package.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);

        const archiveBytes = await readFile(archivePath);
        const archiveDigest = `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`;
        expect(parsed.data?.package.archiveDigest).toBe(archiveDigest);
        expect(await readFile(`${archivePath}.sha256`, 'utf8')).toBe(
          `${archiveDigest}  ${basename(archivePath)}\n`,
        );
      } finally {
        output.restore();
      }

      await expect(readFile(importMarkerPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });

      await installPluginThroughPresentUserTerminal(archivePath);
      expect(promptBoundary.confirm).toHaveBeenCalledWith(
        expect.stringContaining('Install & Trust Acme Pack Smoke 1.2.3'),
        { default: 'no' },
      );
      const installed = (await readInstalledPluginCatalog({ happyHomeDir: home }))
        .find((entry) => entry.pluginId === 'acme.pack-smoke');
      expect(installed?.source).toMatchObject({
        kind: 'archive',
        trustPolicy: 'prompt',
        installPolicy: 'managed_install',
      });
      expect(installed?.install.mode).toBe('managed_install');

      expect(await readFile(importMarkerPath, 'utf8')).toBe('imported\n');
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails closed when packing a local source without a valid manifest', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-missing-manifest-'));
    const outDir = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-output-'));
    const archivePath = join(outDir, 'missing.happier-plugin.tgz');
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['pack', sourceRoot, '--out', archivePath, '--json']);

        const parsed = output.json<{
          v: 1;
          ok: boolean;
          kind: string;
          error?: {
            code: string;
            diagnostics: Array<{ code: string; message: string }>;
          };
        }>();

        expect(parsed.ok).toBe(false);
        expect(parsed.kind).toBe('plugins_pack');
        expect(parsed.error?.code).toBe('pack_failed');
        expect(parsed.error?.diagnostics).toEqual([
          expect.objectContaining({
            code: 'plugin_manifest_missing',
          }),
        ]);
        expect(process.exitCode).toBe(1);
        await expect(readFile(archivePath, 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(readFile(`${archivePath}.sha256`, 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        output.restore();
      }
    } finally {
      process.exitCode = previousExitCode;
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('fails closed instead of overwriting an existing pack digest artifact', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-digest-collision-source-'));
    const outDir = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-digest-collision-output-'));
    const archivePath = join(outDir, 'acme-pack-smoke.happier-plugin.tgz');
    await writeImportSideEffectPlugin(sourceRoot, join(outDir, 'daemon-imported.log'));
    await writeFile(`${archivePath}.sha256`, 'existing digest\n', 'utf8');
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['pack', sourceRoot, '--out', archivePath, '--json']);

        const parsed = output.json<{
          ok: boolean;
          kind: string;
          error?: { diagnostics: Array<{ code: string; message: string }> };
        }>();

        expect(parsed.ok).toBe(false);
        expect(parsed.kind).toBe('plugins_pack');
        expect(parsed.error?.diagnostics[0]?.message).toContain('digest output already exists');
        expect(await readFile(`${archivePath}.sha256`, 'utf8')).toBe('existing digest\n');
        await expect(readFile(archivePath, 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(process.exitCode).toBe(1);
      } finally {
        output.restore();
      }
    } finally {
      process.exitCode = previousExitCode;
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('expands tilde output paths through the CLI home directory helper', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-tilde-source-'));
    const outHome = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-tilde-home-'));
    await writeImportSideEffectPlugin(sourceRoot, join(outHome, 'daemon-imported.log'));
    const envScope = createEnvKeyScope(['HOME', 'USERPROFILE']);
    envScope.patch({ HOME: outHome, USERPROFILE: outHome });

    try {
      const result = await packLocalPlugin({
        locator: sourceRoot,
        outPath: '~/packed.happier-plugin.tgz',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.archivePath).toBe(join(outHome, 'packed.happier-plugin.tgz'));
        expect(result.digestPath).toBe(join(outHome, 'packed.happier-plugin.tgz.sha256'));
      }
    } finally {
      envScope.restore();
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(outHome, { recursive: true, force: true });
    }
  });

  it('leaves authored manifest bytes untouched and does not inspect them during dry-run', async () => {
    const home = await createTempDir('happier-plugin-invalid-dry-run-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-invalid-source-'));
    await mkdir(join(sourceRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(sourceRoot, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
    const manifest = createPluginManifestV2Fixture({
      id: 'acme.invalid-dry-run',
      contributes: {
        actions: [
          {
            id: 'keep-valid',
            title: 'Keep valid action',
            scopes: ['global'],
            surfaces: ['cli'],
            placement: 'commandPalette',
            dangerLevel: 'safe',
          },
          {
            id: 'keep-valid',
            title: 'Duplicate action',
            scopes: ['global'],
            surfaces: ['cli'],
            placement: 'commandPalette',
            dangerLevel: 'safe',
          },
        ],
        settings: [
          {
            id: 'keep-settings',
            title: 'Keep settings',
            target: { kind: 'plugin' },
            scope: 'local',
            fields: [
              {
                id: 'enabled',
                title: 'Keep enabled',
                schema: { type: 'boolean' },
                default: true,
              },
            ],
          },
        ],
      },
    });
    const manifestPath = join(sourceRoot, '.happier-plugin', 'plugin.json');
    const authoredBytes = `${JSON.stringify(manifest, null, 4)}\n`;
    await writeFile(manifestPath, authoredBytes, 'utf8');

    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['install', sourceRoot, '--dry-run', '--json']);
        const parsed = output.json<{
          ok: boolean;
          kind: string;
          data?: { dryRun: boolean; request: { kind: string; locator: string } };
        }>();
        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_install');
        expect(parsed.data).toMatchObject({
          dryRun: true,
          request: { kind: 'installPath', locator: sourceRoot },
        });
        expect(process.exitCode).toBe(0);
        expect(daemonBoundary.requestChange).not.toHaveBeenCalled();
      } finally {
        output.restore();
      }

      expect(await readFile(manifestPath, 'utf8')).toBe(authoredBytes);
    } finally {
      process.exitCode = previousExitCode;
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it('packs a canonical manifest into the archive without rewriting the authored source manifest', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-normalized-source-'));
    const outDir = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-normalized-output-'));
    const manifestPath = join(sourceRoot, '.happier-plugin', 'plugin.json');
    await mkdir(join(sourceRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(sourceRoot, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
    const manifest = createPluginManifestV2Fixture({
      id: 'acme.pack-normalized',
      contributes: {
        hooks: [
          {
            hookApiVersion: 1,
            id: 'session-started',
            on: 'session.spawned',
            category: 'lifecycle',
            scope: 'session',
            executionKind: 'observe',
          },
        ],
      },
    });
    const authoredBytes = `${JSON.stringify(manifest, null, 4)}\n`;
    await writeFile(manifestPath, authoredBytes, 'utf8');
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({
      name: 'happier-plugin-acme-pack-normalized',
      version: manifest.version,
      keywords: ['happier-plugin'],
      happier: { manifest: '.happier-plugin/plugin.json' },
      files: ['.happier-plugin', 'daemon.mjs'],
    }), 'utf8');

    try {
      const result = await packLocalPlugin({
        locator: sourceRoot,
        outPath: join(outDir, 'acme-pack-normalized.happier-plugin.tgz'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(await readFile(manifestPath, 'utf8')).toBe(authoredBytes);
      const packedManifest = await readPackedManifest(result.archivePath);
      const contributes = packedManifest.contributes as {
        hooks?: Array<{ executionKind?: string }>;
      };
      expect(contributes.hooks?.[0]?.executionKind).toBe('observe');
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('persists marketplace sources and uses the registry when browsing without an explicit source reference', async () => {
    const home = await createTempDir('happier-plugin-marketplace-registry-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH', 'HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const marketplace = await createRemoteMarketplaceServer();
    const sourceUrl = 'https://marketplace.example.test/catalog.json';
    envScope.patch({ HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: sourceUrl });
    try {
      const addOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'sources', 'add', sourceUrl, '--title', 'Curated Marketplace', '--registry-profile', 'registry_private', '--json']);

        const parsed = addOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: {
            source: {
              id: string;
              title: string;
              sourceUrl: string;
              enabled: boolean;
              origin: string;
              registryProfileId: string | null;
            };
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_marketplace_sources_add');
        expect(parsed.data?.source).toMatchObject({
          title: 'Curated Marketplace',
          sourceUrl,
          enabled: true,
          origin: 'curated',
          registryProfileId: 'registry_private',
        });
        expect(parsed.data?.source.id).toMatch(/^marketplace:[0-9a-f]{12}$/);
      } finally {
        addOutput.restore();
      }

      const registryPath = join(home, 'plugins', 'plugins', 'state', 'marketplace-source-registry.v1.json');
      const registry = JSON.parse(await readFile(registryPath, 'utf8')) as { sources: ReadonlyArray<{ sourceUrl: string; title: string; enabled: boolean; registryProfileId?: string | null }> };
      expect(registry.sources).toHaveLength(1);
      expect(registry.sources[0]).toMatchObject({
        title: 'Curated Marketplace',
        sourceUrl,
        enabled: true,
        registryProfileId: 'registry_private',
      });

      const unbindOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'sources', 'add', sourceUrl, '--no-registry-profile', '--json']);
        expect(unbindOutput.json()).toMatchObject({
          ok: true,
          kind: 'plugins_marketplace_sources_add',
          data: { source: { registryProfileId: null } },
        });
      } finally {
        unbindOutput.restore();
      }
      const unboundRegistry = JSON.parse(await readFile(registryPath, 'utf8')) as { sources: ReadonlyArray<{ registryProfileId?: string }> };
      expect(unboundRegistry.sources[0]).not.toHaveProperty('registryProfileId');

      const sourcesOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'sources', 'list', '--json']);

        const parsed = sourcesOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: {
            sources: Array<{
              id: string;
              title: string;
              sourceUrl: string;
              enabled: boolean;
            }>;
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_marketplace_sources_list');
        expect(parsed.data?.sources).toHaveLength(1);
        expect(parsed.data?.sources[0]).toMatchObject({
          title: 'Curated Marketplace',
          sourceUrl,
          enabled: true,
        });
      } finally {
        sourcesOutput.restore();
      }

      const listOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'list', '--json']);

        const parsed = listOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: {
            source: {
              sourceUrl: string;
              title: string;
            };
            catalog: {
              sourceUrl: string;
            };
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_marketplace_list');
        expect(parsed.data?.source).toMatchObject({
          title: 'Curated Marketplace',
          sourceUrl,
        });
        expect(parsed.data?.catalog.sourceUrl).toBe(sourceUrl);
      } finally {
        listOutput.restore();
      }
    } finally {
      await marketplace.close();
      await removeTempDir(home).catch(() => undefined);
    }
  });

  it('sends an approved exact curated listing through the canonical daemon change request', async () => {
    const home = await createTempDir('happier-plugin-marketplace-exact-install-');
    const sourceUrl = 'https://marketplace.invalid/catalog.json';
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH', 'HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
    envScope.patch({
      HAPPIER_HOME_DIR: home,
      PATH: process.env.PATH ?? '',
      HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: sourceUrl,
    });
    reloadConfiguration();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const listing = await seedExactCuratedMarketplaceListing({ happyHomeDir: home, sourceUrl });
    daemonBoundary.requestChange.mockResolvedValueOnce({
      kind: 'committed',
      pluginId: SAMPLE_PLUGIN_ID,
      desiredGeneration: 'generation-marketplace-1',
      appliedGeneration: 'generation-marketplace-1',
      pendingSurfaces: [],
    });

    try {
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'install', SAMPLE_PLUGIN_ID, '--json'], {
          marketplaceIndexService: marketplaceIndexServiceForSnapshot(listing.snapshot),
        });

        const parsed = output.json<{
          ok: boolean;
          kind: string;
          data?: { pluginId?: string; desiredGeneration?: string };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_marketplace_install');
        expect(parsed.data).toMatchObject({
          pluginId: SAMPLE_PLUGIN_ID,
          desiredGeneration: 'generation-marketplace-1',
        });
      } finally {
        output.restore();
      }

      expect(daemonBoundary.requestChange).toHaveBeenCalledWith({
        kind: 'installNpm',
        packageName: '@acme/sample',
        selector: '1.0.0',
        registryOrigin: 'https://registry.npmjs.org',
        expectedMarketplaceListing: {
          source: { id: listing.sourceId, kind: 'curated', sourceUrl },
          pluginId: SAMPLE_PLUGIN_ID,
          publisher: { id: 'acme', displayName: 'Acme' },
          packageName: '@acme/sample',
          registryOrigin: 'https://registry.npmjs.org',
          version: '1.0.0',
          integrity: listing.integrity,
          manifestDigest: listing.manifestDigest,
          review: { status: 'approved', reviewedAt: '2026-07-21T00:00:00.000Z' },
          updatePolicy: 'automatic',
        },
      });
      expect(daemonBoundary.decideChange).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it.each([
    ['withdrawn review', { reviewStatus: 'withdrawn' as const }, /withdrawn|approved review/i],
    ['unverified registry profile', { registryProfileId: 'registry:private' }, /registry profile|artifact access/i],
    ['stale marketplace facts', { freshnessState: 'stale' as const }, /fresh marketplace|source facts/i],
    ['stale-offline marketplace facts', { freshnessState: 'stale-offline' as const }, /fresh marketplace|source facts/i],
  ])('fails closed for a curated listing with %s before contacting the daemon', async (_label, listingOverride, expectedMessage) => {
    const home = await createTempDir('happier-plugin-marketplace-refused-install-');
    const sourceUrl = 'https://marketplace.invalid/catalog.json';
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH', 'HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
    envScope.patch({
      HAPPIER_HOME_DIR: home,
      PATH: process.env.PATH ?? '',
      HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: sourceUrl,
    });
    reloadConfiguration();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const listing = await seedExactCuratedMarketplaceListing({ happyHomeDir: home, sourceUrl, ...listingOverride });

    try {
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'install', SAMPLE_PLUGIN_ID, '--json'], {
          marketplaceIndexService: marketplaceIndexServiceForSnapshot(listing.snapshot),
        });
        const parsed = output.json<{ ok: boolean; error?: { code?: string; message?: string } }>();
        expect(parsed.ok).toBe(false);
        expect(parsed.error).toMatchObject({ code: 'install_unavailable' });
        expect(parsed.error?.message).toMatch(expectedMessage);
      } finally {
        output.restore();
      }
      expect(daemonBoundary.requestChange).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('installs a local-path plugin only through the present-user terminal review', async () => {
    const home = await createTempDir('happier-plugin-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    await materializeSamplePluginFixture(sourceRoot);

    try {
      await installPluginThroughPresentUserTerminal(sourceRoot);
      expect(promptBoundary.confirm).toHaveBeenCalledWith(
        expect.stringContaining('Install & Trust Acme Sample 1.0.0'),
        { default: 'no' },
      );
      expect(daemonBoundary.requestChange).toHaveBeenCalledWith({
        kind: 'installPath', locator: sourceRoot, development: false,
      });
      expect(daemonBoundary.decideChange).toHaveBeenCalledWith(expect.objectContaining({
        decision: 'installAndTrust',
        actorEvidence: expect.objectContaining({ kind: 'authenticatedLocalUser' }),
      }));
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('reports daemon-owned post-commit reconciliation as pending', async () => {
    const home = await createTempDir('happier-plugin-cli-reconciliation-pending-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    await materializeSamplePluginFixture(sourceRoot);
    daemonBoundary.requestChange.mockResolvedValueOnce({
      kind: 'committed',
      pluginId: SAMPLE_PLUGIN_ID,
      desiredGeneration: 'generation-1',
      appliedGeneration: null,
      pendingSurfaces: ['runtime'],
    });

    try {
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['install', sourceRoot, '--json']);
        const parsed = output.json<{ ok: boolean; data?: { pendingSurfaces: readonly string[]; appliedGeneration: string | null } }>();
        expect(parsed.ok).toBe(true);
        expect(parsed.data).toMatchObject({ pendingSurfaces: ['runtime'], appliedGeneration: null });
      } finally {
        output.restore();
      }

    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('uninstalls a local-path plugin while reporting unauthenticated custody retirement as pending', async () => {
    const home = await createTempDir('happier-plugin-uninstall-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-uninstall-source-'));
    await materializeSamplePluginFixture(sourceRoot);
    try {
      await installPluginThroughPresentUserTerminal(sourceRoot);

      const paths = resolvePluginStorePaths({ happyHomeDir: home });
      const preservedStorage = createPluginStorageOwner({
        pluginId: SAMPLE_PLUGIN_ID,
        paths,
        sessionId: 'session-1',
      });
      await preservedStorage.local.set('settings', { preserved: true });
      await preservedStorage.session.set('draft', { preserved: true });
      await createPluginSecretStore({ pluginId: SAMPLE_PLUGIN_ID, paths }).set('token', 'preserved');

      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['uninstall', SAMPLE_PLUGIN_ID, '--json']);

        const parsed = output.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: {
            plugin: {
              pluginId: string;
              source: { kind: string };
            };
            desiredGeneration: string | null;
            appliedGeneration: string | null;
            pendingSurfaces: readonly string[];
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_uninstall');
        expect(parsed.data?.plugin).toMatchObject({
          pluginId: SAMPLE_PLUGIN_ID,
          source: {
            kind: 'path',
          },
        });
        expect(parsed.data).toMatchObject({
          desiredGeneration: null,
          appliedGeneration: null,
          pendingSurfaces: ['reconciliation'],
        });
      } finally {
        output.restore();
      }

      expect(daemonBoundary.requestChange).toHaveBeenLastCalledWith({ kind: 'uninstall', pluginId: SAMPLE_PLUGIN_ID });
      const state = await createPluginStateStore({ happyHomeDir: home }).read();
      expect(state.plugins[SAMPLE_PLUGIN_ID]).toBeUndefined();
      expect(await preservedStorage.local.get('settings')).toEqual({ preserved: true });
      expect(await preservedStorage.session.get('draft')).toEqual({ preserved: true });
      expect(await createPluginSecretStore({ pluginId: SAMPLE_PLUGIN_ID, paths }).get('token')).toBe('preserved');
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('rolls an updated plugin back through the committed registry owner and reloads that plugin scope', async () => {
    const home = await createTempDir('happier-plugin-rollback-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-rollback-source-'));
    await materializeSamplePluginFixture(sourceRoot);
    const manifestPath = join(sourceRoot, '.happier-plugin', 'plugin.json');
    try {
      await installPluginThroughPresentUserTerminal(sourceRoot);

      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '2.0.0' }, null, 2), 'utf8');
      await installPluginThroughPresentUserTerminal(sourceRoot, ['--force']);

      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['rollback', SAMPLE_PLUGIN_ID, '--json']);
        expect(output.json<{
          ok: boolean;
          kind: string;
          data?: { pluginId?: string; desiredGeneration?: string | null; appliedGeneration?: string | null };
        }>()).toMatchObject({
          ok: true,
          kind: 'plugins_rollback',
          data: {
            pluginId: SAMPLE_PLUGIN_ID,
            desiredGeneration: expect.any(String),
            appliedGeneration: expect.any(String),
          },
        });
      } finally {
        output.restore();
      }

      expect(daemonBoundary.requestChange).toHaveBeenLastCalledWith({ kind: 'rollback', pluginId: SAMPLE_PLUGIN_ID });
      const state = await createPluginStateStore({ happyHomeDir: home }).read();
      expect(state.plugins[SAMPLE_PLUGIN_ID]?.install.manifestVersion).toBe('1.0.0');
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it('requires confirmation, reports partial destructive cleanup precisely, and completes on idempotent retry', async () => {
    const home = await createTempDir('happier-plugin-delete-data-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-delete-data-source-'));
    await materializeSamplePluginFixture(sourceRoot);

    try {
      await installPluginThroughPresentUserTerminal(sourceRoot);

      const paths = resolvePluginStorePaths({ happyHomeDir: home });
      const storage = createPluginStorageOwner({ pluginId: SAMPLE_PLUGIN_ID, paths, sessionId: 'session-1' });
      await storage.local.set('settings', { enabled: true });
      await storage.session.set('draft', { text: 'remove me' });
      await mkdir(join(paths.storageDir, SAMPLE_PLUGIN_ID, 'fs'), { recursive: true });
      await writeFile(join(paths.storageDir, SAMPLE_PLUGIN_ID, 'fs', 'owned.txt'), 'remove me', 'utf8');
      await createPluginSecretStore({ pluginId: SAMPLE_PLUGIN_ID, paths }).set('token', 'remove-me');
      let accountSettings: Record<string, unknown> = {
        unrelated: { keep: true },
        pluginStorageSyncedV1: {
          v: 1,
          plugins: {
            [SAMPLE_PLUGIN_ID]: { shared: { remove: true } },
            'sibling.plugin': { shared: { keep: true } },
          },
        },
      };
      let failSecretsRemoval = true;
      const deps = {
        pluginDataRemoval: {
          accountSettings: {
            getSettings: () => accountSettings,
            updateSettings: async (mutate: (settings: Readonly<Record<string, unknown>>) => Record<string, unknown>) => {
              accountSettings = mutate(accountSettings);
              return accountSettings;
            },
          },
          removeDirectory: async (directoryPath: string) => {
            if (failSecretsRemoval && directoryPath.startsWith(paths.secretsDir)) {
              throw new Error('injected secrets filesystem failure');
            }
            await rm(directoryPath, { recursive: true, force: true });
          },
        },
      };
      const previousExitCode = process.exitCode;
      process.exitCode = undefined;
      try {
        const unconfirmed = captureConsoleJsonOutput();
        try {
          await handlePluginsCommand(['uninstall', SAMPLE_PLUGIN_ID, '--delete-data', '--json'], deps);
          expect(unconfirmed.json<{ ok: boolean; error?: { code?: string } }>()).toMatchObject({
            ok: false,
            error: { code: 'confirmation_required' },
          });
        } finally {
          unconfirmed.restore();
        }

        process.exitCode = undefined;
        const partial = captureConsoleJsonOutput();
        try {
          await handlePluginsCommand(['uninstall', SAMPLE_PLUGIN_ID, '--delete-data', '--yes', '--json'], deps);
          expect(partial.json<{ ok: boolean; error?: { code?: string; completed?: readonly string[]; pending?: readonly string[] } }>()).toMatchObject({
            ok: false,
            error: {
              code: 'plugin_data_removal_partial',
              completed: ['uninstall', 'syncedStorage', 'localStorage'],
              pending: ['secrets'],
            },
          });
        } finally {
          partial.restore();
        }

        expect((await createPluginStateStore({ happyHomeDir: home }).read()).plugins[SAMPLE_PLUGIN_ID]).toBeUndefined();
        await expect(access(join(paths.storageDir, SAMPLE_PLUGIN_ID))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await createPluginSecretStore({ pluginId: SAMPLE_PLUGIN_ID, paths }).list()).toEqual([{ name: 'token' }]);
        expect(accountSettings).toMatchObject({
          unrelated: { keep: true },
          pluginStorageSyncedV1: { plugins: { 'sibling.plugin': { shared: { keep: true } } } },
        });

        process.exitCode = undefined;
        failSecretsRemoval = false;
        const daemonRequestsBeforeRetry = daemonBoundary.requestChange.mock.calls.length;
        const retry = captureConsoleJsonOutput();
        try {
          await handlePluginsCommand(['uninstall', SAMPLE_PLUGIN_ID, '--delete-data', '--yes', '--json'], deps);
          expect(retry.json<{ ok: boolean; data?: { pluginId?: string; alreadyUninstalled?: boolean } }>()).toMatchObject({
            ok: true,
            data: { pluginId: SAMPLE_PLUGIN_ID, alreadyUninstalled: true },
          });
        } finally {
          retry.restore();
        }
        expect(daemonBoundary.requestChange).toHaveBeenCalledTimes(daemonRequestsBeforeRetry + 1);
        expect(await createPluginSecretStore({ pluginId: SAMPLE_PLUGIN_ID, paths }).list()).toEqual([]);
        expect(daemonBoundary.requestChange).toHaveBeenCalledWith({
          kind: 'uninstall',
          pluginId: SAMPLE_PLUGIN_ID,
          clearHealthHistory: true,
          actorEvidence: {
            kind: 'authenticatedLocalUser',
            interactionId: expect.any(String),
            occurredAtMs: expect.any(Number),
          },
        });
      } finally {
        process.exitCode = previousExitCode;
      }
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it('rejects an invalid destructive plugin identity before reading or mutating owned data', async () => {
    const getSettings = vi.fn(() => ({ pluginStorageSyncedV1: { v: 1, plugins: {} } }));
    const updateSettings = vi.fn(async () => ({}));
    const removeDirectory = vi.fn(async () => undefined);
    const output = captureConsoleJsonOutput();
    try {
      await handlePluginsCommand(['uninstall', '../sibling.plugin', '--delete-data', '--yes', '--json'], {
        pluginDataRemoval: {
          accountSettings: { getSettings, updateSettings },
          removeDirectory,
        },
      });
      expect(output.json<{ ok: boolean; error?: { code?: string } }>()).toMatchObject({
        ok: false,
        error: { code: 'plugin_data_removal_identity_invalid' },
      });
    } finally {
      output.restore();
    }
    expect(getSettings).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
    expect(removeDirectory).not.toHaveBeenCalled();
  });

  it('reports an unknown daemon uninstall outcome inside the JSON error envelope', async () => {
    const home = await createTempDir('happier-plugin-uninstall-reload-failed-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-uninstall-reload-failed-source-'));
    await materializeSamplePluginFixture(sourceRoot);
    try {
      await installPluginThroughPresentUserTerminal(sourceRoot);

      daemonBoundary.requestChange.mockResolvedValueOnce({ kind: 'unavailable', code: 'daemon_unavailable' });
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['uninstall', SAMPLE_PLUGIN_ID, '--json']);

        const parsed = output.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: unknown;
          error?: {
            code: string;
            pluginId?: string;
          };
        }>();

        expect(parsed.ok).toBe(false);
        expect(parsed.kind).toBe('plugins_uninstall');
        expect(parsed.data).toBeUndefined();
        expect(parsed.error).toMatchObject({ code: 'outcome_unknown', pluginId: SAMPLE_PLUGIN_ID });
      } finally {
        output.restore();
      }

      const state = await createPluginStateStore({ happyHomeDir: home }).read();
      expect(state.plugins[SAMPLE_PLUGIN_ID]).toBeDefined();
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('requests a fresh daemon-owned generation for a development plugin', async () => {
    const home = await createTempDir('happier-plugin-reload-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-reload-source-'));
    const disposeMarkerPath = join(home, 'reload-dispose.log');
    await writeDisposableActivationPlugin(sourceRoot, disposeMarkerPath);

    try {
      await createPluginStateStore({ happyHomeDir: home }).write({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          'acme.reload-disposable': {
            source: {
              kind: 'path',
              locator: sourceRoot,
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
              resolvedPath: join(home, 'plugins', 'plugins', 'generations', 'generation-1'),
              manifestPath: join(home, 'plugins', 'plugins', 'generations', 'generation-1', '.happier-plugin', 'plugin.json'),
              devWatch: true,
            },
            compatibility: { status: 'compatible', diagnostics: [] },
            install: { mode: 'link', manifestVersion: '1.0.0', manifestDigest: null, installedPath: null },
            state: { enabled: true },
          },
        },
      });
      daemonBoundary.requestChange.mockResolvedValueOnce({
        kind: 'committed',
        pluginId: 'acme.reload-disposable',
        desiredGeneration: 'generation-2',
        appliedGeneration: 'generation-2',
        pendingSurfaces: [],
      });

      const reloadOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['reload', 'acme.reload-disposable', '--json']);

        const parsed = reloadOutput.json<{
          ok: boolean;
          kind: string;
          data?: {
            pluginId: string;
            desiredGeneration: string | null;
            appliedGeneration: string | null;
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_reload');
        expect(parsed.data).toMatchObject({
          pluginId: 'acme.reload-disposable',
          desiredGeneration: expect.any(String),
          appliedGeneration: expect.any(String),
        });
        expect(daemonBoundary.requestChange).toHaveBeenLastCalledWith({
          kind: 'development',
          pluginId: 'acme.reload-disposable',
          sourceRootPath: sourceRoot,
        });
      } finally {
        reloadOutput.restore();
      }

      await expect(readFile(disposeMarkerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('installs a direct archive URL through the same plugin installer path', async () => {
    const home = await createTempDir('happier-plugin-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const marketplace = await createRemoteMarketplaceServer();
    try {
      await installPluginThroughPresentUserTerminal(
        `${marketplace.archiveUrl}?download=1`,
      );

      const store = createPluginStateStore({ happyHomeDir: home });
      const state = await store.read();
      expect(state.plugins[SAMPLE_PLUGIN_ID]).toMatchObject({
        source: {
          kind: 'archive',
          locator: `${marketplace.archiveUrl}?download=1`,
          trustPolicy: 'prompt',
          installPolicy: 'managed_install',
        },
        install: {
          mode: 'managed_install',
        },
      });
      expect(state.plugins[SAMPLE_PLUGIN_ID]?.install.trust?.state).toBe('trusted');
      expect((await store.read()).plugins[SAMPLE_PLUGIN_ID]?.source.trustPolicy).toBe('prompt');
    } finally {
      await marketplace.close();
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('does not persist local-path plugin state when install runs in dry-run mode', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const home = await createTempDir('happier-plugin-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    await materializeSamplePluginFixture(sourceRoot);

    try {
      const installOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['install', sourceRoot, '--dry-run', '--json']);

        const parsed = installOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: {
            dryRun: boolean;
            request: { kind: string; locator: string; development: boolean };
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_install');
        expect(parsed.data).toMatchObject({
          dryRun: true,
          request: { kind: 'installPath', locator: sourceRoot, development: false },
        });
        expect(daemonBoundary.requestChange).not.toHaveBeenCalled();
      } finally {
        installOutput.restore();
      }

      const listOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['list', '--json']);

        const parsed = listOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          error?: { code: string };
        }>();

        expect(parsed.ok).toBe(false);
        expect(parsed.kind).toBe('plugins_list');
        expect(parsed.error?.code).toBe('daemon_unavailable');
      } finally {
        listOutput.restore();
      }
    } finally {
      process.exitCode = previousExitCode;
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('lists installed plugins through the JSON envelope after install', async () => {
    const home = await createTempDir('happier-plugin-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    await materializeStrictIntrospectionPluginFixture(sourceRoot);
    const canonicalSourceRoot = await realpath(sourceRoot);

    try {
      await installPluginThroughPresentUserTerminal(sourceRoot);
      const installed = await readInstalledPluginCatalog({ happyHomeDir: home });
      daemonBoundary.readCatalog.mockResolvedValue({
        kind: 'available',
        plugins: installed.map((entry) => ({
          ...entry,
          appliedGeneration: entry.desiredGeneration,
        })),
      });

      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['list', '--json']);

        const parsed = output.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data: {
            plugins: Array<{
              pluginId: string;
              desiredGeneration: string | null;
              appliedGeneration: string | null;
              title: string;
              enabled: boolean;
              source: { kind: string; locator: string };
              contributions: { version: 1; contributions: readonly { contribution: { family: string; localId: string } }[] };
            }>;
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_list');
        expect(parsed.data.plugins).toHaveLength(1);
        expect(parsed.data.plugins[0].pluginId).toBe(SAMPLE_PLUGIN_ID);
        expect(parsed.data.plugins[0].desiredGeneration).toEqual(expect.any(String));
        expect(parsed.data.plugins[0].appliedGeneration).toBe(parsed.data.plugins[0].desiredGeneration);
        expect(parsed.data.plugins[0].title).toBe('Acme Sample');
        expect(parsed.data.plugins[0].enabled).toBe(true);
        expect(parsed.data.plugins[0].source.kind).toBe('path');
        expect(parsed.data.plugins[0].source.locator).toBe(canonicalSourceRoot);
        expect(parsed.data.plugins[0].contributions.contributions).toEqual([
          expect.objectContaining({
            contribution: expect.objectContaining({
              kind: 'locale',
              family: 'ui.translations',
              locale: 'en-US',
            }),
          }),
        ]);
      } finally {
        output.restore();
      }
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('shows an installed plugin through the JSON envelope after install', async () => {
    const home = await createTempDir('happier-plugin-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    await materializeStrictIntrospectionPluginFixture(sourceRoot);
    const canonicalSourceRoot = await realpath(sourceRoot);

    try {
      await installPluginThroughPresentUserTerminal(sourceRoot);
      const installed = await readInstalledPluginCatalog({ happyHomeDir: home });
      daemonBoundary.readCatalog.mockResolvedValue({
        kind: 'available',
        plugins: installed.map((entry) => ({
          ...entry,
          appliedGeneration: entry.desiredGeneration,
        })),
      });

      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['show', SAMPLE_PLUGIN_ID, '--json']);

        const parsed = output.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data: {
            plugin: {
              pluginId: string;
              desiredGeneration: string | null;
              appliedGeneration: string | null;
              title: string;
              enabled: boolean;
              source: { kind: string; locator: string };
              contributions: { version: 1; contributions: readonly { contribution: { family: string; localId: string } }[] };
            };
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_show');
        expect(parsed.data.plugin.pluginId).toBe(SAMPLE_PLUGIN_ID);
        expect(parsed.data.plugin.desiredGeneration).toEqual(expect.any(String));
        expect(parsed.data.plugin.appliedGeneration).toBe(parsed.data.plugin.desiredGeneration);
        expect(parsed.data.plugin.title).toBe('Acme Sample');
        expect(parsed.data.plugin.enabled).toBe(true);
        expect(parsed.data.plugin.source.kind).toBe('path');
        expect(parsed.data.plugin.source.locator).toBe(canonicalSourceRoot);
        expect(parsed.data.plugin.contributions.contributions).toEqual([
          expect.objectContaining({
            contribution: expect.objectContaining({
              kind: 'locale',
              family: 'ui.translations',
              locale: 'en-US',
            }),
          }),
        ]);
      } finally {
        output.restore();
      }
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('lists invocable plugin actions for an installed plugin', async () => {
    const home = await createTempDir('happier-plugin-cli-actions-home-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-cli-actions-source-'));
    const fixture = await writeCliActionPlugin(sourceRoot);

    try {
      await installPluginThroughPresentUserTerminal(sourceRoot);

      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['actions', fixture.pluginId, '--json']);

        const parsed = output.json<{
          ok: boolean;
          kind: string;
          data?: {
            pluginId: string;
            actions: Array<{ actionId: string; kind: string; title: string }>;
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_actions');
        expect(parsed.data?.pluginId).toBe(fixture.pluginId);
        expect(parsed.data?.actions).toEqual([
          expect.objectContaining({ actionId: fixture.actionLocalId, kind: 'action', title: 'Echo Action' }),
          expect.objectContaining({ actionId: fixture.toolLocalId, kind: 'tool', title: 'Note Tool' }),
        ]);
      } finally {
        output.restore();
      }
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it('does not publish unreviewed bytes before the atomic Install-and-trust decision', async () => {
    const home = await createTempDir('happier-plugin-cli-trust-home-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-cli-trust-source-'));
    await writeCliActionPlugin(sourceRoot, 'acme.cli-actions-trust');
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      const blockedOutput = captureConsoleJsonOutput();
      try {
        process.exitCode = undefined;
        await handlePluginsCommand(['install', sourceRoot, '--dev', '--json']);
        const parsed = blockedOutput.json<{ ok: boolean; error?: { code: string; pendingChangeId?: string } }>();
        expect(parsed.ok).toBe(false);
        expect(parsed.error).toMatchObject({ code: 'review_required', pendingChangeId: expect.any(String) });
        expect(process.exitCode).toBe(1);
      } finally {
        blockedOutput.restore();
      }
      await activePluginChangeService?.shutdown();
      await activePluginReloadController?.shutdown();
      activePluginChangeService = null;
      activePluginReloadController = null;

      await installPluginThroughPresentUserTerminal(sourceRoot, ['--dev']);

      const installed = await createPluginStateStore({ happyHomeDir: home }).read();
      expect(installed.plugins['acme.cli-actions-trust']?.install.trust?.state).toBe('trusted');
    } finally {
      process.exitCode = previousExitCode;
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it('forwards the normalized SDK registry to daemon-owned development dependency materialization', async () => {
    const output = captureConsoleJsonOutput();
    try {
      await handlePluginsCommand([
        'install',
        '/fixture/plugin',
        '--dev',
        '--sdk-registry',
        'http://127.0.0.1:43127/',
        '--dry-run',
        '--json',
      ]);

      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'plugins_install',
        data: {
          request: {
            kind: 'installPath',
            locator: '/fixture/plugin',
            development: true,
            sdkRegistryOrigin: 'http://127.0.0.1:43127',
          },
        },
      });
    } finally {
      output.restore();
    }
  });

  it('rejects an unregistered legacy catalog URL without mutating installed state', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const home = await createTempDir('happier-plugin-marketplace-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: process.env.PATH ?? '' });
    reloadConfiguration();

    const marketplace = await createRemoteMarketplaceServer();

    try {
      const listOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'list', marketplace.catalogUrl, '--json']);

        const parsed = listOutput.json<{ v: 1; ok: boolean; kind: string; error?: { code: string } }>();

        expect(parsed.ok).toBe(false);
        expect(parsed.kind).toBe('plugins_marketplace_list');
        expect(parsed.error?.code).toBe('not_found');
      } finally {
        listOutput.restore();
      }

      const showOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'show', marketplace.catalogUrl, SAMPLE_PLUGIN_ID, '--json']);

        const parsed = showOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          error?: { code: string };
        }>();

        expect(parsed.ok).toBe(false);
        expect(parsed.kind).toBe('plugins_marketplace_show');
        expect(parsed.error?.code).toBe('not_found');
      } finally {
        showOutput.restore();
      }

      const installOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'install', marketplace.catalogUrl, SAMPLE_PLUGIN_ID, '--json']);

        const parsed = installOutput.json<{ v: 1; ok: boolean; kind: string; error?: { code: string } }>();

        expect(parsed.ok).toBe(false);
        expect(parsed.kind).toBe('plugins_marketplace_install');
        expect(parsed.error?.code).toBe('install_unavailable');
      } finally {
        installOutput.restore();
      }

      const installedOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['list', '--json']);

        const parsed = installedOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          error?: { code: string };
        }>();

        expect(parsed.ok).toBe(false);
        expect(parsed.kind).toBe('plugins_list');
        expect(parsed.error?.code).toBe('daemon_unavailable');
      } finally {
        installedOutput.restore();
      }
    } finally {
      process.exitCode = previousExitCode;
      await marketplace.close();
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });
});
