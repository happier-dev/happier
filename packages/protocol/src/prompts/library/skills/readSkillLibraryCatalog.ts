import { readSkillBundleContentV1, readReadOnlySkillContentV1 } from '../promptBundleSchemas.js';
import { FIRST_PARTY_SKILLS_V1, type ReadOnlySkillV1 } from './firstPartySkillsV1.js';
import { isPluginSkillIdV1 } from './skillLibraryItemV1.js';
import type { ArtifactCoarseKindV1 } from '../../../artifacts/artifactKindV1.js';
import type { ArtifactRevisionProvenanceV1, ArtifactSavedByV1 } from '../../../artifacts/artifactBinaryV1.js';

/** Plugin source outages may omit list rows, but never authorize retirement or GC. */
export async function readAvailablePluginSkillItemsV1<T>(
  read: () => readonly T[] | Promise<readonly T[]>, signal?: AbortSignal,
): Promise<readonly T[]> {
  signal?.throwIfAborted();
  try {
    const items = await read();
    signal?.throwIfAborted();
    return items;
  } catch (error) {
    signal?.throwIfAborted();
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    if (code === 'skill_content_unavailable' || code === 'needs_machine') return [];
    throw error;
  }
}

export type SkillLibraryInventoryArtifactV1 = Readonly<{
  artifactId: string; header: Readonly<Record<string, unknown>>; body?: unknown;
  provenance?: ArtifactRevisionProvenanceV1;
}>;
export type SkillLibraryCatalogItemV1 = Readonly<{ id: string; name: string; creator?: ArtifactSavedByV1 }>;
export type SkillLibraryInventoryPortV1<T extends SkillLibraryInventoryArtifactV1 = SkillLibraryInventoryArtifactV1> = Readonly<{
  readPluginSkills?(signal?: AbortSignal, skillIds?: readonly string[]): Promise<readonly ReadOnlySkillV1[]>;
  list(options: Readonly<{ includeBody: boolean; limit?: number; cursor?: string; coarseKind?: ArtifactCoarseKindV1; signal?: AbortSignal }>): Promise<Readonly<{
    items: readonly T[]; coverage: 'complete' | 'partial'; nextCursor?: string;
  }>>;
}>;

/** Paging is transport-sized, never a limit on the user's skill library. */
export async function readCompleteSkillLibraryInventoryV1<T extends SkillLibraryInventoryArtifactV1>(
  store: SkillLibraryInventoryPortV1<T>, options: Readonly<{ includeBody: boolean; signal?: AbortSignal }>,
): Promise<readonly T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    options.signal?.throwIfAborted();
    // The Artifact API admits at most 500 rows per request; continue until exhausted.
    const page = await store.list({ ...options, limit: 500, coarseKind: 'skill', ...(cursor ? { cursor } : {}) });
    options.signal?.throwIfAborted();
    if (page.coverage !== 'complete') throw Object.assign(new Error('Skill library unavailable'), { code: 'catalog_unavailable' });
    for (const artifact of page.items) {
      if (artifact.header.bundleSchemaId !== 'skills.skill_md_v1') continue;
      // Preserve the item's identity even when its stored header is malformed.
      // The content owner refuses it; selected Sessions can report the item,
      // and GC still withholds its sweep when any content cannot be read.
      items.push(artifact);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

/** Artifact inventory owns paging and decryption; the bundle owner supplies skill names. */
export async function readSkillLibraryCatalog(store: SkillLibraryInventoryPortV1,
  signal?: AbortSignal): Promise<readonly SkillLibraryCatalogItemV1[]>;
export async function readSkillLibraryCatalog(store: SkillLibraryInventoryPortV1 & Readonly<{
  read(id: string, options?: Readonly<{ signal?: AbortSignal }>): Promise<SkillLibraryInventoryArtifactV1 | null>;
}>, signal: AbortSignal | undefined, skillIds: readonly string[] | undefined): Promise<readonly SkillLibraryCatalogItemV1[]>;
export async function readSkillLibraryCatalog(store: SkillLibraryInventoryPortV1 & Partial<Readonly<{
  read(id: string, options?: Readonly<{ signal?: AbortSignal }>): Promise<SkillLibraryInventoryArtifactV1 | null>;
}>>, signal?: AbortSignal, skillIds?: readonly string[]): Promise<readonly SkillLibraryCatalogItemV1[]> {
  signal?.throwIfAborted();
  const readPlugins = () => store.readPluginSkills?.(signal, skillIds) ?? [];
  const pluginSkills = skillIds ? await readPlugins() : await readAvailablePluginSkillItemsV1(readPlugins, signal);
  signal?.throwIfAborted();
  const bundled = [...FIRST_PARTY_SKILLS_V1, ...pluginSkills].filter(skill => !skillIds || skillIds.includes(skill.skillId));
  let inventory: readonly SkillLibraryInventoryArtifactV1[];
  if (skillIds) {
    const read = store.read;
    if (!read) throw Object.assign(new Error('Addressed skill reader unavailable'), { code: 'catalog_unavailable' });
    const nativeIds = [...new Set(skillIds)].filter(id => !isPluginSkillIdV1(id) && !bundled.some(skill => skill.skillId === id));
    const opened = await Promise.all(nativeIds.map(id => read(id, { signal })));
    signal?.throwIfAborted();
    inventory = opened.filter((artifact): artifact is SkillLibraryInventoryArtifactV1 => artifact !== null);
  } else inventory = await readCompleteSkillLibraryInventoryV1(store, { includeBody: true, ...(signal ? { signal } : {}) });
  const items: SkillLibraryCatalogItemV1[] = [];
  for (const artifact of inventory) {
    const content = readSkillBundleContentV1(artifact);
    // One malformed stored skill is unavailable, not the whole name catalog.
    // Session delivery independently reads selected content and exposes its refusal.
    if (!content) continue;
    const creator = artifact.provenance?.skillCreator;
    items.push({ id: artifact.artifactId, name: content.frontmatter.name, ...(creator ? { creator } : {}) });
  }
  return [...items, ...bundled.map(skill => ({ id: skill.skillId, name: readReadOnlySkillContentV1(skill.skillId, pluginSkills)!.frontmatter.name }))];
}
