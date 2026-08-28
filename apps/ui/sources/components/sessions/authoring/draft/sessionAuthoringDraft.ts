import type {
    AcpConfigOptionOverridesV1,
    SessionAuthoringCheckoutCreationDraftV1,
    RuntimeDescriptorV1,
    SessionAuthoringTerminalV1,
    SessionAuthoringValueV1,
    SessionMcpSelectionV1,
    WindowsRemoteSessionLaunchMode,
} from '@happier-dev/protocol';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';

type SessionAuthoringDraftBase = Readonly<Omit<
    SessionAuthoringValueV1,
    'targetType' | 'checkoutCreationDraft' | 'modelSelection' | 'mcpSelection' | 'windowsRemoteSessionLaunchMode' | 'windowsTerminalWindowName' | 'runtimeDescriptorV1' | 'sessionConfigOptionOverrides' | 'automation'
> & {
    targetType: SessionAuthoringValueV1['targetType'];
    checkoutCreationDraft: SessionAuthoringCheckoutCreationDraftV1 | null;
    modelSelection?: SessionAuthoringValueV1['modelSelection'];
    mcpSelection: SessionMcpSelectionV1 | null;
    windowsRemoteSessionLaunchMode: WindowsRemoteSessionLaunchMode | null;
    windowsTerminalWindowName?: string | null;
    runtimeDescriptorV1?: RuntimeDescriptorV1 | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    automation?: NewSessionAutomationDraft | null;
}>;

export type SessionAuthoringDraft = Readonly<SessionAuthoringDraftBase & {
    connectedServices: SessionAuthoringValueV1['connectedServices'];
    terminal: SessionAuthoringTerminalV1 | null;
}>;
