import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ProjectSourceIdentityV1Schema, type ProjectSourceIdentityV1 } from './sources/projectSourceIdentityV1.js';
import type { ProjectSessionDefaultsContextSelectionV1 } from './projectSessionDefaultsSelectionV1.js';
export { ProjectSessionDefaultsContextSelectionV1Schema, type ProjectSessionDefaultsContextSelectionV1 } from './projectSessionDefaultsSelectionV1.js';
import { ProjectSessionDefaultsLeafV1Schema } from './projectSessionDefaultsStorageV1.js';
import { ManagedSessionDefaultsContextV1Schema, buildManagedSessionDefaultsContext, resolveManagedSessionDefaultsTeamId,
  type ManagedSessionDefaultsContext, type ManagedSessionDefaultsV1, type ManagedDefaultsV1 } from '../teams/managedDefaults.js';
import { ActionExecuteFailureSchema, createActionExecuteFailureError } from '../actions/actionExecutionResult.js';

export { ProjectSessionDefaultsGetInputV1Schema, type ProjectSessionDefaultsGetInputV1 } from './projectSessionDefaultsSelectionV1.js';

export const ProjectSessionDefaultsRowV1Schema = lazyZodSchema(() => ProjectSessionDefaultsLeafV1Schema);
export type ProjectSessionDefaultsRowV1 = z.infer<typeof ProjectSessionDefaultsRowV1Schema>;
export const ProjectSessionDefaultsGetOutputV1Schema = lazyZodSchema(() => z.strictObject({
  context: ManagedSessionDefaultsContextV1Schema,
  personalDefaultsRow: z.nullable(ProjectSessionDefaultsRowV1Schema),
  sourceDefaultsRow: z.nullable(ProjectSessionDefaultsRowV1Schema),
  source: z.nullable(ProjectSourceIdentityV1Schema),
  canManageSource: z.boolean(),
  repairRequired: z.boolean(),
  teamName: z.optional(z.string()),
}));
export type ProjectSessionDefaultsGetOutputV1 = z.infer<typeof ProjectSessionDefaultsGetOutputV1Schema>;

type TeamRead = Readonly<{ id: string; name?: string; policy: Readonly<{
  managedDefaults?: ManagedDefaultsV1 | null; homeDefaults?: ManagedSessionDefaultsV1 | null;
  managedDefaultsStatus?: 'available' | 'repair_required';
}>; managedDefaultsGroupIds?: readonly string[] }>;
type SourceRead = Readonly<{ ok: true; source: ProjectSourceIdentityV1; canManage: boolean; canManageSessionDefaults?: boolean;
  sessionDefaults?: ProjectSessionDefaultsRowV1 }>
  | Readonly<{ ok: false; error: string }>;
export type ManagedSessionDefaultsContextLoaderV1 = Readonly<{
  readPersonalDefaults(project: NonNullable<ProjectSessionDefaultsContextSelectionV1['projectRef']>): Promise<ProjectSessionDefaultsRowV1 | null>;
  readSource(source: NonNullable<ProjectSessionDefaultsContextSelectionV1['sourceRef']>): Promise<SourceRead | z.infer<typeof ActionExecuteFailureSchema>>;
  readTeam(teamId: string): Promise<TeamRead | z.infer<typeof ActionExecuteFailureSchema>>;
  readHome(): Promise<Readonly<{ homeDefaults: ManagedSessionDefaultsV1 | null }>>;
}>;

/** One demanded read per selected record. Adapters own transport/admission;
 * the shared builder owns Team selection and every defaults layer. */
export async function loadManagedSessionDefaultsContextV1(input: ProjectSessionDefaultsContextSelectionV1 & Readonly<{
  primaryTeamId?: string | null; sharedTeamIds?: readonly string[];
  memberDefaults?: ManagedSessionDefaultsV1 | null;
  policyDefaults?: ManagedSessionDefaultsContext['policyDefaults'];
  creationMachineApprovalProfileId?: string | null;
}>, deps: ManagedSessionDefaultsContextLoaderV1): Promise<ProjectSessionDefaultsGetOutputV1> {
  const [personalDefaultsRow, sourceRead] = await Promise.all([
    input.projectRef ? deps.readPersonalDefaults(input.projectRef) : null,
    input.sourceRef ? deps.readSource(input.sourceRef) : null,
  ]);
  if (sourceRead && !sourceRead.ok) {
    const failure = ActionExecuteFailureSchema.safeParse(sourceRead);
    throw createActionExecuteFailureError(failure.success ? failure.data
      : { ok: false, errorCode: sourceRead.error, error: sourceRead.error, effectAttempted: false });
  }
  const source = sourceRead ? { id: sourceRead.source.id, revision: sourceRead.source.revision, name: sourceRead.source.name,
    ...(sourceRead.source.owner ? { owner: sourceRead.source.owner } : {}) } : null;
  const sourceDefaultsRow = sourceRead?.sessionDefaults ?? null;
  const projectSourceDefaults = source?.owner ? {
    sourceId: source.id, owner: source.owner, defaults: sourceDefaultsRow?.defaults ?? null,
  } : null;
  const primaryTeamId = resolveManagedSessionDefaultsTeamId({ primaryTeamId: input.primaryTeamId,
    sharedTeamIds: input.sharedTeamIds, projectSourceDefaults });
  const teamRead = primaryTeamId ? await deps.readTeam(primaryTeamId) : null;
  const teamFailure = teamRead && 'ok' in teamRead ? teamRead : null;
  // The Team reader hides inaccessible and absent Teams with this same typed
  // result. Source admission independently permits its project defaults layer.
  if (teamFailure && !(source && teamFailure.errorCode === 'team_not_found')) {
    throw createActionExecuteFailureError(teamFailure);
  }
  const team = teamRead && !('ok' in teamRead) ? teamRead : null;
  const home = team ? null : await deps.readHome();
  const context = buildManagedSessionDefaultsContext({ team: team ?? undefined, home: home?.homeDefaults,
    policy: input.policyDefaults, memberDefaults: input.memberDefaults,
    creationMachineApprovalProfileId: input.creationMachineApprovalProfileId,
    personalDefaultsRow: personalDefaultsRow?.defaults ?? null, projectSourceDefaults,
    primaryTeamId, sharedTeamIds: input.sharedTeamIds });
  return { context, personalDefaultsRow, sourceDefaultsRow, source,
    // The Source owner decides defaults authority once; metadata management (audience admins) never implies it.
    canManageSource: sourceRead?.canManageSessionDefaults === true,
    repairRequired: team?.policy.managedDefaultsStatus === 'repair_required',
    ...(team?.name ? { teamName: team.name } : {}),
  };
}
