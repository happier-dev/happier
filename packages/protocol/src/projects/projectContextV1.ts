import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PromptStackEntryV1Schema, PromptStackSetEnabledIntentV1Schema, applyPromptStackIntentV1, type PromptStackEntryV1, type PromptStackMutationV1 } from '../prompts/library/promptStacksV1.js';
import { ProjectAccountOrganizationKeyV1Schema, ProjectAccountOrganizationV1Schema, ProjectAccountRowExpectedRevisionV1Schema, type ProjectAccountOrganizationV1 } from './projectAccountRowsV1.js';
import type { PromptLibraryStoredArtifact } from '../prompts/library/promptLibraryActionOperations.js';
import { PromptArtifactRefV1Schema, type PromptArtifactRefV1 } from '../prompts/library/promptArtifactRefsV1.js';
import { getArtifactUseTargetV1 } from '../artifacts/artifactSharingV1.js';
import { resolveProjectContextSourceV1 } from './projectListProjectionV1.js';
import type { QualifiedProjectKeyV1, WorkspaceRefV1 } from '../workspaces/workspaceRefV1.js';
import { ProjectSourcesReadOutputV1Schema, ProjectSourcesUpdateOutputV1Schema,
  type ProjectSourcesReadInputV1, type ProjectSourcesUpdateInputV1 } from './sources/projectSourceV1.js';

export const ProjectContextTargetV1Schema = lazyZodSchema(() => z.object({
  serverId: ProjectAccountOrganizationKeyV1Schema.shape.serverId,
  projectKey: ProjectAccountOrganizationKeyV1Schema.shape.projectKey,
}).strict());

// Admission is narrower than retained stacks: only newly attached entries must
// use system_append. Existing placement owners retain their established data.
const NewContextEntrySchema = lazyZodSchema(() => PromptStackEntryV1Schema.extend({
  ref: PromptArtifactRefV1Schema.strict(),
  placement: z.literal('system_append').default('system_append'),
}).strict());

export const ProjectContextIntentV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('attach'), entry: NewContextEntrySchema }).strict(),
  z.object({ kind: z.literal('detach'), entryId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('reorder'), entryId: z.string().min(1), siblingId: z.string().min(1), position: z.enum(['before', 'after']) }).strict(),
  z.object({ kind: z.literal('set_budget'), entryId: z.string().min(1), maxChars: z.number().int().positive().nullable() }).strict(),
  PromptStackSetEnabledIntentV1Schema,
]));
export type ProjectContextIntentV1 = z.infer<typeof ProjectContextIntentV1Schema>;

export const ProjectContextUpdateInputV1Schema = lazyZodSchema(() => z.object({
  target: ProjectContextTargetV1Schema,
  expectedRevision: ProjectAccountRowExpectedRevisionV1Schema,
  intent: ProjectContextIntentV1Schema,
}).strict());
export type ProjectContextUpdateInputV1 = z.infer<typeof ProjectContextUpdateInputV1Schema>;

export const ProjectContextUpdateOutputV1Schema = lazyZodSchema(() => z.union([
  z.object({ ok: z.literal(true), row: ProjectAccountOrganizationV1Schema, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ ok: z.literal(false), errorCode: z.enum(['invalid_parameters', 'entry_conflict', 'entry_not_found',
    'project_context_conflict', 'project_context_unavailable', 'project_context_access_denied', 'artifact_unavailable', 'artifact_wrong_kind']),
    currentRevision: z.optional(ProjectAccountRowExpectedRevisionV1Schema) }).strict(),
]));
export type ProjectContextUpdateOutputV1 = z.infer<typeof ProjectContextUpdateOutputV1Schema>;

/** The existing opened organization-row owner supplies CAS and Account-mode transport. */
export type ProjectContextActionOwnerDepsV1 = Readonly<{
  accountScope(): Readonly<{ serverId: string; accountId: string }> | null;
  readArtifact(ref: PromptArtifactRefV1, options?: Readonly<{ signal?: AbortSignal }>): Promise<PromptLibraryStoredArtifact | null>;
  mutateOrganization(input: Readonly<{
    serverId: string; projectKey: string; expectedRevision: number | 'absent'; signal?: AbortSignal;
    mutate(value: ProjectAccountOrganizationV1): ProjectAccountOrganizationV1;
  }>): Promise<Readonly<{ status: 'updated'; revision: number; value: ProjectAccountOrganizationV1 }> | Readonly<{ status: 'conflict'; revision: number }>>;
}>;

