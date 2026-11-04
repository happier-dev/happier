import { z } from 'zod/mini';
import { isMap, parseDocument } from 'yaml';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../../json/storedReadSchema.js';
import { RegistryContentRefV1Schema, RegistryProvenanceV1Schema, WellKnownSkillRefV1Schema } from '../../../registries/registryItemsV1.js';
import { RegistryUpstreamV1Schema } from '../../../registries/registryUpstreamV1.js';
import { SkillRuleV1Schema } from '../../../reach/reachRuleV1.js';
import { ArtifactRevisionV1Schema } from '../../../artifacts/artifactRevisionV1.js';
import { ArtifactSavedByV1Schema } from '../../../artifacts/artifactBinaryV1.js';
import { SkillTrustV1Schema } from './skillTrustV1.js';
import { SkillCostV1Schema } from './skillCostV1.js';
import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '../../../plugins/contributionIdentity.js';

/** Declaration identity survives occurrence replacement without colliding with personal Artifacts. */
export function pluginSkillIdV1(identity: PluginContributionIdentityV1): string {
  return `plugin:${buildQualifiedPluginContributionKey(identity)}`;
}

/** The declaration namespace remains host-owned after its source is retired. */
export function isPluginSkillIdV1(skillId: string): boolean {
  return skillId.startsWith('plugin:');
}

export type SkillLibraryItemV1 = Readonly<{
  skillId: string; name: string; digest: string; description: string;
  sourceFolderName?: string;
  disableModelInvocation: boolean; userInvocable: boolean; updatedAt?: number;
}>;

export const PluginSkillProvenanceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('plugin'), pluginId: z.string().check(z.minLength(1)), occurrenceId: z.string().check(z.minLength(1)),
}));
export const SkillProvenanceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('registry'), registry: RegistryProvenanceV1Schema }),
  z.strictObject({ kind: z.literal('link'), url: z.string().check(z.minLength(1)), ref: RegistryContentRefV1Schema }),
  WellKnownSkillRefV1Schema,
  z.strictObject({ kind: z.literal('machine'), machineId: z.string().check(z.minLength(1)), agentIds: z.array(z.string()), path: z.string().check(z.minLength(1)), importedAt: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ kind: z.literal('upload'), importedAt: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ kind: z.literal('written') }),
  z.strictObject({ kind: z.literal('first_party') }),
  PluginSkillProvenanceV1Schema,
]));
export type SkillProvenanceV1 = z.infer<typeof SkillProvenanceV1Schema>;

/** Shared Add identity: registry listings know their key; resolved imports also know their source/content. */
export function findHeldSkillV1<T extends Readonly<{ skillId: string; provenance: SkillProvenanceV1; name?: string; digest?: string }>>(
  items: readonly T[],
  candidate: Readonly<{ registry: Readonly<{ sourceId: string; itemId: string }> }>
    | Readonly<{ provenance: SkillProvenanceV1; name: string; digest: string }>,
): T | null {
  const provenance = 'provenance' in candidate ? candidate.provenance : null;
  const registry = 'registry' in candidate ? candidate.registry : provenance?.kind === 'registry' ? provenance.registry : null;
  const ref = provenance?.kind === 'registry' ? provenance.registry.ref : provenance?.kind === 'link' ? provenance.ref : null;
  return items.find(item => {
    if (provenance?.kind === 'wellKnown' && item.provenance.kind === 'wellKnown')
      return provenance.indexUrl === item.provenance.indexUrl && provenance.name === item.provenance.name;
    if (registry && item.provenance.kind === 'registry'
      && item.provenance.registry.sourceId === registry.sourceId && item.provenance.registry.itemId === registry.itemId) return true;
    const heldRef = item.provenance.kind === 'registry' ? item.provenance.registry.ref : item.provenance.kind === 'link' ? item.provenance.ref : null;
    if (ref?.kind === 'gitTree' && heldRef?.kind === 'gitTree') return ref.repo === heldRef.repo && ref.path === heldRef.path;
    // Uploads have no stable source key. Compare current content, never the historical imported digest.
    return 'provenance' in candidate && provenance?.kind === 'upload'
      && item.name === candidate.name && item.digest === candidate.digest;
  }) ?? null;
}
export type ReadOnlySkillProvenanceV1 = Extract<SkillProvenanceV1, { kind: 'first_party' | 'plugin' }>;
export function isReadOnlySkillProvenanceV1(provenance: SkillProvenanceV1): provenance is ReadOnlySkillProvenanceV1 {
  return provenance.kind === 'first_party' || provenance.kind === 'plugin';
}
/** One source-directory segment, never a relative or absolute destination path. */
export const SkillSourceFolderNameV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1),
  z.refine(value => value !== '.' && value !== '..' && !/[\\/\0]/u.test(value))));
