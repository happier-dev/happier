import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExtensionSourceSpecV1, PluginManifestV1 } from '@happier-dev/protocol';
import { z } from 'zod';

import { validatePluginManifest } from '../manifest/validatePluginManifest';
import type { PluginCompatibilityDiagnostic } from '../shared/pluginDiagnostics';
import { installPluginFromSource } from '../install/installPluginFromSource';
import { createPluginStateStore } from '../store/pluginStateStore';
import { summarizePluginContributions, type PluginCatalogContributionSummary } from './pluginCatalogSummary';

const REMOTE_MARKETPLACE_CACHE_TTL_MS = 5 * 60 * 1000;

const MarketplaceCatalogEntrySchema = z.unknown();

const MarketplaceCatalogDocumentSchema = z.object({
  t: z.literal('happier_plugin_marketplace_catalog_v1'),
  schemaVersion: z.literal(1),
  sourceUrl: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  entries: z.array(MarketplaceCatalogEntrySchema).default([]),
}).strict();

const MarketplaceCatalogCacheRecordSchema = z.object({
  t: z.literal('happier_plugin_marketplace_catalog_cache_v1'),
  schemaVersion: z.literal(1),
  sourceUrl: z.string().trim().min(1),
  fetchedAtMs: z.number().int().nonnegative(),
  etag: z.string().trim().min(1).nullable().optional(),
  lastModified: z.string().trim().min(1).nullable().optional(),
  catalog: MarketplaceCatalogDocumentSchema,
}).strict();

export type MarketplaceCatalogEntry = Readonly<{
  pluginId: string;
  title: string;
  description: string | null;
  version: string;
  manifest: PluginManifestV1 | null;
  source: ExtensionSourceSpecV1 | null;
  manifestDigest: string | null;
  contributionIds: PluginCatalogContributionSummary;
  installable: boolean;
  diagnostics: readonly PluginCompatibilityDiagnostic[];
}>;

export type RemoteMarketplaceCatalog = Readonly<{
  sourceUrl: string;
  title: string;
  description: string | null;
  entries: readonly MarketplaceCatalogEntry[];
}>;

export type RemoteMarketplaceCatalogCacheState = Readonly<{
  cachePath: string | null;
  fromCache: boolean;
  stale: boolean;
}>;

export type RemoteMarketplaceCatalogReadResult =
  | Readonly<{
      ok: true;
      catalog: RemoteMarketplaceCatalog;
      cache: RemoteMarketplaceCatalogCacheState;
      diagnostics: readonly PluginCompatibilityDiagnostic[];
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly PluginCompatibilityDiagnostic[];
    }>;

export type InstallMarketplacePluginResult =
  | Readonly<{
      ok: true;
      alreadyInstalled: boolean;
      entry: MarketplaceCatalogEntry;
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly PluginCompatibilityDiagnostic[];
    }>;

