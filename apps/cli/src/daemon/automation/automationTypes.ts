export type AutomationRunState = 'queued' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

export type AutomationClaimRunResponse = Readonly<{
  run: null | {
    id: string;
    automationId: string;
    state: AutomationRunState;
    scheduledAt: number;
    dueAt: number;
    claimedAt: number | null;
    startedAt: number | null;
    finishedAt: number | null;
    claimedByMachineId: string | null;
    leaseExpiresAt: number | null;
    attempt: number;
    summaryCiphertext: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    producedSessionId: string | null;
    createdAt: number;
    updatedAt: number;
  };
  automation: null | {
    id: string;
    name: string;
    enabled: boolean;
    targetType: 'new_session' | 'existing_session';
    templateCiphertext: string;
  };
}>;

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
