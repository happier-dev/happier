import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { decodeBase64 } from '../../crypto/base64.js';
import { ArtifactRevisionV1Schema } from '../../artifacts/artifactRevisionV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { PromptLibrarySaveOrganizationFieldsV1, isPromptLibrarySaveFolderAssignmentV1 } from './promptFolderActionSchemasV1.js';
import { readStoredSkillFrontmatterV1, readSkillFrontmatterV1, type ReadOnlySkillProvenanceV1 } from './skills/skillLibraryItemV1.js';
import { computePromptBundleDigestV1 } from './promptLibraryDigests.js';
import { FIRST_PARTY_SKILLS_V1, type ReadOnlySkillV1 } from './skills/firstPartySkillsV1.js';

const PromptBundleSchemaIdV1Schema = lazyZodSchema(() => z.enum(['skills.skill_md_v1', 'bundle.generic_v1']));
export type PromptBundleSchemaIdV1 = z.infer<typeof PromptBundleSchemaIdV1Schema>;
export { PromptBundleSchemaIdV1Schema };

export const PromptBundleArtifactHeaderV1Schema = lazyZodSchema(() => z.looseObject({
  v: z.literal(1), kind: z.literal('prompt_bundle.v2'), title: z.string().check(z.minLength(1)),
  bundleSchemaId: PromptBundleSchemaIdV1Schema,
}));

export const PromptBundleEntryV1Schema = lazyZodSchema(() => z.looseObject({
    path: z.string().check(z.minLength(1)),
    contentBase64: z.string(),
    contentKind: z.enum(['utf8', 'binary']),
    unixMode: z.optional(z.nullable(z.number().check(z.int(), z.minimum(0), z.maximum(0o7777)))),
  }));

export type PromptBundleEntryV1 = z.infer<typeof PromptBundleEntryV1Schema>;

// Mutation operands are closed even though stored bundle readers retain extensions.
export const PromptBundleActionEntryV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(PromptBundleEntryV1Schema));
const PromptBundleActionEntriesProjectionV1Schema = lazyZodSchema(() => z.array(createStoredReadSchema(PromptBundleActionEntryV1Schema)));

/** Retained annotations are read data, not operands of a current closed mutation. */
export function projectPromptBundleActionEntriesV1(entries: readonly PromptBundleEntryV1[]): PromptBundleCreateActionInputV1['entries'] {
  return PromptBundleActionEntriesProjectionV1Schema.parse(entries);
}
export const PromptBundleCreateActionInputV1Schema = lazyZodSchema(() => z.strictObject({
title: z.string().check(z.minLength(1)), bundleSchemaId: z.literal('skills.skill_md_v1'),
  entries: z.array(PromptBundleActionEntryV1Schema), ...PromptLibrarySaveOrganizationFieldsV1,
}).check(z.refine(isPromptLibrarySaveFolderAssignmentV1, { message: 'Folder assignment must match the reviewed folder creation' })));
export type PromptBundleCreateActionInputV1 = z.infer<typeof PromptBundleCreateActionInputV1Schema>;

const bundleUpdateFields = {
  artifactId: lazyZodSchema(() => z.string().check(z.minLength(1))), title: lazyZodSchema(() => z.string().check(z.minLength(1))),
  ...PromptLibrarySaveOrganizationFieldsV1,
} as const;
export const PromptBundleUpdateActionInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...bundleUpdateFields, skillMarkdown: z.string(), expectedRevision: z.optional(ArtifactRevisionV1Schema) }),
  z.strictObject({ ...bundleUpdateFields, entries: z.array(PromptBundleActionEntryV1Schema), expectedRevision: ArtifactRevisionV1Schema }),
]).check(z.refine(isPromptLibrarySaveFolderAssignmentV1, { message: 'Folder assignment must match the reviewed folder creation' })));
export type PromptBundleUpdateActionInputV1 = z.infer<typeof PromptBundleUpdateActionInputV1Schema>;

export const PromptBundleBodyV1Schema = lazyZodSchema(() => z.looseObject({
    v: z.literal(1),
    entries: z.array(PromptBundleEntryV1Schema),
    createdAtMs: z.number().check(z.int(), z.minimum(0)),
    updatedAtMs: z.number().check(z.int(), z.minimum(0)),
  }));

export type PromptBundleBodyV1 = z.infer<typeof PromptBundleBodyV1Schema>;

export type SkillBundleContentV1 = Readonly<{
  body: PromptBundleBodyV1; skillMd: string;
  frontmatter: ReturnType<typeof readStoredSkillFrontmatterV1> & Readonly<{ name: string }>;
  digest: string;
}>;

/** The same opened bundle projection supplies discovery, delivery and skill reads. */
export function readSkillBundleContentV1(artifact: Readonly<{ header: unknown; body?: unknown }>): SkillBundleContentV1 | null {
  const header = PromptBundleArtifactHeaderV1Schema.safeParse(artifact.header);
  if (!header.success || header.data.bundleSchemaId !== 'skills.skill_md_v1' || typeof artifact.body !== 'string') return null;
  let value: unknown;
  try { value = JSON.parse(artifact.body); } catch { return null; }
  const body = PromptBundleBodyV1Schema.safeParse(value);
  if (!body.success || !validateStoredPromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: header.data.bundleSchemaId, body: body.data }).ok) return null;
  const entry = body.data.entries.find(entry => entry.path === 'SKILL.md' && entry.contentKind === 'utf8');
  if (!entry) return null;
  try {
    const skillMd = new TextDecoder().decode(decodeBase64(entry.contentBase64, 'base64'));
    const frontmatter = readStoredSkillFrontmatterV1(skillMd);
    return frontmatter.name ? { body: body.data, skillMd, frontmatter: { ...frontmatter, name: frontmatter.name },
      digest: computePromptBundleDigestV1(body.data) } : null;
  } catch { return null; }
}

