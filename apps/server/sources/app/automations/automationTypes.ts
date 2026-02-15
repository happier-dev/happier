export type AutomationScheduleKind = 'cron' | 'interval';
export type AutomationTargetType = 'new_session' | 'existing_session';
export type AutomationRunState = 'queued' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

export type AutomationAssignmentInput = Readonly<{
    machineId: string;
    enabled?: boolean;
    priority?: number;
}>;

export type AutomationScheduleInput = Readonly<{
    kind: 'interval';
    everyMs: number;
    scheduleExpr?: undefined;
    timezone?: string | null;
}> | Readonly<{
    kind: 'cron';
    scheduleExpr: string;
    everyMs?: undefined;
    timezone?: string | null;
}>;

export type AutomationUpsertInput = Readonly<{
    name: string;
    description?: string | null;
    enabled: boolean;
    schedule: AutomationScheduleInput;
    targetType: AutomationTargetType;
    templateCiphertext: string;
    assignments?: ReadonlyArray<AutomationAssignmentInput>;
}>;

export type AutomationPatchInput = Readonly<Partial<AutomationUpsertInput>>;

export type AutomationListItem = Readonly<{
    id: string;
    accountId: string;
    name: string;
    description: string | null;
    enabled: boolean;
    scheduleKind: AutomationScheduleKind;
    scheduleExpr: string | null;
    everyMs: number | null;
    timezone: string | null;
    targetType: AutomationTargetType;
    templateCiphertext: string;
    templateVersion: number;
    nextRunAt: Date | null;
    lastRunAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    assignments: ReadonlyArray<{
        machineId: string;
        enabled: boolean;
        priority: number;
        updatedAt?: Date;
    }>;
}>;

export type AutomationRunItem = Readonly<{
    id: string;
    automationId: string;
    accountId: string;
    state: AutomationRunState;
    scheduledAt: Date;
    dueAt: Date;
    claimedAt: Date | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    claimedByMachineId: string | null;
    leaseExpiresAt: Date | null;
    attempt: number;
    summaryCiphertext: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    producedSessionId: string | null;
    createdAt: Date;
    updatedAt: Date;
}>;

export type AutomationRunWithAutomation = AutomationRunItem & Readonly<{
    automation: {
        id: string;
        name: string;
        enabled: boolean;
        targetType: AutomationTargetType;
        templateCiphertext: string;
    };
}>;

export type AutomationApiDto = Readonly<{
    id: string;
    name: string;
    description: string | null;
    enabled: boolean;
    schedule: {
        kind: AutomationScheduleKind;
        scheduleExpr: string | null;
        everyMs: number | null;
        timezone: string | null;
    };
    targetType: AutomationTargetType;
    templateCiphertext: string;
    templateVersion: number;
    nextRunAt: number | null;
    lastRunAt: number | null;
    createdAt: number;
    updatedAt: number;
    assignments: ReadonlyArray<{
        machineId: string;
        enabled: boolean;
        priority: number;
        updatedAt: number | null;
    }>;
}>;

export type AutomationRunApiDto = Readonly<{
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

export function toAutomationApiDto(item: AutomationListItem): AutomationApiDto {
    return {
        id: item.id,
        name: item.name,
        description: item.description,
        enabled: item.enabled,
        schedule: {
            kind: item.scheduleKind,
            scheduleExpr: item.scheduleExpr,
            everyMs: item.everyMs,
            timezone: item.timezone,
        },
        targetType: item.targetType,
        templateCiphertext: item.templateCiphertext,
        templateVersion: item.templateVersion,
        nextRunAt: item.nextRunAt ? item.nextRunAt.getTime() : null,
        lastRunAt: item.lastRunAt ? item.lastRunAt.getTime() : null,
        createdAt: item.createdAt.getTime(),
        updatedAt: item.updatedAt.getTime(),
        assignments: item.assignments.map((assignment) => ({
            machineId: assignment.machineId,
            enabled: assignment.enabled,
            priority: assignment.priority,
            updatedAt: assignment.updatedAt ? assignment.updatedAt.getTime() : null,
        })),
    };
}

export function toAutomationRunApiDto(item: AutomationRunItem): AutomationRunApiDto {
    return {
        id: item.id,
        automationId: item.automationId,
        state: item.state,
        scheduledAt: item.scheduledAt.getTime(),
        dueAt: item.dueAt.getTime(),
        claimedAt: item.claimedAt ? item.claimedAt.getTime() : null,
        startedAt: item.startedAt ? item.startedAt.getTime() : null,
        finishedAt: item.finishedAt ? item.finishedAt.getTime() : null,
        claimedByMachineId: item.claimedByMachineId,
        leaseExpiresAt: item.leaseExpiresAt ? item.leaseExpiresAt.getTime() : null,
        attempt: item.attempt,
        summaryCiphertext: item.summaryCiphertext,
        errorCode: item.errorCode,
        errorMessage: item.errorMessage,
        producedSessionId: item.producedSessionId,
        createdAt: item.createdAt.getTime(),
        updatedAt: item.updatedAt.getTime(),
    };
}
