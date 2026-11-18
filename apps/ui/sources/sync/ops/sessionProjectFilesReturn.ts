import {
  SESSION_WORKSPACE_RETURN_APPLY_ACTION_ID_V1,
  SESSION_WORKSPACE_RETURN_PREPARE_ACTION_ID_V1,
} from '@happier-dev/protocol/actions/sessionWorkspaceReturnActionIdsV1';
import type { SessionWorkspaceReturnInputV1, SessionWorkspaceReturnPreviewV1,
  SessionWorkspaceReturnApplyResultV1 } from '@happier-dev/protocol/actions/specs/session/projectFilesReturn';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createDefaultActionExecutor, type UiActionExecutorContext } from './actions/defaultActionExecutor';
export type { SessionWorkspaceReturnPreviewV1 } from '@happier-dev/protocol/actions/specs/session/projectFilesReturn';
export { buildCapturedComparisonFiles } from '@/components/sessions/files/comparison/capturedComparisonFiles';

export type SessionProjectFilesReturnPrepareResult = ActionExecuteFailure
  | Readonly<{ ok: true; result: SessionWorkspaceReturnPreviewV1 }>;
export type SessionProjectFilesReturnApplyResult = ActionExecuteFailure
  | Readonly<{ ok: true; result: SessionWorkspaceReturnApplyResultV1 }>;
export type SessionProjectFilesReturnReviewState = Readonly<{ kind: 'failed'; failure: ActionExecuteFailure }>
  | Readonly<{ kind: 'no_changes' | 'ready' | 'conflicts'; review: SessionWorkspaceReturnPreviewV1 }>;
export type SessionProjectFilesReturnApplyState = Readonly<{ kind: 'failed'; failure: ActionExecuteFailure }>
  | Readonly<{ kind: 'applied' | 'conflicts'; result: SessionWorkspaceReturnApplyResultV1 }>;

/** Stateless presentation facts; failures retain the owner's partial-effect details. */
export function projectSessionProjectFilesReturnReviewState(result: SessionProjectFilesReturnPrepareResult): SessionProjectFilesReturnReviewState {
  if (!result.ok) return { kind: 'failed', failure: result };
  const review = result.result;
  return { kind: review.paths.length === 0 ? 'no_changes'
    : review.paths.some(path => path.conflicts.length > 0) ? 'conflicts' : 'ready', review };
}

export function projectSessionProjectFilesReturnApplyState(result: SessionProjectFilesReturnApplyResult): SessionProjectFilesReturnApplyState {
  if (!result.ok) return { kind: 'failed', failure: result };
  return { kind: result.result.conflicts.length > 0 ? 'conflicts' : 'applied', result: result.result };
}

/** Callable data API for the Session's diff-review surface; mutations retain the shared Action approval flow. */
export function prepareSessionProjectFilesReturn(
  input: Pick<SessionWorkspaceReturnInputV1, 'sessionId' | 'machineId'>,
  context: UiActionExecutorContext,
): Promise<SessionProjectFilesReturnPrepareResult> {
  // The canonical Action executor validates this exact output schema before returning.
  return createDefaultActionExecutor().execute(SESSION_WORKSPACE_RETURN_PREPARE_ACTION_ID_V1, input, context) as Promise<SessionProjectFilesReturnPrepareResult>;
}

export function applySessionProjectFilesReturn(
  input: Extract<SessionWorkspaceReturnInputV1, { returnId: string }>,
  context: UiActionExecutorContext,
): Promise<SessionProjectFilesReturnApplyResult> {
  return createDefaultActionExecutor().execute(SESSION_WORKSPACE_RETURN_APPLY_ACTION_ID_V1, input, context) as Promise<SessionProjectFilesReturnApplyResult>;
}

/** Uses the same captured-comparison reader as the Session's changed-files review. */
export function readSessionProjectFilesReturnComparison(
  input: Readonly<{ machineId: string; review: SessionWorkspaceReturnPreviewV1 }>,
  context: UiActionExecutorContext,
) {
  return createDefaultActionExecutor().execute('scm.diffSummary.capture', {
    cwd: input.review.repositoryRootPath, sessionId: input.review.sessionId,
    comparisonId: input.review.returnId, source: { kind: 'workingTree' },
  }, { ...context, externalActionTarget: { kind: 'machine', machineId: input.machineId } });
}

/** The conflict row's one-press swap changes exactly its reviewed file. */
export function replaceSessionProjectFilesReturnConflict(
  input: Pick<Extract<SessionWorkspaceReturnInputV1, { returnId: string }>, 'sessionId' | 'machineId' | 'returnId'> & Readonly<{ path: string }>,
  context: UiActionExecutorContext,
) {
  const { path, ...target } = input;
  return applySessionProjectFilesReturn({ ...target, paths: [path], replaceConflictPaths: [path] }, context);
}
