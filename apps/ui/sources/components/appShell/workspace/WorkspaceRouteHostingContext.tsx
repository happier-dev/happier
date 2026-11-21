import * as React from 'react';

/** The workspace owner's admission projection, independent of tab state and readiness. */
export const WorkspaceRouteHostingContext = React.createContext<((href: string) => boolean) | null>(null);

/** The web shell will host private destination bodies, including while its first route is being admitted. */
export const WorkspaceShellWillHostRoutesContext = React.createContext(false);
