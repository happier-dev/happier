import type { IconName } from '@/components/ui/icons/Icon';

export type WizardChoice = Readonly<{
    id: 'cloud' | 'thisComputer' | 'remoteComputer' | 'customUrl';
    title: string;
    subtitle: string;
    icon: IconName;
    badge?: string;
    disabled?: boolean;
}>;