function isHttpUrl(locator: string): boolean {
  try {
    const parsed = new URL(locator);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isFileUrl(locator: string): boolean {
  try {
    return new URL(locator).protocol === 'file:';
  } catch {
    return false;
  }
}

function normalizeSourceUrl(sourceUrl: string): string {
  const trimmed = String(sourceUrl ?? '').trim();
  if (!trimmed) {
    throw new Error('Marketplace catalog source URL is required');
  }
  return trimmed;
}

function hashSourceLocator(sourceUrl: string): string {
  return createHash('sha256').update(sourceUrl).digest('hex');
}

function buildMarketplaceCatalogCachePath(params: Readonly<{
  happyHomeDir?: string;
  sourceUrl: string;
}>): string {
  const store = createPluginStateStore({ happyHomeDir: params.happyHomeDir });
  return resolve(store.paths.cacheDir, 'marketplace', `${hashSourceLocator(params.sourceUrl)}.json`);
}

async function readMarketplaceCatalogCache(params: Readonly<{
  happyHomeDir?: string;
  sourceUrl: string;
}>): Promise<Readonly<{
  cachePath: string;
  fetchedAtMs: number;
  etag: string | null;
  lastModified: string | null;
  catalog: RemoteMarketplaceCatalog;
} | null>> {
  const cachePath = buildMarketplaceCatalogCachePath(params);
  try {
    const raw = await readFile(cachePath, 'utf8');
    const parsed = MarketplaceCatalogCacheRecordSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) {
      return null;
    }
    const cache = parsed.data;
    return {
      cachePath,
      fetchedAtMs: cache.fetchedAtMs,
      etag: cache.etag ?? null,
      lastModified: cache.lastModified ?? null,
      catalog: materializeMarketplaceCatalog(cache.catalog, {
        catalogSourceUrl: params.sourceUrl,
      }),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeMarketplaceCatalogCache(params: Readonly<{
  happyHomeDir?: string;
  sourceUrl: string;
  fetchedAtMs: number;
  etag: string | null;
  lastModified: string | null;
  catalog: MarketplaceCatalogDocumentV1;
}>): Promise<string> {
  const cachePath = buildMarketplaceCatalogCachePath(params);
  await mkdir(resolve(cachePath, '..'), { recursive: true });
  await writeFile(
    cachePath,
    JSON.stringify({
      t: 'happier_plugin_marketplace_catalog_cache_v1',
      schemaVersion: 1,
      sourceUrl: params.sourceUrl,
      fetchedAtMs: params.fetchedAtMs,
      etag: params.etag,
      lastModified: params.lastModified,
      catalog: params.catalog,
    }, null, 2),
    'utf8',
  );
  return cachePath;
}

function readStringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readSourceSpec(value: unknown): ExtensionSourceSpecV1 | null {
  const parsed = z.object({
    kind: z.enum(['path', 'marketplace', 'package', 'archive']),
    locator: z.string().trim().min(1),
    trustPolicy: z.enum(['local_trusted', 'prompt', 'untrusted']),
    installPolicy: z.enum(['link', 'copy', 'managed_install']),
    resolvedVersion: z.string().trim().min(1).optional(),
    resolvedDigest: z.string().trim().min(1).optional(),
    installedAt: z.number().int().nonnegative().optional(),
  }).passthrough().safeParse(value);
  return parsed.success ? parsed.data : null;
}

function hashManifest(manifest: PluginManifestV1): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`;
}

function readContributionSummaryFromRawManifest(raw: unknown): PluginCatalogContributionSummary {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : null;
  const contributions = record && typeof record.contributions === 'object' && record.contributions !== null
    ? record.contributions as Record<string, unknown>
    : null;

  const readIds = (key: 'providers' | 'backends' | 'hooks'): readonly string[] => {
    const items = contributions && Array.isArray(contributions[key]) ? contributions[key] as unknown[] : [];
    return items.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const id = typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id.trim() : '';
      return id ? [id] : [];
    });
  };

  return {
    providers: readIds('providers'),
    backends: readIds('backends'),
    hooks: readIds('hooks'),
  };
}

function readMarketplaceManifestDescriptor(raw: unknown): Readonly<{
  pluginId: string;
  title: string;
  description: string | null;
  version: string;
}> {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : null;
  return {
    pluginId: readStringField(record?.id) ?? 'unknown',
    title: readStringField(record?.displayName) ?? readStringField(record?.id) ?? 'unknown',
    description: readStringField(record?.description),
    version: readStringField(record?.version) ?? 'unknown',
  };
}

function diagnoseSourceSupport(
  source: ExtensionSourceSpecV1 | null,
  params?: Readonly<{ catalogSourceUrl?: string }>,
): readonly PluginCompatibilityDiagnostic[] {
  if (!source) {
    return [
      {
        code: 'plugin_source_missing',
        message: 'Marketplace entry does not declare an installable source',
      },
    ];
  }

  if (source.kind === 'path' && isHttpUrl(params?.catalogSourceUrl ?? '')) {
    return [
      {
        code: 'plugin_source_kind_unsupported',
        message: 'Remote marketplace catalogs cannot install local path sources',
      },
    ];
  }

  if (source.kind !== 'path' && source.kind !== 'archive') {
    return [
      {
        code: 'plugin_source_kind_unsupported',
        message: `Marketplace entry source kind '${source.kind}' is not installable in the curated local runtime`,
      },
    ];
  }

  return [];
}

function readMarketplaceCatalogEntry(
  raw: unknown,
  params?: Readonly<{ catalogSourceUrl?: string }>,
): MarketplaceCatalogEntry {
  const manifestValidation = validatePluginManifest(raw);
  if (manifestValidation.ok) {
    const manifest = manifestValidation.manifest;
    const source = manifest.source ?? null;
    const diagnostics = diagnoseSourceSupport(source, params);
    return {
      pluginId: manifest.id,
      title: manifest.displayName,
      description: manifest.description,
      version: manifest.version,
      manifest,
      source,
      manifestDigest: hashManifest(manifest),
      contributionIds: summarizePluginContributions(manifest),
      installable: source !== null && diagnostics.length === 0,
      diagnostics,
    };
  }

  const descriptor = readMarketplaceManifestDescriptor(raw);
  const source = readSourceSpec(typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).source : null);
  return {
    pluginId: descriptor.pluginId,
    title: descriptor.title,
    description: descriptor.description,
    version: descriptor.version,
    manifest: null,
    source,
    manifestDigest: null,
    contributionIds: readContributionSummaryFromRawManifest(raw),
    installable: false,
    diagnostics: [...manifestValidation.diagnostics, ...diagnoseSourceSupport(source, params)],
  };
}

function materializeMarketplaceCatalog(
  document: MarketplaceCatalogDocumentV1,
  params?: Readonly<{ catalogSourceUrl?: string }>,
): RemoteMarketplaceCatalog {
  const entries = document.entries.map((entry) => readMarketplaceCatalogEntry(entry, params));
  entries.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  return {
    sourceUrl: document.sourceUrl,
    title: document.title,
    description: document.description ?? null,
    entries: Object.freeze(entries),
  };
}

function readDuplicateMarketplacePluginIdDiagnostics(entries: readonly MarketplaceCatalogEntry[]): readonly PluginCompatibilityDiagnostic[] {
  const seen = new Set<string>();
  const diagnostics: PluginCompatibilityDiagnostic[] = [];

  for (const entry of entries) {
    if (seen.has(entry.pluginId)) {
      diagnostics.push({
        code: 'plugin_manifest_semantic_invalid',
        message: `Duplicate marketplace plugin id: ${entry.pluginId}`,
      });
      continue;
    }
    seen.add(entry.pluginId);
  }

  return diagnostics;
}

type MarketplaceCatalogDocumentV1 = Readonly<{
  t: 'happier_plugin_marketplace_catalog_v1';
  schemaVersion: 1;
  sourceUrl: string;
  title: string;
  description?: string;
  entries: readonly unknown[];
}>;

async function readMarketplaceCatalogDocument(sourceUrl: string): Promise<MarketplaceCatalogDocumentV1> {
  if (isFileUrl(sourceUrl)) {
    const filePath = fileURLToPath(sourceUrl);
    const raw = await readFile(filePath, 'utf8');
    const parsed = MarketplaceCatalogDocumentSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) {
      throw new Error('Invalid marketplace catalog document');
    }
    return parsed.data as MarketplaceCatalogDocumentV1;
  }

  if (!isHttpUrl(sourceUrl)) {
    const filePath = isAbsolute(sourceUrl) ? sourceUrl : resolve(sourceUrl);
    const raw = await readFile(filePath, 'utf8');
    const parsed = MarketplaceCatalogDocumentSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) {
      throw new Error('Invalid marketplace catalog document');
    }
    return parsed.data as MarketplaceCatalogDocumentV1;
  }

  const response = await fetch(sourceUrl, {
    headers: {
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Marketplace catalog fetch failed with ${response.status}`);
  }
  const parsed = MarketplaceCatalogDocumentSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Invalid marketplace catalog document');
  }
  return parsed.data as MarketplaceCatalogDocumentV1;
}

