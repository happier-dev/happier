import { SessionSpawnNewInputV2Schema, type SessionSpawnNewInputV2 } from './sessionSpawnNewInputV2.js';
import { readSessionPlacementProjectFilesV1, type SessionPlacementSelectionV1, type SessionProjectFilesV1 } from './sessionPlacementSelectionV1.js';
import type { SessionExecutionTargetV1 } from './sessionExecutionTargetV1.js';
import type { HostReviewedChildrenPlanV1 } from '../../actions/executor/types.js';
import type { ExternalActionExecutionAuthorizationV1, ReviewedActionChildHttpProofV1 } from '../../actions/externalActionApi.js';
import { computeActionInputApprovalDigestV1 } from '../../actions/decisionAuthority.js';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { OpenProjectInputV1Schema, type OpenProjectInputV1 } from '../../projects/openProjectV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';

export const SESSION_PROJECT_FILES_OPEN_CHILDREN_V1 = {
  source: { action: 'projects.open', role: 'session_project_files_source' },
  target: { action: 'projects.open', role: 'session_project_files_target' },
} as const;

/** Content demand is known from authoring intent before destination inheritance. */
export function sessionProjectFilesConsumeRequesterAccountContentV1(input: Pick<SessionSpawnNewInputV2,
  'sessionPlacement'> & Readonly<{ projectFiles?: SessionProjectFilesV1 }>): boolean {
  const { projectFiles, projectFilesSource } = readSessionPlacementProjectFilesV1(input.sessionPlacement, input.projectFiles);
  return projectFilesSource !== undefined || projectFiles?.kind === 'git_clone';
}

/** Placement's captured folder is the origin; the chosen execution Machine is never a substitute. */
export function needsEnrolledSessionProjectFilesOpenV1(input: Readonly<{
  placement?: SessionPlacementSelectionV1;
  /** Trusted birth default; an authored placement remains authoritative. */
  projectFiles?: SessionProjectFilesV1;
  executionTarget: SessionExecutionTargetV1;
}>): boolean {
  const { projectFiles, projectFilesSource: source } = readSessionPlacementProjectFilesV1(input.placement, input.projectFiles);
  if (projectFiles?.kind === 'git_clone') return true;
  return source !== undefined && ('workspace' in source || source.target.machineId !== input.executionTarget.machineId
    || source.target.serverId !== input.executionTarget.serverId);
}

export function buildSessionProjectFilesSourceOpenInputV1(placement: SessionPlacementSelectionV1): OpenProjectInputV1 | null {
  const { projectFilesSource: source } = readSessionPlacementProjectFilesV1(placement);
  if (!source) return null;
  if ('workspace' in source) {
    const { workspace } = source;
    return OpenProjectInputV1Schema.parse({
      serverId: workspace.serverId, machineId: workspace.controller.machineId,
      source: { kind: 'workspace', workspaceId: workspace.workspaceId, checkout: workspace },
      materialization: { kind: 'attach' },
    });
  }
  return OpenProjectInputV1Schema.parse({
    ...source.target, source: { kind: 'folder', path: source.directory }, materialization: { kind: 'attach' },
  });
}

/** Source attachment has its own Machine admission; destination spawn grants no source reads. */
export function sessionProjectFilesOpenChildrenV1(input: Pick<SessionSpawnNewInputV2,
  'sessionPlacement' | 'executionTarget'> & Readonly<{ projectFiles?: SessionProjectFilesV1 }>): HostReviewedChildrenPlanV1['children'] {
  const { projectFiles: choice } = readSessionPlacementProjectFilesV1(input.sessionPlacement, input.projectFiles);
  const source = (choice?.kind !== 'git_clone' || !choice.source || !choice.branch) && input.sessionPlacement
    ? buildSessionProjectFilesSourceOpenInputV1(input.sessionPlacement) : null;
  return [
    ...(source ? [
      ...(choice?.kind !== 'git_clone' ? [{ ...SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source,
        input: projectNativeJsonValueForTransport(source) }] : []),
      ...(choice === undefined || choice.kind === 'git_clone' ? [{ ...SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source,
        input: projectNativeJsonValueForTransport({ ...source, cloneSource: true }) }] : []),
    ] : []),
    ...(sessionProjectFilesConsumeRequesterAccountContentV1(input)
      ? [{ ...SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.target, scopeInput: { ...input.executionTarget } }] : []),
  ];
}

/** The one cross-Machine source-attach child of `session.spawn_new`. */
export function readSessionProjectFilesSourceOpenChildRpcEffectV1(
  binding: ExternalActionExecutionAuthorizationV1['binding'] | undefined,
  method: string,
  reviewedChild?: ReviewedActionChildHttpProofV1,
): 'projects.open' | null {
  return binding?.actionId === 'session.spawn_new'
    && method === RPC_METHODS.PROJECTS_OPEN
    && reviewedChild?.actionId === SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source.action
    && reviewedChild.role === SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source.role
    ? 'projects.open' : null;
}

/** Operand check when the relay/seal layer holds only the child input and proof. */
export function isSessionProjectFilesSourceOpenChildRecipientOperandV1(input: Readonly<{
  reviewedChild: ReviewedActionChildHttpProofV1 | undefined;
  machineId: string;
  params: unknown;
}>): boolean {
  const parsed = OpenProjectInputV1Schema.safeParse(input.params);
  return parsed.success
    && parsed.data.machineId === input.machineId
    && parsed.data.materialization.kind === 'attach'
    && input.reviewedChild !== undefined
    && input.reviewedChild.actionId === SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source.action
    && input.reviewedChild.role === SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source.role
    && computeActionInputApprovalDigestV1('projects.open', input.params) === input.reviewedChild.inputDigest;
}

/** Full root-to-child verification: exact reviewed attach operand on the root's named source Machine. */
export function isSessionProjectFilesSourceOpenChildInputV1(input: Readonly<{
  rootInput: unknown;
  reviewedChild: ReviewedActionChildHttpProofV1 | undefined;
  machineId: string;
  params: unknown;
}>): boolean {
  if (!isSessionProjectFilesSourceOpenChildRecipientOperandV1(input)) return false;
  const root = SessionSpawnNewInputV2Schema.safeParse(input.rootInput);
  if (!root.success || !root.data.sessionPlacement) return false;
  const expected = buildSessionProjectFilesSourceOpenInputV1(root.data.sessionPlacement);
  if (!expected || expected.machineId !== input.machineId
    || expected.serverId !== root.data.executionTarget.serverId) return false;
  const parsed = OpenProjectInputV1Schema.parse(input.params);
  const { projectFiles: choice } = readSessionPlacementProjectFilesV1(root.data.sessionPlacement);
  if (choice?.kind === 'git_clone' && choice.source && choice.branch) return false;
  const allowed: OpenProjectInputV1[] = [];
  if (choice?.kind !== 'git_clone') allowed.push(expected);
  if (choice === undefined || choice.kind === 'git_clone') allowed.push({ ...expected, cloneSource: true });
  return allowed.some(candidate => sameStrictJsonValue(candidate, parsed, { omitUndefinedObjectMembers: true }));
}
