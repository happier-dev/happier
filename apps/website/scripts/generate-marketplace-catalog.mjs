import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CURATED_MARKETPLACE_SOURCE_TITLE,
  DEFAULT_CURATED_MARKETPLACE_SOURCE_URL,
  deriveMarketplaceSourceId,
  deriveMarketplaceSourceTitle,
  normalizeMarketplaceSourceUrlV1,
  registryMarketplaceSourceV1,
  MarketplaceCatalogDiscoveryV1Schema,
  MarketplaceIndexEntryV1Schema,
  MarketplaceIndexSourceSnapshotV1Schema,
} from '@happier-dev/protocol';

const defaultWebsiteRoot = fileURLToPath(new URL('..', import.meta.url));
const defaultPublicDir = fileURLToPath(new URL('../public', import.meta.url));

function sortEntries(entries) {
  return [...entries].sort((a, b) => (
    String(a.pluginId).localeCompare(String(b.pluginId))
    || String(a.distribution?.packageName ?? '').localeCompare(String(b.distribution?.packageName ?? ''))
    || String(a.distribution?.version ?? '').localeCompare(String(b.distribution?.version ?? ''))
  ));
}

/** Pending producer bindings are editorial gaps, never runtime operands. */
function projectDiscovery(discovery) {
  if (discovery === undefined) return undefined;
  const ids = new Set();
  const admitted = new Set();
  const items = discovery.items.filter(item => {
    if (typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)) {
      throw new Error('Discovery items require unique nonempty ids');
    }
    ids.add(item.id);
    if (item.pending !== undefined) {
      if (item.reference !== undefined || !item.pending?.reason || !item.pending.reference) {
        throw new Error(`Pending discovery choice ${item.id} must have only a flagged review reference`);
      }
      return false;
    }
    admitted.add(item.id);
    return true;
  });
  const visibleIds = values => values.filter(id => {
    if (!ids.has(id)) throw new Error(`Unknown discovery choice ${id}`);
    return admitted.has(id);
  });
  if (discovery.featured) visibleIds([discovery.featured.item]);
  return MarketplaceCatalogDiscoveryV1Schema.parse({
    ...discovery,
    items,
    featured: discovery.featured && admitted.has(discovery.featured.item) ? discovery.featured : undefined,
    categories: discovery.categories.map(category => ({ ...category, items: visibleIds(category.items) })),
    jobs: discovery.jobs.map(job => ({ ...job,
      groups: job.groups.map(group => ({ ...group, items: visibleIds(group.items) })),
    })),
  });
}

export async function generateMarketplaceCatalog({
  publicDir = defaultPublicDir,
  websiteRoot = defaultWebsiteRoot,
  sourceUrl = DEFAULT_CURATED_MARKETPLACE_SOURCE_URL,
} = {}) {
  // Development uses its own admitted HTTPS source, never an override of the
  // built-in URL or a production-bound document masquerading at another origin.
  const url = normalizeMarketplaceSourceUrlV1(sourceUrl);
  const catalogSource = registryMarketplaceSourceV1({ id: deriveMarketplaceSourceId(url),
    title: url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL ? DEFAULT_CURATED_MARKETPLACE_SOURCE_TITLE : deriveMarketplaceSourceTitle(url),
    format: 'happier-catalog', kinds: ['plugin'], url, enabled: true, addedAt: 0 });
  const sourcePath = join(websiteRoot, 'marketplace', 'catalog.source.json');
  const raw = await readFile(sourcePath, 'utf8');
  const source = JSON.parse(raw);
  if (!source || typeof source !== 'object' || !Array.isArray(source.entries)) {
    throw new Error('Marketplace catalog source must contain an entries array');
  }
  // Offline validation only: every entry must already be an exact curated
  // listing (approved review, exact semver, complete SRI, manifest digest).
  // Approving a release entry requires separately checking the same facts
  // against live npm metadata and its tarball; ordinary builds never touch
  // the network or manufacture publication evidence.
  const entries = sortEntries(source.entries).map((entry) => {
    const parsed = MarketplaceIndexEntryV1Schema.parse(entry);
    if (parsed.review.status !== 'approved') {
      throw new Error(`Curated marketplace entry ${parsed.pluginId} must carry an approved review`);
    }
    if (parsed.distribution.registryProfileId !== undefined) {
      throw new Error(`Curated marketplace entry ${parsed.pluginId} must name a public npm coordinate`);
    }
    return parsed;
  });
  const snapshot = MarketplaceIndexSourceSnapshotV1Schema.parse({
    source: catalogSource,
    freshness: { state: 'fresh', fetchedAtMs: null },
    entries,
    picks: source.picks ?? [],
    discovery: projectDiscovery(source.discovery),
    diagnostics: [],
  });
  const outputPath = join(publicDir, 'catalog.json');
  await mkdir(publicDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return outputPath;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await generateMarketplaceCatalog();
}
