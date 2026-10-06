import { renderWorkerUpdatePromptBlockV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import type { WorkerUpdateV1 } from '@happier-dev/protocol';
import type { SessionFollowPreparedContext } from '../follow/sessionFollowContextReconciler';
import { measureSessionFollowUtf8Bytes } from '../follow/sessionFollowContextBudget';

export type WorkflowInvocationIdentity = Readonly<{ runId: string; invocationRecordId: string }>;

export type HostContextOnlySourceInput =
  | Readonly<{
      kind: 'worker_update'; localId: string; update: WorkerUpdateV1;
      recheckAdmission: (signal: AbortSignal) => Promise<boolean>;
      acknowledgeAccepted: () => void;
    }>
  | Readonly<{
      kind: 'workflow_step'; localInputId: string; text: string;
      workflowInvocation: WorkflowInvocationIdentity;
      workDepth: number;
      acknowledgeAccepted: () => void;
    }>;

export type PreparedWorkerContextItem = Readonly<{
  localId: string;
  update: WorkerUpdateV1;
  recheckAdmission: (signal: AbortSignal) => Promise<boolean>;
  acknowledgeAccepted: () => void;
}>;

/** Producers retain their own custody; this is the existing input consumer's pull/hint seam. */
export type HostContextOnlyInputPort = Readonly<{
  take: (signal: AbortSignal) => Promise<HostContextOnlySourceInput | null>;
  waitForChange: (signal: AbortSignal) => Promise<boolean>;
  isWorkflowStepDeliverable: (input: Readonly<{ localInputId: string }>) => Promise<boolean>;
  reportWorkflowStepWithdrawn: (input: Readonly<{ localInputId: string }>) => Promise<void>;
  prepareWorkerUpdates?: (input: Readonly<{ signal: AbortSignal; maxUtf8Bytes: number }>) => Promise<readonly PreparedWorkerContextItem[]>;
}>;

export type HostPreparedContext = SessionFollowPreparedContext & Readonly<{
  workerUpdates?: readonly WorkerUpdateV1[];
  /** Final allowance fit for the optional wake already taken by this turn. */
  contextOnlyWorkerUpdate?: WorkerUpdateV1 | null;
  /** A retained wake that cannot fit keeps its custody until an input/context edge. */
  contextOnlyWorkerDisposition?: 'deferred';
  recheckAdmission?: (signal: AbortSignal) => Promise<boolean>;
}>;

/** Optional blocks share Follow's allowance; required workflow text never enters this owner. */
export function fitWorkerUpdateWithinHostContextAllowance(update: WorkerUpdateV1, maxUtf8Bytes: number): WorkerUpdateV1 | null {
  if (measureSessionFollowUtf8Bytes(renderWorkerUpdatePromptBlockV1(update)) <= maxUtf8Bytes) return update;
  if (!update.transcriptPointer) return null;
  const characters = Array.from(update.result ?? '');
  let low = 0;
  let high = characters.length;
  let fitted: WorkerUpdateV1 | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate: WorkerUpdateV1 = { ...update, result: characters.slice(0, middle).join(''), truncated: true };
    if (measureSessionFollowUtf8Bytes(renderWorkerUpdatePromptBlockV1(candidate)) <= maxUtf8Bytes) {
      fitted = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return fitted;
}
