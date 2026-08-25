import type {
    AcpConfigOptionOverridesV1,
    AutomationDefinitionDetail,
    AutomationDefinitionListItem,
    AutomationV3RunListItem,
    BackendTargetRefV2,
    SessionMcpSelectionV1,
    SessionModelSelectionV1,
    WindowsRemoteSessionLaunchMode,
} from '@happier-dev/protocol';
import type { CodexBackendMode } from '@happier-dev/protocol';

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
    /**
     * Client-only, fail-closed association projected from the canonical
     * decrypted template reader at Automation ingress. It is never sent to or
     * persisted by the server.
     */
    linkedExistingSessionId: string | null;
    templateVersion: number;
    nextRunAt: number | null;
    lastRunAt: number | null;
    createdAt: number;
    updatedAt: number;
    assignments: ReadonlyArray<AutomationAssignment>;
}>;

/**
 * The current definition projection is deliberately separate from the
 * retained V2 shape above while the released schedule editor completes its
 * migration. It holds one safe summary plus, when directly requested, the
 * matching private detail in the same Automation store record.
 */
export type AutomationDefinitionDetail =
    | Readonly<{
        kind: 'unloaded';
        templateVersion: number;
    }>
    | Readonly<{
        kind: 'available';
        templateVersion: number;
        value: AutomationDefinitionDetail;
    }>
    | Readonly<{
        kind: 'unavailable';
        templateVersion: number;
        code: 'automation_stored_content_unavailable';
    }>;

type AutomationDefinitionTriggerKind = AutomationDefinitionListItem['trigger']['kind'];

export type AutomationDefinitionListItemForTrigger<
    TTriggerKind extends AutomationDefinitionTriggerKind,
> = Extract<AutomationDefinitionListItem, Readonly<{
    trigger: Readonly<{ kind: TTriggerKind }>;
}>>;

export type AutomationDefinitionDetailForTrigger<
    TTriggerKind extends AutomationDefinitionTriggerKind,
> = Extract<AutomationDefinitionDetail, Readonly<{
    trigger: Readonly<{ kind: TTriggerKind }>;
}>>;

type AutomationDefinitionWithDetail<
    TSummary extends AutomationDefinitionListItem,
    TDetail extends AutomationDefinitionDetail,
> = TSummary extends AutomationDefinitionListItem
    ? Readonly<TSummary & {
        detail: TDetail;
        linkedExistingSessionId: string | null;
    }>
    : never;

type AutomationDefinitionUnloaded = AutomationDefinitionWithDetail<
    AutomationDefinitionListItem,
    Extract<AutomationDefinitionDetail, Readonly<{ kind: 'unloaded' }>>
>;

type AutomationDefinitionUnavailable = AutomationDefinitionWithDetail<
    AutomationDefinitionListItem,
    Extract<AutomationDefinitionDetail, Readonly<{ kind: 'unavailable' }>>
>;

export type AutomationDefinitionAvailable<
    TTriggerKind extends AutomationDefinitionTriggerKind,
> = Readonly<AutomationDefinitionListItemForTrigger<TTriggerKind> & {
    detail: Readonly<{
        kind: 'available';
        templateVersion: number;
        value: AutomationDefinitionDetailForTrigger<TTriggerKind>;
    }>;
    /**
     * Client-only association derived only from the private direct detail.
     * `null` therefore means either another target or not-yet-readable detail.
     */
    linkedExistingSessionId: string | null;
}>;

/**
 * List and direct-detail trigger variants stay correlated in one store record.
 * An unavailable or unloaded record intentionally has no private detail to
 * correlate yet, while available records retain the matching trigger arm.
 */
export type AutomationDefinition =
    | AutomationDefinitionUnloaded
    | AutomationDefinitionUnavailable
    | AutomationDefinitionAvailable<'schedule'>
    | AutomationDefinitionAvailable<'manual'>
    | AutomationDefinitionAvailable<'pluginEvent'>;

/** Event-only consumers must retain the source-status/trigger correlation. */
export type PluginEventAutomationDefinition = Extract<
    AutomationDefinitionListItem,
    Readonly<{ trigger: Readonly<{ kind: 'pluginEvent' }> }>
>;

export function isPluginEventAutomationDefinition(
    definition: AutomationDefinitionListItem | null | undefined,
): definition is PluginEventAutomationDefinition {
    return definition?.trigger.kind === 'pluginEvent';
}

/** Bounded V3 Run projection held by the incumbent Automation run cache. */
export type AutomationDefinitionRun = AutomationV3RunListItem;

export type AutomationTemplate = Readonly<{
    directory: string;
    checkoutCreationDraft?: NewSessionCheckoutCreationDraft;
    prompt?: string;
    displayText?: string;
    agent?: string;
    backendTarget?: BackendTargetRefV2;
    connectedServices?: unknown;
    transcriptStorage?: 'persisted' | 'direct';
    profileId?: string;
    environmentVariables?: Record<string, string>;
    resume?: string;
    permissionMode?: string;
    permissionModeUpdatedAt?: number;
    modelSelection?: SessionModelSelectionV1 | null;
    /** Read-only compatibility fields. New templates write `modelSelection`. */
    modelId?: string;
    modelUpdatedAt?: number;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
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
