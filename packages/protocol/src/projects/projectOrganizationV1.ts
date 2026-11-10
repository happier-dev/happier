import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { isActionOutcomeUnknownErrorCodeV1 } from '../actions/actionExecutionResult.js';
import { QualifiedProjectKeyV1Schema } from '../workspaces/workspaceRefV1.js';
import { EnvVarRequirementSchema } from '../profiles/environmentVariables.js';
import { SavedSecretReferenceV1Schema } from '../profiles/secretReferenceOverlayV1.js';
import { ProjectAccountOrganizationV1Schema, ProjectAccountRowExpectedRevisionV1Schema } from './projectAccountRowsV1.js';
import type { ProjectContextActionOwnerDepsV1 } from './projectContextV1.js';

export const ProjectOrganizationUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({
  projectRef: QualifiedProjectKeyV1Schema,
  expectedRevision: ProjectAccountRowExpectedRevisionV1Schema,
  label: z.optional(z.nullable(z.nonoptional(ProjectAccountOrganizationV1Schema.shape.label))),
  environmentBinding: z.optional(z.strictObject({
    name: EnvVarRequirementSchema.shape.name,
    reference: z.nullable(SavedSecretReferenceV1Schema),
  })),
}).check(z.refine(input => input.label !== undefined || input.environmentBinding !== undefined,
  'Provide a label or an environment binding edit')));
export type ProjectOrganizationUpdateInputV1 = z.infer<typeof ProjectOrganizationUpdateInputV1Schema>;

export const ProjectOrganizationUpdateOutputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), row: ProjectAccountOrganizationV1Schema,
    revision: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)) }),
  z.strictObject({ ok: z.literal(false), errorCode: z.enum(['invalid_parameters', 'project_organization_conflict',
    'project_organization_access_denied', 'project_organization_unavailable']),
    currentRevision: z.optional(ProjectAccountRowExpectedRevisionV1Schema) }),
]));
export type ProjectOrganizationUpdateOutputV1 = z.infer<typeof ProjectOrganizationUpdateOutputV1Schema>;

/** Private Project metadata and reference-only bindings share the existing organization row and CAS. */
export async function updateProjectOrganizationV1(
  deps: Pick<ProjectContextActionOwnerDepsV1, 'accountScope' | 'mutateOrganization'>,
  input: ProjectOrganizationUpdateInputV1,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<ProjectOrganizationUpdateOutputV1> {
  options?.signal?.throwIfAborted();
  const parsed = ProjectOrganizationUpdateInputV1Schema.safeParse(input);
  if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters' };
  const request = parsed.data;
  const scope = deps.accountScope();
  if (!scope || scope.serverId !== request.projectRef.serverId) return { ok: false, errorCode: 'project_organization_access_denied' };
  const assertCurrent = () => {
    options?.signal?.throwIfAborted();
    const current = deps.accountScope();
    if (!current || current.serverId !== scope.serverId || current.accountId !== scope.accountId) {
      throw Object.assign(new Error('Project organization Account scope changed'), { code: 'project_organization_access_denied' });
    }
  };
  try {
    assertCurrent();
    const result = await deps.mutateOrganization({ ...request.projectRef, expectedRevision: request.expectedRevision,
      signal: options?.signal, mutate(value) {
        assertCurrent();
        const next = { ...value };
        if (request.label !== undefined) {
          if (request.label === null) delete next.label;
          else next.label = request.label;
        }
        if (request.environmentBinding) {
          const { name, reference } = request.environmentBinding;
          const bindings = { ...next.environmentBindings?.bindings };
          if (reference === null) delete bindings[name];
          else bindings[name] = reference;
          if (Object.keys(bindings).length === 0) delete next.environmentBindings;
          else next.environmentBindings = { v: 1, bindings };
        }
        return next;
      } });
    if (result.status === 'conflict') return { ok: false, errorCode: 'project_organization_conflict',
      currentRevision: result.revision < 0 ? 'absent' : result.revision };
    // A validated receipt belongs to this captured write even after focus changes.
    return { ok: true, row: result.value, revision: result.revision };
  } catch (error) {
    const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    if (isActionOutcomeUnknownErrorCodeV1(code)) throw error;
    options?.signal?.throwIfAborted();
    return { ok: false, errorCode: code === 'project_organization_access_denied'
      ? 'project_organization_access_denied' : 'project_organization_unavailable' };
  }
}
