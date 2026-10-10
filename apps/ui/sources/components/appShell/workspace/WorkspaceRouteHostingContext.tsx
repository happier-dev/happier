import * as React from 'react';

/** The workspace owner's admission projection, independent of tab state and readiness. */
export const WorkspaceRouteHostingContext = React.createContext<((href: string) => boolean) | null>(null);
