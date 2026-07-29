import { readFile } from 'node:fs/promises';

import {
  createDefaultCuratedMarketplaceSourceRegistryV1,
  MarketplaceSourceRegistryV1Schema,
  type MarketplaceSourceOriginV1,
  type MarketplaceSourceRegistryV1,
  type MarketplaceSourceV1,
  resolvePreferredMarketplaceSource,
  createMarketplaceSourceV1,
  normalizeMarketplaceSourceUrlV1,
} from '@happier-dev/protocol';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import { MARKETPLACE_SOURCE_REGISTRY_LOCK_NAME, withPluginStoreLock } from '@/plugins/store/lock';
import { ensurePluginStoreDirectories, resolvePluginStorePaths, type PluginStorePaths } from '@/plugins/store/paths';

export type MarketplaceSourceRegistryInputV1 = Readonly<{
  title?: string;
  sourceUrl: string;
  enabled?: boolean;
  origin?: MarketplaceSourceOriginV1;
  description?: string | null;
  registryProfileId?: string | null;
}>;

const DEFAULT_CURATED_MARKETPLACE_SOURCE_URL = 'https://marketplace.happier.dev/catalog.json';

function resolveCuratedMarketplaceSourceUrl(): string {
  const candidate = String(process.env.HAPPIER_MARKETPLACE_CURATED_SOURCE_URL ?? '').trim();
  return candidate || DEFAULT_CURATED_MARKETPLACE_SOURCE_URL;
}

function createMarketplaceSourceRecord(
  input: MarketplaceSourceRegistryInputV1,
  existing?: MarketplaceSourceV1 | null,
): MarketplaceSourceV1 {
  return createMarketplaceSourceV1({
    sourceUrl: normalizeMarketplaceSourceUrlV1(input.sourceUrl),
    title: input.title ?? undefined,
    description: input.description,
    enabled: input.enabled,
    origin: input.origin,
    registryProfileId: input.registryProfileId,
  }, existing);
}

function assertMarketplaceSourceAuthorityTransition(
  current: MarketplaceSourceRegistryV1,
  next: MarketplaceSourceRegistryV1,
): void {
  for (const nextSource of next.sources) {
    const existing = current.sources.find((source) => source.id === nextSource.id || source.sourceUrl === nextSource.sourceUrl);
    if (!existing) {
      if (nextSource.origin === 'curated') {
        throw new Error('Marketplace source curated authority can only be established by the daemon seed');
      }
      continue;
    }
    if (existing.origin !== nextSource.origin) {
      throw new Error('Marketplace source curated authority cannot be changed by registry mutation');
    }
  }
}

