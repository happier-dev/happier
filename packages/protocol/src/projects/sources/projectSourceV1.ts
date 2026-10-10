import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { ScmCredentialFreeRepositorySelectorV1Schema, ScmRepositoryContainedSubdirV1Schema } from '../../scm/repositoryClone.js';
import { PrincipalRefV1Schema } from '../../teams/principal.js';
import { PromptArtifactRefV1Schema } from '../../prompts/library/promptArtifactRefsV1.js';
import { PromptStackEntryV1Schema, PromptStackSetEnabledIntentV1Schema } from '../../prompts/library/promptStacksV1.js';
import { readScmHostingRepositoryIdentity } from '../../scm/hostingRepositoryIdentity.js';

export const PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 = 'projects:sources' as const;

export const ProjectSourceRepositorySelectorV1Schema = ScmCredentialFreeRepositorySelectorV1Schema;
export type ProjectSourceRepositorySelectorV1 = z.infer<typeof ProjectSourceRepositorySelectorV1Schema>;
export const ProjectSourceGrantV1Schema = lazyZodSchema(() => z.object({ principal: PrincipalRefV1Schema, level: z.literal('view') }).strict());
export type ProjectSourceGrantV1 = z.infer<typeof ProjectSourceGrantV1Schema>;
export const SourceAttachmentV1Schema = lazyZodSchema(() => z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('context'), entry: PromptStackEntryV1Schema.extend({ ref: PromptArtifactRefV1Schema.strict() }).strict() }).strict(),
  z.object({ purpose: z.literal('dashboard'), ref: PromptArtifactRefV1Schema.strict() }).strict(),
]));
export type SourceAttachmentV1 = z.infer<typeof SourceAttachmentV1Schema>;
// Source folders use clone's containment admission, with one canonical root representation.
const ProjectSourceSubdirV1Schema = lazyZodSchema(() => z.union([
  z.string().trim().length(0), ScmRepositoryContainedSubdirV1Schema,
]).transform(value => value.replaceAll('\\', '/').split('/').filter(part => part && part !== '.').join('/') || undefined));
export function normalizeProjectSourceSubdirV1(value: string | null | undefined): string | undefined {
  return value == null ? undefined : ProjectSourceSubdirV1Schema.parse(value);
}
export const ProjectSourceV1Schema = lazyZodSchema(() => z.object({
  id: z.string().min(1), revision: z.number().int().positive(), name: z.string().trim().min(1),
  repository: ProjectSourceRepositorySelectorV1Schema,
  defaultRef: z.string().trim().min(1).optional(), subdir: ProjectSourceSubdirV1Schema.optional(),
  audience: z.array(ProjectSourceGrantV1Schema), createdByAccountId: z.string().min(1),
  attachments: z.array(SourceAttachmentV1Schema).optional(),
}).strict());
export type ProjectSourceV1 = z.infer<typeof ProjectSourceV1Schema>;
export const ProjectSourceV1StoredSchema = createStoredReadSchema(ProjectSourceV1Schema);
const id = z.string().min(1);
const revision = z.number().int().positive();
export const ProjectSourcesListInputV1Schema = lazyZodSchema(() => z.object({ serverId: id, query: z.string().optional(), audience: PrincipalRefV1Schema.optional(), cursor: id.optional(), limit: z.number().int().positive().optional() }).strict());
export const ProjectSourcesReadInputV1Schema = lazyZodSchema(() => z.object({ serverId: id, sourceId: id }).strict());
export const ProjectSourcesCreateInputV1Schema = lazyZodSchema(() => ProjectSourceV1Schema.pick({ name: true, repository: true, defaultRef: true, subdir: true }).extend({ serverId: id, requestKey: id, audience: z.array(ProjectSourceGrantV1Schema).optional() }).strict());
export const ProjectSourceAttachmentIntentV1Schema = lazyZodSchema(() => z.union([
  z.object({ kind: z.literal('attach'), attachment: SourceAttachmentV1Schema }).strict(),
  z.object({ kind: z.literal('detach'), purpose: z.literal('context'), attachmentId: id }).strict(),
  z.object({ kind: z.literal('detach'), purpose: z.literal('dashboard'), ref: PromptArtifactRefV1Schema.strict() }).strict(),
  z.object({ kind: z.literal('reorder'), attachmentId: id, beforeId: id.nullable() }).strict(),
  z.object({ kind: z.literal('budget'), attachmentId: id, maxChars: z.number().int().positive().nullable() }).strict(),
  PromptStackSetEnabledIntentV1Schema.omit({ entryId: true }).extend({ attachmentId: id }).strict(),
]));
export type ProjectSourceAttachmentIntentV1 = z.infer<typeof ProjectSourceAttachmentIntentV1Schema>;
export const ProjectSourcePatchV1Schema = lazyZodSchema(() => z.object({
  name: ProjectSourceV1Schema.shape.name.optional(), repository: ProjectSourceRepositorySelectorV1Schema.optional(),
  defaultRef: ProjectSourceV1Schema.shape.defaultRef.unwrap().nullable().optional(),
  subdir: ProjectSourceV1Schema.shape.subdir.unwrap().nullable().transform(value => value ?? null).optional(),
  audience: z.array(ProjectSourceGrantV1Schema).optional(), attachment: ProjectSourceAttachmentIntentV1Schema.optional(),
}).strict());
export const ProjectSourcesUpdateInputV1Schema = lazyZodSchema(() => z.object({ serverId: id, sourceId: id, expectedRevision: revision, patch: ProjectSourcePatchV1Schema }).strict());
export const ProjectSourcesDeleteInputV1Schema = lazyZodSchema(() => z.object({ serverId: id, sourceId: id, expectedRevision: revision }).strict());
export const ProjectSourcesFailureV1Schema = lazyZodSchema(() => z.object({ ok: z.literal(false), error: z.enum(['source_unavailable', 'source_access_denied', 'source_invalid', 'source_conflict', 'artifact_unavailable', 'artifact_wrong_kind', 'source_backend_unavailable']), current: ProjectSourceV1Schema.optional() }).strict());
export type ProjectSourcesFailureV1 = z.infer<typeof ProjectSourcesFailureV1Schema>;
export const ProjectSourcesReadOutputV1Schema = lazyZodSchema(() => z.union([z.object({ ok: z.literal(true), source: ProjectSourceV1Schema, canManage: z.boolean() }).strict(), ProjectSourcesFailureV1Schema]));
export const ProjectSourcesCreateOutputV1Schema = ProjectSourcesReadOutputV1Schema;
export const ProjectSourcesUpdateOutputV1Schema = ProjectSourcesReadOutputV1Schema;
export const ProjectSourcesDeleteOutputV1Schema = lazyZodSchema(() => z.union([z.object({ ok: z.literal(true), sourceId: id, revision }).strict(), ProjectSourcesFailureV1Schema]));
export const ProjectSourcesListOutputV1Schema = lazyZodSchema(() => z.union([z.object({ ok: z.literal(true), sources: z.array(ProjectSourceV1Schema), coverage: z.object({ complete: z.boolean(), nextCursor: id.nullable() }).strict() }).strict(), ProjectSourcesFailureV1Schema]));
export type ProjectSourcesListInputV1 = z.infer<typeof ProjectSourcesListInputV1Schema>;
export type ProjectSourcesReadInputV1 = z.infer<typeof ProjectSourcesReadInputV1Schema>;
export type ProjectSourcesCreateInputV1 = z.infer<typeof ProjectSourcesCreateInputV1Schema>;
export type ProjectSourcesUpdateInputV1 = z.infer<typeof ProjectSourcesUpdateInputV1Schema>;
export type ProjectSourcesDeleteInputV1 = z.infer<typeof ProjectSourcesDeleteInputV1Schema>;
export type ProjectSourcesListOutputV1 = z.infer<typeof ProjectSourcesListOutputV1Schema>;
export type ProjectSourcesReadOutputV1 = z.infer<typeof ProjectSourcesReadOutputV1Schema>;
export type ProjectSourcesCreateOutputV1 = z.infer<typeof ProjectSourcesCreateOutputV1Schema>;
export type ProjectSourcesUpdateOutputV1 = z.infer<typeof ProjectSourcesUpdateOutputV1Schema>;
export type ProjectSourcesDeleteOutputV1 = z.infer<typeof ProjectSourcesDeleteOutputV1Schema>;

