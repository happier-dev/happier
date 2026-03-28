import * as React from 'react';
import { Platform } from 'react-native';

import { PopoverPortalTargetProvider } from '@/components/ui/popover';

export function createNewSessionContainedModalScreenOptions(params: Readonly<{
    title: string;
    headerBackTitle: string;
    headerShown?: boolean;
}>) {
    return {
        headerShown: params.headerShown ?? true,
        title: params.title,
        headerTitle: params.title,
        headerBackTitle: params.headerBackTitle,
        presentation: Platform.OS === 'ios' ? ('containedModal' as const) : undefined,
    } as const;
}

export function NewSessionScreenPortalScope(props: Readonly<{ children: React.ReactNode }>) {
    return (
        <PopoverPortalTargetProvider>
            {props.children}
        </PopoverPortalTargetProvider>
    );
}
