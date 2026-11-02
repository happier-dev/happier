import { createServer } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';
import * as https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { access, mkdir, mkdtemp, realpath, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import * as tar from 'tar';
import * as undici from 'undici';
import fastify from 'fastify';
import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';
import { createActionExecutor, createMarketplaceNpmDiscoveryProjectionV1, DEFAULT_CURATED_MARKETPLACE_SOURCE_URL, type MarketplaceIndexSourceSnapshotV1 } from '@happier-dev/protocol';
import { createPluginCompatibilityProjectionV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '@/configuration';
import type { DaemonPluginChangeService } from '@/plugins/daemon/changeService';
import { createDaemonPluginRuntimeOwner } from '@/plugins/daemon/runtimeOwner';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';
import { materializeSamplePluginFixture, SAMPLE_PLUGIN_ID } from '@/plugins/testkit/samplePackage';
import { createPluginStateStore } from '@/plugins/store/state.testkit';
import {
  managedPnpmBinPath,
  resolveExistingPnpmCommand,
} from '@/packagedRuntime/managedTools/pnpm/managedPnpm';
import { managedJavaScriptRuntimeBinPath } from '@/packagedRuntime/js/managedJavaScriptRuntime';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { publishAccountRegistrySourcesFixture, accountMarketplaceUserSourceFixture, curatedMarketplaceSourceFixture, communityMarketplaceSourceFixture } from '@/plugins/testkit/accountRegistrySources';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { findCompiledActionCliCommand, listCompiledActionCliCommands } from '@/cli/actions/compiledCommands';
import { composeActionCliInput, parseActionCliCommandInput } from '@/cli/actions/parseCommandInput';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { packLocalPlugin } from '@/plugins/packaging/pack';
import { sriSha512 } from '@/plugins/distribution/testkit/npmTarball';
import { createTestPluginSdkTarball } from '@/plugins/distribution/testkit/pluginSdkTarball';
import { readInstalledPluginCatalog } from '@/plugins/projection/catalog/installed';
import { projectPluginCompatibilityDiagnostics } from '@/plugins/projection/introspection/project';
import { createPluginSecretStore } from '@/plugins/runtime/context/secrets';
import { createPluginStorageOwner } from '@/plugins/runtime/context/storage';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import {
  createPluginReloadController,
  type PluginReloadController,
} from '@/plugins/runtime/reload/controller';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createPluginCliActionHost } from '@/plugins/testkit/pluginCliActionHost';
import { createDaemonControlAuthGuard } from '@/daemon/controlAuth';
import { PluginChangePendingReviewResultSchema } from '@happier-dev/protocol/marketplace/internal';
import { PLUGIN_CHANGE_REQUEST_PATH, PLUGIN_CHANGE_DECISION_PATH, registerDaemonPluginChangeRoutes } from '@/plugins/daemon/controlRoutes';

import { handlePluginsCommand } from './plugins';

async function executeMarketplaceRegistryAlias(path: readonly string[], args: readonly string[] = []) {
  const commandPath = ['plugins', 'marketplace', ...path];
  const command = findCompiledActionCliCommand(commandPath, listCompiledActionCliCommands());
  if (!command || command.path.join(' ') !== commandPath.join(' ')) throw new Error('Missing generated marketplace alias');
  const parsed = parseActionCliCommandInput(command, [...commandPath, ...args]);
  if (!parsed.ok) throw new Error(parsed.message);
  const composed = composeActionCliInput({ parsed, canonicalSchema: command.spec.inputSchema,
    wholeInputSchema: command.wholeInputSchema, callerSchema: command.callerSchema,
    bindInput: command.spec.cli?.bindInput,
    context: { actionId: command.actionId, invocationId: 'marketplace-alias', commandPath, output: 'json' } });
  if (!composed.ok) throw new Error('Invalid generated marketplace input');
  const host = createCliRegistryHostV1();
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
    registryActionExecute: ({ actionId, input }) => host.execute(actionId, input) });
  return executor.execute(command.actionId, composed.input, { surface: 'cli', authority: 'account_automation', bypassApprovals: true });
}

const daemonBoundary = vi.hoisted(() => ({
  ensureRunning: vi.fn(async () => undefined),
  requestChange: vi.fn(),
  decideChange: vi.fn(),
  readChangeStatus: vi.fn(),
  readCatalog: vi.fn(),
  controlDevelopment: vi.fn(),
}));
const promptBoundary = vi.hoisted(() => ({
  confirm: vi.fn(),
}));

vi.mock('@/daemon/ensureDaemon', async original => ({
  ...await original<typeof import('@/daemon/ensureDaemon')>(),
  ensureDaemonRunningForSessionCommand: daemonBoundary.ensureRunning,
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestDaemonPluginChange: daemonBoundary.requestChange,
  decideDaemonPluginChange: daemonBoundary.decideChange,
  readDaemonPluginChangeStatus: daemonBoundary.readChangeStatus,
  readDaemonPluginCatalog: daemonBoundary.readCatalog,
  controlDaemonPluginDevelopment: daemonBoundary.controlDevelopment,
}));
vi.mock('@/terminal/prompts/promptConfirmYesNo', () => ({
  promptConfirmYesNo: promptBoundary.confirm,
}));