export async function readRemoteMarketplaceCatalog(params: Readonly<{
  sourceUrl: string;
  happyHomeDir?: string;
  cacheMaxAgeMs?: number;
  forceRefresh?: boolean;
}>): Promise<RemoteMarketplaceCatalogReadResult> {
  const sourceUrl = normalizeSourceUrl(params.sourceUrl);
  const cacheMaxAgeMs = params.cacheMaxAgeMs ?? REMOTE_MARKETPLACE_CACHE_TTL_MS;
  const existingCache = await readMarketplaceCatalogCache({ happyHomeDir: params.happyHomeDir, sourceUrl });

  if (!params.forceRefresh && existingCache && Date.now() - existingCache.fetchedAtMs <= cacheMaxAgeMs) {
    return {
      ok: true,
      catalog: existingCache.catalog,
      cache: {
        cachePath: existingCache.cachePath,
        fromCache: true,
        stale: false,
      },
      diagnostics: [],
    };
  }

  try {
    const document = await readMarketplaceCatalogDocument(sourceUrl);
    const catalog = materializeMarketplaceCatalog(document, {
      catalogSourceUrl: sourceUrl,
    });
    const duplicateDiagnostics = readDuplicateMarketplacePluginIdDiagnostics(catalog.entries);
    if (duplicateDiagnostics.length > 0) {
      throw new Error(duplicateDiagnostics.map((diagnostic) => diagnostic.message).join('\n'));
    }
    const fetchedAtMs = Date.now();
    const cachePath = await writeMarketplaceCatalogCache({
      happyHomeDir: params.happyHomeDir,
      sourceUrl,
      fetchedAtMs,
      etag: null,
      lastModified: null,
      catalog: document,
    });

    return {
      ok: true,
      catalog,
      cache: {
        cachePath,
        fromCache: false,
        stale: false,
      },
      diagnostics: [],
    };
  } catch (error) {
    if (existingCache) {
      return {
        ok: true,
        catalog: existingCache.catalog,
        cache: {
          cachePath: existingCache.cachePath,
          fromCache: true,
          stale: true,
        },
        diagnostics: [
          {
            code: 'plugin_manifest_semantic_invalid',
            message: error instanceof Error ? error.message : 'Marketplace catalog refresh failed',
          },
        ],
      };
    }

    return {
      ok: false,
      diagnostics: [
        {
          code: 'plugin_manifest_semantic_invalid',
          message: error instanceof Error ? error.message : 'Marketplace catalog fetch failed',
        },
      ],
    };
  }
}

