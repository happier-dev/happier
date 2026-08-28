import type {
    AcpConfigOptionOverridesV1,
    AgentExecutionTargetV1,
    AutomationDefinitionDetail as AutomationDefinitionDetailResponse,
    AutomationDefinitionListItem,
    AutomationV3RunListItem,
    BackendTargetRefV2,
    SessionMcpSelectionV1,
    SessionModelSelectionV1,
    RuntimeDescriptorV1,
    SessionExecutionTargetV1,
    SessionOrganizationPlacementV1,
    WindowsRemoteSessionLaunchMode,
} from '@happier-dev/protocol';

import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';

export type AutomationAssignment = Readonly<{
    machineId: string;
    enabled: boolean;
    priority: number;
    updatedAt: number | null;
}>;

/** One current plural summary plus its exact private detail, when loaded. */
export type AutomationDefinitionDetail =
    | Readonly<{
        kind: 'unloaded';
        templateVersion: number;
    }>
    | Readonly<{
        kind: 'available';
        templateVersion: number;
        value: AutomationDefinitionDetailResponse;
    }>
    | Readonly<{
        kind: 'unavailable';
        templateVersion: number;
        code: 'automation_stored_content_unavailable';
    }>;

export type AutomationDefinitionAvailable = Readonly<AutomationDefinitionListItem & {
    detail: Readonly<{
        kind: 'available';
        templateVersion: number;
        value: AutomationDefinitionDetailResponse;
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
    | Readonly<AutomationDefinitionListItem & {
        detail: Extract<AutomationDefinitionDetail, Readonly<{ kind: 'unloaded' }>>;
        linkedExistingSessionId: string | null;
    }>
    | Readonly<AutomationDefinitionListItem & {
        detail: Extract<AutomationDefinitionDetail, Readonly<{ kind: 'unavailable' }>>;
        linkedExistingSessionId: string | null;
    }>
    | AutomationDefinitionAvailable;

export type PluginEventAutomationTrigger = Extract<
    AutomationDefinitionListItem['triggers'][number],
    Readonly<{ kind: 'pluginEvent' }>
>;

export function isPluginEventAutomationTrigger(
    trigger: AutomationDefinitionListItem['triggers'][number] | null | undefined,
): trigger is PluginEventAutomationTrigger {
    return trigger?.kind === 'pluginEvent';
}

/** Bounded V3 Run projection held by the incumbent Automation run cache. */
export type AutomationDefinitionRun = AutomationV3RunListItem;

export type AutomationTemplate = Readonly<{
    executionTarget?: SessionExecutionTargetV1;
    directory: string;
    checkoutCreationDraft?: NewSessionCheckoutCreationDraft;
    organizationPlacement?: SessionOrganizationPlacementV1;
    prompt?: string;
    displayText?: string;
    agent?: string;
    agentTarget?: AgentExecutionTargetV1;
    /** Released predecessor read input. New templates write `agentTarget`. */
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
    runtimeDescriptorV1?: RuntimeDescriptorV1;
    agentModeId?: string;
    existingSessionId?: string;
    sessionEncryptionMode?: 'e2ee' | 'plain';
    sessionEncryptionKeyBase64?: string;
    sessionEncryptionVariant?: 'dataKey';
}>;
