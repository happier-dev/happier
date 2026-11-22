import * as React from 'react';

/** The workspace owner's admission projection, independent of tab state and readiness. */
export const WorkspaceRouteHostingContext = React.createContext<((href: string) => boolean) | null>(null);

/** The web shell will host private destination bodies, including while its first route is being admitted. */
export const WorkspaceShellWillHostRoutesContext = React.createContext(false);

/** Keeps the phone Home selected by a live entry through the first Account's navigator remount. */
export const WorkspacePhoneHomeArrivalContext = React.createContext<{
    defer: (href: '/home') => boolean;
    take: () => '/home' | null;
} | null>(null);
