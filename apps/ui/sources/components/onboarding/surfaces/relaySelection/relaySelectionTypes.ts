import type * as React from 'react';
import type { Ionicons } from '@expo/vector-icons';

export type WizardChoice = Readonly<{
    id: 'cloud' | 'thisComputer' | 'remoteComputer' | 'customUrl';
    title: string;
    subtitle: string;
    icon: React.ComponentProps<typeof Ionicons>['name'];
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