export const SkillLockV1Schema = lazyZodSchema(() => z.strictObject({ provenance: SkillProvenanceV1Schema,
  sourceFolderName: z.optional(SkillSourceFolderNameV1Schema),
  importedDigest: z.optional(z.string().check(z.minLength(1))), updatePolicy: z.enum(['manual', 'auto', 'pinned']), upstream: z.optional(RegistryUpstreamV1Schema) }));
export type SkillLockV1 = z.infer<typeof SkillLockV1Schema>;
const SkillLockStoredV1Schema = createStoredReadSchema(SkillLockV1Schema);
export function readSkillLockV1(header: unknown): SkillLockV1 {
  const raw = header && typeof header === 'object' && 'skillLock' in header ? header.skillLock : undefined;
  if (raw === undefined) return { provenance: { kind: 'written' }, updatePolicy: 'manual' };
  const parsed = SkillLockStoredV1Schema.safeParse(raw);
  if (!parsed.success || isReadOnlySkillProvenanceV1(parsed.data.provenance)) throw Object.assign(new Error('invalid_skill_lock'), { code: 'invalid_skill_lock' });
  return parsed.data;
}
export function isSkillModifiedV1(lock: SkillLockV1, currentDigest: string): boolean {
  return (lock.provenance.kind === 'registry' || lock.provenance.kind === 'link' || lock.provenance.kind === 'wellKnown')
    && lock.importedDigest !== currentDigest;
}
export const SkillRevisionV1Schema = lazyZodSchema(() => z.union([z.string().check(z.regex(/^sha256:[0-9a-f]{64}$/)), z.string().check(z.regex(/^\d+:\d+$/), z.refine(value => {
  const [headerVersion, bodyVersion] = value.split(':').map(Number);
  return ArtifactRevisionV1Schema.safeParse({ headerVersion, bodyVersion }).success;
}))]));
export function encodeSkillRevisionV1(revision: Readonly<{ headerVersion: number; bodyVersion: number }>): string {
  const valid = ArtifactRevisionV1Schema.parse(revision);
  return `${valid.headerVersion}:${valid.bodyVersion}`;
}
export function decodeSkillRevisionV1(revision: string): Readonly<{ headerVersion: number; bodyVersion: number }> {
  const [headerVersion, bodyVersion] = revision.split(':').map(Number);
  return ArtifactRevisionV1Schema.parse({ headerVersion, bodyVersion });
}
export const SkillListItemV1Schema = lazyZodSchema(() => z.strictObject({
  creator: z.optional(ArtifactSavedByV1Schema),
  skillId: z.string().check(z.minLength(1)), name: z.string().check(z.minLength(1)), description: z.nullable(z.string()), revision: SkillRevisionV1Schema,
  rules: z.array(SkillRuleV1Schema), trust: SkillTrustV1Schema, cost: SkillCostV1Schema,
  provenance: SkillProvenanceV1Schema, modified: z.boolean(), updatePolicy: z.enum(['manual', 'auto', 'pinned']), upstream: z.optional(RegistryUpstreamV1Schema),
  lastUsedAt: z.optional(z.number().check(z.int(), z.nonnegative())), createdAt: z.number().check(z.int(), z.nonnegative()), migratedFromContext: z.boolean(), userInvocable: z.boolean(), folderId: z.nullable(z.string()),
}));
export type SkillListItemV1 = z.infer<typeof SkillListItemV1Schema>;
export const SkillUnavailableReasonV1Schema = lazyZodSchema(() => z.enum(['skill_content_unavailable', 'not_found', 'invalid_skill_lock']));
/** Identity and public title remain knowable when a single stored skill cannot be opened. */
export const SkillUnavailableItemV1Schema = lazyZodSchema(() => z.strictObject({
  skillId: z.string().check(z.minLength(1)), title: z.nullable(z.string().check(z.minLength(1))),
  reason: SkillUnavailableReasonV1Schema,
}));
export type SkillUnavailableItemV1 = z.infer<typeof SkillUnavailableItemV1Schema>;

