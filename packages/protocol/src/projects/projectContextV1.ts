import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PromptStackEntryV1Schema, type PromptStackEntryV1 } from '../prompts/library/promptStacksV1.js';
import { ProjectAccountOrganizationKeyV1Schema, ProjectAccountOrganizationV1Schema, ProjectAccountRowExpectedRevisionV1Schema, type ProjectAccountOrganizationV1 } from './projectAccountRowsV1.js';
import type { PromptLibraryStoredArtifact } from '../prompts/library/promptLibraryActionOperations.js';
import { PromptArtifactRefV1Schema, type PromptArtifactRefV1 } from '../prompts/library/promptArtifactRefsV1.js';
import { getArtifactUseTargetV1 } from '../artifacts/artifactSharingV1.js';

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

export type ProjectContextMutationV1<Row> =
  | Readonly<{ ok: true; row: Row; changed: boolean }>
  | Readonly<{ ok: false; errorCode: 'entry_conflict' | 'entry_not_found' | 'invalid_parameters' }>;

export function applyProjectContextIntentV1<Row extends Readonly<{ promptStack?: readonly PromptStackEntryV1[] }>>(
  row: Row,
  intent: ProjectContextIntentV1,
): ProjectContextMutationV1<Row> {
  const entries = row.promptStack ?? [];
  const entryId = intent.kind === 'attach' ? intent.entry.id : intent.entryId;
  const index = entries.findIndex((entry) => entry.id === entryId);
  let next: readonly PromptStackEntryV1[];
  if (intent.kind === 'attach') {
    if (index >= 0) {
      const existing = entries[index]!;
      const candidate = PromptStackEntryV1Schema.parse(intent.entry);
      const same = JSON.stringify(PromptStackEntryV1Schema.parse(existing)) === JSON.stringify(candidate);
      return same ? { ok: true, row, changed: false } : { ok: false, errorCode: 'entry_conflict' };
    }
    next = [...entries, PromptStackEntryV1Schema.parse(intent.entry)];
  } else if (intent.kind === 'detach') {
    if (index < 0) return { ok: true, row, changed: false };
    next = entries.filter((entry) => entry.id !== entryId);
  } else {
    if (index < 0) return { ok: false, errorCode: 'entry_not_found' };
    const selected = entries[index]!;
    if (intent.kind === 'set_budget') {
      if ((selected.maxChars ?? null) === intent.maxChars) return { ok: true, row, changed: false };
      const { maxChars: _previous, ...withoutBudget } = selected;
      const replacement = intent.maxChars === null ? withoutBudget : { ...withoutBudget, maxChars: intent.maxChars };
      next = entries.map((entry, entryIndex) => entryIndex === index ? replacement : entry);
    } else {
      if (intent.siblingId === entryId) return { ok: false, errorCode: 'invalid_parameters' };
      const remaining = entries.filter((entry) => entry.id !== entryId);
      const siblingIndex = remaining.findIndex((entry) => entry.id === intent.siblingId);
      if (siblingIndex < 0) return { ok: false, errorCode: 'entry_not_found' };
      const position = siblingIndex + (intent.position === 'after' ? 1 : 0);
      next = [...remaining.slice(0, position), selected, ...remaining.slice(position)];
      if (next.every((entry, entryIndex) => entry === entries[entryIndex])) return { ok: true, row, changed: false };
    }
  }
  return { ok: true, row: { ...row, promptStack: next }, changed: true };
}
