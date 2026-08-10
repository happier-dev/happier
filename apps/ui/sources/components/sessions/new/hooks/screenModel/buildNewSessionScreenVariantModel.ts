import type { View } from 'react-native';

import type { NewSessionSimplePanelProps } from '@/components/sessions/new/components/NewSessionSimplePanel';
import type { NewSessionWizardProfilesProps } from '@/components/sessions/new/components/NewSessionWizard';
import type { NewSessionWizardSectionProps } from '@/components/sessions/new/hooks/useNewSessionWizardProps';
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import type {
    NewSessionScreenModel,
    NewSessionSimpleScreenProps,
} from '@/components/sessions/new/hooks/newSessionScreenModelTypes';
export function buildNewSessionScreenVariantModel(params: Readonly<{
    useEnhancedSessionWizard: boolean;
    popoverBoundaryRef: React.RefObject<View>;
    simplePanelProps: NewSessionSimplePanelProps;
    checkoutCreationDraft: NewSessionCheckoutCreationDraft | null;
    setCheckoutCreationDraft: React.Dispatch<React.SetStateAction<NewSessionCheckoutCreationDraft | null>>;
    wizardProfilesProps: NewSessionWizardProfilesProps;
    /** Built only when the wizard variant is active; `null` for the simple panel. */
    wizardSections: NewSessionWizardSectionProps | null;
}>): NewSessionScreenModel {
    if (!params.useEnhancedSessionWizard || !params.wizardSections) {
        const simpleProps: NewSessionSimpleScreenProps = {
            ...params.simplePanelProps,
            checkoutCreationDraft: params.checkoutCreationDraft,
            setCheckoutCreationDraft: params.setCheckoutCreationDraft,
        };

        return {
            variant: 'simple',
            popoverBoundaryRef: params.popoverBoundaryRef,
            simpleProps,
        };
    }

    return {
        variant: 'wizard',
        popoverBoundaryRef: params.popoverBoundaryRef,
        wizardProps: {
            layout: params.wizardSections.layout,
            sectionPresentation: params.wizardSections.sectionPresentation,
            useColumnLayout: params.wizardSections.useColumnLayout,
            profiles: params.wizardProfilesProps,
            agent: params.wizardSections.agent,
            machine: params.wizardSections.machine,
            footer: params.wizardSections.footer,
        },
    };
}