export async function updatePersonalProjectContextV1(
  deps: ProjectContextActionOwnerDepsV1,
  input: ProjectContextUpdateInputV1,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<ProjectContextUpdateOutputV1> {
  options?.signal?.throwIfAborted();
  const parsed = ProjectContextUpdateInputV1Schema.safeParse(input);
  if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters' };
  const request = parsed.data;
  const scope = deps.accountScope();
  if (!scope || scope.serverId !== request.target.serverId) return { ok: false, errorCode: 'project_context_access_denied' };
  const assertCurrent = () => {
    options?.signal?.throwIfAborted();
    const current = deps.accountScope();
    if (!current || current.accountId !== scope.accountId || current.serverId !== scope.serverId) {
      throw Object.assign(new Error('Project context Account scope changed'), { code: 'project_context_access_denied' });
    }
  };
  if (request.intent.kind === 'attach') {
    let artifact: PromptLibraryStoredArtifact | null;
    try { artifact = await deps.readArtifact(request.intent.entry.ref, options); }
    catch { options?.signal?.throwIfAborted(); return { ok: false, errorCode: 'artifact_unavailable' }; }
    try { assertCurrent(); } catch { options?.signal?.throwIfAborted(); return { ok: false, errorCode: 'project_context_access_denied' }; }
    if (!artifact || artifact.id !== request.intent.entry.ref.artifactId || !artifact.header) return { ok: false, errorCode: 'artifact_unavailable' };
    const use = getArtifactUseTargetV1({ artifactId: artifact.id, header: artifact.header, body: artifact.body });
    const accepts = request.intent.entry.ref.kind === 'bundle'
      ? use.kind === 'prompt_bundle'
      : artifact.header.kind === 'prompt_doc.v2' || artifact.header.kind === 'memory_doc.v1';
    // The real store already admitted the read. Public sharing policy is neither
    // read authority nor permission to reference this content in a private stack.
    if (!accepts) return { ok: false, errorCode: 'artifact_wrong_kind' };
  }
  try {
    assertCurrent();
    const result = await deps.mutateOrganization({ ...request.target, expectedRevision: request.expectedRevision,
      ...(options?.signal ? { signal: options.signal } : {}),
      mutate(value) {
        assertCurrent();
        const applied = applyProjectContextIntentV1(value, request.intent);
        if (!applied.ok) throw Object.assign(new Error(applied.errorCode), { code: applied.errorCode });
        return ProjectAccountOrganizationV1Schema.parse(applied.row);
      },
    });
    // A captured invoker's acknowledged write stays true even if the focused
    // Account retires while the external mutation returns its effect receipt.
    if (result.status === 'conflict') return { ok: false, errorCode: 'project_context_conflict',
      currentRevision: result.revision < 0 ? 'absent' : result.revision };
    return { ok: true, row: result.value, revision: result.revision };
  } catch (error) {
    options?.signal?.throwIfAborted();
    const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    if (code === 'entry_conflict' || code === 'entry_not_found' || code === 'invalid_parameters' || code === 'project_context_access_denied') {
      return { ok: false, errorCode: code };
    }
    return { ok: false, errorCode: 'project_context_unavailable' };
  }
}

export type ProjectContextMutationV1<Row> = PromptStackMutationV1<Row>;

export function applyProjectContextIntentV1<Row extends Readonly<{ promptStack?: readonly PromptStackEntryV1[] }>>(
  row: Row,
  intent: ProjectContextIntentV1,
): ProjectContextMutationV1<Row> {
  return applyPromptStackIntentV1(row, intent);
}

/** One captured context target for both hosts; existing personal/Source Actions remain the writers. */
export async function readProjectContextAttachmentTargetV1(deps: Readonly<{
  readRows(): Promise<Readonly<{ workspaceRefs: readonly WorkspaceRefV1[]; organizations: readonly Readonly<{
    key: QualifiedProjectKeyV1; revision: number; value: ProjectAccountOrganizationV1;
  }>[] }>>;
  readSource(input: ProjectSourcesReadInputV1): Promise<unknown>;
  updateSource(input: ProjectSourcesUpdateInputV1): Promise<unknown>;
  updatePersonalContext(input: ProjectContextUpdateInputV1): Promise<ProjectContextUpdateOutputV1>;
}>, target: QualifiedProjectKeyV1): Promise<Readonly<{
  entries: readonly PromptStackEntryV1[]; safety: 'safe' | 'danger'; attach(entry: PromptStackEntryV1): Promise<boolean>;
}>> {
  const rows = await deps.readRows();
  const organization = rows.organizations.find(row => row.key.serverId === target.serverId && row.key.projectKey === target.projectKey);
  const association = resolveProjectContextSourceV1({ projectRef: target, workspaceRefs: rows.workspaceRefs,
    organizationPresent: !!organization });
  const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
  if (association.kind === 'unavailable') return refuse('project_context_unavailable');
  const assertAssociation = async () => {
    const current = await deps.readRows();
    const resolved = resolveProjectContextSourceV1({ projectRef: target, workspaceRefs: current.workspaceRefs,
      organizationPresent: current.organizations.some(row => row.key.serverId === target.serverId && row.key.projectKey === target.projectKey) });
    if (resolved.kind !== association.kind || (resolved.kind === 'source' && association.kind === 'source' && resolved.sourceId !== association.sourceId)) {
      refuse('project_context_conflict');
    }
  };
  const qualify = (entries: readonly PromptStackEntryV1[]) => entries.map(entry => ({ ...entry,
    ref: { ...entry.ref, serverId: entry.ref.serverId ?? target.serverId } }));
  if (association.kind === 'source') {
    const result = ProjectSourcesReadOutputV1Schema.safeParse(await deps.readSource({ serverId: target.serverId, sourceId: association.sourceId }));
    if (!result.success || !result.data.ok || result.data.source.id !== association.sourceId) return refuse('project_context_unavailable');
    if (!result.data.canManage) return refuse('project_context_access_denied');
    const source = result.data.source;
    const entries = (source.attachments ?? []).flatMap(attachment => attachment.purpose === 'context' ? [attachment.entry] : []);
    return { safety: 'danger', entries: qualify(entries), attach: async entry => {
      await assertAssociation();
      const current = ProjectSourcesReadOutputV1Schema.safeParse(await deps.readSource({ serverId: target.serverId, sourceId: source.id }));
      if (!current.success || !current.data.ok || current.data.source.id !== source.id) return refuse('project_context_unavailable');
      if (!current.data.canManage) return refuse('project_context_access_denied');
      if (current.data.source.revision !== source.revision) return false;
      const written = ProjectSourcesUpdateOutputV1Schema.safeParse(await deps.updateSource({ serverId: target.serverId,
        sourceId: source.id, expectedRevision: source.revision, patch: { attachment: { kind: 'attach',
          attachment: { purpose: 'context', entry } } } }));
      if (!written.success) return refuse('project_context_unavailable');
      if (!written.data.ok) { if (written.data.error === 'source_conflict') return false; return refuse(written.data.error); }
      if (written.data.source.id !== source.id) return refuse('project_context_unavailable');
      return true;
    } };
  }
  return { safety: 'safe', entries: qualify(organization?.value.promptStack ?? []), attach: async entry => {
    await assertAssociation();
    const intent = ProjectContextIntentV1Schema.safeParse({ kind: 'attach', entry });
    if (!intent.success) return refuse('invalid_parameters');
    const result = await deps.updatePersonalContext({ target, expectedRevision: organization?.revision ?? 'absent',
      intent: intent.data });
    if (!result.ok) { if (result.errorCode === 'project_context_conflict' || result.errorCode === 'entry_conflict') return false; return refuse(result.errorCode); }
    return true;
  } };
}
