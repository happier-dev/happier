import type { SessionSpawnNewInputV2 } from './sessionSpawnNewInputV2.js';
import { readSessionPlacementProjectFilesV1, type SessionPlacementSelectionV1, type SessionProjectFilesV1 } from './sessionPlacementSelectionV1.js';
import type { SessionExecutionTargetV1 } from './sessionExecutionTargetV1.js';
import type { HostReviewedChildrenPlanV1 } from '../../actions/executor/types.js';
import { projectNativeJsonValueForTransport } from '../../json/strictJsonValue.js';
import { OpenProjectInputV1Schema, type OpenProjectInputV1 } from '../../projects/openProjectV1.js';

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
  return source !== undefined && (source.target.machineId !== input.executionTarget.machineId
    || source.target.serverId !== input.executionTarget.serverId);
}

export function buildSessionProjectFilesSourceOpenInputV1(placement: SessionPlacementSelectionV1): OpenProjectInputV1 | null {
  const { projectFilesSource: source } = readSessionPlacementProjectFilesV1(placement);
  return source ? OpenProjectInputV1Schema.parse({
    ...source.target, source: { kind: 'folder', path: source.directory }, materialization: { kind: 'attach' },
  }) : null;
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
