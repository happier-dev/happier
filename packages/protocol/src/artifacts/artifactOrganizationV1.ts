import { z } from 'zod';

import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Generic library metadata. Personal placement is stored in the existing private folders row. */
export const ArtifactOrganizationHeaderV1Schema = lazyZodSchema(() => z.object({
  folderId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().min(1)).optional(),
}).strict());
export type ArtifactOrganizationHeaderV1 = z.infer<typeof ArtifactOrganizationHeaderV1Schema>;
export const StoredArtifactOrganizationHeaderV1Schema = createStoredReadSchema(ArtifactOrganizationHeaderV1Schema);

export function normalizeArtifactTagsV1(value: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value ?? []) {
    const normalized = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(normalized);
  }
  return tags;
}

/** A received Artifact never imports its owner's private folder or tags. */
export function resolveArtifactOrganizationHeaderV1(input: Readonly<{
  artifactId: string;
  artifactHeadersById?: Readonly<Record<string, ArtifactOrganizationHeaderV1>>;
  header: Readonly<Record<string, unknown>>;
  owned: boolean;
}>): ArtifactOrganizationHeaderV1 {
  const personal = input.artifactHeadersById && Object.hasOwn(input.artifactHeadersById, input.artifactId)
    ? ArtifactOrganizationHeaderV1Schema.parse(input.artifactHeadersById[input.artifactId]) : {};
  const legacy = input.owned ? StoredArtifactOrganizationHeaderV1Schema.parse({
    ...(!Object.hasOwn(personal, 'folderId') && Object.hasOwn(input.header, 'folderId') ? { folderId: input.header.folderId } : {}),
    ...(!Object.hasOwn(personal, 'tags') && Object.hasOwn(input.header, 'tags') ? { tags: input.header.tags } : {}),
  }) : {};
  return { ...legacy, ...personal };
}
