import type { View } from 'react-native';
import type { SessionSpaceMembershipTargetV1 } from '@happier-dev/protocol/actions';
import type { SessionBotFaceV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import type { NewSessionTemporaryComputerLaunch } from '../components/NewSessionLaunchSurface';

import type { NewSessionSimplePanelProps } from '@/components/sessions/new/components/NewSessionSimplePanel';
import type {
    NewSessionWizardAgentProps,
    NewSessionWizardFooterProps,
    NewSessionWizardLayoutProps,
    NewSessionWizardMachineProps,
    NewSessionWizardProfilesProps,
    NewSessionWizardProps,
} from '@/components/sessions/new/components/NewSessionWizard';
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import type { ManagedMachineSelectionDraft, ManagedMachineAcquisitionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedMachineCreationProgress } from '@/components/settings/machines/managed/managedMachineCreation';
import type { ComposerTextStore } from '@/components/sessions/agentInput/composerTextStore';
import type { SessionInstructionsAuthoringResult } from '@/sync/ops/promptLibrary/sessionInstructions';
import type { SessionInstructionsAuthoringDraft } from '@/sync/domains/state/sessionInstructionsDraft';
import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import type { ManagedMachineArchiveChoiceAvailability } from '@/components/sessions/new/components/machineSelection/managedMachineSelection';

export type NewSessionInstructionsCreationModel = Readonly<{
    titleStore: ComposerTextStore;
    markdownStore: ComposerTextStore;
    getDraft: () => SessionInstructionsAuthoringDraft | null;
    /** The draft's reserved `session.instructions` stack entry, when it attaches a Prompt Library document. */
    getEntry: () => PromptStackEntryV1 | null;
    /** Reads presentation from the shared mounted Action approval continuation. */
    getApprovalPending: () => boolean;
    /** Notifies after the draft's Instructions (authored body or attached entry) change. */
    subscribe: (listener: () => void) => () => void;
    onDraftChange: (draft: SessionInstructionsAuthoringDraft) => void;
    selectReference: (ref: PromptDocArtifactRefV1 | null) => void;
    saveDraft: () => Promise<SessionInstructionsAuthoringResult | null>;
}>;

/** The PageHeader title leaf subscribes here; typing does not render the creation screen model. */
export type NewSessionBotCreationModel = Readonly<{
    nameStore: ComposerTextStore;
    onSessionNameChange: (value: string) => void;
    /** The face the Bot will be born with (its seed is concrete); the header previews it. */
    face?: SessionBotFaceV1 | null;
    /** Keeps a face choice with the draft (no server write); absent where the draft cannot be written. */
    onFaceChange?: (face: SessionBotFaceV1 | null) => void;
}>;

/** Non-visual managed configurator transaction; CUI owns its accessory/picker presentation. */
export type NewSessionManagedMachineDraftModel = Readonly<{
    selection: ManagedMachineSelectionDraft | null;
    acquisition: ManagedMachineAcquisitionDraft | null;
    onAcquisitionChange?: (value: ManagedMachineAcquisitionDraft | null) => void;
    /** The existing scope-choice presentation uses this source's actual lifecycle boundary. */
    creationScope?: 'session' | 'task';
    select: (draft: ManagedMachineSelectionDraft, serverId?: string, options?: import('../components/machineSelection/managedMachineSelection').ManagedMachineUseOptions) => void;
    progress: ManagedMachineCreationProgress;
    /** The retained resource row while no operation reports for it (its stages, or Setup interrupted), and its page. */
    retainedMachine?: Readonly<{ machine: ManagedMachineV1; inspect: () => void }>;
    retryInstallation: () => void;
    retrySetup?: () => void;
    continueWithoutSetup?: () => void;
    deleteMachine?: () => void;
    cancel?: () => void;
    updateArchiveEffect?: (effect: ManagedMachineSelectionDraft['archiveEffect']) => void;
    archiveChoiceAvailability?: ManagedMachineArchiveChoiceAvailability | null;
}>;

export type NewSessionSimpleScreenProps = NewSessionSimplePanelProps & Readonly<{
    checkoutCreationDraft: NewSessionCheckoutCreationDraft | null;
    setCheckoutCreationDraft: React.Dispatch<React.SetStateAction<NewSessionCheckoutCreationDraft | null>>;
}>;

export type NewSessionScreenModel =
    Readonly<{
        /** Editable local draft context; presentation is supplied by the creation host. */
        spaceMembership?: SessionSpaceMembershipTargetV1 | null;
        setSpaceMembership?: (next: SessionSpaceMembershipTargetV1 | null) => void;
    }> & (
    | Readonly<{
        variant: 'simple';
        requesterIsolation?: ReturnType<typeof import('@/hooks/machine/useMachineOwnIsolationStatus').useMachineOwnIsolationStatus>;
        popoverBoundaryRef: React.RefObject<View>;
        launchOverlay: React.ReactNode | null;
        temporaryComputerLaunch?: NewSessionTemporaryComputerLaunch;
        managedMachineDraft?: NewSessionManagedMachineDraftModel;
        botCreation?: NewSessionBotCreationModel;
        instructionsCreation?: NewSessionInstructionsCreationModel;
        launchOnRequestClose: () => void;
        overlayPresentation?: 'card' | 'screen';
        overlayFocusReturnRef?: React.RefObject<View | null>;
        overlayAccessibilityLabel?: string;
        simpleProps: NewSessionSimpleScreenProps;
    }>
    | Readonly<{
        variant: 'wizard';
        requesterIsolation?: ReturnType<typeof import('@/hooks/machine/useMachineOwnIsolationStatus').useMachineOwnIsolationStatus>;
        popoverBoundaryRef: React.RefObject<View>;
        launchOverlay: React.ReactNode | null;
        temporaryComputerLaunch?: NewSessionTemporaryComputerLaunch;
        managedMachineDraft?: NewSessionManagedMachineDraftModel;
        botCreation?: NewSessionBotCreationModel;
        instructionsCreation?: NewSessionInstructionsCreationModel;
        launchOnRequestClose: () => void;
        overlayPresentation?: 'card' | 'screen';
        overlayFocusReturnRef?: React.RefObject<View | null>;
        overlayAccessibilityLabel?: string;
        wizardProps: Readonly<{
            layout: NewSessionWizardLayoutProps;
            sectionPresentation?: NewSessionWizardProps['sectionPresentation'];
            useColumnLayout?: NewSessionWizardProps['useColumnLayout'];
            profiles: NewSessionWizardProfilesProps;
            agent: NewSessionWizardAgentProps;
            machine: NewSessionWizardMachineProps;
            footer: NewSessionWizardFooterProps;
        }>;
    }>);
