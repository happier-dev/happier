import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { ScmCredentialFreeRepositorySelectorV1Schema, ScmRepositoryContainedSubdirV1Schema } from '../../scm/repositoryClone.js';
import { AccountPrincipalRefV1Schema, PrincipalRefV1Schema, TeamPrincipalRefV1Schema } from '../../teams/principal.js';
import { PromptArtifactRefV1Schema } from '../../prompts/library/promptArtifactRefsV1.js';
import { PromptStackEntryV1Schema, PromptStackEntryAuthoringV1Schema, PromptStackSetEnabledIntentV1Schema } from '../../prompts/library/promptStacksV1.js';
import { readScmHostingRepositoryIdentity } from '../../scm/hostingRepositoryIdentity.js';
import { ActionOperationIdentifierV1Schema } from '../../actions/operations/identifierV1.js';

export const PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 = 'projects:sources' as const;

export const ProjectSourceRepositorySelectorV1Schema = ScmCredentialFreeRepositorySelectorV1Schema;
export type ProjectSourceRepositorySelectorV1 = z.infer<typeof ProjectSourceRepositorySelectorV1Schema>;
export const ProjectSourceOwnerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  AccountPrincipalRefV1Schema, TeamPrincipalRefV1Schema,
]));
// Unlike presentation extras, an ambiguous persisted owner cannot be dropped into validity.
defineStoredReadProjection(ProjectSourceOwnerV1Schema, () => ProjectSourceOwnerV1Schema);
export type ProjectSourceOwnerV1 = z.infer<typeof ProjectSourceOwnerV1Schema>;
export const ProjectSourceGrantV1Schema = lazyZodSchema(() => z.strictObject({ principal: PrincipalRefV1Schema, level: z.literal('view') }));
export type ProjectSourceGrantV1 = z.infer<typeof ProjectSourceGrantV1Schema>;
export const SourceAttachmentV1Schema = lazyZodSchema(() => z.discriminatedUnion('purpose', [
  z.strictObject({ purpose: z.literal('context'), entry: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PromptStackEntryV1Schema, { ref: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(PromptArtifactRefV1Schema) })) }),
  z.strictObject({ purpose: z.literal('dashboard'), ref: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(PromptArtifactRefV1Schema) }),
]));
export type SourceAttachmentV1 = z.infer<typeof SourceAttachmentV1Schema>;
const SourceAttachmentAuthoringV1Schema = lazyZodSchema(() => z.discriminatedUnion('purpose', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SourceAttachmentV1Schema._zod.def.options[0], { entry: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PromptStackEntryAuthoringV1Schema, { ref: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(PromptArtifactRefV1Schema) })) })),
  SourceAttachmentV1Schema._zod.def.options[1],
]));
// Source folders use clone's containment admission, with one canonical root representation.
const ProjectSourceSubdirV1Schema = lazyZodSchema(() => z.pipe(z.union([
  z.string().check(z.trim(), z.length(0)), ScmRepositoryContainedSubdirV1Schema,
]), z.transform(value => value.replaceAll('\\', '/').split('/').filter(part => part && part !== '.').join('/') || undefined)));
export function normalizeProjectSourceSubdirV1(value: string | null | undefined): string | undefined {
  return value == null ? undefined : ProjectSourceSubdirV1Schema.parse(value);
}
export const ProjectSourceV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)), revision: z.number().check(z.int(), z.positive()), name: z.string().check(z.trim(), z.minLength(1)),
  repository: z.optional(ProjectSourceRepositorySelectorV1Schema),
  owner: z.optional(ProjectSourceOwnerV1Schema),
  defaultRef: z.optional(z.string().check(z.trim(), z.minLength(1))), subdir: z.optional(ProjectSourceSubdirV1Schema),
  audience: z.array(ProjectSourceGrantV1Schema), createdByAccountId: z.string().check(z.minLength(1)),
  attachments: z.optional(z.array(SourceAttachmentV1Schema)),
}));
export type ProjectSourceV1 = z.infer<typeof ProjectSourceV1Schema>;
export const ProjectSourceV1StoredSchema = createStoredReadSchema(ProjectSourceV1Schema);
const id = z.string().check(z.minLength(1));
const revision = z.number().check(z.int(), z.positive());
export const ProjectSourcesListInputV1Schema = lazyZodSchema(() => z.strictObject({ serverId: id, query: z.optional(z.string()), audience: z.optional(PrincipalRefV1Schema), cursor: z.optional(id), limit: z.optional(z.number().check(z.int(), z.positive())) }));
export const ProjectSourcesReadInputV1Schema = lazyZodSchema(() => z.strictObject({ serverId: id, sourceId: id }));
export const ProjectSourcesCreateInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.pick(ProjectSourceV1Schema, { name: true, repository: true, owner: true, defaultRef: true, subdir: true }), { serverId: id, requestKey: id, audience: z.optional(z.array(ProjectSourceGrantV1Schema)) })));
export const ProjectSourceAttachmentIntentV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('attach'), attachment: SourceAttachmentAuthoringV1Schema }),
  z.strictObject({ kind: z.literal('detach'), purpose: z.literal('context'), attachmentId: id }),
  z.strictObject({ kind: z.literal('detach'), purpose: z.literal('dashboard'), ref: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(PromptArtifactRefV1Schema) }),
  z.strictObject({ kind: z.literal('reorder'), attachmentId: id, beforeId: z.nullable(id) }),
  z.strictObject({ kind: z.literal('budget'), attachmentId: id, maxChars: z.nullable(z.number().check(z.int(), z.positive())) }),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(PromptStackSetEnabledIntentV1Schema, { entryId: true }), { attachmentId: id })),
]));
export type ProjectSourceAttachmentIntentV1 = z.infer<typeof ProjectSourceAttachmentIntentV1Schema>;
export const ProjectSourcePatchV1Schema = lazyZodSchema(() => z.strictObject({
  name: z.optional(ProjectSourceV1Schema.shape.name), repository: z.optional(z.nullable(ProjectSourceRepositorySelectorV1Schema)),
  owner: z.optional(ProjectSourceOwnerV1Schema),
  defaultRef: z.optional(z.nullable(ProjectSourceV1Schema.shape.defaultRef._zod.def.innerType)),
  subdir: z.optional(z.pipe(z.nullable(ProjectSourceV1Schema.shape.subdir._zod.def.innerType), z.transform(value => value ?? null))),
  audience: z.optional(z.array(ProjectSourceGrantV1Schema)), attachment: z.optional(ProjectSourceAttachmentIntentV1Schema),
}));
export const ProjectSourcesUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({ serverId: id, sourceId: id, expectedRevision: revision, patch: ProjectSourcePatchV1Schema }));
export const ProjectSourcesDeleteInputV1Schema = lazyZodSchema(() => z.strictObject({ serverId: id, sourceId: id, expectedRevision: revision }));
export const ProjectSourcesMoveToTeamInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: id, sourceId: id, expectedRevision: revision, teamId: id, requestKey: id,
}));
export const ProjectSourcesFailureV1Schema = lazyZodSchema(() => z.strictObject({ ok: z.literal(false), error: z.enum(['source_unavailable', 'source_access_denied', 'source_invalid', 'source_conflict', 'artifact_unavailable', 'artifact_wrong_kind', 'source_backend_unavailable']), current: z.optional(ProjectSourceV1Schema) }));
export type ProjectSourcesFailureV1 = z.infer<typeof ProjectSourcesFailureV1Schema>;
export const ProjectSourcesReadOutputV1Schema = lazyZodSchema(() => z.union([z.strictObject({ ok: z.literal(true), source: ProjectSourceV1Schema, canManage: z.boolean() }), ProjectSourcesFailureV1Schema]));
export const ProjectSourcesCreateOutputV1Schema = ProjectSourcesReadOutputV1Schema;
export const ProjectSourcesUpdateOutputV1Schema = ProjectSourcesReadOutputV1Schema;
export const ProjectSourcesDeleteOutputV1Schema = lazyZodSchema(() => z.union([z.strictObject({ ok: z.literal(true), sourceId: id, revision }), ProjectSourcesFailureV1Schema]));
export const ProjectSourcesListOutputV1Schema = lazyZodSchema(() => z.union([z.strictObject({ ok: z.literal(true), sources: z.array(ProjectSourceV1Schema), coverage: z.strictObject({ complete: z.boolean(), nextCursor: z.nullable(id) }) }), ProjectSourcesFailureV1Schema]));
// Existing Action-operation addresses are observations, never transfer custody.
const ProjectSourceMoveChildOperationV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: id, machineId: id, operationId: ActionOperationIdentifierV1Schema,
}));
export const ProjectSourcesMoveToTeamOutputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('completed'), source: z.extend(ProjectSourceV1Schema, { owner: TeamPrincipalRefV1Schema }),
    childOperations: z.array(ProjectSourceMoveChildOperationV1Schema) }),
  z.strictObject({ kind: z.enum(['held', 'partial', 'outcome_unknown']), source: z.optional(ProjectSourceV1Schema),
    childOperations: z.array(ProjectSourceMoveChildOperationV1Schema) }),
  ProjectSourcesFailureV1Schema,
]));
export type ProjectSourcesListInputV1 = z.infer<typeof ProjectSourcesListInputV1Schema>;
export type ProjectSourcesReadInputV1 = z.infer<typeof ProjectSourcesReadInputV1Schema>;
export type ProjectSourcesCreateInputV1 = z.infer<typeof ProjectSourcesCreateInputV1Schema>;
export type ProjectSourcesUpdateInputV1 = z.infer<typeof ProjectSourcesUpdateInputV1Schema>;
export type ProjectSourcesDeleteInputV1 = z.infer<typeof ProjectSourcesDeleteInputV1Schema>;
export type ProjectSourcesMoveToTeamInputV1 = z.infer<typeof ProjectSourcesMoveToTeamInputV1Schema>;
export type ProjectSourcesListOutputV1 = z.infer<typeof ProjectSourcesListOutputV1Schema>;
export type ProjectSourcesReadOutputV1 = z.infer<typeof ProjectSourcesReadOutputV1Schema>;
export type ProjectSourcesCreateOutputV1 = z.infer<typeof ProjectSourcesCreateOutputV1Schema>;
export type ProjectSourcesUpdateOutputV1 = z.infer<typeof ProjectSourcesUpdateOutputV1Schema>;
export type ProjectSourcesDeleteOutputV1 = z.infer<typeof ProjectSourcesDeleteOutputV1Schema>;
export type ProjectSourcesMoveToTeamOutputV1 = z.infer<typeof ProjectSourcesMoveToTeamOutputV1Schema>;

export type ProjectSourceSelectionV1 = Readonly<{
  selector?: ProjectSourceRepositorySelectorV1;
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

/** Execution identity excludes Source display metadata and CAS revisions. */
export function projectProjectSourceSelectionSemanticInputV1(selection: ProjectSourceSelectionV1) {
  return effectiveSourceSelection(selection, {}).comparison;
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
  if (current.source.repository === undefined) return { kind: 'refused', code: 'needs_repository' };
  if (input.captured.selector === undefined) return { kind: 'refused', code: 'source_selection_changed' };
  try {
    const captured = effectiveSourceSelection(input.captured, input);
    const fresh = effectiveSourceSelection({ selector: current.source.repository,
      defaultRef: current.source.defaultRef, subdir: current.source.subdir }, input);
    if (JSON.stringify(captured.comparison) !== JSON.stringify(fresh.comparison)) return { kind: 'refused', code: 'source_selection_changed' };
    return { kind: 'admitted', selector: captured.selector, ref: captured.ref, subdir: captured.subdir, sourceRevision: current.source.revision };
  } catch { return { kind: 'refused', code: 'source_invalid' }; }
}
