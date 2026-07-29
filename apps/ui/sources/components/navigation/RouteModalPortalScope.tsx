import * as React from 'react';
import { useIsFocused } from '@react-navigation/native';

import { PopoverScope } from '@/components/ui/popover';
import { ModalProvider } from '@/modal';

/**
 * Portal scope for routes presented modally (e.g. `/new`, settings on tablet/desktop).
 *
 * A modal route renders above the rest of the navigation stack, so popovers and
 * in-screen modals opened from inside it must portal into a boundary scoped to the
 * focused modal — otherwise they can mount behind the modal or leak across routes.
 * Wrapping the modal's content in this scope keeps the `@/modal` and popover portals
 * anchored to the modal while it is focused.
 *
 * This is the canonical shared scaffold; domain modules (e.g. the new-session
 * navigation helpers) re-export it rather than reimplementing the wrapper.
 */
export function RouteModalPortalScope(props: Readonly<{ children: React.ReactNode }>) {
    const isFocused = useIsFocused();

    return (
        <PopoverScope>
            <ModalProvider active={isFocused}>
                {props.children}
            </ModalProvider>
        </PopoverScope>
    );
}
