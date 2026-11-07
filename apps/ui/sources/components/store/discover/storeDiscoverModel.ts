import type {
  MarketplaceCatalogDiscoveryV1,
  MarketplaceCatalogReferenceV1,
} from '@happier-dev/protocol/marketplace';
import type { RegistryProjectSuggestion } from '@/registries/registryProjectSuggestions';
import { storeEditorialGroupKey } from '../catalog/storeEditorialIdentity';
import type { StoreKind } from '../catalog/storeKinds';

type DiscoveryItem = MarketplaceCatalogDiscoveryV1['items'][number];
type DiscoveryJob = MarketplaceCatalogDiscoveryV1['jobs'][number];

/** The kind a Discover choice belongs to, from its native reference only. */
export type StoreDiscoverKind = StoreKind;

export type StoreDiscoverItem = Readonly<{
  /** The full canonical reference: one item per page, distinct refs with the same title stay distinct. */
  key: string;
  id: string;
  sourceId: string;
  reference: MarketplaceCatalogReferenceV1;
  kind: StoreDiscoverKind;
  title: string;
  description: string | null;
}>;

export type StoreDiscoverJob = Readonly<{
  id: string;
  sourceId: string;
  title: string;
  description: string;
  glyph: string;
  /** Admitted choices only; an editorial group without one is not a way. */
  ways: number;
  kinds: readonly StoreDiscoverKind[];
  groups: readonly Readonly<{
    title: string;
    description: string | null;
    items: readonly StoreDiscoverItem[];
  }>[];
}>;

export type StoreDiscoverSection = Readonly<{
  id: string;
  sourceId: string | null;
  categoryId: string | null;
  title: string | null;
  description: string | null;
  items: readonly StoreDiscoverItem[];
  /** Every member of the category, before this page's dedupe: what its own page lists. */
  total: number;
}>;

export type StoreDiscoverPage = Readonly<{
  featured: Readonly<{ item: StoreDiscoverItem; reason: string }> | null;
  suggestions: readonly (StoreDiscoverItem & Readonly<{ because: RegistryProjectSuggestion['because'] }>)[];
  jobs: readonly StoreDiscoverJob[];
  sections: readonly StoreDiscoverSection[];
}>;

type CurationPage = Readonly<{
  sourceId: string;
  discovery: MarketplaceCatalogDiscoveryV1;
}>;
type HeldSuggestion = RegistryProjectSuggestion;

export function storeDiscoverKind(
  reference: MarketplaceCatalogReferenceV1,
): StoreDiscoverKind {
  switch (reference.type) {
    case 'registryItem':
      return reference.kind;
    case 'providerContribution':
      return 'provider';
    case 'agentContribution':
      return 'agent';
    case 'software':
      return 'software';
  }
}

function place(sourceId: string, item: DiscoveryItem): StoreDiscoverItem {
  const kind = storeDiscoverKind(item.reference);
  return {
    key: JSON.stringify(item.reference),
    id: item.id,
    sourceId,
    reference: item.reference,
    kind,
    title: item.title,
    description: item.description?.trim() || null,
  };
}

function placeAll(sourceId: string, items: readonly DiscoveryItem[]): Map<string, StoreDiscoverItem> {
  const placed = new Map<string, StoreDiscoverItem>();
  for (const item of items) {
    placed.set(item.id, place(sourceId, item));
  }
  return placed;
}

function projectJob(
  sourceId: string,
  job: DiscoveryJob,
  items: ReadonlyMap<string, StoreDiscoverItem>,
): StoreDiscoverJob {
  const groups = job.groups.map((group) => ({
    title: group.title,
    description: group.description?.trim() || null,
    items: group.items.flatMap((id) => items.get(id) ?? []),
  }));
  const choices = groups.flatMap((group) => group.items);
  const kinds: StoreDiscoverKind[] = [];
  for (const choice of choices)
    if (!kinds.includes(choice.kind)) kinds.push(choice.kind);
  return {
    id: job.id,
    sourceId,
    title: job.title,
    description: job.description,
    glyph: job.glyph,
    ways: choices.length,
    kinds,
    groups,
  };
}

/**
 * Discover's order and dedupe (S40 §9): featured → suggestions → jobs → Happier picks → categories. An item's
 * first placement wins; a job's marks preview its choices and never consume them. Nothing is padded or invented:
 * an absent featured, an empty job or a fully placed category simply leaves its slot out.
 */
