import type {
    AcpConfigOptionOverridesV1,
    BackendTargetRefV1,
    SessionAuthoringAutomationV1,
    SessionAuthoringCheckoutCreationDraftV1,
    SessionAuthoringCodexBackendMode,
    SessionAuthoringTerminalV1,
    SessionAuthoringValueV1,
    SessionMcpSelectionV1,
    WindowsRemoteSessionLaunchMode,
} from '@happier-dev/protocol';
import type { CodexBackendMode } from '@happier-dev/agents';

import type { AutomationTargetType } from '@/sync/domains/automations/automationTypes';

type SessionAuthoringDraftBase = Readonly<Omit<
    SessionAuthoringValueV1,
    'targetType' | 'checkoutCreationDraft' | 'backendTarget' | 'mcpSelection' | 'windowsRemoteSessionLaunchMode' | 'codexBackendMode' | 'sessionConfigOptionOverrides' | 'automation'
> & {
    targetType: AutomationTargetType;
    checkoutCreationDraft: SessionAuthoringCheckoutCreationDraftV1 | null;
    backendTarget: BackendTargetRefV1 | null;
    mcpSelection: SessionMcpSelectionV1 | null;
    windowsRemoteSessionLaunchMode: WindowsRemoteSessionLaunchMode | null;
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