export type ProjectSourceSelectionV1 = Readonly<{
  selector: ProjectSourceRepositorySelectorV1;
  defaultRef?: string;
  subdir?: string;
}>;
export type ProjectSourceAdmissionV1 = Readonly<{
  kind: 'admitted'; selector: ProjectSourceRepositorySelectorV1; ref?: string; subdir?: string; sourceRevision: number;
}> | Readonly<{ kind: 'refused'; code: string }>;

function effectiveSourceSelection(selection: ProjectSourceSelectionV1, overrides: Readonly<{ ref?: string; subdir?: string }>) {
  const selector = ProjectSourceRepositorySelectorV1Schema.parse(selection.selector);
  const identity = readScmHostingRepositoryIdentity({ ...selector.provider, nameWithOwner: selector.repository.nameWithOwner });
  if (!identity) throw new Error('source_invalid');
  const locator = (value: string | undefined) => value === undefined ? null
    : value.includes('://') ? new URL(value.trim()).href : value.trim();
  const ref = overrides.ref ?? selection.defaultRef;
  const selectedSubdir = overrides.subdir ?? selection.subdir;
  const subdir = normalizeProjectSourceSubdirV1(selectedSubdir);
  return { selector: { ...selector, provider: { ...selector.provider, baseUrl: identity.deployment },
      repository: { ...selector.repository, nameWithOwner: identity.repository } }, ref: ref?.trim(), subdir,
    // Display names, visibility, web links and discovered defaultBranch are metadata.
    // Clone protocol/locators and the resolved hosting binding select execution.
    comparison: [selector.provider.id, identity.kind, identity.deployment, identity.repository, selector.protocol,
      selector.protocol === 'ssh' ? null : locator(selector.repository.cloneUrl),
      selector.protocol === 'https' ? null : locator(selector.repository.sshUrl), ref?.trim() ?? null, subdir ?? null] };
}