export function createMarketplaceSourceRegistryStore(params?: Readonly<{ happyHomeDir?: string }>): Readonly<{
  paths: PluginStorePaths;
  read: () => Promise<MarketplaceSourceRegistryV1>;
  write: (next: MarketplaceSourceRegistryV1) => Promise<void>;
  update: (
    transform: (current: MarketplaceSourceRegistryV1) => Promise<MarketplaceSourceRegistryV1> | MarketplaceSourceRegistryV1,
  ) => Promise<MarketplaceSourceRegistryV1>;
  listSources: () => Promise<readonly MarketplaceSourceV1[]>;
  upsertSource: (input: MarketplaceSourceRegistryInputV1) => Promise<MarketplaceSourceV1>;
  removeSource: (sourceId: string) => Promise<boolean>;
  setSourceEnabled: (sourceId: string, enabled: boolean) => Promise<MarketplaceSourceV1 | null>;
  resolveSourceReference: (reference: string) => Promise<MarketplaceSourceV1 | null>;
  resolvePreferredSource: () => Promise<MarketplaceSourceV1 | null>;
}> {
  const paths = resolvePluginStorePaths(params);

  async function readUnlocked(): Promise<MarketplaceSourceRegistryV1 | null> {
    try {
      const raw = await readFile(paths.marketplaceSourceRegistryFilePath, 'utf8');
      const parsed = MarketplaceSourceRegistryV1Schema.safeParse(JSON.parse(raw) as unknown);
      if (!parsed.success) {
        throw new Error('Invalid marketplace source registry file');
      }
      return parsed.data;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') {
        return null;
      }
      if (error instanceof SyntaxError) {
        throw new Error('Invalid marketplace source registry file');
      }
      throw error;
    }
  }

  async function writeUnlocked(next: MarketplaceSourceRegistryV1): Promise<void> {
    const parsed = MarketplaceSourceRegistryV1Schema.parse(next);
    await ensurePluginStoreDirectories({ happyHomeDir: paths.happyHomeDir });
    await writeJsonAtomic(paths.marketplaceSourceRegistryFilePath, parsed);
  }

  async function read(): Promise<MarketplaceSourceRegistryV1> {
    const existing = await readUnlocked();
    if (existing) {
      return existing;
    }

    return await withPluginStoreLock({
      paths,
      lockName: MARKETPLACE_SOURCE_REGISTRY_LOCK_NAME,
      fn: async () => {
        const current = await readUnlocked();
        if (current) {
          return current;
        }
        const seeded = createDefaultCuratedMarketplaceSourceRegistryV1(resolveCuratedMarketplaceSourceUrl());
        await writeUnlocked(seeded);
        return seeded;
      },
    });
  }

  async function write(next: MarketplaceSourceRegistryV1): Promise<void> {
    await withPluginStoreLock({
      paths,
      lockName: MARKETPLACE_SOURCE_REGISTRY_LOCK_NAME,
      fn: async () => {
        const current = await readUnlocked() ?? createDefaultCuratedMarketplaceSourceRegistryV1(resolveCuratedMarketplaceSourceUrl());
        const parsed = MarketplaceSourceRegistryV1Schema.parse(next);
        assertMarketplaceSourceAuthorityTransition(current, parsed);
        await writeUnlocked(parsed);
      },
    });
  }

  async function update(
    transform: (current: MarketplaceSourceRegistryV1) => Promise<MarketplaceSourceRegistryV1> | MarketplaceSourceRegistryV1,
  ): Promise<MarketplaceSourceRegistryV1> {
    return await withPluginStoreLock({
      paths,
      lockName: MARKETPLACE_SOURCE_REGISTRY_LOCK_NAME,
      fn: async () => {
        const current = await readUnlocked() ?? createDefaultCuratedMarketplaceSourceRegistryV1(resolveCuratedMarketplaceSourceUrl());
        const next = MarketplaceSourceRegistryV1Schema.parse(await transform(current));
        assertMarketplaceSourceAuthorityTransition(current, next);
        await writeUnlocked(next);
        return next;
      },
    });
  }

  async function listSources(): Promise<readonly MarketplaceSourceV1[]> {
    const registry = await read();
    return registry.sources;
  }

  async function upsertSource(input: MarketplaceSourceRegistryInputV1): Promise<MarketplaceSourceV1> {
    const nextSourceUrl = normalizeMarketplaceSourceUrlV1(input.sourceUrl);
    let nextSource: MarketplaceSourceV1 | null = null;
    await update(async (registry) => {
      const existingIndex = registry.sources.findIndex((entry) => entry.sourceUrl === nextSourceUrl);
      const existing = existingIndex >= 0 ? registry.sources[existingIndex] : null;
      const updatedSource = createMarketplaceSourceRecord(input, existing);
      nextSource = updatedSource;
      const nextSources: MarketplaceSourceV1[] = existingIndex >= 0
        ? registry.sources.map((entry, index) => (index === existingIndex ? updatedSource : entry))
        : [...registry.sources, updatedSource];
      return {
        ...registry,
        sources: nextSources,
      };
    });
    return nextSource!;
  }

  async function removeSource(sourceId: string): Promise<boolean> {
    const normalizedSourceId = String(sourceId ?? '').trim();
    if (!normalizedSourceId) return false;
    let removed = false;
    await update(async (registry) => {
      const nextSources = registry.sources.filter((entry) => entry.id !== normalizedSourceId);
      removed = nextSources.length !== registry.sources.length;
      if (!removed) {
        return registry;
      }
      return {
        ...registry,
        sources: nextSources,
      };
    });
    return removed;
  }

  async function setSourceEnabled(sourceId: string, enabled: boolean): Promise<MarketplaceSourceV1 | null> {
    const normalizedSourceId = String(sourceId ?? '').trim();
    if (!normalizedSourceId) return null;
    let updated: MarketplaceSourceV1 | null = null;
    await update(async (registry) => {
      const nextSources: MarketplaceSourceV1[] = [];
      for (const entry of registry.sources) {
        if (entry.id !== normalizedSourceId) {
          nextSources.push(entry);
          continue;
        }
        const updatedEntry: MarketplaceSourceV1 = {
          ...entry,
          enabled: Boolean(enabled),
          updatedAtMs: Date.now(),
        };
        updated = updatedEntry;
        nextSources.push(updatedEntry);
      }
      if (!updated) {
        return registry;
      }
      return {
        ...registry,
        sources: nextSources,
      };
    });
    return updated;
  }

  async function resolveSourceReference(reference: string): Promise<MarketplaceSourceV1 | null> {
    const normalized = String(reference ?? '').trim();
    if (!normalized) return null;
    const registry = await read();
    const byId = registry.sources.find((entry) => entry.id === normalized) ?? null;
    if (byId) return byId;
    const byUrl = registry.sources.find((entry) => entry.sourceUrl === normalized) ?? null;
    if (byUrl) return byUrl;
    try {
      const sourceUrl = normalizeMarketplaceSourceUrlV1(normalized);
      return createMarketplaceSourceRecord({ sourceUrl }, null);
    } catch {
      return null;
    }
  }

  async function resolvePreferredSource(): Promise<MarketplaceSourceV1 | null> {
    const registry = await read();
    return resolvePreferredMarketplaceSource(registry.sources);
  }

  return {
    paths,
    read,
    write,
    update,
    listSources,
    upsertSource,
    removeSource,
    setSourceEnabled,
    resolveSourceReference,
    resolvePreferredSource,
  };
}
