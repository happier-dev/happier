import type {
  AutomationAccountCurrentnessWitnessV1,
  AutomationRunCause,
} from '@happier-dev/protocol';
import type { LiveWorkProducerV1 } from '../lifecycle/managedActivity';

/**
 * Origin-neutral claim seam shared by Automation and direct Workflow Runs.
 * The single production composition owner is
 * `createProductionWorkflowRunCoordinator` in `./production`; every consumer
 * types its coordinator against that owner's returned claim-to-result
 * contract rather than a parallel composition wrapper.
 */
export type WorkflowClaimForCoordination = Readonly<{
  runId: string;
  automationId?: string;
  /** Automation origin only: the Automation's own name, the Run's name when its source carries none. */
  automationName?: string;
  attempt: number;
  /** Claimed parent revision used by the one pre-root accepted-snapshot CAS. */
  expectedRevision: number;
  /** Recorded boundary Resume, consumed atomically by this successful claim. */
  workflowResumeRequestedRevision?: number;
  accountCurrentness: AutomationAccountCurrentnessWitnessV1;
  /** Automation origin carries sealed trigger context; direct origin carries an accepted snapshot. */
  definitionEnvelope?: string;
  /** Automation-owned live source and optional session scope, copied from the claim receipt. */
  workflowDefinitionId?: string | null;
  scopeSessionId?: string | null;
  /** Closing checkpoint of the newest succeeded occurrence of this scoped trigger. */
  lastSucceededRun?: Readonly<{ runId: string; checkpointEnvelope: string }>;
  /** Frozen cause depth from the server claim receipt, never recomputed by the daemon. */
  causeWorkDepth?: number;
  acceptedEnvelope?: string;
  /** Automation origin only: separately frozen occurrence evidence. */
  automationEvidenceEnvelope?: string | null;
  /** Automation origin only: immutable bounded cause captured at admission. */
  automationCause?: AutomationRunCause;
  /** Exact live coordinator callback; the incumbent worker remains its owner. */
  registerReviewHoldRefresh?: (refresh: () => Promise<void>) => void;
  /** Projects this claim's actual coordinator custody through the incumbent worker map. */
  registerLiveWorkProducer?: (producer: LiveWorkProducerV1) => () => void;
  /** Reserve the incumbent machine budget after private materialization. */
  acquireMachineStartCapacity?: (signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}>;
