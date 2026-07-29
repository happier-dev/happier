import type {
    AcpConfigOptionOverridesV1,
    BackendTargetRefV2,
    SessionAuthoringAutomationV1,
    SessionAuthoringCheckoutCreationDraftV1,
    SessionAuthoringCodexBackendMode,
    SessionAuthoringTerminalV1,
    SessionAuthoringValueV1,
    SessionMcpSelectionV1,
    WindowsRemoteSessionLaunchMode,
} from '@happier-dev/protocol';
import type { CodexBackendMode } from '@happier-dev/protocol';

import type { AutomationTargetType } from '@/sync/domains/automations/automationTypes';

type SessionAuthoringDraftBase = Readonly<Omit<
    SessionAuthoringValueV1,
    'targetType' | 'checkoutCreationDraft' | 'backendTarget' | 'modelSelection' | 'mcpSelection' | 'windowsRemoteSessionLaunchMode' | 'windowsTerminalWindowName' | 'codexBackendMode' | 'sessionConfigOptionOverrides' | 'automation'
> & {
    targetType: AutomationTargetType;
    checkoutCreationDraft: SessionAuthoringCheckoutCreationDraftV1 | null;
    backendTarget: BackendTargetRefV2 | null;
    modelSelection?: SessionAuthoringValueV1['modelSelection'];
    mcpSelection: SessionMcpSelectionV1 | null;
    windowsRemoteSessionLaunchMode: WindowsRemoteSessionLaunchMode | null;
    windowsTerminalWindowName?: string | null;
    codexBackendMode?: SessionAuthoringCodexBackendMode | CodexBackendMode | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    automation?: SessionAuthoringAutomationV1 | null;
}>;

export type SessionAuthoringDraft = Readonly<SessionAuthoringDraftBase & {
    connectedServices: SessionAuthoringValueV1['connectedServices'];
    terminal: SessionAuthoringTerminalV1 | null;
    /**
     * Legacy read fallback only. New authored draft state should use `codexBackendMode`.
     */
    experimentalCodexAcp: boolean | null;
}>;
