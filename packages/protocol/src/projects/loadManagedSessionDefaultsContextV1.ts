import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ProjectSourceIdentityV1Schema, type ProjectSourceIdentityV1 } from './sources/projectSourceIdentityV1.js';
import type { ProjectSessionDefaultsContextSelectionV1 } from './projectSessionDefaultsSelectionV1.js';
export { ProjectSessionDefaultsContextSelectionV1Schema, type ProjectSessionDefaultsContextSelectionV1 } from './projectSessionDefaultsSelectionV1.js';
import { ProjectSessionDefaultsLeafV1Schema } from './projectSessionDefaultsStorageV1.js';
import { ManagedSessionDefaultsContextV1Schema, buildManagedSessionDefaultsContext, resolveManagedSessionDefaultsTeamId,
  type ManagedSessionDefaultsContext, type ManagedSessionDefaultsV1, type ManagedDefaultsV1 } from '../teams/managedDefaults.js';
import { ActionExecuteFailureSchema, createActionExecuteFailureError, parseActionExecuteFailure, type ActionExecuteFailure } from '../actions/actionExecutionResult.js';

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
  unavailableDefaults: z.optional(z.array(ActionExecuteFailureSchema)),
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
  /** Absent when the invocation has no requester-private Account custody. */
  readPersonalDefaults?(project: NonNullable<ProjectSessionDefaultsContextSelectionV1['projectRef']>): Promise<ProjectSessionDefaultsRowV1 | null>;
  readSource(source: NonNullable<ProjectSessionDefaultsContextSelectionV1['sourceRef']>): Promise<SourceRead | z.infer<typeof ActionExecuteFailureSchema>>;
  readTeam?(teamId: string): Promise<TeamRead | z.infer<typeof ActionExecuteFailureSchema>>;
  readHome?(): Promise<Readonly<{ homeDefaults: ManagedSessionDefaultsV1 | null }>>;
}>;

/** One demanded read per selected record. Adapters own transport/admission;
 * the shared builder owns Team selection and every defaults layer. */
export async function loadManagedSessionDefaultsContextV1(input: ProjectSessionDefaultsContextSelectionV1 & Readonly<{
  primaryTeamId?: string | null; sharedTeamIds?: readonly string[];
  memberDefaults?: ManagedSessionDefaultsV1 | null;
  policyDefaults?: ManagedSessionDefaultsContext['policyDefaults'];
  creationMachineApprovalProfileId?: string | null;
}>, deps: ManagedSessionDefaultsContextLoaderV1): Promise<ProjectSessionDefaultsGetOutputV1> {
  const unavailableDefaults: ActionExecuteFailure[] = [];
  async function readOptional<T>(read: () => Promise<T>): Promise<T | null> {
    try { return await read(); }
    catch (error) {
      unavailableDefaults.push(parseActionExecuteFailure(error) ?? { ok: false, errorCode: 'defaults_unavailable',
        error: 'defaults_unavailable', effectAttempted: false });
      return null;
    }
  }
  const [personalDefaultsRow, sourceRead] = await Promise.all([
    input.projectRef && deps.readPersonalDefaults ? readOptional(() => deps.readPersonalDefaults!(input.projectRef!)) : null,
    input.sourceRef ? readOptional(async () => {
      const value = await deps.readSource(input.sourceRef!);
      if (!value.ok) {
        const failure = ActionExecuteFailureSchema.safeParse(value);
        throw createActionExecuteFailureError(failure.success ? failure.data
          : { ok: false, errorCode: value.error, error: value.error, effectAttempted: false });
      }
      return value;
    }) : null,
  ]);
  const source = sourceRead ? { id: sourceRead.source.id, revision: sourceRead.source.revision, name: sourceRead.source.name,
    ...(sourceRead.source.owner ? { owner: sourceRead.source.owner } : {}) } : null;
  const sourceDefaultsRow = sourceRead?.sessionDefaults ?? null;
  const projectSourceDefaults = source?.owner ? {
    sourceId: source.id, owner: source.owner, defaults: sourceDefaultsRow?.defaults ?? null,
  } : null;
  const primaryTeamId = resolveManagedSessionDefaultsTeamId({ primaryTeamId: input.primaryTeamId,
    sharedTeamIds: input.sharedTeamIds, projectSourceDefaults });
  const team = primaryTeamId && deps.readTeam ? await readOptional(async () => {
    const value = await deps.readTeam!(primaryTeamId);
    if ('ok' in value) throw createActionExecuteFailureError(value);
    return value;
  }) : null;
  const home = !team && deps.readHome ? await readOptional(deps.readHome) : null;
  const context = buildManagedSessionDefaultsContext({ team: team ?? undefined, home: home?.homeDefaults,
    policy: input.policyDefaults, memberDefaults: input.memberDefaults,
    creationMachineApprovalProfileId: input.creationMachineApprovalProfileId,
    personalDefaultsRow: personalDefaultsRow?.defaults ?? null, projectSourceDefaults,
    primaryTeamId, sharedTeamIds: input.sharedTeamIds });
  return { context, personalDefaultsRow, sourceDefaultsRow, source,
    // The Source owner decides defaults authority once; metadata management never implies it.
    canManageSource: sourceRead?.canManageSessionDefaults === true,
    repairRequired: team?.policy.managedDefaultsStatus === 'repair_required',
    ...(unavailableDefaults.length ? { unavailableDefaults } : {}),
    ...(team?.name ? { teamName: team.name } : {}),
  };
}
