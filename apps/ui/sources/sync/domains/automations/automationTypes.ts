export type AutomationSchedule = Readonly<{
    kind: 'cron' | 'interval';
    scheduleExpr: string | null;
    everyMs: number | null;
    timezone: string | null;
}>;

export type AutomationAssignment = Readonly<{
    machineId: string;
    enabled: boolean;
    priority: number;
    updatedAt: number | null;
}>;

export type AutomationTargetType = 'new_session' | 'existing_session';

export type Automation = Readonly<{
    id: string;
    name: string;
    description: string | null;
    enabled: boolean;
    schedule: AutomationSchedule;
    targetType: AutomationTargetType;
    templateCiphertext: string;
    templateVersion: number;
    nextRunAt: number | null;
    lastRunAt: number | null;
    createdAt: number;
    updatedAt: number;
    assignments: ReadonlyArray<AutomationAssignment>;
}>;

export type AutomationRunState =
    | 'queued'
    | 'claimed'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'expired';

export type AutomationRun = Readonly<{
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
}>;

export type AutomationTemplate = Readonly<{
    directory: string;
    prompt?: string;
    displayText?: string;
    agent?: string;
    profileId?: string;
    environmentVariables?: Record<string, string>;
    resume?: string;
    permissionMode?: string;
    permissionModeUpdatedAt?: number;
    modelId?: string;
    modelUpdatedAt?: number;
    terminal?: unknown;
    windowsRemoteSessionConsole?: 'hidden' | 'visible';
    experimentalCodexResume?: boolean;
    experimentalCodexAcp?: boolean;
    existingSessionId?: string;
    sessionEncryptionKeyBase64?: string;
    sessionEncryptionVariant?: 'dataKey';
}>;
