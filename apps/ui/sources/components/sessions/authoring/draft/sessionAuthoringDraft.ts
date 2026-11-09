import type {
    AcpConfigOptionOverridesV1} from '@happier-dev/protocol/sessions/metadata/overrides';
import type {
    SessionAuthoringCheckoutCreationDraftV1,
    SessionAuthoringTerminalV1,
    SessionAuthoringValueV1} from '@happier-dev/protocol/sessions/authoring/index';
import type {
    RuntimeDescriptorV1} from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import type {
    SessionCapabilitySelectionV1} from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import type {
    WindowsRemoteSessionLaunchMode,
} from '@happier-dev/protocol/sessions/metadata/windowsRemoteSessionLaunchMode';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import type { SessionTeamCredentialBindingIntentListV1 } from '@happier-dev/protocol/teams';
import type { SessionIdentityAdditions } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import type { SessionPromptStackV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import type { SessionInstructionsAuthoringDraft } from '@/sync/domains/state/sessionInstructionsDraft';

type SessionAuthoringDraftBase = Readonly<Omit<
    SessionAuthoringValueV1,
    'targetType' | 'checkoutCreationDraft' | 'modelSelection' | 'capabilitySelection' | 'windowsRemoteSessionLaunchMode' | 'windowsTerminalWindowName' | 'runtimeDescriptorV1' | 'sessionConfigOptionOverrides' | 'automation' | 'promptStack'
> & {
    targetType: SessionAuthoringValueV1['targetType'];
    checkoutCreationDraft: SessionAuthoringCheckoutCreationDraftV1 | null;
    modelSelection?: SessionAuthoringValueV1['modelSelection'];
    capabilitySelection: SessionCapabilitySelectionV1 | null;
    windowsRemoteSessionLaunchMode: WindowsRemoteSessionLaunchMode | null;
    windowsTerminalWindowName?: string | null;
    runtimeDescriptorV1?: RuntimeDescriptorV1 | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    automation?: NewSessionAutomationDraft | null;
}>;

export type SessionAuthoringDraft = Readonly<SessionAuthoringDraftBase & {
    sessionName?: string;
    initialSessionFacts?: SessionIdentityAdditions;
    memoryEnabled?: boolean;
    promptStack?: SessionPromptStackV1;
    instructionsDraft?: SessionInstructionsAuthoringDraft | null;
    connectedServices: SessionAuthoringValueV1['connectedServices'];
    terminal: SessionAuthoringTerminalV1 | null;
    primaryTeamId?: string | null;
    teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
}>;