/** Source owns effective selection admission; its existing authenticated reader owns visibility. */
export async function admitProjectSourceSelectionV1(input: Readonly<{
  serverId: string; sourceId: string; captured: ProjectSourceSelectionV1; ref?: string; subdir?: string; signal?: AbortSignal;
  readSource(input: ProjectSourcesReadInputV1): Promise<ProjectSourcesReadOutputV1 | Readonly<{ ok: false; errorCode: string }>>;
}>): Promise<ProjectSourceAdmissionV1> {
  input.signal?.throwIfAborted();
  const current = await input.readSource(ProjectSourcesReadInputV1Schema.parse({ serverId: input.serverId, sourceId: input.sourceId }));
  input.signal?.throwIfAborted();
  if (!current.ok) return { kind: 'refused', code: 'error' in current ? current.error : current.errorCode };
  if (current.source.id !== input.sourceId) return { kind: 'refused', code: 'source_invalid' };
  try {
    const captured = effectiveSourceSelection(input.captured, input);
    const fresh = effectiveSourceSelection({ selector: current.source.repository,
      defaultRef: current.source.defaultRef, subdir: current.source.subdir }, input);
    if (JSON.stringify(captured.comparison) !== JSON.stringify(fresh.comparison)) return { kind: 'refused', code: 'source_selection_changed' };
    return { kind: 'admitted', selector: captured.selector, ref: captured.ref, subdir: captured.subdir, sourceRevision: current.source.revision };
  } catch { return { kind: 'refused', code: 'source_invalid' }; }
}
