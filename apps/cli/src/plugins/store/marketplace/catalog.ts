import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PluginMarketplaceEntryV1Schema,
  type PluginSourceSpecV1,
} from '@happier-dev/protocol';
import { z } from 'zod';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { fetchRemoteJsonWithLimits } from '@/plugins/discovery/remote/fetch';
import { resolvePluginStorePaths } from '@/plugins/store/paths';

type MarketplaceContributionPreview = Readonly<{
  agents: readonly string[];
  agentRuntimes: readonly string[];
  actions: readonly string[];
  tools: readonly string[];
  commands: readonly string[];
  resources: readonly string[];
  settings: readonly string[];
  hooks: readonly string[];
  hostedWeb: readonly string[];
  reactNativeBundles: readonly string[];
  uiArtifacts: readonly string[];
  surfacePlacements: readonly string[];
}>;

const REMOTE_MARKETPLACE_CACHE_TTL_MS = 5 * 60 * 1000;

const MarketplaceCatalogEntrySchema = PluginMarketplaceEntryV1Schema;

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
  manifest: null;
  source: PluginSourceSpecV1 | null;
  manifestDigest: string | null;
  contributionIds: MarketplaceContributionPreview;
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
  const paths = resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir });
  return resolve(paths.cacheDir, 'marketplace', `${hashSourceLocator(params.sourceUrl)}.json`);
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

function tryParseUrl(locator: string): URL | null {
  try {
    return new URL(locator);
  } catch {
    return null;
  }
}

function resolveLocatorAgainstCatalogOrigin(params: Readonly<{
  locator: string;
  catalogSourceUrl?: string;
}>): string {
  if (!params.catalogSourceUrl) {
    return resolve(params.locator);
  }

  if (isHttpUrl(params.catalogSourceUrl)) {
    return new URL(params.locator, params.catalogSourceUrl).toString();
  }

  if (isFileUrl(params.catalogSourceUrl)) {
    const catalogFilePath = fileURLToPath(params.catalogSourceUrl);
    return resolve(dirname(catalogFilePath), params.locator);
  }

  const catalogPath = isAbsolute(params.catalogSourceUrl)
    ? params.catalogSourceUrl
    : resolve(params.catalogSourceUrl);
  return resolve(dirname(catalogPath), params.locator);
}

function normalizeMarketplaceSourceSpec(
  source: PluginSourceSpecV1 | null,
  params?: Readonly<{ catalogSourceUrl?: string }>,
): Readonly<{
  source: PluginSourceSpecV1 | null;
  diagnostics: readonly PluginCompatibilityDiagnostic[];
}> {
  if (!source) {
    return {
      source,
      diagnostics: [],
    };
  }

  const locator = source.locator.trim();
  const parsedLocatorUrl = tryParseUrl(locator);
  const diagnostics: PluginCompatibilityDiagnostic[] = [];

  if (source.kind === 'path') {
    if (parsedLocatorUrl && parsedLocatorUrl.protocol !== 'file:') {
      diagnostics.push({
        code: 'plugin_source_kind_unsupported',
        message: `Marketplace source kind 'path' uses unsupported locator scheme '${parsedLocatorUrl.protocol}'`,
      });
      return {
        source,
        diagnostics,
      };
    }

    let normalizedLocator = parsedLocatorUrl?.protocol === 'file:'
      ? fileURLToPath(parsedLocatorUrl)
      : locator;
    if (!isAbsolute(normalizedLocator) && params?.catalogSourceUrl && !isHttpUrl(params.catalogSourceUrl)) {
      normalizedLocator = resolveLocatorAgainstCatalogOrigin({
        locator: normalizedLocator,
        catalogSourceUrl: params.catalogSourceUrl,
      });
    }

    return {
      source: {
        ...source,
        locator: normalizedLocator,
      },
      diagnostics,
    };
  }

  if (source.kind === 'archive') {
    if (parsedLocatorUrl) {
      if (parsedLocatorUrl.protocol === 'http:' || parsedLocatorUrl.protocol === 'https:') {
        return {
          source: {
            ...source,
            locator: parsedLocatorUrl.toString(),
          },
          diagnostics,
        };
      }
      if (parsedLocatorUrl.protocol === 'file:') {
        return {
          source: {
            ...source,
            locator: fileURLToPath(parsedLocatorUrl),
          },
          diagnostics,
        };
      }

      diagnostics.push({
        code: 'plugin_source_kind_unsupported',
        message: `Marketplace source kind 'archive' uses unsupported locator scheme '${parsedLocatorUrl.protocol}'`,
      });
      return {
        source,
        diagnostics,
      };
    }

    if (params?.catalogSourceUrl && isHttpUrl(params.catalogSourceUrl) && (locator.startsWith('//') || locator.startsWith('\\\\'))) {
      diagnostics.push({
        code: 'plugin_source_kind_unsupported',
        message: `Marketplace source kind 'archive' uses unsupported network-path locator '${locator}'`,
      });
      return {
        source,
        diagnostics,
      };
    }

    if (!isAbsolute(locator)) {
      return {
        source: {
          ...source,
          locator: resolveLocatorAgainstCatalogOrigin({
            locator,
            catalogSourceUrl: params?.catalogSourceUrl,
          }),
        },
        diagnostics,
      };
    }
  }

  return {
    source,
    diagnostics,
  };
}

