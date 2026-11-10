import type { View } from 'react-native';
import type { NewSessionTemporaryComputerLaunch } from '../../components/NewSessionLaunchSurface';

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
import type {
    NewSessionScreenModel,
    NewSessionSimpleScreenProps,
    NewSessionManagedMachineDraftModel,
    NewSessionBotCreationModel,
    NewSessionInstructionsCreationModel,
} from '@/components/sessions/new/hooks/newSessionScreenModelTypes';
import { buildNewSessionManagedProgressBadge } from './newSessionManagedProgressBadge';
import { buildSessionAuthoringCredentialOperands } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { presentActionApproval } from '@/components/approvals/actionApprovalPresentation';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveCapturedTeamCredentialApprovalSources } from '@happier-dev/protocol/actions/specs/teamCredentialApproval';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';

export function buildNewSessionScreenVariantModel(params: Readonly<{
    useEnhancedSessionWizard: boolean;
    spaceMembership?: NewSessionScreenModel['spaceMembership'];
    setSpaceMembership?: NewSessionScreenModel['setSpaceMembership'];
    requesterIsolation?: NewSessionScreenModel['requesterIsolation'];
    creationReview?: Readonly<{
        draft: Parameters<typeof buildSessionAuthoringCredentialOperands>[0];
        serverId: string | null;
        teamCredentialPresentation?: ActionExecutorContext['teamCredentialPresentation'];
    }>;
    popoverBoundaryRef: React.RefObject<View>;
    launchOverlay: React.ReactNode | null;
    temporaryComputerLaunch?: NewSessionTemporaryComputerLaunch;
    managedMachineDraft?: NewSessionManagedMachineDraftModel;
    botCreation?: NewSessionBotCreationModel;
    instructionsCreation?: NewSessionInstructionsCreationModel;
    launchOnRequestClose?: () => void;
    overlayPresentation?: 'card' | 'screen';
    overlayFocusReturnRef?: React.RefObject<View | null>;
    overlayAccessibilityLabel?: string;
    simplePanelProps: NewSessionSimplePanelProps;
    checkoutCreationDraft: NewSessionCheckoutCreationDraft | null;
    setCheckoutCreationDraft: React.Dispatch<React.SetStateAction<NewSessionCheckoutCreationDraft | null>>;
    wizardLayoutProps: NewSessionWizardLayoutProps;
    wizardSectionPresentation?: NewSessionWizardProps['sectionPresentation'];
    wizardUseColumnLayout?: NewSessionWizardProps['useColumnLayout'];
    wizardProfilesProps: NewSessionWizardProfilesProps;
    wizardAgentProps: NewSessionWizardAgentProps;
    wizardMachineProps: NewSessionWizardMachineProps;
    wizardFooterProps: NewSessionWizardFooterProps;
}>): NewSessionScreenModel {
    const actionArgs = params.creationReview ? buildSessionAuthoringCredentialOperands(params.creationReview.draft) : null;
    const selectedSources = params.creationReview ? resolveCapturedTeamCredentialApprovalSources({
        selection: getActionSpec('session.spawn_new').approvalPresentation?.teamCredentialSources?.(actionArgs),
        context: { serverId: params.creationReview.serverId, teamCredentialPresentation: params.creationReview.teamCredentialPresentation },
    }) : [];
    const creationReviewSummary = selectedSources.length ? presentActionApproval({
        actionId: 'session.spawn_new', actionArgs, preview: { teamCredentialSources: selectedSources },
    }).summary : null;
    const managedProgressBadge = buildNewSessionManagedProgressBadge(params.managedMachineDraft);
    // A Bot is an ordinary composer and an ordinary first turn (lab `b-new`): never the wizard.
    if (!params.useEnhancedSessionWizard || params.botCreation) {
        const simpleProps: NewSessionSimpleScreenProps = {
            ...params.simplePanelProps,
            creationReviewSummary,
            managedMachineDraft: params.managedMachineDraft,
            ...(managedProgressBadge ? { statusBadges: [...(params.simplePanelProps.statusBadges ?? []), managedProgressBadge] } : {}),
            checkoutCreationDraft: params.checkoutCreationDraft,
            setCheckoutCreationDraft: params.setCheckoutCreationDraft,
            // The composer draws the requester's folder hint with its launch notices.
            requesterIsolation: params.requesterIsolation,
        };

        return {
            variant: 'simple',
            spaceMembership: params.spaceMembership,
            setSpaceMembership: params.setSpaceMembership,
            requesterIsolation: params.requesterIsolation,
            popoverBoundaryRef: params.popoverBoundaryRef,
            launchOverlay: params.launchOverlay,
            temporaryComputerLaunch: params.temporaryComputerLaunch,
            managedMachineDraft: params.managedMachineDraft,
            botCreation: params.botCreation,
            instructionsCreation: params.instructionsCreation,
            launchOnRequestClose: params.launchOnRequestClose ?? (() => undefined),
            overlayPresentation: params.overlayPresentation,
            overlayFocusReturnRef: params.overlayFocusReturnRef,
            overlayAccessibilityLabel: params.overlayAccessibilityLabel,
            simpleProps,
        };
    }

    return {
        variant: 'wizard',
        spaceMembership: params.spaceMembership,
        setSpaceMembership: params.setSpaceMembership,
        requesterIsolation: params.requesterIsolation,
        popoverBoundaryRef: params.popoverBoundaryRef,
        launchOverlay: params.launchOverlay,
        temporaryComputerLaunch: params.temporaryComputerLaunch,
        managedMachineDraft: params.managedMachineDraft,
        botCreation: params.botCreation,
        instructionsCreation: params.instructionsCreation,
        launchOnRequestClose: params.launchOnRequestClose ?? (() => undefined),
        overlayPresentation: params.overlayPresentation,
        overlayFocusReturnRef: params.overlayFocusReturnRef,
        overlayAccessibilityLabel: params.overlayAccessibilityLabel,
        wizardProps: {
            layout: params.wizardLayoutProps,
            sectionPresentation: params.wizardSectionPresentation,
            useColumnLayout: params.wizardUseColumnLayout,
            profiles: params.wizardProfilesProps,
            agent: params.wizardAgentProps,
            machine: params.wizardMachineProps,
            // The wizard draws the requester's folder hint with its launch notices, as the composer does.
            footer: {
                ...params.wizardFooterProps,
                creationReviewSummary,
                requesterIsolation: params.requesterIsolation,
                ...(managedProgressBadge ? { statusBadges: [...(params.wizardFooterProps.statusBadges ?? []), managedProgressBadge] } : {}),
            },
        },
    };
}
