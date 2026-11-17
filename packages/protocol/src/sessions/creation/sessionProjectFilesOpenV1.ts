import type { SessionSpawnNewInputV2 } from './sessionSpawnNewInputV2.js';
import type { SessionPlacementSelectionV1, SessionProjectFilesV1 } from './sessionPlacementSelectionV1.js';
import type { SessionExecutionTargetV1 } from './sessionExecutionTargetV1.js';
import type { HostReviewedChildrenPlanV1 } from '../../actions/executor/types.js';
import { projectNativeJsonValueForTransport } from '../../json/strictJsonValue.js';
import { OpenProjectInputV1Schema, type OpenProjectInputV1 } from '../../projects/openProjectV1.js';

export const SESSION_PROJECT_FILES_OPEN_CHILDREN_V1 = {
  source: { action: 'projects.open', role: 'session_project_files_source' },
  target: { action: 'projects.open', role: 'session_project_files_target' },
} as const;

/** Placement's captured folder is the origin; the chosen execution Machine is never a substitute. */
export function needsEnrolledSessionProjectFilesOpenV1(input: Readonly<{
  placement?: SessionPlacementSelectionV1;
  /** Trusted birth default; an authored placement remains authoritative. */
  projectFiles?: SessionProjectFilesV1;
  executionTarget: SessionExecutionTargetV1;
}>): boolean {
  if ((input.placement?.projectFiles ?? input.projectFiles)?.kind === 'git_clone') return true;
  const source = input.placement?.projectFilesSource;
  return source !== undefined && (source.target.machineId !== input.executionTarget.machineId
    || source.target.serverId !== input.executionTarget.serverId);
}

export function buildSessionProjectFilesSourceOpenInputV1(placement: SessionPlacementSelectionV1): OpenProjectInputV1 | null {
  const source = placement.projectFilesSource;
  return source ? OpenProjectInputV1Schema.parse({
    ...source.target, source: { kind: 'folder', path: source.directory }, materialization: { kind: 'attach' },
  }) : null;
}

/** Source attachment has its own Machine admission; destination spawn grants no source reads. */
export function sessionProjectFilesOpenChildrenV1(input: Pick<SessionSpawnNewInputV2,
  'sessionPlacement' | 'executionTarget'> & Readonly<{ projectFiles?: SessionProjectFilesV1 }>): HostReviewedChildrenPlanV1['children'] {
  const source = (input.sessionPlacement?.projectFiles ?? input.projectFiles)?.kind !== 'git_clone' && input.sessionPlacement
    ? buildSessionProjectFilesSourceOpenInputV1(input.sessionPlacement) : null;
  return [
    ...(source ? [{ ...SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source, input: projectNativeJsonValueForTransport(source) }] : []),
    ...(source || needsEnrolledSessionProjectFilesOpenV1({ placement: input.sessionPlacement,
      projectFiles: input.projectFiles, executionTarget: input.executionTarget })
      ? [{ ...SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.target, scopeInput: { ...input.executionTarget } }] : []),
  ];
}