// Acquisition and npm metadata use real owners beneath these OS/network boundaries.
vi.mock('node:dns/promises', async original => ({ ...await original<typeof import('node:dns/promises')>(),
  lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('undici', async original => {
  const actual = await original<typeof import('undici')>();
  return { ...actual, fetch: vi.fn(actual.fetch) };
});
vi.mock('node:https', async original => {
  const actual = await original<typeof import('node:https')>();
  return { ...actual, request: vi.fn(actual.request) };
});

let activePluginChangeService: DaemonPluginChangeService | null = null;
let activePluginReloadController: PluginReloadController | null = null;
let activePluginCliActionHost: Awaited<ReturnType<typeof createPluginCliActionHost>> | null = null;
const TEST_PLUGIN_SECRET_KEY = new Uint8Array(32).fill(7);
let testPnpmCommand: string | null = null;

async function materializeManagedPnpmTestShim(happyHomeDir: string): Promise<void> {
  const pnpmCommand = testPnpmCommand ?? resolveExistingPnpmCommand(process.env);
  if (!pnpmCommand) throw new Error('The plugin command test requires a package-manager boundary');
  testPnpmCommand = pnpmCommand;
  const managedPath = managedPnpmBinPath({ ...process.env, HAPPIER_HOME_DIR: happyHomeDir });
  await mkdir(dirname(managedPath), { recursive: true });
  await writeExecutableShim({
    dir: dirname(managedPath),
    fileName: basename(managedPath),
    contents: process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${pnpmCommand}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${pnpmCommand}" "$@"\n`,
  });
  const managedRuntimePath = managedJavaScriptRuntimeBinPath({
    ...process.env,
    HAPPIER_HOME_DIR: happyHomeDir,
  });
  await mkdir(dirname(managedRuntimePath), { recursive: true });
  await writeExecutableShim({
    dir: dirname(managedRuntimePath),
    fileName: basename(managedRuntimePath),
    contents: process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "$@"\n`,
  });
}

async function createPluginChangeService(): Promise<DaemonPluginChangeService> {
  const connectedAccounts: StablePluginConnectedAccountsOwner = Object.freeze({
    getBinding: vi.fn(async () => null),
    requestSelection: vi.fn(async () => {
      throw new Error('Unexpected connected-account selection during plugin command test');
    }),
    materialize: vi.fn(async () => {
      throw new Error('Unexpected connected-account materialization during plugin command test');
    }),
    listAccounts: async () => {
      throw new Error('Connected Account listing is outside this fixture');
    },
    materializeListedAccount: async () => {
      throw new Error('Exact-listed Connected Account materialization is outside this fixture');
    },
    watch: vi.fn(() => Object.freeze({ dispose() {} })),
  });
  const reloadController = createPluginReloadController({
    happyHomeDir: configuration.happyHomeDir,
  });
  activePluginReloadController = reloadController;
  const owner = createDaemonPluginRuntimeOwner({
    happyHomeDir: configuration.happyHomeDir,
    reloadController,
    staleCandidateCleanup: 'disabled',
    connectedAccounts,
    generationCustodyRetirement: {
      readCredentials: async () => ({
        token: 'plugins-command-test-token',
        encryption: { type: 'legacy', secret: TEST_PLUGIN_SECRET_KEY },
      }),
      retireGeneration: async () => undefined,
      readRunnerRetainedGenerationIds: async () => new Set(),
    },
  });
  return owner.changeService;
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
    files: ['.happier-plugin', 'daemon.mjs', 'agentRuntime.mjs'],
  }), 'utf8');
  const archivePath = join(pluginSourceRoot, 'sample-plugin.tar.gz');
  const packed = await packLocalPlugin({ locator: archiveRoot, outPath: archivePath });
  if (!packed.ok) throw new Error(packed.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
  const archiveBytes = await readFile(archivePath);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (url.pathname === '/catalog.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Raw obsolete URL-catalog fixture in the retired
      // happier_plugin_marketplace_catalog_v1 wire shape: URL-based
      // `packageUrl` entries the current npm-origin marketplace index must
      // reject. Untyped on purpose; the legacy protocol schema is deleted.
      res.end(JSON.stringify({
        t: 'happier_plugin_marketplace_catalog_v1',
        schemaVersion: 1,
        sourceUrl: `${url.origin}/catalog.json`,
        title: 'Curated Marketplace',
        description: 'Curated plugin discovery feed',
        entries: [
          {
            id: `marketplace.${SAMPLE_PLUGIN_ID}`,
            manifestId: SAMPLE_PLUGIN_ID,
            title: 'Acme Sample',
            description: 'Sample plugin from the marketplace',
            sourceUrl: `${url.origin}/entries/acme.sample.json`,
            packageUrl: `${url.origin}/plugins/acme.sample.tar.gz`,
            categories: ['providers'],
          },
        ],
      }));
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

async function startLoopbackPluginSdkRegistry(sdkTarball: Buffer): Promise<Readonly<{
  origin: string;
  requests: readonly string[];
  close(): Promise<void>;
}>> {
  const requests: string[] = [];
  let origin = '';
  const integrity = sriSha512(sdkTarball);
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', origin).pathname);
    requests.push(pathname);
    if (pathname === '/-/ping') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    if (pathname === '/@happier-dev/plugin-sdk') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        name: '@happier-dev/plugin-sdk',
        'dist-tags': { latest: '0.0.0' },
        versions: {
          '0.0.0': {
            name: '@happier-dev/plugin-sdk',
            version: '0.0.0',
            dist: {
              tarball: `${origin}/@happier-dev/plugin-sdk/-/plugin-sdk-0.0.0.tgz`,
              integrity,
            },
          },
        },
      }));
      return;
    }
    if (pathname === '/@happier-dev/plugin-sdk/-/plugin-sdk-0.0.0.tgz') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(sdkTarball);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"not_found"}');
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
    throw new Error('Plugin SDK loopback registry did not bind a TCP address');
  }
  origin = `http://127.0.0.1:${address.port}`;
  return Object.freeze({
    origin,
    requests,
    close: async () => await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  });
}

async function seedExactCuratedMarketplaceListing(params: Readonly<{
  happyHomeDir: string;
  reviewStatus?: 'approved' | 'withdrawn' | 'blocked';
  registryProfileId?: string;
  freshnessState?: 'fresh' | 'stale' | 'stale-offline';
  contributions?: readonly string[];
}>) {
  publishAccountRegistrySourcesFixture();
  const source = curatedMarketplaceSourceFixture();
  const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
  const manifestDigest = `sha256:${'a'.repeat(64)}`;
  const fetchedAtMs = Date.now();
  const snapshot: MarketplaceIndexSourceSnapshotV1 = {
    picks: [],
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
      summary: {
        contributions: [...(params.contributions ?? ['actions'])],
        requiredHostAccess: [],
        optionalHostAccess: [],
        executableRealms: ['daemon' as const],
      },
      review: { status: params.reviewStatus ?? 'approved', reviewedAt: '2026-07-21T00:00:00.000Z' },
      categories: ['actions'],
      media: [],
      updatePolicy: 'allowed' as const,
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
      requestUrl: source.sourceUrl,
      fetchedAtMs,
      etag: null,
      lastModified: null,
      communityNpmPage: null,
      snapshot,
    }),
    'utf8',
  );
  return { sourceId: source.id, integrity, manifestDigest, snapshot };
}

function installMarketplaceHttpFixture(snapshot: MarketplaceIndexSourceSnapshotV1) {
  if (snapshot.source.kind === 'community-npm') {
    const entry = snapshot.entries[0];
    if (!entry) throw new Error('Missing published community npm fixture');
    const compatibility = createPluginCompatibilityProjectionV1({
      manifest: PluginManifestV2Schema.parse({ schemaVersion: 2, id: entry.pluginId, version: entry.distribution.version,
        displayName: entry.display.title, engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' }, hostAccess: { required: [], optional: [] }, contributes: {} }),
      uiArtifacts: { version: 2, entries: [] },
    });
    const metadata = { name: entry.distribution.packageName, version: entry.distribution.version,
      happier: { compatibilityProjection: compatibility,
        marketplaceDiscovery: createMarketplaceNpmDiscoveryProjectionV1({ compatibility, manifestDigest: entry.manifestDigest }) },
      dist: { integrity: entry.distribution.integrity, tarball: 'https://registry.npmjs.org/sample.tgz' } };
    vi.mocked(undici.fetch).mockImplementation(async () => new undici.Response(JSON.stringify({
      total: 1, objects: [{ package: { name: metadata.name, version: metadata.version, publisher: { username: 'acme' } } }],
    }), { status: 200 }));
    // Native HTTPS is a genuine process boundary; the npm client, resolver and projection remain real.
    const request = ((_options: https.RequestOptions, callback: (message: IncomingMessage) => void) => {
      const emitter = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void };
      emitter.end = () => queueMicrotask(() => {
        const message = Object.assign(Readable.from([JSON.stringify({ name: metadata.name,
          'dist-tags': { latest: metadata.version }, versions: { [metadata.version]: metadata } })]),
        { statusCode: 200, headers: { 'content-type': 'application/json' } });
        callback(message as unknown as IncomingMessage);
      });
      emitter.destroy = error => { if (error) emitter.emit('error', error); };
      return emitter as unknown as ClientRequest;
    }) as typeof https.request;
    vi.mocked(https.request).mockImplementation(request);
  } else {
    vi.mocked(undici.fetch).mockImplementation(async () => {
      if (snapshot.freshness.state !== 'fresh') {
        if (snapshot.freshness.state === 'stale-offline') throw Object.assign(new Error('Network unreachable'), { code: 'ENETUNREACH' });
        return new undici.Response('', { status: 503 });
      }
      return new undici.Response(JSON.stringify(snapshot), { status: 200 });
    });
  }
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
            placementBindings: ['commandPalette'],
            dangerLevel: 'safe',
            execution: { target: 'daemon' },
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
      '  return undefined;',
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
  const output = captureConsoleJsonOutput();
  try {
    await runCompiledPluginCommand(['install', locator, ...flags, '--json']);
    const envelope = output.json<{ ok: boolean; error?: { code: string } }>();
    if (!envelope.ok) {
      expect(envelope.error?.code).toBe('review_required');
      const request = daemonBoundary.requestChange.mock.results.at(-1);
      if (!request || request.type !== 'return') throw new Error('Expected a prepared daemon candidate');
      const review = PluginChangePendingReviewResultSchema.parse(await request.value);
      // Test setup acts as the separately authenticated human host. The CLI
      // command above must never issue this private decision itself.
      expect(await daemonBoundary.decideChange({ pendingChangeId: review.pendingChangeId,
        decision: 'installAndTrust', optionalSelections: review.reviewKind === 'installation'
          ? review.review.optionalHostAccess.map(access => ({ accessId: access.id, selected: false })) : [],
      })).toMatchObject({ kind: 'committed' });
    }
  } finally {
    output.restore();
    process.exitCode = previousExitCode;
  }
}

async function runCompiledPluginCommand(args: readonly string[]): Promise<void> {
  activePluginCliActionHost ??= await createPluginCliActionHost();
  await activePluginCliActionHost.run(args);
}

describe('handlePluginsCommand', () => {
  // Help text, recovery guidance, and scaffold scripts name the invoker the
  // author actually invoked (`resolveInvokerName()`), so pin the documented
  // default lane for this file instead of inheriting the test runner's argv.
  let invokerNameScope: ReturnType<typeof createEnvKeyScope> | null = null;

  beforeEach(() => {
    invokerNameScope = createEnvKeyScope(['HAPPIER_CLI_INVOKER_NAME']);
    invokerNameScope.patch({ HAPPIER_CLI_INVOKER_NAME: 'happier' });
    activePluginChangeService = null;
    activePluginReloadController = null;
    daemonBoundary.ensureRunning.mockClear();
    daemonBoundary.requestChange.mockReset();
    daemonBoundary.decideChange.mockReset();
    daemonBoundary.readChangeStatus.mockReset();
    daemonBoundary.readCatalog.mockReset();
    daemonBoundary.controlDevelopment.mockReset();
    promptBoundary.confirm.mockReset();
    promptBoundary.confirm.mockResolvedValue(false);
    daemonBoundary.readCatalog.mockResolvedValue({
      kind: 'unavailable',
      code: 'daemon_unavailable',
    });
    daemonBoundary.requestChange.mockImplementation(async (request) => {
      activePluginChangeService ??= await createPluginChangeService();
      return await activePluginChangeService.requestPluginChange(request);
    });
    daemonBoundary.decideChange.mockImplementation(async (decision) => {
      if (!activePluginChangeService) throw new Error('Plugin change decision arrived before its request');
      return await activePluginChangeService.decidePluginChange(decision);
    });
    daemonBoundary.readChangeStatus.mockImplementation(async (request) => {
      if (!activePluginChangeService) throw new Error('Plugin change status arrived before its request');
      return await activePluginChangeService.statusPluginChange(request);
    });
  });

  afterEach(async () => {
    await activePluginCliActionHost?.dispose();
    activePluginCliActionHost = null;
    resetActiveAccountSettingsSnapshotForTests();
    vi.restoreAllMocks();
    vi.mocked(undici.fetch).mockReset();
    vi.mocked(https.request).mockReset();
    invokerNameScope?.restore();
    invokerNameScope = null;
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
      expect(output.text()).toContain('happier plugins update <pluginId> [--json]');
      expect(output.text()).toContain('happier plugins rollback <pluginId> [--json]');
      expect(output.text()).toContain('happier plugins uninstall <pluginId> [--delete-data --yes] [--json]');
      expect(output.text()).toContain('happier plugins create <name> [--id <plugin.id>] [--name <display name>] [--template session-agent] [--ui declarative|hostedWeb|reactNative] [--json]');
      expect(output.text()).toContain('happier plugins dev [path] [--sdk-registry <origin>] [--json]');
      expect(output.text()).toContain('happier plugins dev install <path> [--sdk-registry <origin>] [--json]');
      expect(output.text()).toContain('happier plugins dev typecheck|build|test <path> [--json]');
      expect(output.text()).toContain('happier plugins dev unregister <path> [--json]');
      expect(output.text()).toContain('happier plugins test [path] [--packed] [--with-plugin <root-or-archive>]… [--sdk-registry <origin>] [--json]');
      expect(output.text()).not.toContain('happier plugins scaffold');
      expect(output.text()).not.toContain('happier plugins author');
      expect(output.text()).toContain('Repair or refresh a stale or wiped author root');
      expect(output.text()).toContain('happier plugins pack <path> [--out <archive.tgz>] [--sdk-registry <origin>] [--json]');
      expect(output.text()).toContain('happier plugins doctor [path] [--json]');
      expect(output.text()).toContain('happier plugins reload [developmentPluginId] [--json]');
      expect(output.text()).toContain('happier plugins logs <pluginId> [--machine <id>] [--generation <id>] [--correlation <id>] [--cursor <byteOffset>] [--limit <1-500>] [--follow] [--json]');
      expect(output.text()).toContain('happier registries');
      expect(output.text()).not.toContain('happier plugins call');
      expect(output.text()).not.toContain('happier plugins trust');
      expect(output.text()).not.toContain('--trust');
      expect(output.text()).toContain('--sdk-registry <origin>');
      expect(output.text()).not.toMatch(/\b(?:fence|last-known-good|LKG)\b/iu);
      expect(output.text()).toContain('plugin-provided agent CLI surfaces');
      expect(output.text()).not.toContain('plugin-provided provider CLI surfaces');
    } finally {
      output.restore();
    }
  });

  it('rejects the retired --trust install option before contacting the daemon', async () => {
    const previousExitCode = process.exitCode;
    const output = captureConsoleJsonOutput();
    try {
      await runCompiledPluginCommand(['install', '/tmp/acme-dev', '--dev', '--trust', '--json']);
      expect(output.json()).toMatchObject({ ok: false, kind: 'plugins_install', error: { code: 'invalid_arguments' } });
      expect(daemonBoundary.requestChange).not.toHaveBeenCalled();
      expect(daemonBoundary.decideChange).not.toHaveBeenCalled();
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('rejects the retired scaffold SDK-version override instead of silently ignoring it', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-version-override-'));
    const targetDir = join(parentDir, 'acme-scaffold');
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const output = captureConsoleJsonOutput();
    try {
      await handlePluginsCommand([
        'create',
        targetDir,
        '--sdk-version',
        '0.1.0-unsupported-override',
        '--json',
      ]);

      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'plugins_create',
        error: {
          code: 'invalid_option',
          message: expect.stringContaining('--sdk-version'),
        },
      });
      await expect(access(targetDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it('routes plugins doctor through the canonical author evaluator and reports diagnostics', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const output = captureConsoleJsonOutput();
    const runPluginAuthorDoctor = vi.fn(async () => ({
      ok: true as const,
      pluginId: 'example.doctor',
      version: '0.1.0',
      entryPath: '/fixture/plugin.ts',
      evaluationMs: 25,
      canonicalManifestJson: '{}\n',
      diagnostics: [],
    }));
    try {
      await handlePluginsCommand(['doctor', '/fixture/plugin.ts', '--json'], {
        runPluginAuthorDoctor,
      });

      expect(runPluginAuthorDoctor).toHaveBeenCalledWith({ locator: '/fixture/plugin.ts' });
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'plugins_doctor',
        data: {
          pluginId: 'example.doctor',
          version: '0.1.0',
          entryPath: '/fixture/plugin.ts',
          evaluationMs: 25,
          diagnostics: [],
        },
      });
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('routes plugins doctor --installed through the installed-generation owner, not the author evaluator', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const output = captureConsoleJsonOutput();
    const runPluginAuthorDoctor = vi.fn();
    const diagnoseInstalledPluginGenerations = vi.fn(async () => ({
      ok: false as const,
      plugins: [{
        pluginId: 'acme.plugin',
        immutableGenerationId: 'generation-a',
        inspectedFileCount: 2,
        diagnostics: [{
          code: 'plugin_installed_generation_file_missing' as const,
          message: 'Installed plugin generation file is missing from the immutable generation root: daemon.mjs',
          relativePath: 'daemon.mjs',
        }],
        repair: 'reinstall' as const,
      }],
    }));
    try {
      await handlePluginsCommand(['doctor', '--installed', 'acme.plugin', '--json'], {
        runPluginAuthorDoctor,
        diagnoseInstalledPluginGenerations,
      });

      expect(runPluginAuthorDoctor).not.toHaveBeenCalled();
      expect(diagnoseInstalledPluginGenerations).toHaveBeenCalledWith(
        expect.objectContaining({ pluginId: 'acme.plugin' }),
      );
      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'plugins_doctor_installed',
        error: {
          code: 'plugin_installed_generation_unhealthy',
          plugins: [{
            pluginId: 'acme.plugin',
            immutableGenerationId: 'generation-a',
            repair: 'reinstall',
            diagnostics: [{ code: 'plugin_installed_generation_file_missing' }],
          }],
        },
      });
      expect(process.exitCode).toBe(1);
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('prints installed-generation repair guidance naming the real recovery command', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const failing = captureConsoleText();
    try {
      await handlePluginsCommand(['doctor', '--installed'], {
        diagnoseInstalledPluginGenerations: vi.fn(async () => ({
          ok: false as const,
          plugins: [{
            pluginId: 'acme.plugin',
            immutableGenerationId: 'generation-a',
            inspectedFileCount: 2,
            diagnostics: [{
              code: 'plugin_installed_generation_manifest_unloadable' as const,
              message: 'plugin_manifest_invalid: runtime: Invalid input',
              relativePath: '.happier-plugin/plugin.json',
            }],
            repair: 'reinstall' as const,
          }],
        })),
      });

      const text = failing.text();
      expect(text).toContain('acme.plugin');
      expect(text).toContain('.happier-plugin/plugin.json');
      expect(text).toContain('happier plugins install');
      expect(process.exitCode).toBe(1);
    } finally {
      failing.restore();
      process.exitCode = previousExitCode;
    }

    const healthy = captureConsoleText();
    try {
      await handlePluginsCommand(['doctor', '--installed'], {
        diagnoseInstalledPluginGenerations: vi.fn(async () => ({
          ok: true as const,
          plugins: [{
            pluginId: 'acme.plugin',
            immutableGenerationId: 'generation-a',
            inspectedFileCount: 2,
            diagnostics: [],
          }],
        })),
      });

      expect(healthy.text()).toContain('acme.plugin');
      expect(healthy.text()).not.toContain('happier plugins install');
      expect(process.exitCode).toBeUndefined();
    } finally {
      healthy.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('prints the resolved author source location for doctor diagnostics on the human surface', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const failing = captureConsoleText();
    try {
      await handlePluginsCommand(['doctor', '/fixture/plugin.ts'], {
        runPluginAuthorDoctor: vi.fn(async () => ({
          ok: false as const,
          diagnostics: [{
            code: 'plugin_author_evaluation_failed' as const,
            message: 'Plugin author evaluation failed: Cannot read properties of undefined (reading \'id\')',
            location: { file: 'src/index.ts', line: 27, column: 24 },
          }],
        })),
      });

      expect(failing.text()).toContain('src/index.ts:27:24');
      expect(process.exitCode).toBe(1);
    } finally {
      failing.restore();
      process.exitCode = previousExitCode;
    }

    const passing = captureConsoleText();
    try {
      await handlePluginsCommand(['doctor', '/fixture/plugin.ts'], {
        runPluginAuthorDoctor: vi.fn(async () => ({
          ok: true as const,
          pluginId: 'example.doctor',
          version: '0.1.0',
          entryPath: '/fixture/plugin.ts',
          evaluationMs: 4200,
          canonicalManifestJson: '{}\n',
          diagnostics: [{
            code: 'plugin_author_evaluation_slow' as const,
            message: 'Plugin author evaluation took 4200ms.',
            location: { file: 'src/slow.ts', line: 9 },
          }],
        })),
      });

      expect(passing.text()).toContain('src/slow.ts:9');
    } finally {
      passing.restore();
      process.exitCode = previousExitCode;
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

  it('reports an unknown plugins change operation as a structured failure', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const output = captureConsoleJsonOutput();
    try {
      await handlePluginsCommand(['change', 'bogus', 'pending-1', '--json']);

      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'plugins_change_bogus',
        error: { code: 'unknown_subcommand' },
      });
      expect(process.exitCode).toBe(1);
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it.each([
    ['change', ['change']],
    ['change help', ['change', '--help']],
  ])('keeps the plugins %s help path successful', async (_label, args) => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const output = captureConsoleText();
    try {
      await handlePluginsCommand(args as string[]);

      expect(output.text()).toContain('happier plugins');
      expect(process.exitCode).toBeUndefined();
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

      const sourceEntry = await readFile(join(parentDir, 'my-plugin', 'src', 'index.ts'), 'utf8');
      expect(sourceEntry).toContain('export const { manifest, activate } = definePlugin({');
      expect(sourceEntry).toContain("entrypoints: { daemon: './dist/index.js', development: './src/index.ts' }");
      expect(sourceEntry).toContain("'save-note': {");
      await expect(readFile(join(parentDir, 'my-plugin', '.happier-plugin', 'plugin.json'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      const packageJson = JSON.parse(
        await readFile(join(parentDir, 'my-plugin', 'package.json'), 'utf8'),
      ) as { dependencies?: Record<string, string> };
      expect(packageJson.dependencies?.['@happier-dev/plugin-sdk'])
        .toBe(PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['@happier-dev/plugin-sdk']);
    } finally {
      process.chdir(previousCwd);
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it('registers plugins dev with the daemon and never starts a CLI source observer', async () => {
    const ensureDaemon = vi.fn(async () => undefined);
    const controlPluginDevelopment = vi.fn(async () => ({
      kind: 'status' as const,
      status: { roots: [], plugins: [] },
    }));
    const controller = new AbortController();
    controller.abort();
    const output = captureConsoleJsonOutput();
    try {
      await handlePluginsCommand(['dev', '/fixture/plugin', '--sdk-registry', 'https://registry.example', '--json'], {
        ensureDaemon,
        controlPluginDevelopment,
      }, { signal: controller.signal });

      expect(controlPluginDevelopment).toHaveBeenCalledWith({
        kind: 'registerExplicit',
        rootPath: '/fixture/plugin',
        sdkRegistryOrigin: 'https://registry.example',
      }, { signal: controller.signal });
      expect(ensureDaemon).toHaveBeenCalledOnce();
      expect(ensureDaemon).toHaveBeenCalledBefore(controlPluginDevelopment);
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'plugins_dev',
        data: { status: { roots: [], plugins: [] } },
      });
    } finally {
      output.restore();
    }
  });

  it('unregisters an exact plugins dev root without entering the watch wait', async () => {
    const ensureDaemon = vi.fn(async () => undefined);
    const controlPluginDevelopment = vi.fn(async () => ({
      kind: 'status' as const,
      status: { roots: [], plugins: [] },
    }));
    const output = captureConsoleJsonOutput();
    const controller = new AbortController();
    controller.abort();
    try {
      await handlePluginsCommand(['dev', 'unregister', '/fixture/plugin', '--json'], {
        ensureDaemon,
        controlPluginDevelopment,
      }, { signal: controller.signal });

      expect(controlPluginDevelopment).toHaveBeenCalledWith({
        kind: 'unregisterExplicit',
        rootPath: '/fixture/plugin',
      }, { signal: controller.signal });
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'plugins_dev_unregister',
        data: { status: { roots: [], plugins: [] } },
      });
    } finally {
      output.restore();
    }
  });

  it('renders the daemon-owned development status from the top-level status command', async () => {
    const ensureDaemon = vi.fn(async () => undefined);
    const controlPluginDevelopment = vi.fn(async () => ({
      kind: 'status' as const,
      status: {
        roots: [{ kind: 'explicit' as const, rootPath: '/fixture', trusted: true, persisted: true }],
        plugins: [{
          sourceRootPath: '/fixture/plugin',
          pluginId: 'acme.fixture',
          phase: 'retained_incumbent' as const,
          occurrenceId: 'occurrence-7',
          uiArtifactDigest: 'sha256:fixture',
          diagnostic: { code: 'plugin_build_failed', message: 'Candidate build failed.' },
        }],
      },
    }));
    const output = captureConsoleJsonOutput();
    try {
      await handlePluginsCommand(['status', '--json'], { ensureDaemon, controlPluginDevelopment });

      expect(controlPluginDevelopment).toHaveBeenCalledWith({ kind: 'status' }, {});
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'plugins_status',
        data: {
          roots: [{ rootPath: '/fixture', trusted: true, persisted: true }],
          plugins: [{
            pluginId: 'acme.fixture',
            phase: 'retained_incumbent',
            occurrenceId: 'occurrence-7',
            uiArtifactDigest: 'sha256:fixture',
          }],
        },
      });
    } finally {
      output.restore();
    }
  });

  it('lists marketplace sources through the generated plugin alias and Account source owner', async () => {
    const source = accountMarketplaceUserSourceFixture({ sourceUrl: 'https://catalog.example/team.json' });
    const skill = { id: 'registry:skill-only', title: 'Skills only', format: 'git' as const,
      kinds: ['skill' as const], url: 'https://github.com/acme/skills', enabled: true, addedAt: 0 };
    const curated = curatedMarketplaceSourceFixture();
    publishAccountRegistrySourcesFixture([source, skill], [curated.id]);

    const result = await executeMarketplaceRegistryAlias(['sources', 'list']);
    expect(result).toMatchObject({ ok: true, result: { sources: [
      expect.objectContaining({ id: curated.id, url: curated.sourceUrl, enabled: false, origin: { kind: 'built_in' } }),
      expect.objectContaining({ format: 'happier-npm', origin: { kind: 'built_in' } }),
      expect.objectContaining({ id: source.id, url: source.url, origin: { kind: 'user' }, removable: true }),
    ] } });
    expect(daemonBoundary.ensureRunning).not.toHaveBeenCalled();
    expect(daemonBoundary.requestChange).not.toHaveBeenCalled();
  });

  it('creates a packable public SDK plugin template without internal imports', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-parent-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    envScope.patch({ HAPPIER_HOME_DIR: join(parentDir, 'home') });
    await materializeManagedPnpmTestShim(join(parentDir, 'home'));
    const targetDir = join(parentDir, 'acme-scaffold');
    const archivePath = join(parentDir, 'acme-scaffold.happier-plugin.tgz');
    let registry: Awaited<ReturnType<typeof startLoopbackPluginSdkRegistry>> | null = null;

    try {
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand([
          'create',
          targetDir,
          '--id',
          'acme.scaffold',
          '--name',
          'Acme Scaffold',
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
              packageJsonPath: string;
              sourceEntryPath: string;
              uiEntryPath?: string;
            };
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_create');
        expect(parsed.data?.plugin).toEqual({
          pluginId: 'acme.scaffold',
          title: 'Acme Scaffold',
          version: '0.1.0',
        });
        expect(parsed.data?.scaffold).toEqual({
          targetDir,
          packageJsonPath: join(targetDir, 'package.json'),
          sourceEntryPath: join(targetDir, 'src', 'index.ts'),
        });
      } finally {
        output.restore();
      }

      await expect(readFile(join(targetDir, '.happier-plugin', 'plugin.json'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });

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
        files: ['.agents/skills/happier-plugin-authoring', 'dist'],
      });
      expect(packageJson.private).toBeUndefined();
      expect(packageJson.scripts?.['pack:plugin']).toBe('happier plugins pack .');
      expect(packageJson.scripts?.build).toBe('happier plugins dev build .');
      expect(packageJson.scripts?.typecheck).toBe('happier plugins dev typecheck .');
      expect(packageJson.scripts?.test).toBe('happier plugins test .');
      expect(packageJson.dependencies?.['@happier-dev/plugin-sdk'])
        .toBe(PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['@happier-dev/plugin-sdk']);
      expect(packageJson.devDependencies?.['@typescript/native'])
        .toBe(PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@typescript/native']);
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
      expect(sourceEntry).toContain("import { definePlugin } from '@happier-dev/plugin-sdk';");
      expect(sourceEntry).toContain("from '@happier-dev/plugin-sdk/protocol';");
      expect(sourceEntry).toContain('export const { manifest, activate } = definePlugin({');
      expect(sourceEntry).toContain("'save-note': {");
      expect(sourceEntry).not.toMatch(/plugin-sdk\/runtime|export function activate|api\.actions\.register/u);

      await mkdir(join(targetDir, 'dist'), { recursive: true });
      await writeFile(join(targetDir, 'dist', 'index.js'), 'export function activate() {}\n', 'utf8');
      // Pack evaluates an operation-local copy, so source-local node_modules
      // are deliberately excluded. Supply the public SDK through the same
      // operation-local registry contract an external author uses.
      const sdkTarball = await createTestPluginSdkTarball();
      registry = await startLoopbackPluginSdkRegistry(sdkTarball);
      const packResult = await packLocalPlugin({
        locator: targetDir,
        outPath: archivePath,
        sdkRegistryOrigin: registry.origin,
      });
      expect(packResult).toEqual(expect.objectContaining({ ok: true }));
      if (packResult.ok) {
        expect(packResult.pluginId).toBe('acme.scaffold');
        expect(packResult.title).toBe('Acme Scaffold');
        expect(packResult.archivePath).toBe(archivePath);
      }
      expect(registry.requests).toContain('/@happier-dev/plugin-sdk');
    } finally {
      envScope.restore();
      await registry?.close();
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it('dispatches focused development operations through the author toolchain owner', async () => {
    const output = captureConsoleJsonOutput();
    const runPluginAuthorToolchain = vi.fn(async () => ({
      ok: true as const,
      operation: 'install' as const,
      projectRoot: '/fixture/plugin',
    }));
    try {
      await handlePluginsCommand([
        'dev',
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
        kind: 'plugins_dev_install',
        data: { operation: 'install', projectRoot: '/fixture/plugin' },
      });
    } finally {
      output.restore();
    }
  });

  it('does not retain the never-published plugins author command family', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const output = captureConsoleText();
    try {
      await handlePluginsCommand(['author', 'typecheck', '/fixture/plugin']);

      expect(output.text()).toContain('Unknown plugins subcommand: author');
      expect(process.exitCode).toBe(1);
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('uses the plugins dev vocabulary in focused-check human output', async () => {
    const output = captureConsoleText();
    try {
      await handlePluginsCommand(['dev', 'typecheck', '/fixture/plugin'], {
        runPluginAuthorToolchain: async () => ({
          ok: true,
          operation: 'typecheck',
          projectRoot: '/fixture/plugin',
        }),
      });

      expect(output.text()).toContain('Plugin development typecheck completed');
      expect(output.text()).not.toContain('Plugin author typecheck');
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

  it('rejects cross-plugin prerequisites outside packed testing instead of silently dropping them', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const output = captureConsoleJsonOutput();
    const runPluginAuthorToolchain = vi.fn(async () => ({
      ok: true as const,
      operation: 'test' as const,
      projectRoot: '/fixture/plugin',
    }));
    try {
      await handlePluginsCommand([
        'test',
        '/fixture/plugin',
        '--with-plugin',
        '/fixture/contributor',
        '--json',
      ], {
        runPluginAuthorToolchain,
      });

      expect(runPluginAuthorToolchain).not.toHaveBeenCalled();
      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'plugins_test',
        error: {
          code: 'plugin_test_invalid_input',
          message: '--with-plugin is only valid with --packed',
        },
      });
      expect(process.exitCode).toBe(1);
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('rejects equals-form cross-plugin prerequisites outside packed testing instead of silently dropping them', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const output = captureConsoleJsonOutput();
    const runPluginAuthorToolchain = vi.fn(async () => ({
      ok: true as const,
      operation: 'test' as const,
      projectRoot: '/fixture/plugin',
    }));
    try {
      await handlePluginsCommand([
        'test',
        '/fixture/plugin',
        '--with-plugin=/fixture/contributor',
        '--json',
      ], {
        runPluginAuthorToolchain,
      });

      expect(runPluginAuthorToolchain).not.toHaveBeenCalled();
      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'plugins_test',
        error: {
          code: 'plugin_test_invalid_input',
          message: '--with-plugin is only valid with --packed',
        },
      });
      expect(process.exitCode).toBe(1);
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('passes each equals-form packed prerequisite to the daemon-backed packed test owner', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const output = captureConsoleJsonOutput();
    const runPackedPluginTest = vi.fn(async () => ({
      ok: false as const,
      mode: 'packed' as const,
      projectRoot: '/fixture/plugin',
      diagnostics: [{
        code: 'fixture_packed_failure',
        message: 'fixture packed failure',
      }],
    }));
    try {
      await handlePluginsCommand([
        'test',
        '/fixture/plugin',
        '--packed',
        '--with-plugin=/fixture/contributor.tgz',
        '--with-plugin=/fixture/unrelated.tgz',
        '--json',
      ], { runPackedPluginTest });

      expect(runPackedPluginTest).toHaveBeenCalledWith({
        projectRoot: '/fixture/plugin',
        prerequisiteLocators: ['/fixture/contributor.tgz', '/fixture/unrelated.tgz'],
      });
      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'plugins_test',
        error: {
          code: 'plugin_test_packed_failed',
          diagnostics: [{ code: 'fixture_packed_failure' }],
        },
      });
      expect(process.exitCode).toBe(1);
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('names the failing --with-plugin companion in the human packed failure output', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const output = captureConsoleText();
    const runPackedPluginTest = vi.fn(async () => ({
      ok: false as const,
      mode: 'packed' as const,
      projectRoot: '/fixture/plugin',
      diagnostics: [{
        code: 'plugin_manifest_invalid',
        message: 'Plugin manifest is missing',
        subject: {
          role: 'prerequisite' as const,
          index: 1,
          locator: '/fixture/unrelated',
        },
      }],
    }));
    try {
      await handlePluginsCommand([
        'test',
        '/fixture/plugin',
        '--packed',
        '--with-plugin=/fixture/contributor.tgz',
        '--with-plugin=/fixture/unrelated',
      ], { runPackedPluginTest });

      const text = output.text();
      expect(text).toContain('--with-plugin #2');
      expect(text).toContain('/fixture/unrelated');
      expect(text).toContain('Plugin manifest is missing');
      expect(process.exitCode).toBe(1);
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('rejects an empty equals-form packed prerequisite instead of running a target-only test', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const output = captureConsoleJsonOutput();
    const runPackedPluginTest = vi.fn();
    try {
      await handlePluginsCommand([
        'test',
        '/fixture/plugin',
        '--packed',
        '--with-plugin=',
        '--json',
      ], { runPackedPluginTest });

      expect(runPackedPluginTest).not.toHaveBeenCalled();
      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'plugins_test',
        error: {
          code: 'plugin_test_invalid_input',
          message: '--with-plugin requires a <root-or-archive> value',
        },
      });
      expect(process.exitCode).toBe(1);
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('renders plugin test help without invoking the author toolchain', async () => {
    const output = captureConsoleText();
    const runPluginAuthorToolchain = vi.fn();
    try {
      await handlePluginsCommand(['test', '--help'], { runPluginAuthorToolchain });

      expect(runPluginAuthorToolchain).not.toHaveBeenCalled();
      expect(output.text()).toContain('happier plugins test [path] [--packed] [--with-plugin <root-or-archive>]… [--sdk-registry <origin>] [--json]');
    } finally {
      output.restore();
    }
  });

  it.each([['dev', '--help'], ['dev', '.', '-h']])('renders development help without registering a source: %j', async (...args) => {
    const output = captureConsoleText();
    try {
      await handlePluginsCommand(args, {
        // Help must not reach the daemon lifecycle/process boundary.
        ensureDaemon: async () => { throw new Error('Help attempted to reach the daemon'); },
      });
      expect(output.text()).toContain('plugins dev');
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
      target: {
        source: { kind: 'project' as const, locator: '/fixture/plugin' },
        plugin: {
          id: 'acme.packed',
          version: '1.2.3',
          packageIdentity: { name: '@acme/packed', version: '1.2.3' },
        },
        archive: {
          digest: `sha256:${'a'.repeat(64)}`,
          integrity: `sha256-${Buffer.alloc(32, 1).toString('base64')}`,
        },
        admission: {
          decision: 'installAndTrust' as const,
          desiredGeneration: 'generation-packed-1',
          appliedGeneration: 'generation-packed-1',
        },
      },
      prerequisites: [{
        source: { kind: 'archive' as const, locator: '/fixture/contributor.tgz' },
        plugin: {
          id: 'acme.contributor',
          version: '4.5.6',
          packageIdentity: { name: '@acme/contributor', version: '4.5.6' },
        },
        archive: {
          digest: null,
          integrity: `sha256-${Buffer.alloc(32, 2).toString('base64')}`,
        },
        admission: {
          decision: 'installAndTrust' as const,
          desiredGeneration: 'generation-contributor-1',
          appliedGeneration: 'generation-contributor-1',
        },
      }, {
        source: { kind: 'archive' as const, locator: '/fixture/unrelated.tgz' },
        plugin: {
          id: 'acme.unrelated',
          version: '7.8.9',
          packageIdentity: { name: '@acme/unrelated', version: '7.8.9' },
        },
        archive: {
          digest: null,
          integrity: `sha256-${Buffer.alloc(32, 3).toString('base64')}`,
        },
        admission: {
          decision: 'installAndTrust' as const,
          desiredGeneration: 'generation-unrelated-1',
          appliedGeneration: 'generation-unrelated-1',
        },
      }],
      contributors: [{
        source: { kind: 'archive' as const, locator: '/fixture/contributor.tgz' },
        plugin: {
          id: 'acme.contributor',
          version: '4.5.6',
          packageIdentity: { name: '@acme/contributor', version: '4.5.6' },
        },
        archive: {
          digest: null,
          integrity: `sha256-${Buffer.alloc(32, 2).toString('base64')}`,
        },
        admission: {
          decision: 'installAndTrust' as const,
          desiredGeneration: 'generation-contributor-1',
          appliedGeneration: 'generation-contributor-1',
        },
        targetedAdmissions: [{
          target: {
            pluginId: 'acme.packed',
            pointId: 'providers',
            occurrenceId: 'generation-packed-1',
          },
          protocol: { id: 'packed-provider', version: 1 },
          contributor: {
            pluginId: 'acme.contributor',
            contributionId: 'provider-a',
            occurrenceId: 'generation-contributor-1',
          },
        }],
      }],
      initialInvocation: null,
      invocation: {
        actionId: 'acme.packed/verify',
        result: { verified: true },
      },
      daemon: {
        authenticatedControl: true as const,
        entrypoint: '/fixture/dist/index.mjs',
        initialPid: 101,
        restartedPid: 102,
        initialIncarnationId: 'incarnation-1',
        restartedIncarnationId: 'incarnation-2',
        staleIncarnationRejected: true as const,
      },
    }));
    try {
      await handlePluginsCommand([
        'test',
        '/fixture/plugin',
        '--packed',
        '--with-plugin',
        '/fixture/contributor.tgz',
        '--with-plugin',
        '/fixture/unrelated.tgz',
        '--sdk-registry',
        'http://127.0.0.1:43127',
        '--json',
      ], {
        runPluginAuthorToolchain,
        runPackedPluginTest,
      });

      expect(runPluginAuthorToolchain).not.toHaveBeenCalled();
      expect(runPackedPluginTest).toHaveBeenCalledWith({
        projectRoot: '/fixture/plugin',
        prerequisiteLocators: ['/fixture/contributor.tgz', '/fixture/unrelated.tgz'],
        sdkRegistryOrigin: 'http://127.0.0.1:43127',
      });
      const response = output.json<{
        ok: boolean;
        kind: string;
        data?: {
          prerequisites?: readonly {
            source: { kind: string; locator: string };
            plugin: { id: string; version: string };
            admission: { decision: string };
          }[];
          contributors?: readonly {
            source: { kind: string; locator: string };
            plugin: { id: string; version: string };
            admission: { decision: string };
          }[];
        };
      }>();
      expect(response).toMatchObject({
        ok: true,
        kind: 'plugins_test',
        data: {
          mode: 'packed',
          projectRoot: '/fixture/plugin',
          target: {
            source: { kind: 'project', locator: '/fixture/plugin' },
            plugin: {
              id: 'acme.packed',
              version: '1.2.3',
              packageIdentity: { name: '@acme/packed', version: '1.2.3' },
            },
            archive: { digest: `sha256:${'a'.repeat(64)}` },
            admission: {
              decision: 'installAndTrust',
              desiredGeneration: 'generation-packed-1',
              appliedGeneration: 'generation-packed-1',
            },
          },
          prerequisites: [{
            source: { kind: 'archive', locator: '/fixture/contributor.tgz' },
            plugin: { id: 'acme.contributor', version: '4.5.6' },
            admission: { decision: 'installAndTrust' },
          }, {
            source: { kind: 'archive', locator: '/fixture/unrelated.tgz' },
            plugin: { id: 'acme.unrelated', version: '7.8.9' },
            admission: { decision: 'installAndTrust' },
          }],
          contributors: [{
            source: { kind: 'archive', locator: '/fixture/contributor.tgz' },
            plugin: { id: 'acme.contributor', version: '4.5.6' },
            targetedAdmissions: [{
              target: {
                pluginId: 'acme.packed',
                pointId: 'providers',
                occurrenceId: 'generation-packed-1',
              },
              protocol: { id: 'packed-provider', version: 1 },
              contributor: {
                pluginId: 'acme.contributor',
                contributionId: 'provider-a',
                occurrenceId: 'generation-contributor-1',
              },
            }],
          }],
          invocation: {
            actionId: 'acme.packed/verify',
            result: { verified: true },
          },
        },
      });
      expect(response.data?.prerequisites?.map((participant) => participant.plugin.id)).toEqual([
        'acme.contributor',
        'acme.unrelated',
      ]);
      expect(response.data?.contributors).toHaveLength(1);
      expect(response.data?.contributors?.[0]).toMatchObject({
        source: { kind: 'archive', locator: '/fixture/contributor.tgz' },
        plugin: { id: 'acme.contributor', version: '4.5.6' },
        admission: { decision: 'installAndTrust' },
      });
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('renders packed target and contributor admission facts for human operators', async () => {
    const output = captureConsoleText();
    const runPackedPluginTest = vi.fn(async () => ({
      ok: true as const,
      mode: 'packed' as const,
      projectRoot: '/fixture/plugin',
      pluginId: 'acme.packed',
      archiveDigest: `sha256:${'a'.repeat(64)}`,
      target: {
        source: { kind: 'project' as const, locator: '/fixture/plugin' },
        plugin: {
          id: 'acme.packed',
          version: '1.2.3',
          packageIdentity: { name: '@acme/packed', version: '1.2.3' },
        },
        archive: {
          digest: `sha256:${'a'.repeat(64)}`,
          integrity: `sha256-${Buffer.alloc(32, 1).toString('base64')}`,
        },
        admission: {
          decision: 'installAndTrust' as const,
          desiredGeneration: 'generation-packed-1',
          appliedGeneration: 'generation-packed-1',
        },
      },
      prerequisites: [{
        source: { kind: 'archive' as const, locator: '/fixture/contributor.tgz' },
        plugin: {
          id: 'acme.contributor',
          version: '4.5.6',
          packageIdentity: { name: '@acme/contributor', version: '4.5.6' },
        },
        archive: {
          digest: null,
          integrity: `sha256-${Buffer.alloc(32, 2).toString('base64')}`,
        },
        admission: {
          decision: 'installAndTrust' as const,
          desiredGeneration: 'generation-contributor-1',
          appliedGeneration: 'generation-contributor-1',
        },
      }, {
        source: { kind: 'archive' as const, locator: '/fixture/unrelated.tgz' },
        plugin: {
          id: 'acme.unrelated',
          version: '7.8.9',
          packageIdentity: { name: '@acme/unrelated', version: '7.8.9' },
        },
        archive: {
          digest: null,
          integrity: `sha256-${Buffer.alloc(32, 3).toString('base64')}`,
        },
        admission: {
          decision: 'installAndTrust' as const,
          desiredGeneration: 'generation-unrelated-1',
          appliedGeneration: 'generation-unrelated-1',
        },
      }],
      contributors: [{
        source: { kind: 'archive' as const, locator: '/fixture/contributor.tgz' },
        plugin: {
          id: 'acme.contributor',
          version: '4.5.6',
          packageIdentity: { name: '@acme/contributor', version: '4.5.6' },
        },
        archive: {
          digest: null,
          integrity: `sha256-${Buffer.alloc(32, 2).toString('base64')}`,
        },
        admission: {
          decision: 'installAndTrust' as const,
          desiredGeneration: 'generation-contributor-1',
          appliedGeneration: 'generation-contributor-1',
        },
        targetedAdmissions: [{
          target: {
            pluginId: 'acme.packed',
            pointId: 'providers',
            occurrenceId: 'generation-packed-1',
          },
          protocol: { id: 'packed-provider', version: 1 },
          contributor: {
            pluginId: 'acme.contributor',
            contributionId: 'provider-a',
            occurrenceId: 'generation-contributor-1',
          },
        }],
      }],
      initialInvocation: null,
      invocation: {
        actionId: 'acme.packed/verify',
        result: { verified: true },
      },
      daemon: {
        authenticatedControl: true as const,
        entrypoint: '/fixture/dist/index.mjs',
        initialPid: 101,
        restartedPid: 102,
        initialIncarnationId: 'incarnation-1',
        restartedIncarnationId: 'incarnation-2',
        staleIncarnationRejected: true as const,
      },
    }));
    try {
      await handlePluginsCommand([
        'test',
        '/fixture/plugin',
        '--packed',
        '--with-plugin',
        '/fixture/contributor.tgz',
        '--with-plugin',
        '/fixture/unrelated.tgz',
      ], {
        runPackedPluginTest,
      });

      expect(output.text()).toContain('Packed test passed; invoked acme.packed/verify.');
      expect(output.text()).toContain('Target: acme.packed@1.2.3');
      expect(output.text()).toContain('Prerequisite: acme.contributor@4.5.6');
      expect(output.text()).toContain('Prerequisite: acme.unrelated@7.8.9');
      expect(output.text()).toContain('Contributor: acme.contributor@4.5.6');
      expect(output.text()).not.toContain('Contributor: acme.unrelated@7.8.9');
      expect(output.text()).toContain('Package identity: @acme/packed@1.2.3');
      expect(output.text()).toContain(`Archive digest: sha256:${'a'.repeat(64)}`);
      expect(output.text()).toContain('Install & trust: installAndTrust; desired generation-packed-1; applied generation-packed-1');
      expect(output.text()).toContain('Targeted admission: acme.packed@generation-packed-1; point providers; protocol packed-provider@1; contributor provider-a@generation-contributor-1');
    } finally {
      output.restore();
    }
  });

  it('creates a reactNative-ui public SDK plugin template (DEC-6 flagship mode)', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-rn-parent-'));
    const targetDir = join(parentDir, 'acme-rn-scaffold');

    try {
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand([
          'create',
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

      const uiEntry = await readFile(join(targetDir, 'src', 'ui', 'renderSurface.tsx'), 'utf8');
      expect(uiEntry).toContain('export const renderSurface = defineUiSurface');
      expect(uiEntry).toContain("from '@happier-dev/plugin-ui';");
      expect(uiEntry).not.toContain("from 'react-native'");

      // The SDK builder owns the universal CommonJS artifact build, so a
      // scaffold has no package-root compiler configuration to drift.
      for (const configPath of ['vite.config.mjs', 'rspack.config.mjs', 'react-native.config.cjs']) {
        await expect(readFile(join(targetDir, configPath), 'utf8'))
          .rejects.toMatchObject({ code: 'ENOENT' });
      }
      await expect(readFile(join(targetDir, 'pluginUiBuild.ts'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      const scaffoldPackageJson = JSON.parse(
        await readFile(join(targetDir, 'package.json'), 'utf8'),
      ) as { scripts?: Record<string, string>; devDependencies?: Record<string, string> };
      expect(scaffoldPackageJson.scripts?.['build:ui']).toBe('happier-plugin-build-ui --project-root .');
      expect(scaffoldPackageJson.devDependencies).not.toHaveProperty('vite');

    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it('creates a buildable hostedWeb bridge application from the documented --ui flag', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'happier-plugin-create-hosted-web-'));
    const targetDir = join(parentDir, 'acme-hosted-web');

    try {
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand([
          'create',
          targetDir,
          '--id',
          'acme.hostedweb',
          '--name',
          'Acme Hosted Web',
          '--ui',
          'hostedWeb',
          '--json',
        ]);

        const parsed = output.json<{
          ok: boolean;
          kind: string;
          data?: { plugin: { pluginId: string; title: string }; scaffold: { uiEntryPath?: string } };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_create');
        expect(parsed.data?.plugin).toMatchObject({ pluginId: 'acme.hostedweb', title: 'Acme Hosted Web' });
        expect(parsed.data?.scaffold.uiEntryPath).toBe(join(
          targetDir,
          '.happier-plugin',
          'ui',
          'hosted-web',
          'main-renderer',
          'entry.ts',
        ));
      } finally {
        output.restore();
      }

      const uiEntry = await readFile(
        join(targetDir, '.happier-plugin', 'ui', 'hosted-web', 'main-renderer', 'entry.ts'),
        'utf8',
      );
      expect(uiEntry).toContain("from '@happier-dev/plugin-sdk/ui/client'");
      expect(uiEntry).toContain('createPluginUiRenderContext');
      expect(uiEntry).not.toContain('context.launchInput');
      expect(uiEntry).not.toContain('context.subPath');

      for (const path of ['index.html', 'vite.config.mjs']) {
        await expect(readFile(join(targetDir, path), 'utf8'))
          .rejects.toMatchObject({ code: 'ENOENT' });
      }
      // The renderer kind is declared once, on the surface; the build config
      // derives its target from that declaration instead of restating it.
      const uiSurfaceModule = await readFile(join(targetDir, 'src', 'ui', 'surfaces.ts'), 'utf8');
      expect(uiSurfaceModule).toContain("kind: 'hostedWeb'");
      await expect(readFile(join(targetDir, 'pluginUiBuild.ts'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });

      const packageJson = JSON.parse(await readFile(join(targetDir, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(packageJson.scripts?.['build:ui']).toBe('happier-plugin-build-ui --project-root .');
      expect(packageJson.devDependencies).not.toHaveProperty('vite');
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
          'create',
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
        expect(parsed.kind).toBe('plugins_create');
        expect(parsed.error?.code).toBe('create_failed');
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
        expect(parsed.data?.package).not.toHaveProperty('manifestDigest');

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

  it('forwards --sdk-registry from plugins pack into operation-local author dependency materialization', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-sdk-registry-source-'));
    const outDir = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-sdk-registry-output-'));
    const archivePath = join(outDir, 'sdk-registry.happier-plugin.tgz');
    const sdkTarball = await createTestPluginSdkTarball();
    const registry = await startLoopbackPluginSdkRegistry(sdkTarball);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    envScope.patch({ HAPPIER_HOME_DIR: join(outDir, 'home') });
    await materializeManagedPnpmTestShim(join(outDir, 'home'));

    try {
      await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({
        name: 'happier-plugin-sdk-registry-cli-fixture',
        version: '1.0.0',
        type: 'module',
        keywords: ['happier-plugin'],
        happier: { manifest: '.happier-plugin/plugin.json' },
        files: ['index.ts'],
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
      }, null, 2), 'utf8');
      await writeFile(join(sourceRoot, 'index.ts'), [
        "import { definePlugin } from '@happier-dev/plugin-sdk';",
        'export const { manifest, activate } = definePlugin({',
        "  id: 'acme.sdk-registry-cli', version: '1.0.0',",
        "  displayName: 'SDK registry CLI', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
        "  entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] },",
        '});',
        '',
      ].join('\n'), 'utf8');

      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand([
          'pack',
          sourceRoot,
          '--out',
          archivePath,
          '--sdk-registry',
          registry.origin,
          '--json',
        ]);

        expect(output.json()).toMatchObject({
          ok: true,
          kind: 'plugins_pack',
          data: { plugin: { pluginId: 'acme.sdk-registry-cli' } },
        });
        expect(process.exitCode).toBe(0);
      } finally {
        output.restore();
      }

      expect(registry.requests).toContain('/@happier-dev/plugin-sdk');
      await expect(readFile(
        join(sourceRoot, 'node_modules', '@happier-dev', 'plugin-sdk', 'index.js'),
        'utf8',
      )).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      process.exitCode = previousExitCode;
      envScope.restore();
      await registry.close();
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
            placementBindings: ['commandPalette'],
            dangerLevel: 'safe',
            execution: { target: 'daemon' },
          },
          {
            id: 'keep-valid',
            title: 'Duplicate action',
            scopes: ['global'],
            surfaces: ['cli'],
            placementBindings: ['commandPalette'],
            dangerLevel: 'safe',
            execution: { target: 'daemon' },
          },
        ],
        settings: [
          {
            id: 'keep-settings',
            title: 'Keep settings',
            target: { kind: 'plugin' },
            scope: 'daemon',
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
        await runCompiledPluginCommand(['install', sourceRoot, '--dry-run', '--json']);
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

  it('browses only the selected Account source through the generated marketplace alias', async () => {
    const home = await createTempDir('happier-plugin-marketplace-alias-browse-');
    try {
      const listing = await seedExactCuratedMarketplaceListing({ happyHomeDir: home });
      const source = accountMarketplaceUserSourceFixture({ sourceUrl: 'https://catalog.example/team.json' });
      const unrelated = accountMarketplaceUserSourceFixture({ sourceUrl: 'https://catalog.example/unrelated.json' });
      publishAccountRegistrySourcesFixture([source, unrelated]);
      const catalog = { ...listing.snapshot, picks: [], entries: listing.snapshot.entries.map(entry => ({
        ...entry, review: { status: 'unreviewed' as const, reviewedAt: null },
      })), source: { id: source.id, title: source.title,
        kind: 'user' as const, sourceUrl: source.url } };
      const urls: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
        const url = String(input);
        urls.push(url);
        if (url !== source.url) throw new Error('Unexpected source fetch');
        return new Response(JSON.stringify(catalog), { status: 200 });
      });

      const result = await executeMarketplaceRegistryAlias(['list'], ['--source', source.id, '--query', 'Sample']);
      expect(result).toMatchObject({ ok: true, result: { pages: [{
        sourceId: source.id, status: { state: 'ok' }, nextCursor: null,
        items: [{ sourceId: source.id, kind: 'plugin', itemId: SAMPLE_PLUGIN_ID, version: '1.0.0' }],
      }] } });
      expect(urls).toEqual([source.url]);
      expect(await executeMarketplaceRegistryAlias(['list'], ['--source', source.id, '--query', 'absent']))
        .toMatchObject({ ok: true, result: { pages: [{ sourceId: source.id, status: { state: 'ok' }, items: [] }] } });
      expect(daemonBoundary.ensureRunning).not.toHaveBeenCalled();
    } finally { await removeTempDir(home); }
  });

  it('reads the published plugin payload through the generated marketplace show alias', async () => {
    const home = await createTempDir('happier-plugin-marketplace-alias-show-');
    try {
      const contributions = ['2-actions', '1-hooks', '3-ui', '4-targeted'];
      const listing = await seedExactCuratedMarketplaceListing({ happyHomeDir: home, contributions });
      const source = accountMarketplaceUserSourceFixture({ sourceUrl: 'https://catalog.example/team.json' });
      publishAccountRegistrySourcesFixture([source]);
      const catalog = { ...listing.snapshot, picks: [], entries: listing.snapshot.entries.map(entry => ({
        ...entry, review: { status: 'unreviewed' as const, reviewedAt: null },
      })), source: { id: source.id, title: source.title,
        kind: 'user' as const, sourceUrl: source.url } };
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(catalog), { status: 200 }));

      expect(await executeMarketplaceRegistryAlias(['show'], [source.id, SAMPLE_PLUGIN_ID, '--version', '1.0.0']))
        .toMatchObject({ ok: true, result: { item: {
          summary: { sourceId: source.id, kind: 'plugin', itemId: SAMPLE_PLUGIN_ID, version: '1.0.0' },
          payload: { kind: 'plugin', source: catalog.source, listing: {
            distribution: { packageName: '@acme/sample', version: '1.0.0' },
            summary: { contributions },
          } },
        } } });
      // Neither user-published approved reviews nor a schema-valid forged
      // curated source may borrow the configured Account source's authority.
      const approvedEntries = catalog.entries.map(entry => ({ ...entry,
        review: { status: 'approved' as const, reviewedAt: '2026-07-22T00:00:00.000Z' },
      }));
      vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify({
        ...catalog, entries: approvedEntries,
      }), { status: 200 }));
      expect(await executeMarketplaceRegistryAlias(['list'], ['--source', source.id]))
        .toMatchObject({ ok: true, result: { pages: [{ sourceId: source.id, status: { state: 'invalid_source' }, items: [] }] } });
      vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify({
        ...catalog, entries: approvedEntries, source: { ...catalog.source, kind: 'curated' },
      }), { status: 200 }));
      expect(await executeMarketplaceRegistryAlias(['list'], ['--source', source.id]))
        .toMatchObject({ ok: true, result: { pages: [{ sourceId: source.id, status: { state: 'invalid_source' }, items: [] }] } });
      expect(daemonBoundary.requestChange).not.toHaveBeenCalled();
    } finally { await removeTempDir(home); }
  });

  it('sends an approved exact curated listing through the canonical daemon change request', async () => {
    const home = await createTempDir('happier-plugin-marketplace-exact-install-');
    const sourceUrl = DEFAULT_CURATED_MARKETPLACE_SOURCE_URL;
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({
      HAPPIER_HOME_DIR: home,
      PATH: process.env.PATH ?? '',
    });
    reloadConfiguration();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const listing = await seedExactCuratedMarketplaceListing({ happyHomeDir: home });
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
        installMarketplaceHttpFixture(listing.snapshot);
        await runCompiledPluginCommand(['marketplace', 'install', listing.sourceId, SAMPLE_PLUGIN_ID,
          '--version', '1.0.0', '--machine', 'machine-1', '--json']);

        const parsed = output.json<{
          ok: boolean;
          kind: string;
          data?: { change?: { pluginId?: string; desiredGeneration?: string } };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_marketplace_install');
        expect(parsed.data?.change).toMatchObject({
          pluginId: SAMPLE_PLUGIN_ID,
          desiredGeneration: 'generation-marketplace-1',
        });
        expect(activePluginCliActionHost?.delivered).toEqual([expect.objectContaining({
          target: { kind: 'machine', machineId: 'machine-1' }, input: {
            machineId: 'machine-1', source: { kind: 'marketplace', sourceId: listing.sourceId,
              pluginId: SAMPLE_PLUGIN_ID, version: '1.0.0' },
          },
        })]);
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
          updatePolicy: 'allowed',
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

  it('uses the exact Community npm source package and refuses a conflicting selected package name', async () => {
    const home = await createTempDir('happier-plugin-marketplace-community-install-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({
      HAPPIER_HOME_DIR: home,
      PATH: process.env.PATH ?? '',
    });
    reloadConfiguration();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const packageName = '@acme/npm-name-different-from-plugin-id';
    const seeded = await seedExactCuratedMarketplaceListing({
      happyHomeDir: home,
    });
    const communitySource = communityMarketplaceSourceFixture();
    const communitySnapshot: MarketplaceIndexSourceSnapshotV1 = {
      ...seeded.snapshot,
      source: {
        id: communitySource.id,
        title: communitySource.title,
        kind: communitySource.origin,
        sourceUrl: communitySource.sourceUrl,
      },
      entries: seeded.snapshot.entries.map((entry) => ({
        ...entry,
        distribution: { ...entry.distribution, packageName },
        review: { status: 'unreviewed', reviewedAt: null },
        updatePolicy: 'allowed',
      })),
    };
    installMarketplaceHttpFixture(communitySnapshot);
    daemonBoundary.requestChange.mockResolvedValue({
      kind: 'committed',
      pluginId: SAMPLE_PLUGIN_ID,
      desiredGeneration: 'generation-community-1',
      appliedGeneration: 'generation-community-1',
      pendingSurfaces: [],
    });

    try {
      const discoveredPackageOutput = captureConsoleJsonOutput();
      try {
        await runCompiledPluginCommand([
          'marketplace',
          'install',
          communitySource.id,
          SAMPLE_PLUGIN_ID,
          '--version', '1.0.0', '--machine', 'machine-1',
          '--json',
        ]);
        expect(discoveredPackageOutput.json()).toMatchObject({
          ok: true,
          kind: 'plugins_marketplace_install',
          data: { change: { pluginId: SAMPLE_PLUGIN_ID } },
        });
      } finally {
        discoveredPackageOutput.restore();
      }
      expect(daemonBoundary.requestChange).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'installNpm', packageName, selector: '1.0.0',
      }));

      const requestsBeforeConflict = daemonBoundary.requestChange.mock.calls.length;
      const conflictingPackageOutput = captureConsoleJsonOutput();
      try {
        await runCompiledPluginCommand(['marketplace', 'install', communitySource.id, SAMPLE_PLUGIN_ID,
          '--package', '@acme/conflicting-selected-package', '--version', '1.0.0', '--machine', 'machine-1', '--json']);
        expect(conflictingPackageOutput.json()).toMatchObject({ ok: false,
          kind: 'plugins_marketplace_install', error: { code: 'install_unavailable' } });
      } finally { conflictingPackageOutput.restore(); }
      expect(daemonBoundary.requestChange).toHaveBeenCalledTimes(requestsBeforeConflict);

      process.exitCode = undefined;
      const output = captureConsoleJsonOutput();
      try {
        await runCompiledPluginCommand([
          'marketplace',
          'install',
          communitySource.id,
          SAMPLE_PLUGIN_ID,
          '--package',
          packageName,
          '--version', '1.0.0', '--machine', 'machine-1',
          '--json',
        ]);
        expect(output.json()).toMatchObject({
          ok: true,
          kind: 'plugins_marketplace_install',
          data: { change: { pluginId: SAMPLE_PLUGIN_ID } },
        });
      } finally {
        output.restore();
      }

      expect(daemonBoundary.requestChange).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'installNpm',
        packageName,
      }));
      expect(daemonBoundary.decideChange).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('keeps source failures typed while another selected Account catalog still lists', async () => {
    const home = await createTempDir('happier-plugin-marketplace-alias-unavailable-');
    try {
      const listing = await seedExactCuratedMarketplaceListing({ happyHomeDir: home });
      const source = accountMarketplaceUserSourceFixture({ sourceUrl: 'https://catalog.example/team.json' });
      const unavailable = accountMarketplaceUserSourceFixture({ sourceUrl: 'https://unavailable.example/catalog.json' });
      publishAccountRegistrySourcesFixture([source, unavailable]);
      const catalog = { ...listing.snapshot, source: { id: source.id, title: source.title,
        kind: 'user' as const, sourceUrl: source.url } };
      vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
        if (String(input) !== source.url) throw new TypeError('Network unavailable');
        return new Response(JSON.stringify(catalog), { status: 200 });
      });
      expect(await executeMarketplaceRegistryAlias(['list'], ['--source', source.id, '--source', unavailable.id]))
        .toMatchObject({ ok: true, result: { pages: [
          { sourceId: source.id, status: { state: 'ok' }, items: [{ itemId: SAMPLE_PLUGIN_ID }] },
          { sourceId: unavailable.id, status: { state: 'unreachable' }, items: [], nextCursor: null },
        ] } });
    } finally { await removeTempDir(home); }
  });

  it.each([
    ['withdrawn review', { reviewStatus: 'withdrawn' as const }],
    ['stale marketplace facts', { freshnessState: 'stale' as const }],
    ['stale-offline marketplace facts', { freshnessState: 'stale-offline' as const }],
  ])('fails closed for a curated listing with %s before contacting the daemon', async (_label, listingOverride) => {
    const home = await createTempDir('happier-plugin-marketplace-refused-install-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({
      HAPPIER_HOME_DIR: home,
      PATH: process.env.PATH ?? '',
    });
    reloadConfiguration();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const listing = await seedExactCuratedMarketplaceListing({ happyHomeDir: home, ...listingOverride });

    try {
      const output = captureConsoleJsonOutput();
      try {
        installMarketplaceHttpFixture(listing.snapshot);
        await runCompiledPluginCommand(['marketplace', 'install', listing.sourceId, SAMPLE_PLUGIN_ID,
          '--version', '1.0.0', '--machine', 'machine-1', '--json']);
        const parsed = output.json<{ ok: boolean; error?: { code?: string; message?: string } }>();
        expect(parsed.ok).toBe(false);
        expect(parsed.error).toMatchObject({ code: 'install_unavailable' });
        // Source facts and transport/cache currentness are classified by the
        // canonical exact service, not wording reconstructed by this CLI.
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

  it('prepares an explicit local path through registered daemon review and commits only the authenticated human decision', async () => {
    const home = await createTempDir('happier-plugin-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    await materializeSamplePluginFixture(sourceRoot);
    const control = fastify({ logger: false });
    const controlToken = 'fixture-private-plugin-control';

    try {
      activePluginChangeService = await createPluginChangeService();
      registerDaemonPluginChangeRoutes(control, {
        service: activePluginChangeService,
        requireAuth: createDaemonControlAuthGuard(controlToken),
      });
      await control.ready();
      // HTTP/control-token custody is the boundary; registration, request parsing,
      // candidate preparation, trust and durable installation stay real.
      daemonBoundary.requestChange.mockImplementation(async request => {
        const response = await control.inject({ method: 'POST', url: PLUGIN_CHANGE_REQUEST_PATH,
          headers: { 'x-happier-daemon-token': controlToken }, payload: request });
        expect(response.statusCode).toBe(200);
        return response.json();
      });
      const output = captureConsoleJsonOutput();
      try {
        await runCompiledPluginCommand(['install', sourceRoot, '--json']);
        const envelope = output.json<{ error?: { code?: string; message?: string } }>();
        expect(envelope, JSON.stringify(envelope.error)).toMatchObject({ ok: false, kind: 'plugins_install', error: { code: 'review_required' } });
        expect(daemonBoundary.requestChange).toHaveBeenCalledWith({ kind: 'installPath', locator: sourceRoot });
        expect(daemonBoundary.decideChange).not.toHaveBeenCalled();
        expect((await createPluginStateStore({ happyHomeDir: home }).read()).plugins[SAMPLE_PLUGIN_ID]).toBeUndefined();
        const issued = daemonBoundary.requestChange.mock.results[0];
        if (!issued || issued.type !== 'return') throw new Error('Expected a daemon-issued review');
        const pending = PluginChangePendingReviewResultSchema.parse(await issued.value);
        const decision = { pendingChangeId: pending.pendingChangeId, decision: 'installAndTrust', optionalSelections: [] };
        expect((await control.inject({ method: 'POST', url: PLUGIN_CHANGE_DECISION_PATH, payload: decision })).statusCode).toBe(401);
        expect((await createPluginStateStore({ happyHomeDir: home }).read()).plugins[SAMPLE_PLUGIN_ID]).toBeUndefined();
        const committed = await control.inject({ method: 'POST', url: PLUGIN_CHANGE_DECISION_PATH,
          headers: { 'x-happier-daemon-token': controlToken }, payload: decision });
        expect(committed.statusCode).toBe(200);
        expect(committed.json()).toMatchObject({ kind: 'committed', pluginId: SAMPLE_PLUGIN_ID });
        expect((await createPluginStateStore({ happyHomeDir: home }).read()).plugins[SAMPLE_PLUGIN_ID]).toBeDefined();
      } finally { output.restore(); }
    } finally {
      await control.close();
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await removeTempDir(sourceRoot);
    }
  });

  it('installs the maintained out-of-tree triage source as a development source', async () => {
    const home = await createTempDir('happier-acme-install-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    envScope.patch({ HAPPIER_HOME_DIR: home });
    reloadConfiguration();
    const sourceRoot = resolve('../../packages/tests/fixtures/plugin-platform/out-of-tree-triage-source');
    const output = captureConsoleJsonOutput();
    try {
      await runCompiledPluginCommand(['install', sourceRoot, '--dev', '--json']);
      expect(output.json()).toMatchObject({ ok: true, kind: 'plugins_install', data: { change: {
        kind: 'committed', pluginId: 'acme.ledger',
      } } });
      expect((await readInstalledPluginCatalog({ happyHomeDir: home })).map(entry => entry.pluginId)).toContain('acme.ledger');
    } finally {
      output.restore();
      await activePluginChangeService?.shutdown();
      await activePluginReloadController?.shutdown();
      activePluginChangeService = null;
      activePluginReloadController = null;
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('preserves the daemon rejection reason for a local path install', async () => {
    const home = await createTempDir('happier-plugin-cli-rejection-');
    const sourceRoot = await createTempDir('happier-plugin-cli-rejection-source-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    envScope.patch({ HAPPIER_HOME_DIR: home });
    reloadConfiguration();
    await materializeSamplePluginFixture(sourceRoot);
    // The daemon transport is the boundary; the catalog and CLI presentation stay real.
    daemonBoundary.requestChange.mockResolvedValue({ kind: 'failed',
      code: 'plugin_change_preparation_failed',
      message: 'Immutable plugin generation source contains a symbolic link: node_modules/react' });
    const output = captureConsoleJsonOutput();
    try {
      await runCompiledPluginCommand(['install', sourceRoot, '--json']);
      expect(output.json()).toMatchObject({ ok: false, kind: 'plugins_install', error: {
        code: 'plugin_change_preparation_failed',
        message: 'Immutable plugin generation source contains a symbolic link: node_modules/react',
      } });
      expect(daemonBoundary.requestChange).toHaveBeenCalledTimes(1);
      expect(daemonBoundary.readChangeStatus).not.toHaveBeenCalled();
    } finally {
      output.restore();
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(sourceRoot);
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
    try {
      await installPluginThroughPresentUserTerminal(sourceRoot);
      daemonBoundary.requestChange.mockResolvedValueOnce({ kind: 'committed', pluginId: SAMPLE_PLUGIN_ID,
        desiredGeneration: 'generation-1', appliedGeneration: null, pendingSurfaces: ['reconciliation'] });
      const output = captureConsoleJsonOutput();
      try {
        await runCompiledPluginCommand(['install', sourceRoot, '--force', '--json']);
        const parsed = output.json<{ ok: boolean; data?: { change: { pendingSurfaces: readonly string[]; appliedGeneration: string | null } } }>();
        expect(parsed.ok).toBe(true);
        expect(parsed.data?.change).toMatchObject({ pendingSurfaces: ['reconciliation'], appliedGeneration: null });
      } finally {
        output.restore();
      }

    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('uninstalls a local-path plugin after authenticated generation-custody retirement', async () => {
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
      await preservedStorage.daemon.set('settings', { preserved: true });
      await preservedStorage.daemonSession.set('draft', { preserved: true });
      await createPluginSecretStore({ pluginId: SAMPLE_PLUGIN_ID, paths, secretKey: TEST_PLUGIN_SECRET_KEY }).set('token', 'preserved');

      const output = captureConsoleJsonOutput();
      try {
        await runCompiledPluginCommand(['uninstall', SAMPLE_PLUGIN_ID, '--json']);

        const parsed = output.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: {
            plugin: {
              pluginId: string;
              source: { kind: string };
            };
            change: { desiredGeneration: string | null; appliedGeneration: string | null; pendingSurfaces: readonly string[] };
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
        expect(parsed.data?.change).toMatchObject({
          desiredGeneration: null,
          appliedGeneration: null,
          pendingSurfaces: [],
        });
      } finally {
        output.restore();
      }

      expect(daemonBoundary.requestChange).toHaveBeenLastCalledWith({ kind: 'uninstall', pluginId: SAMPLE_PLUGIN_ID });
      const state = await createPluginStateStore({ happyHomeDir: home }).read();
      expect(state.plugins[SAMPLE_PLUGIN_ID]).toBeUndefined();
      expect(await preservedStorage.daemon.get('settings')).toEqual({ preserved: true });
      expect(await preservedStorage.daemonSession.get('draft')).toEqual({ preserved: true });
      expect(await createPluginSecretStore({ pluginId: SAMPLE_PLUGIN_ID, paths, secretKey: TEST_PLUGIN_SECRET_KEY }).get('token')).toBe('preserved');
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

  it('updates an installed plugin on its trusted allowed channel without reconstructing that channel client-side', async () => {
    const home = await createTempDir('happier-plugin-update-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-update-source-'));
    await materializeSamplePluginFixture(sourceRoot);
    const manifestPath = join(sourceRoot, '.happier-plugin', 'plugin.json');
    try {
      await installPluginThroughPresentUserTerminal(sourceRoot);

      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '2.0.0' }, null, 2), 'utf8');

      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['update', SAMPLE_PLUGIN_ID, '--json']);
        const result = output.json<{
          ok: boolean;
          kind: string;
          data?: { pluginId?: string; desiredGeneration?: string | null; appliedGeneration?: string | null };
        }>();
        expect(result).toMatchObject({
          ok: true,
          kind: 'plugins_update',
          data: {
            pluginId: SAMPLE_PLUGIN_ID,
            desiredGeneration: expect.any(String),
            appliedGeneration: expect.any(String),
          },
        });
      } finally {
        output.restore();
      }

      expect(daemonBoundary.requestChange).toHaveBeenLastCalledWith({ kind: 'update', pluginId: SAMPLE_PLUGIN_ID });
      const state = await createPluginStateStore({ happyHomeDir: home }).read();
      expect(state.plugins[SAMPLE_PLUGIN_ID]?.install.manifestVersion).toBe('2.0.0');
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it('requires confirmation, reports partial daemon-storage cleanup precisely, and completes on idempotent retry', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const unconfirmed = captureConsoleJsonOutput();
      try {
        await runCompiledPluginCommand(['uninstall', SAMPLE_PLUGIN_ID, '--delete-data', '--json']);
        expect(unconfirmed.json<{ ok: boolean; error?: { code?: string } }>()).toMatchObject({
          ok: false,
          error: { code: 'confirmation_required' },
        });
      } finally {
        unconfirmed.restore();
      }
      expect(daemonBoundary.requestChange).not.toHaveBeenCalled();

      daemonBoundary.requestChange.mockResolvedValueOnce({
        kind: 'dataRemovalPartial',
        pluginId: SAMPLE_PLUGIN_ID,
        completed: ['uninstall', 'daemonStorage'],
        pending: ['secrets'],
        causeCode: 'EIO',
      });
      process.exitCode = undefined;
      const partial = captureConsoleJsonOutput();
      try {
        await runCompiledPluginCommand(['uninstall', SAMPLE_PLUGIN_ID, '--delete-data', '--yes', '--json']);
        expect(partial.json<{ ok: boolean; error?: { code?: string; completed?: readonly string[]; pending?: readonly string[] } }>()).toMatchObject({
          ok: false,
          error: {
            code: 'plugin_data_removal_partial',
            completed: ['uninstall', 'daemonStorage'],
            pending: ['secrets'],
          },
        });
      } finally {
        partial.restore();
      }

      daemonBoundary.requestChange.mockResolvedValueOnce({
        kind: 'committed',
        pluginId: SAMPLE_PLUGIN_ID,
        desiredGeneration: null,
        appliedGeneration: null,
        pendingSurfaces: [],
        dataRemoval: {
          alreadyUninstalled: true,
          removedData: { daemonStorage: false, secrets: true },
        },
      });
      process.exitCode = undefined;
      const retry = captureConsoleJsonOutput();
      try {
        await runCompiledPluginCommand(['uninstall', SAMPLE_PLUGIN_ID, '--delete-data', '--yes', '--json']);
        expect(retry.json<{ ok: boolean; data?: { pluginId?: string; alreadyUninstalled?: boolean } }>()).toMatchObject({
          ok: true,
          data: { pluginId: SAMPLE_PLUGIN_ID, alreadyUninstalled: true },
        });
      } finally {
        retry.restore();
      }
      expect(daemonBoundary.requestChange).toHaveBeenLastCalledWith({
        kind: 'uninstallAndDeleteData',
        pluginId: SAMPLE_PLUGIN_ID,
      });
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('rejects an invalid destructive plugin identity before reading or mutating owned data', async () => {
    const output = captureConsoleJsonOutput();
    try {
      await runCompiledPluginCommand(['uninstall', '../sibling.plugin', '--delete-data', '--yes', '--json']);
      expect(output.json<{ ok: boolean; error?: { code?: string } }>()).toMatchObject({
        ok: false,
        error: { code: 'plugin_data_removal_identity_invalid' },
      });
    } finally {
      output.restore();
    }
    expect(daemonBoundary.requestChange).not.toHaveBeenCalled();
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
        await runCompiledPluginCommand(['uninstall', SAMPLE_PLUGIN_ID, '--json']);

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

  it('requests a daemon-owned source-in-place reload for a development plugin', async () => {
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
            install: { mode: 'link', manifestVersion: '1.0.0', installedPath: null },
            state: { enabled: true },
          },
        },
      });
      const controlPluginDevelopment = vi.fn(async () => ({
        kind: 'status' as const,
        status: { roots: [], plugins: [] },
      }));

      const reloadOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['reload', 'acme.reload-disposable', '--json'], {
          controlPluginDevelopment,
        });

        const parsed = reloadOutput.json<{
          ok: boolean;
          kind: string;
          data?: {
            pluginId: string;
            sourceRootPath: string;
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_reload');
        expect(parsed.data).toMatchObject({
          pluginId: 'acme.reload-disposable',
          sourceRootPath: sourceRoot,
        });
        expect(controlPluginDevelopment).toHaveBeenLastCalledWith({
          kind: 'reload',
          rootPath: sourceRoot,
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

  it('reloads the uniquely registered development plugin from a nested working directory', async () => {
    const home = await createTempDir('happier-plugin-reload-current-directory-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-reload-current-directory-source-'));
    const nestedDirectory = join(sourceRoot, 'src', 'nested');
    const previousWorkingDirectory = process.cwd();
    await writeDisposableActivationPlugin(sourceRoot, join(home, 'unused-dispose.log'));
    await mkdir(nestedDirectory, { recursive: true });
    await createPluginStateStore({ happyHomeDir: home }).write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.reload-current-directory': {
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
          install: { mode: 'link', manifestVersion: '1.0.0', installedPath: null },
          state: { enabled: true },
        },
      },
    });
    const controlPluginDevelopment = vi.fn(async () => ({
      kind: 'status' as const,
      status: { roots: [], plugins: [] },
    }));

    const output = captureConsoleJsonOutput();
    try {
      process.chdir(nestedDirectory);
      await handlePluginsCommand(['reload', '--json'], { controlPluginDevelopment });

      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'plugins_reload',
        data: { pluginId: 'acme.reload-current-directory' },
      });
      expect(controlPluginDevelopment).toHaveBeenLastCalledWith({
        kind: 'reload',
        rootPath: await realpath(sourceRoot),
      });
    } finally {
      process.chdir(previousWorkingDirectory);
      output.restore();
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it('reports typed actionable diagnostics when the current directory matches zero or multiple development plugins', async () => {
    const home = await createTempDir('happier-plugin-reload-current-directory-diagnostic-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-reload-current-directory-diagnostic-source-'));
    const nestedDirectory = join(sourceRoot, 'nested');
    const previousWorkingDirectory = process.cwd();
    const previousExitCode = process.exitCode;
    await mkdir(nestedDirectory, { recursive: true });
    try {
      process.chdir(nestedDirectory);
      process.exitCode = undefined;
      const noMatchOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['reload', '--json']);
        expect(noMatchOutput.json()).toMatchObject({
          ok: false,
          kind: 'plugins_reload',
          error: {
            code: 'development_plugin_not_found_in_current_directory',
            message: expect.stringContaining('happier plugins install . --dev'),
          },
        });
      } finally {
        noMatchOutput.restore();
      }

      await createPluginStateStore({ happyHomeDir: home }).write({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: Object.fromEntries(['acme.first', 'acme.second'].map((pluginId) => [pluginId, {
          source: {
            kind: 'path',
            locator: sourceRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: sourceRoot,
            manifestPath: join(sourceRoot, '.happier-plugin', 'plugin.json'),
            devWatch: true,
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'link', manifestVersion: '1.0.0', installedPath: null },
          state: { enabled: true },
        }])),
      });
      process.exitCode = undefined;
      const ambiguousOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['reload', '--json']);
        expect(ambiguousOutput.json()).toMatchObject({
          ok: false,
          kind: 'plugins_reload',
          error: {
            code: 'development_plugin_ambiguous_in_current_directory',
            message: expect.stringContaining('acme.first, acme.second'),
          },
        });
      } finally {
        ambiguousOutput.restore();
      }
    } finally {
      process.chdir(previousWorkingDirectory);
      process.exitCode = previousExitCode;
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(sourceRoot, { recursive: true, force: true });
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
        await runCompiledPluginCommand(['install', sourceRoot, '--dry-run', '--json']);

        const parsed = installOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: {
            dryRun: boolean;
            request: { kind: string; locator: string };
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_install');
        expect(parsed.data).toMatchObject({
          dryRun: true,
          request: { kind: 'installPath', locator: sourceRoot },
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

  it('renders canonical contribution diagnostics in human plugin list and show output', async () => {
    const home = await createTempDir('happier-plugin-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    await materializeStrictIntrospectionPluginFixture(sourceRoot);

    try {
      await installPluginThroughPresentUserTerminal(sourceRoot);
      const [installed] = await readInstalledPluginCatalog({ happyHomeDir: home });
      if (!installed) throw new Error('Expected installed introspection fixture');
      const diagnostics = projectPluginCompatibilityDiagnostics({
        diagnostics: [{
          code: 'target_absent',
          message: 'Targeted contribution admission rejected (target_absent).',
          stage: 'normalization',
          contribution: { pluginId: installed.pluginId, localId: 'introspection' },
        }],
        plugin: {
          id: installed.pluginId,
          version: installed.version,
          source: 'localPath',
        },
        defaultStage: 'normalization',
        host: 'daemon',
        platform: process.platform,
        occurredAtMs: 0,
      });
      const entry = {
        ...installed,
        contributionIntrospection: {
          ...installed.contributionIntrospection,
          diagnostics,
        },
      };
      daemonBoundary.readCatalog.mockResolvedValue({ kind: 'available', plugins: [entry] });

      const listOutput = captureConsoleText();
      try {
        await handlePluginsCommand(['list']);
        expect(listOutput.text()).toContain('Diagnostics:');
        expect(listOutput.text()).toContain('Targeted contribution admission rejected (target_absent).');
      } finally {
        listOutput.restore();
      }

      const showOutput = captureConsoleText();
      try {
        await handlePluginsCommand(['show', SAMPLE_PLUGIN_ID]);
        expect(showOutput.text()).toContain('Diagnostics');
        expect(showOutput.text()).toContain('Targeted contribution admission rejected (target_absent).');
      } finally {
        showOutput.restore();
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

  it('routes the legacy install --dev spelling through daemon development-root registration', async () => {
    daemonBoundary.controlDevelopment.mockResolvedValue({
      kind: 'status' as const,
      status: {
        roots: [{
          kind: 'explicit' as const,
          rootPath: '/fixture/plugin',
          trusted: true,
          persisted: true,
        }],
        plugins: [],
      },
    });
    const output = captureConsoleJsonOutput();
    try {
      await runCompiledPluginCommand([
        'install',
        '/fixture/plugin',
        '--dev',
        '--sdk-registry',
        'http://127.0.0.1:43127/',
        '--json',
      ]);

      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'plugins_install',
        data: {
          status: {
            roots: [expect.objectContaining({ kind: 'explicit', rootPath: '/fixture/plugin' })],
          },
        },
      });
      expect(daemonBoundary.controlDevelopment).toHaveBeenCalledWith({
        kind: 'registerExplicit',
        rootPath: '/fixture/plugin',
        sdkRegistryOrigin: 'http://127.0.0.1:43127/',
      }, {});
      expect(daemonBoundary.requestChange).not.toHaveBeenCalled();
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
      const installOutput = captureConsoleJsonOutput();
      try {
        await runCompiledPluginCommand(['marketplace', 'install', marketplace.catalogUrl, SAMPLE_PLUGIN_ID,
          '--version', '1.0.0', '--machine', 'machine-1', '--json']);

        const parsed = installOutput.json<{ v: 1; ok: boolean; kind: string; error?: { code: string } }>();

        expect(parsed.ok).toBe(false);
        expect(parsed.kind).toBe('plugins_marketplace_install');
        expect(parsed.error?.code).toBe('install_unavailable');
        expect(daemonBoundary.requestChange).not.toHaveBeenCalled();
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
