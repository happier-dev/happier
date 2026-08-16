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

/**
 * COORDINATE-SPACE INVARIANT (native).
 *
 * `PopoverScope` publishes the popover measurement root: the `View` that
 * `usePopoverPortalTarget().rootRef` points at, and the space every portal-relative anchor rect is
 * expressed in. The nested `ModalProvider` installs its OWN `OverlayPortalProvider` +
 * `OverlayPortalHost`, so on this screen popovers RENDER into the modal provider's host while they
 * MEASURE against the scope's root view. (`PopoverScope`'s own host is shadowed here; it is still
 * the live host on the screens that use `PopoverScope` without a nested `ModalProvider`, such as
 * `SidebarView` and `DirectSessionsBrowseScreen`.)
 *
 * Those two views coincide only because `ModalProvider` renders no `View` between them — its host
 * is an `absoluteFill` whose nearest ancestor view is the `PopoverScope` root. Insert any wrapper
 * view in that gap and every popover on this screen silently shifts by that view's origin — with no
 * test to catch it. If `ModalProvider` ever needs to render a wrapping view, this screen must stop
 * nesting the two providers (or `Popover` must measure the host it actually renders into).
 */
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
