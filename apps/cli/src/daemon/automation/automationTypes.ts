import type {
  AutomationAccountCurrentnessWitnessV1,
  AutomationRunCause,
  AutomationTriggerId,
  AutomationV3WorkerResultDelivery,
} from '@happier-dev/protocol';

export type AutomationV2ClaimedRun = Readonly<{
  id: string;
  automationId: string;
  attempt: number;
}>;

export type AutomationV2ClaimedAutomation = Readonly<{
  id: string;
  name: string;
  enabled: boolean;
  targetType: 'new_session' | 'existing_session';
  templateCiphertext: string;
}>;

export type AutomationV3ClaimedRun = Readonly<{
  id: string;
  automationId: string;
  attempt: number;
  triggerId: AutomationTriggerId | null;
  /** Null is a retained pre-recipe Run and must fail closed in the worker. */
  executionInputEnvelope: string | null;
  /** Immutable Run-owned cause consumed with the frozen execution recipe. */
  cause: AutomationRunCause;
  /** Missing wire fact normalizes to none at the private claim boundary. */
  resultDelivery: AutomationV3WorkerResultDelivery | Readonly<{ kind: 'none' }>;
}>;

export type AutomationV3ClaimedAutomation = Readonly<{
  id: string;
  name: string;
  enabled: boolean;
}>;

export type AutomationV2ClaimedRunPayload = Readonly<{
  protocol: 'v2';
  run: AutomationV2ClaimedRun;
  automation: AutomationV2ClaimedAutomation;
}>;

export type AutomationV3ClaimedRunPayload = Readonly<{
  protocol: 'v3';
  run: AutomationV3ClaimedRun;
  automation: AutomationV3ClaimedAutomation;
  /** C: exact Account currentness observed atomically with the claim. */
  accountCurrentness: AutomationAccountCurrentnessWitnessV1;
}>;

export type AutomationClaimedRunPayload =
  | AutomationV2ClaimedRunPayload
  | AutomationV3ClaimedRunPayload;

export type AutomationClaimRunResponse =
  | Readonly<{
    protocol: 'v2' | 'v3';
    run: null;
    automation: null;
  }>
  | AutomationClaimedRunPayload;

export type AutomationDaemonAssignmentsResponse = Readonly<{
  assignments: Array<{
    machineId: string;
    enabled: boolean;
    priority: number;
    updatedAt: number;
    automation: {
      id: string;
      name: string;
      enabled: boolean;
      schedule: {
        kind: 'cron' | 'interval';
        scheduleExpr: string | null;
        everyMs: number | null;
        timezone: string | null;
      };
      targetType: 'new_session' | 'existing_session';
      templateCiphertext: string;
      templateVersion: number;
      nextRunAt: number | null;
      lastRunAt: number | null;
      updatedAt: number;
    };
  }>;
}>;

/**
 * The worker's narrow wake cache. V3 exposes the durable claim deadline
 * directly; a V2 schedule response is normalized at the HTTP boundary.
 */
export type AutomationWorkerAssignmentsResponse = Readonly<{
  assignments: Array<{
    machineId: string;
    automationId: string;
    nextClaimAt: number | null;
  }>;
  /**
   * Current V3 server projection, or the Protocol-owned default normalized
   * once at the V2 HTTP compatibility boundary.
   */
  settings: Readonly<{
    maxActiveRunsPerMachine: number;
  }>;
}>;
