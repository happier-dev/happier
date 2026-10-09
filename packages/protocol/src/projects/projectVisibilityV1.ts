import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ProjectAccountOrganizationV1Schema, ProjectAccountRowExpectedRevisionV1Schema } from './projectAccountRowsV1.js';
import { ProjectContextTargetV1Schema, type ProjectContextActionOwnerDepsV1 } from './projectContextV1.js';

export const ProjectVisibilitySetInputV1Schema = lazyZodSchema(() => z.object({
  target: ProjectContextTargetV1Schema,
  expectedRevision: ProjectAccountRowExpectedRevisionV1Schema,
  hidden: z.boolean(),
}).strict());
export type ProjectVisibilitySetInputV1 = z.infer<typeof ProjectVisibilitySetInputV1Schema>;
export const ProjectVisibilitySetOutputV1Schema = lazyZodSchema(() => z.union([
  z.object({ ok: z.literal(true), row: ProjectAccountOrganizationV1Schema, revision: z.number().int().nonnegative() }).strict(),
  z.object({ ok: z.literal(false), errorCode: z.enum(['invalid_parameters', 'project_visibility_conflict',
    'project_visibility_access_denied', 'project_visibility_unavailable']),
    currentRevision: z.optional(ProjectAccountRowExpectedRevisionV1Schema) }).strict(),
]));
export type ProjectVisibilitySetOutputV1 = z.infer<typeof ProjectVisibilitySetOutputV1Schema>;

/** Hide, Show and Undo are one field intent on the existing anchored organization row. */
export async function setProjectVisibilityV1(
  deps: Pick<ProjectContextActionOwnerDepsV1, 'accountScope' | 'mutateOrganization'>,
  input: ProjectVisibilitySetInputV1,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<ProjectVisibilitySetOutputV1> {
  options?.signal?.throwIfAborted();
  const request = ProjectVisibilitySetInputV1Schema.safeParse(input);
  if (!request.success) return { ok: false, errorCode: 'invalid_parameters' };
  const scope = deps.accountScope();
  if (!scope || scope.serverId !== request.data.target.serverId) return { ok: false, errorCode: 'project_visibility_access_denied' };
  const assertCurrent = () => {
    options?.signal?.throwIfAborted();
    const current = deps.accountScope();
    if (!current || current.serverId !== scope.serverId || current.accountId !== scope.accountId) {
      throw Object.assign(new Error('Project visibility Account scope changed'), { code: 'project_visibility_access_denied' });
    }
  };
  try {
    assertCurrent();
    const result = await deps.mutateOrganization({ ...request.data.target, expectedRevision: request.data.expectedRevision,
      signal: options?.signal, mutate(value) { assertCurrent(); return { ...value, hidden: request.data.hidden }; } });
    if (result.status === 'conflict') return { ok: false, errorCode: 'project_visibility_conflict',
      currentRevision: result.revision < 0 ? 'absent' : result.revision };
    return { ok: true, row: result.value, revision: result.revision };
  } catch (error) {
    options?.signal?.throwIfAborted();
    return { ok: false, errorCode: error instanceof Error && 'code' in error && error.code === 'project_visibility_access_denied'
      ? 'project_visibility_access_denied' : 'project_visibility_unavailable' };
  }
}
