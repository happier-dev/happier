import * as React from 'react';

/** Retained dialogs own presentation separately from their open and close lifecycle. */
export const ModalRoutePresentationContext = React.createContext<Readonly<{
    suspended: boolean;
    willNavigate(href: string): void;
}> | null>(null);