export function projectStoreDiscover(
  curation: readonly CurationPage[],
  held: readonly HeldSuggestion[],
): StoreDiscoverPage {
  const placed = new Set<string>();
  const claim = (item: StoreDiscoverItem): boolean => {
    if (placed.has(item.key)) return false;
    placed.add(item.key);
    return true;
  };
  let featured: StoreDiscoverPage['featured'] = null;
  for (const page of curation) {
    const chosen = page.discovery.featured;
    const item = chosen
      ? page.discovery.items.find((candidate) => candidate.id === chosen.item)
      : undefined;
    if (!chosen || !item) continue;
    const projected = place(page.sourceId, item);
    if (claim(projected)) featured = { item: projected, reason: chosen.reason };
    break;
  }
  const suggestions = held
    .map((suggestion) => ({ ...place(suggestion.sourceId, suggestion.item), because: suggestion.because }))
    .filter(claim);
  const jobs = listStoreDiscoverJobs(curation);
  const picks: StoreDiscoverItem[] = [];
  const categories: StoreDiscoverSection[] = [];
  for (const page of curation) {
    const items = placeAll(page.sourceId, page.discovery.items);
    const categorized = new Set(
      page.discovery.categories.flatMap((category) => category.items),
    );
    for (const item of items.values())
      if (!categorized.has(item.id) && claim(item)) picks.push(item);
    for (const category of page.discovery.categories) {
      const members = category.items.flatMap((id) => items.get(id) ?? []);
      categories.push({
        id: `category:${storeEditorialGroupKey(page.sourceId, category.id)}`,
        sourceId: page.sourceId,
        categoryId: category.id,
        title: category.title,
        description: category.description?.trim() || null,
        items: members.filter(claim),
        total: members.length,
      });
    }
  }
  const sections = [
    ...(picks.length > 0
      ? [
          {
            id: 'picks',
            sourceId: null,
            categoryId: null,
            title: null,
            description: null,
            items: picks,
            total: picks.length,
          },
        ]
      : []),
    ...categories.filter((section) => section.items.length > 0),
  ];
  return { featured, suggestions, jobs, sections };
}

/** Every admitted item of one category or job, for its own page (no dedupe against Discover). */
export function findStoreDiscoverCategory(
  curation: readonly CurationPage[],
  categoryId: string,
  sourceId?: string | null,
): StoreDiscoverSection | null {
  const candidates = curation.filter(page => (sourceId === undefined || page.sourceId === sourceId)
    && page.discovery.categories.some(category => category.id === categoryId));
  if (candidates.length !== 1) return null;
  for (const page of candidates) {
    const category = page.discovery.categories.find(
      (candidate) => candidate.id === categoryId,
    );
    if (!category) continue;
    const items = placeAll(page.sourceId, page.discovery.items);
    const members = category.items.flatMap((id) => items.get(id) ?? []);
    return {
      id: `category:${storeEditorialGroupKey(page.sourceId, category.id)}`,
      sourceId: page.sourceId,
      categoryId: category.id,
      title: category.title,
      description: category.description?.trim() || null,
      items: members,
      total: members.length,
    };
  }
  return null;
}

export function findStoreDiscoverJob(
  curation: readonly CurationPage[],
  jobId: string,
  sourceId?: string | null,
): StoreDiscoverJob | null {
  const candidates = curation.filter(page => (sourceId === undefined || page.sourceId === sourceId)
    && page.discovery.jobs.some(job => job.id === jobId));
  if (candidates.length !== 1) return null;
  for (const page of candidates) {
    const job = page.discovery.jobs.find((candidate) => candidate.id === jobId);
    if (!job) continue;
    return projectJob(
      page.sourceId,
      job,
      placeAll(page.sourceId, page.discovery.items),
    );
  }
  return null;
}

export function listStoreDiscoverJobs(
  curation: readonly CurationPage[],
): readonly StoreDiscoverJob[] {
  const placed = new Set<string>();
  return curation.flatMap((page) => {
    const items = placeAll(page.sourceId, page.discovery.items);
    return page.discovery.jobs
      .map((job) => projectJob(page.sourceId, job, items))
      .filter((job) => {
        if (job.ways === 0) return false;
        // Copies of an editorial job share its identity and native choices; a genuinely different
        // choice remains source-qualified even when its editorial id and words are the same.
        const key = JSON.stringify([job.id, job.title, job.description, job.glyph,
          job.groups.map(group => [group.title, group.description, group.items.map(item => item.key)])]);
        if (placed.has(key)) return false;
        placed.add(key);
        return true;
      });
  });
}
