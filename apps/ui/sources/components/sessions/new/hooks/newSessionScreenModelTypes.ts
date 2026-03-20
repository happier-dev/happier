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

export type NewSessionSimpleScreenProps = NewSessionSimplePanelProps & Readonly<{
    checkoutCreationDraft: NewSessionCheckoutCreationDraft | null;
    setCheckoutCreationDraft: React.Dispatch<React.SetStateAction<NewSessionCheckoutCreationDraft | null>>;
}>;

export type NewSessionScreenModel =
    | Readonly<{
        variant: 'simple';
        popoverBoundaryRef: React.RefObject<View>;
        simpleProps: NewSessionSimpleScreenProps;
    }>
    | Readonly<{
        variant: 'wizard';
        popoverBoundaryRef: React.RefObject<View>;
        wizardProps: Readonly<{
            layout: NewSessionWizardLayoutProps;
            profiles: NewSessionWizardProfilesProps;
            agent: NewSessionWizardAgentProps;
            machine: NewSessionWizardMachineProps;
            footer: NewSessionWizardFooterProps;
        }>;
    }>;
