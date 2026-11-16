import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import {
  WorkflowAuthoredInputV1Schema,
  WorkflowProgressEnvelopeV1Schema,
  type WorkflowAuthoredInputV1,
  type WorkflowProgressEnvelopeV1,
} from '../../workflows/workflowProgressV1.js';

type RecoveryInput = { kind: 'original' } | { kind: 'replacement'; value: WorkflowAuthoredInputV1 };

export function normalizeWorkflowInvocationRecoveryInput(
  progress: WorkflowProgressEnvelopeV1,
  input: RecoveryInput,
): { kind: 'replacement'; value: WorkflowAuthoredInputV1 } | undefined {
  if (progress.blockKind !== 'step') return undefined;
  if (input.kind === 'replacement') return input;
  const prepared = createStoredReadSchema(WorkflowAuthoredInputV1Schema).safeParse(progress.input);
  if (!prepared.success) throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
  return { kind: 'replacement' as const, value: prepared.data };
}

function resetRecoveredContainer(container: NonNullable<WorkflowProgressEnvelopeV1['container']>) {
  if (container.kind === 'body') return { ...container, nextBlockOrdinal: '0' };
  if (container.kind === 'parallel') return { ...container, nextBranchOrdinal: '0' };
  if (container.kind === 'if') return { ...container, nextBlockOrdinal: '0' };
  const { closing: _closing, ...loop } = container;
  return { ...loop, nextMemberIndex: '0', nextBodyBlockOrdinal: '0' };
}

/** Retry and Restore retain admitted Action/frame input; only Agent steps have a recovery conversation. */
export function createRecoveredWorkflowInvocationProgress(params: Readonly<{
  prior: WorkflowProgressEnvelopeV1;
  priorRecordId: string;
  attempt: string;
  input: RecoveryInput;
  conversation: 'same_conversation' | 'fresh_agent';
  acknowledgeUncertainPriorEffects?: boolean;
}>): WorkflowProgressEnvelopeV1 {
  const {
    execution: _execution, result: _result, containerResult: _containerResult,
    reason: _reason, observationDeadline: _deadline, recovery: _recovery,
    uncertainPriorEffects: _uncertain, previousAttemptRecordId: _previous,
    timing: _timing, loopProgress: _loopProgress,
    ...reusable
  } = params.prior;
  const input = normalizeWorkflowInvocationRecoveryInput(params.prior, params.input);
  return WorkflowProgressEnvelopeV1Schema.parse({
    ...reusable,
    attempt: params.attempt,
    previousAttemptRecordId: params.priorRecordId,
    ...(params.prior.container ? { container: resetRecoveredContainer(params.prior.container) } : {}),
    ...(input ? {
      input: StrictJsonValueSchema.parse(input.value),
      recovery: {
        conversation: params.conversation, input,
        ...(params.acknowledgeUncertainPriorEffects !== undefined
          ? { acknowledgeUncertainPriorEffects: params.acknowledgeUncertainPriorEffects } : {}),
      },
    } : {}),
  });
}
