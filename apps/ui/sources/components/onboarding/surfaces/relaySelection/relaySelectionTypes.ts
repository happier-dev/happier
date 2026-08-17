import type * as React from 'react';
import type { IconName } from '@/components/ui/icons/Icon';

export type WizardChoice = Readonly<{
    id: 'cloud' | 'thisComputer' | 'remoteComputer' | 'customUrl';
    title: string;
    subtitle: string;
    icon: IconName;
    badge?: string;
    disabled?: boolean;
}>;

export type WizardProfileChoice = Readonly<{
    kind: 'profile';
    id: string;
    name: string;
    serverUrl: string;
    disabled?: boolean;
}>;