/** Bundled content passes the same validation/digest owner as stored skill content. */
export function readReadOnlySkillContentV1(skillId: string, pluginSkills: readonly ReadOnlySkillV1[] = []):
  (SkillBundleContentV1 & Readonly<{ provenance: ReadOnlySkillProvenanceV1 }>) | null {
  const skill = FIRST_PARTY_SKILLS_V1.find(item => item.skillId === skillId) ?? pluginSkills.find(item => item.skillId === skillId);
  if (!skill) return null;
  const content = readSkillBundleContentV1({ header: { v: 1, kind: 'prompt_bundle.v2',
    title: skill.skillId, bundleSchemaId: 'skills.skill_md_v1' },
    body: JSON.stringify({ v: 1, entries: skill.files, createdAtMs: 0, updatedAtMs: 0 }) });
  if (!content) throw new Error('invalid_read_only_skill');
  // Packaged declarations are current inputs, not retained 0.2 Artifact Markdown.
  const frontmatter = readSkillFrontmatterV1(content.skillMd);
  if (!frontmatter.name) throw new Error('invalid_read_only_skill');
  return { ...content, frontmatter: { ...frontmatter, name: frontmatter.name }, provenance: skill.provenance };
}

/** Normalize an already-admitted retained body for current writes, preserving the raw read contract. */
export const PromptBundleBodyV1WriteSchema = createStoredReadSchema(PromptBundleBodyV1Schema);

export type PromptBundleValidationResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      errorCode: 'unsupported_schema' | 'missing_required_entry' | 'invalid_request' | 'invalid_path' | 'duplicate_path' | 'size_limit_exceeded';
      message: string;
      path?: string;
      requiredPath?: string;
    }>;

function normalizePosixRelativePath(raw: string, portable: boolean): { ok: true; normalized: string } | { ok: false; message: string } {
  // Generic bundles retain their released whitespace normalization; Skills are portable filesystem inputs.
  const value = portable ? String(raw ?? '') : String(raw ?? '').trim();
  if (!value) return { ok: false, message: 'path is empty' };
  if (value.startsWith('/')) return { ok: false, message: 'path must be relative' };
  if (value.includes('\\')) return { ok: false, message: 'path must use posix separators' };
  if (value.includes('\u0000')) return { ok: false, message: 'path contains null byte' };

  const segments = value.split('/');
  if (segments.some((s) => s.length === 0)) return { ok: false, message: 'path contains empty segment' };
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return { ok: false, message: 'path contains dot segment' };
    if (portable && (/[<>:"|?*\u0000-\u001f]/.test(seg) || /[. ]$/.test(seg)
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(seg))) {
      return { ok: false, message: 'path contains a Windows-invalid name' };
    }
  }

  return { ok: true, normalized: segments.join('/') };
}

type PromptBundleValidationInput = Readonly<{
  bundleSchemaId: PromptBundleSchemaIdV1;
  body: PromptBundleBodyV1;
}>;

/** New imports and writes require portable skill paths. */
export function validatePromptBundleBodyV1AgainstSchemaId(input: PromptBundleValidationInput): PromptBundleValidationResult {
  return validatePromptBundleBody(input, input.bundleSchemaId === 'skills.skill_md_v1');
}

/** The cd2bb4d853 predecessor admitted safe relative POSIX names, including CON.txt. */
export function validateStoredPromptBundleBodyV1AgainstSchemaId(input: PromptBundleValidationInput): PromptBundleValidationResult {
  return validatePromptBundleBody(input, false);
}

function validatePromptBundleBody(input: PromptBundleValidationInput, portable: boolean): PromptBundleValidationResult {
  const schemaId = input.bundleSchemaId;
  const body = input.body;

  const bodyParsed = PromptBundleBodyV1Schema.safeParse(body);
  if (!bodyParsed.success) {
    return { ok: false, errorCode: 'invalid_request', message: 'invalid_body' };
  }

  // Artifact document quotas and the containing HTTP/Action transport own byte admission.
  // Registry skills already exceed the former 1 MiB ceiling; file count has no separate resource boundary.
  const seen = new Set<string>();
  for (const entry of body.entries) {
    const normalized = normalizePosixRelativePath(entry.path, portable);
    if (!normalized.ok) {
      return {
        ok: false,
        errorCode: 'invalid_path',
        message: normalized.message,
        path: entry.path,
      };
    }
    if (seen.has(normalized.normalized)) {
      return {
        ok: false,
        errorCode: 'duplicate_path',
        message: 'duplicate entry path',
        path: normalized.normalized,
      };
    }
    seen.add(normalized.normalized);

  }

  if (schemaId === 'skills.skill_md_v1') {
    if (!seen.has('SKILL.md')) {
      return {
        ok: false,
        errorCode: 'missing_required_entry',
        message: 'skills bundles require SKILL.md at bundle root',
        requiredPath: 'SKILL.md',
      };
    }
  } else if (schemaId !== 'bundle.generic_v1') {
    return { ok: false, errorCode: 'unsupported_schema', message: `unsupported schema: ${schemaId}` };
  }

  return { ok: true };
}
