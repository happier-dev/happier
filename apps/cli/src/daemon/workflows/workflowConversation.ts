import type {
  WorkflowConversationSelection,
  WorkflowProgressEnvelopeV1,
  WorkflowStepExecutionSelection,
} from '@happier-dev/protocol/workflows';
import type { WorkflowConversationUnavailableDetailsV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { SessionLaunchRetiredV1 } from '@happier-dev/protocol/spawnSession';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { logger } from '@/ui/logger';
export { workflowBodyOwnsConversation } from '@happier-dev/protocol/workflows/workflowInvocationStructureV1';

export class WorkflowSessionCompositionError extends Error {
  constructor(readonly code: string, message = code, readonly details?: WorkflowConversationUnavailableDetailsV1,
    readonly launchFailure?: SessionLaunchRetiredV1, readonly runtimeIssueV1?: SessionRuntimeIssueV1) {
    super(message);
    if (details) logger.infoFile(JSON.stringify({ event: 'workflow_conversation_refused', errorCode: code, ...details }));
  }
}

export type WorkflowConversationTargetClass = 'session' | 'detached_run';

/** Authored continuity interpreted against the current lexical conversation owner. */
export type WorkflowConversationBinding =
  | Readonly<{ kind: 'shared'; scopeOwnerKey: string; targetClass: WorkflowConversationTargetClass }>
  | Exclude<WorkflowConversationSelection, { kind: 'shared_run' }>;

export function resolveWorkflowConversationBinding(params: Readonly<{
  execution: WorkflowStepExecutionSelection;
  authoredConversation?: WorkflowConversationSelection;
  inheritedOwnerKey: string;
  rootOwnerKey: string;
  targetClass: WorkflowConversationTargetClass;
}>): WorkflowConversationBinding {
  const choice = params.execution.conversation;
  if (choice && choice.kind !== 'shared_run') return choice;
  return {
    kind: 'shared',
    scopeOwnerKey: params.authoredConversation?.kind === 'shared_run'
      ? params.rootOwnerKey : params.inheritedOwnerKey,
    targetClass: params.targetClass,
  };
}

/** The shared key stays stable before and after the native target is created. */
export function workflowConversationAdmissionKey(
  binding: WorkflowConversationBinding,
  retainedRunId?: string,
): string | undefined {
  if (binding.kind === 'shared') return `${binding.scopeOwnerKey}:${binding.targetClass}`;
  if (binding.kind === 'from_step' && retainedRunId) return `retained:${retainedRunId}`;
  return undefined;
}

export function sameWorkflowConversationTarget(
  left: NonNullable<WorkflowProgressEnvelopeV1['execution']>,
  right: NonNullable<WorkflowProgressEnvelopeV1['execution']>,
): boolean {
  return (left.kind === 'session' || left.kind === 'session_ready') && (right.kind === 'session' || right.kind === 'session_ready')
    ? left.sessionId === right.sessionId
    : left.kind === 'detached_run' && right.kind === 'detached_run' && left.runId === right.runId;
}

/** Fresh recovery changes the future pointer, never an already-rebound target on replay. */
export function shouldPublishWorkflowSharedConversation(params: Readonly<{
  current?: WorkflowProgressEnvelopeV1['execution'];
  next: NonNullable<WorkflowProgressEnvelopeV1['execution']>;
  replacesExecution?: WorkflowProgressEnvelopeV1['execution'];
  currentSequence?: string;
  nextSequence?: string;
}>): boolean {
  if (!params.current) return true;
  if (sameWorkflowConversationTarget(params.current, params.next) || !params.replacesExecution) return false;
  // Reconstructing an earlier completed recovery must not rewind a later
  // recovery's pointer. These are the existing admission-index sequences.
  if (params.currentSequence !== undefined && params.nextSequence !== undefined
    && BigInt(params.currentSequence) > BigInt(params.nextSequence)) return false;
  return true;
}

export type WorkflowConversationSelectionResolution =
  | Readonly<{ kind: 'observe'; execution: NonNullable<WorkflowProgressEnvelopeV1['execution']> }>
  | Readonly<{ kind: 'retained'; execution: NonNullable<WorkflowProgressEnvelopeV1['execution']> }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'select'; binding: Exclude<WorkflowConversationBinding, { kind: 'input' }> }>;

/** Rejoin is exact-input observation; recovery intent precedes authored continuity. */
export function resolveWorkflowConversationSelection(params: Readonly<{
  invocation: WorkflowProgressEnvelopeV1;
  recoveryPreviousExecution?: WorkflowProgressEnvelopeV1['execution'];
  execution: WorkflowStepExecutionSelection;
  conversationBinding?: WorkflowConversationBinding;
  runId: string;
  executionTarget?: Readonly<{ kind: WorkflowConversationTargetClass }>;
}>): WorkflowConversationSelectionResolution {
  if (params.invocation.execution) return { kind: 'observe', execution: params.invocation.execution };
  if (params.invocation.recovery?.conversation === 'fresh_agent') {
    return { kind: 'select', binding: { kind: 'fresh' } };
  }
  if (params.invocation.recovery?.conversation === 'same_conversation') {
    return params.recoveryPreviousExecution
      ? { kind: 'retained', execution: params.recoveryPreviousExecution }
      : { kind: 'unavailable' };
  }
  const binding = params.conversationBinding ?? resolveWorkflowConversationBinding({
    execution: params.execution,
    authoredConversation: params.execution.conversation,
    inheritedOwnerKey: params.runId,
    rootOwnerKey: params.runId,
    targetClass: params.executionTarget?.kind ?? 'session',
  });
  return binding.kind === 'input' ? { kind: 'unavailable' } : { kind: 'select', binding };
}
