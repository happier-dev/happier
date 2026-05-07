import type { BackendTargetRefV1, SessionMcpSelectionV1, WindowsRemoteSessionLaunchMode } from '@happier-dev/protocol';
import type { CodexBackendMode } from '@happier-dev/agents';

import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';

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
    checkoutCreationDraft?: NewSessionCheckoutCreationDraft;
    prompt?: string;
    displayText?: string;
    agent?: string;
    backendTarget?: BackendTargetRefV1;
    connectedServices?: unknown;
    transcriptStorage?: 'persisted' | 'direct';
    profileId?: string;
    environmentVariables?: Record<string, string>;
    resume?: string;
    permissionMode?: string;
    permissionModeUpdatedAt?: number;
    modelId?: string;
    modelUpdatedAt?: number;
    mcpSelection?: SessionMcpSelectionV1;
    terminal?: unknown;
    windowsRemoteSessionLaunchMode?: WindowsRemoteSessionLaunchMode;
    windowsRemoteSessionConsole?: 'hidden' | 'visible';
    windowsTerminalWindowName?: string;
    experimentalCodexAcp?: boolean;
    codexBackendMode?: CodexBackendMode;
    agentModeId?: string;
    existingSessionId?: string;
    sessionEncryptionMode?: 'e2ee' | 'plain';
    sessionEncryptionKeyBase64?: string;
    sessionEncryptionVariant?: 'dataKey';
}>;