export const SKILL_NAME_PATTERN_V1 = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SkillFrontmatterV1Schema = lazyZodSchema(() => z.object({
  name: z.optional(z.string().check(z.regex(SKILL_NAME_PATTERN_V1))),
  description: z.optional(z.string()),
  'disable-model-invocation': z.optional(z.boolean()),
  'user-invocable': z.optional(z.boolean()),
}));
const skillFrontmatterPattern = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Delimiter lines consume only their own whitespace, never Markdown body indentation. */
export function splitSkillMarkdownV1(markdown: string): Readonly<{ frontmatter: string | null; body: string }> {
  const match = markdown.match(skillFrontmatterPattern);
  return { frontmatter: match?.[1] ?? null, body: match ? markdown.slice(match[0].length) : markdown };
}

function openSkillFrontmatter(markdown: string) {
  const { frontmatter, body } = splitSkillMarkdownV1(markdown);
  try {
    const document = parseDocument(frontmatter ?? '');
    return { document, hasHeader: frontmatter !== null, body };
  } catch { return null; }
}

type SkillFrontmatterV1 = Readonly<{
  name?: string; description?: string; disableModelInvocation: boolean; userInvocable: boolean;
}>;

/** Exact 82f2997875 predecessor line projection, used only after a stored YAML syntax failure. */
function readPredecessorSkillFrontmatter(markdown: string) {
  const match = String(markdown ?? '').match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  const out: { name?: string; description?: string } = {};
  if (!match) return out;
  for (const line of match[1]!.split('\n')) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (!value) continue;
    if (key === 'name') out.name = value;
    if (key === 'description') out.description = value;
  }
  return out;
}

function readFrontmatter(markdown: string, stored: boolean): SkillFrontmatterV1 {
  const out: { name?: string; description?: string; disableModelInvocation: boolean; userInvocable: boolean } = {
    disableModelInvocation: false, userInvocable: true,
  };
  const opened = openSkillFrontmatter(markdown);
  let value: unknown;
  if (!opened) {
    if (!stored) return out;
    value = readPredecessorSkillFrontmatter(markdown);
  } else if (!opened.hasHeader) return out;
  else if (opened.document.errors.length) {
    if (!stored) return out;
    value = readPredecessorSkillFrontmatter(markdown);
  } else {
    if (opened.document.contents !== null && !isMap(opened.document.contents)) return out;
    try { value = opened.document.toJS(); } catch { return out; }
  }
  const decoded = SkillFrontmatterV1Schema.safeParse(value);
  if (!decoded.success) return out;
  if (decoded.data.name) out.name = decoded.data.name;
  if (decoded.data.description) out.description = decoded.data.description;
  out.disableModelInvocation = decoded.data['disable-model-invocation'] === true;
  out.userInvocable = decoded.data['user-invocable'] !== false;
  return out;
}

/** Current registry imports and writes require decoded, semantically valid YAML. */
export function readSkillFrontmatterV1(markdown: string): SkillFrontmatterV1 {
  return readFrontmatter(markdown, false);
}

/** Stored 0.2 Markdown is YAML-first; only syntax failures reach its predecessor line rule. */
export function readStoredSkillFrontmatterV1(markdown: string): SkillFrontmatterV1 {
  return readFrontmatter(markdown, true);
}

/** Editing uses the same YAML owner; block children, quoting and retained metadata are not line fragments. */
export function writeSkillFrontmatterV1(markdown: string, fields: Readonly<{ name?: string; description?: string }>): string | null {
  const opened = openSkillFrontmatter(markdown);
  if (!opened || opened.document.errors.length || opened.document.contents !== null && !isMap(opened.document.contents)) return null;
  try {
    if (fields.name !== undefined) opened.document.set('name', fields.name);
    if (fields.description !== undefined) opened.document.set('description', fields.description);
    if (!SkillFrontmatterV1Schema.safeParse(opened.document.toJS()).success) return null;
    return `---\n${opened.document.toString()}---\n${opened.body}`;
  } catch { return null; }
}

/**
 * The skill folders in an uploaded file set: the set itself when it has a root `SKILL.md`, else each folder holding
 * one (`''` is the root). The one reading of an upload's roots, shared by the install preview and the upload reader.
 */
export function readSkillUploadRootsV1(paths: readonly string[]): string[] {
  if (paths.includes('SKILL.md')) return [''];
  return paths.filter(path => path.endsWith('/SKILL.md')).map(path => path.slice(0, -'/SKILL.md'.length));
}