function inferMarketplaceArchiveTrustPolicy(locator: string): PluginSourceSpecV1['trustPolicy'] {
  const parsedLocatorUrl = tryParseUrl(locator);
  if (parsedLocatorUrl) {
    if (parsedLocatorUrl.protocol === 'http:' || parsedLocatorUrl.protocol === 'https:') {
      return 'prompt';
    }
    if (parsedLocatorUrl.protocol === 'file:') {
      return 'local_trusted';
    }
  }
  return isAbsolute(locator) ? 'local_trusted' : 'prompt';
}

function buildProtocolMarketplaceEntry(
  descriptor: z.infer<typeof PluginMarketplaceEntryV1Schema>,
  params?: Readonly<{ catalogSourceUrl?: string }>,
): MarketplaceCatalogEntry {
  const normalizedSource = normalizeMarketplaceSourceSpec(
    descriptor.packageUrl
      ? {
          kind: 'archive',
          locator: descriptor.packageUrl,
          trustPolicy: 'prompt',
          installPolicy: 'managed_install',
        }
      : null,
    params,
  );
  const source = normalizedSource.source
    ? {
        ...normalizedSource.source,
        trustPolicy: inferMarketplaceArchiveTrustPolicy(normalizedSource.source.locator),
      }
    : null;
  const diagnostics = [...normalizedSource.diagnostics, ...diagnoseSourceSupport(source, params)];

  return {
    pluginId: descriptor.manifestId,
    title: descriptor.title,
    description: descriptor.description ?? null,
    version: descriptor.version ?? 'unknown',
    manifest: null,
    source,
    manifestDigest: descriptor.digest ?? null,
    contributionIds: {
      agents: [],
      agentRuntimes: [],
      actions: [],
      tools: [],
      commands: [],
      resources: [],
      settings: [],
      hooks: [],
      hostedWeb: [],
      reactNativeBundles: [],
      uiArtifacts: [],
      surfacePlacements: [],
    },
    installable: source !== null && diagnostics.length === 0,
    diagnostics,
  };
}

function diagnoseSourceSupport(
  source: PluginSourceSpecV1 | null,
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

  if (source.kind === 'archive') {
    if (isHttpUrl(params?.catalogSourceUrl ?? '')) {
      const parsedLocatorUrl = tryParseUrl(source.locator);
      if (!parsedLocatorUrl || (parsedLocatorUrl.protocol !== 'http:' && parsedLocatorUrl.protocol !== 'https:')) {
        return [
          {
            code: 'plugin_source_kind_unsupported',
            message: 'Remote marketplace catalogs cannot install local archive sources',
          },
        ];
      }
    }

    const parsedLocatorUrl = tryParseUrl(source.locator);
    if (parsedLocatorUrl && parsedLocatorUrl.protocol !== 'http:' && parsedLocatorUrl.protocol !== 'https:' && parsedLocatorUrl.protocol !== 'file:') {
      return [
        {
          code: 'plugin_source_kind_unsupported',
          message: `Marketplace source kind 'archive' uses unsupported locator '${source.locator}'`,
        },
      ];
    }
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
  raw: z.infer<typeof PluginMarketplaceEntryV1Schema>,
  params?: Readonly<{ catalogSourceUrl?: string }>,
): MarketplaceCatalogEntry {
  return buildProtocolMarketplaceEntry(raw, params);
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
  entries: readonly z.infer<typeof PluginMarketplaceEntryV1Schema>[];
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

  const parsed = MarketplaceCatalogDocumentSchema.safeParse(await fetchRemoteJsonWithLimits<unknown>({
    url: sourceUrl,
    accept: 'application/json',
    errorLabel: 'Marketplace catalog',
  }));
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
