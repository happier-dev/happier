import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { isActionOutcomeUnknownErrorCodeV1 } from '../actions/actionExecutionResult.js';
import { QualifiedProjectKeyV1Schema } from '../workspaces/workspaceRefV1.js';
import { EnvVarRequirementSchema } from '../profiles/environmentVariables.js';
import { SavedSecretReferenceV1Schema } from '../profiles/secretReferenceOverlayV1.js';
import { ProjectAccountOrganizationActionViewV1Schema, ProjectAccountOrganizationV1Schema, ProjectAccountRowExpectedRevisionV1Schema, projectProjectAccountOrganizationActionViewV1 } from './projectAccountRowsV1.js';
import { captureProjectContextAccountScopeV1, type ProjectContextActionOwnerDepsV1 } from './projectContextV1.js';
import type { ProjectSessionDefaultsV1 } from './projectSessionDefaultsV1.js';
import { ProjectSessionDefaultsPatchV1Schema, ProjectSessionDefaultsLeafV1Schema } from './projectSessionDefaultsStorageV1.js';

export type ProjectOrganizationUpdateDepsV1 = Pick<ProjectContextActionOwnerDepsV1,
  'accountScope' | 'normalizeServerId' | 'mutateOrganization'> & Readonly<{
  mutateSessionDefaults?: (input: Readonly<{ serverId: string; projectKey: string;
    expectedRevision: number | 'absent'; defaults: ProjectSessionDefaultsV1 | null; signal?: AbortSignal }>) => Promise<
      Readonly<{ status: 'updated'; revision: number; value: ProjectSessionDefaultsV1 | null }>
      | Readonly<{ status: 'conflict'; revision: number }>>;
}>;

export const ProjectOrganizationUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({
  projectRef: QualifiedProjectKeyV1Schema,
  expectedRevision: ProjectAccountRowExpectedRevisionV1Schema,
  sessionDefaults: z.optional(ProjectSessionDefaultsPatchV1Schema),
  label: z.optional(z.nullable(z.nonoptional(ProjectAccountOrganizationV1Schema.shape.label))),
  environmentBinding: z.optional(z.strictObject({
    name: EnvVarRequirementSchema.shape.name,
    reference: z.nullable(SavedSecretReferenceV1Schema),
  })),
}).check(z.refine(input => input.sessionDefaults !== undefined
  ? input.label === undefined && input.environmentBinding === undefined
  : input.label !== undefined || input.environmentBinding !== undefined,
  'Provide one project metadata or Session defaults edit')));
export type ProjectOrganizationUpdateInputV1 = z.infer<typeof ProjectOrganizationUpdateInputV1Schema>;

export const ProjectOrganizationUpdateOutputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), row: ProjectAccountOrganizationActionViewV1Schema,
    revision: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)) }),
  z.strictObject({ ok: z.literal(true), sessionDefaults: ProjectSessionDefaultsLeafV1Schema }),
  z.strictObject({ ok: z.literal(false), errorCode: z.enum(['invalid_parameters', 'project_organization_conflict',
    'project_organization_access_denied', 'project_organization_unavailable']),
    currentRevision: z.optional(ProjectAccountRowExpectedRevisionV1Schema) }),
]));
export type ProjectOrganizationUpdateOutputV1 = z.infer<typeof ProjectOrganizationUpdateOutputV1Schema>;

/** Private metadata uses the organization CAS. Session defaults use their own leaf and revision. */
export async function updateProjectOrganizationV1(
  deps: ProjectOrganizationUpdateDepsV1,
  input: ProjectOrganizationUpdateInputV1,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<ProjectOrganizationUpdateOutputV1> {
  options?.signal?.throwIfAborted();
  const parsed = ProjectOrganizationUpdateInputV1Schema.safeParse(input);
  if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters' };
  const request = parsed.data;
  const scope = captureProjectContextAccountScopeV1(deps, request.projectRef.serverId);
  if (!scope) return { ok: false, errorCode: 'project_organization_access_denied' };
  const assertCurrent = () => {
    options?.signal?.throwIfAborted();
    const current = deps.accountScope();
    if (!current || current.serverId !== scope.serverId || current.accountId !== scope.accountId) {
      throw Object.assign(new Error('Project organization Account scope changed'), { code: 'project_organization_access_denied' });
    }
  };
  try {
    assertCurrent();
    if (request.sessionDefaults !== undefined) {
      if (!deps.mutateSessionDefaults) return { ok: false, errorCode: 'project_organization_unavailable' };
      const result = await deps.mutateSessionDefaults({ ...request.projectRef, ...request.sessionDefaults,
        signal: options?.signal });
      if (result.status === 'conflict') return { ok: false, errorCode: 'project_organization_conflict',
        currentRevision: result.revision < 0 ? 'absent' : result.revision };
      return { ok: true, sessionDefaults: { revision: result.revision, defaults: result.value } };
    }
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
    return { ok: true, row: projectProjectAccountOrganizationActionViewV1(result.value), revision: result.revision };
  } catch (error) {
    const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    if (isActionOutcomeUnknownErrorCodeV1(code)) throw error;
    options?.signal?.throwIfAborted();
    return { ok: false, errorCode: code === 'project_organization_access_denied'
      ? 'project_organization_access_denied' : 'project_organization_unavailable' };
  }
}
