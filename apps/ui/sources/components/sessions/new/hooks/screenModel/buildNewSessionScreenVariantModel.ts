import type { View } from 'react-native';

import type { NewSessionSimplePanelProps } from '@/components/sessions/new/components/NewSessionSimplePanel';
import type {
    NewSessionWizardAgentProps,
    NewSessionWizardFooterProps,
    NewSessionWizardLayoutProps,
    NewSessionWizardMachineProps,
    NewSessionWizardProfilesProps,
} from '@/components/sessions/new/components/NewSessionWizard';
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
    wizardLayoutProps: NewSessionWizardLayoutProps;
    wizardProfilesProps: NewSessionWizardProfilesProps;
    wizardAgentProps: NewSessionWizardAgentProps;
    wizardMachineProps: NewSessionWizardMachineProps;
    wizardFooterProps: NewSessionWizardFooterProps;
}>): NewSessionScreenModel {
    if (!params.useEnhancedSessionWizard) {
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
            layout: params.wizardLayoutProps,
            profiles: params.wizardProfilesProps,
            agent: params.wizardAgentProps,
            machine: params.wizardMachineProps,
            footer: params.wizardFooterProps,
        },
    };
}
