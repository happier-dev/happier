import * as React from 'react';
import { useIsFocused } from '@react-navigation/native';
import { Platform } from 'react-native';

import { PopoverScope } from '@/components/ui/popover';
import { ModalProvider } from '@/modal';

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
    const isFocused = useIsFocused();

    return (
        <PopoverScope>
            <ModalProvider active={isFocused}>
                {props.children}
            </ModalProvider>
        </PopoverScope>
    );
}
