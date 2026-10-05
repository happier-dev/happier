import * as React from 'react';

/** The selected child of a hosted layout, independent of Expo's global navigator. */
export const WorkspaceRouteOutlet = React.createContext<React.ReactNode>(null);
