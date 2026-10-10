import type {
  AutomationAccountCurrentnessWitnessV1,
  AutomationRunCause,
  AutomationTriggerId,
  AutomationV3WorkerResultDelivery,
  AutomationRunLifecycleSource,
} from '@happier-dev/protocol';

export type AutomationV3ClaimedRun = Readonly<{
  id: string;
  automationId: string;
  attempt: number;
  revision: number;
  workflowResumeRequestedRevision?: number;
  recipeKind: 'legacy' | 'workflow-v2';
  triggerId: AutomationTriggerId | null;
  /** Null is a retained pre-recipe Run and must fail closed in the worker. */
  executionInputEnvelope: string | null;
  automationEvidenceEnvelope?: string | null;
  /** Present only after the Run's one-time accepted-snapshot materialization. */
  workflowAcceptedSnapshotEnvelope?: string;
  /** Immutable Run-owned cause consumed with the frozen execution recipe. */
  cause: AutomationRunCause;
  /** Host-stamped firing cause depth, carried by the frozen server receipt. */
  causeWorkDepth?: number;
  lastSucceededRun?: Readonly<{ runId: string; checkpointEnvelope: string }>;
  /** Missing wire fact normalizes to none at the private claim boundary. */
  resultDelivery: AutomationV3WorkerResultDelivery | Readonly<{ kind: 'none' }>;
}>;

export type DirectWorkflowV3ClaimedRun = Readonly<{
  id: string;
  automationId: null;
  attempt: number;
  revision: number;
  workflowResumeRequestedRevision?: number;
  origin: Readonly<{ kind: 'direct'; originSessionId?: string }>;
  workflowAcceptedSnapshotEnvelope: string;
  triggerId: null;
}>;

export type AutomationV3ClaimedAutomation = Readonly<{
  id: string;
  name: string;
  enabled: boolean;
  workflowDefinitionId?: string | null;
  scopeSessionId?: string | null;
}>;

export type AutomationV3ClaimedRunPayload =
  | Readonly<{
    protocol: 'v3';
    run: AutomationV3ClaimedRun;
    automation: AutomationV3ClaimedAutomation;
    /** C: exact Account currentness observed atomically with the claim. */
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
  }>
  | Readonly<{
    protocol: 'v3';
    run: DirectWorkflowV3ClaimedRun;
    automation: null;
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
  }>;

export type AutomationClaimedRunPayload = AutomationV3ClaimedRunPayload;

export type AutomationClaimRunResponse =
  | Readonly<{
    protocol: 'v3';
    run: null;
    automation: null;
  }>
  | AutomationClaimedRunPayload;

/**
 * The worker's narrow wake cache. V3 exposes the durable claim deadline
 * directly.
 */
export type AutomationWorkerAssignmentsResponse = Readonly<{
  runLifecycleSources?: ReadonlyArray<Extract<AutomationRunLifecycleSource, { kind: 'execution_run' }>>;
  assignments: Array<{
    machineId: string;
    automationId: string;
    nextClaimAt: number | null;
    /** Null/omission is unclassified, not a claim that the stored recipe is legacy. */
    executionRecipeVersion?: 2 | null;
  }>;
  /** Current server-owned execution capacity. */
  settings: Readonly<{
    maxActiveRunsPerMachine: number;
  }>;
}>;