export async function readRemoteMarketplaceCatalogEntry(params: Readonly<{
  sourceUrl: string;
  pluginId: string;
  happyHomeDir?: string;
  cacheMaxAgeMs?: number;
  forceRefresh?: boolean;
}>): Promise<Readonly<{
  ok: true;
  catalog: RemoteMarketplaceCatalog;
  entry: MarketplaceCatalogEntry | null;
  cache: RemoteMarketplaceCatalogCacheState;
  diagnostics: readonly PluginCompatibilityDiagnostic[];
}> | Readonly<{
  ok: false;
  diagnostics: readonly PluginCompatibilityDiagnostic[];
}>> {
  const catalogResult = await readRemoteMarketplaceCatalog(params);
  if (!catalogResult.ok) {
    return catalogResult;
  }

  return {
    ok: true,
    catalog: catalogResult.catalog,
    entry: catalogResult.catalog.entries.find((entry) => entry.pluginId === params.pluginId) ?? null,
    cache: catalogResult.cache,
    diagnostics: catalogResult.diagnostics,
  };
}

export async function installMarketplacePlugin(params: Readonly<{
  sourceUrl: string;
  pluginId: string;
  happyHomeDir?: string;
  skipIfInstalled: boolean;
  dryRun?: boolean;
}>): Promise<InstallMarketplacePluginResult> {
  const result = await readRemoteMarketplaceCatalogEntry({
    sourceUrl: params.sourceUrl,
    pluginId: params.pluginId,
    happyHomeDir: params.happyHomeDir,
  });

  if (!result.ok) {
    return result;
  }

  if (!result.entry) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'plugin_manifest_semantic_invalid',
          message: `Unknown marketplace plugin id: ${params.pluginId}`,
        },
      ],
    };
  }

  if (!result.entry.source) {
    return {
      ok: false,
      diagnostics: result.entry.diagnostics.length > 0
        ? result.entry.diagnostics
        : [
            {
              code: 'plugin_source_missing',
              message: `Marketplace plugin '${result.entry.pluginId}' does not declare an installable source`,
            },
          ],
    };
  }

  if (!result.entry.installable) {
    return {
      ok: false,
      diagnostics: result.entry.diagnostics.length > 0
        ? result.entry.diagnostics
        : diagnoseSourceSupport(result.entry.source, {
            catalogSourceUrl: params.sourceUrl,
          }),
    };
  }

  if (result.entry.source.kind === 'path') {
    const installed = await installPluginFromSource({
      happyHomeDir: createPluginStateStore({ happyHomeDir: params.happyHomeDir }).paths.happyHomeDir,
      locator: result.entry.source.locator,
      sourceKind: 'path',
      skipIfInstalled: params.skipIfInstalled,
      dryRun: params.dryRun,
    });
    if (!installed.ok) {
      return {
        ok: false,
        diagnostics: [
          {
            code: 'plugin_manifest_semantic_invalid',
            message: installed.errorMessage,
          },
        ],
      };
    }
    return {
      ok: true,
      alreadyInstalled: installed.alreadyInstalled,
      entry: result.entry,
    };
  }

  if (result.entry.source.kind === 'archive') {
    const installed = await installPluginFromSource({
      happyHomeDir: createPluginStateStore({ happyHomeDir: params.happyHomeDir }).paths.happyHomeDir,
      locator: result.entry.source.locator,
      sourceKind: 'archive',
      skipIfInstalled: params.skipIfInstalled,
      dryRun: params.dryRun,
    });
    if (!installed.ok) {
      return {
        ok: false,
        diagnostics: [
          {
            code: 'plugin_manifest_semantic_invalid',
            message: installed.errorMessage,
          },
        ],
      };
    }
    return {
      ok: true,
      alreadyInstalled: installed.alreadyInstalled,
      entry: result.entry,
    };
  }

  return {
    ok: false,
    diagnostics: diagnoseSourceSupport(result.entry.source, {
      catalogSourceUrl: params.sourceUrl,
    }),
  };
}
