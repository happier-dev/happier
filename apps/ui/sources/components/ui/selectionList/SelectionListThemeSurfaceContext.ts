import * as React from 'react';
import type { ThemeSelectionSurfaceBinding } from '@happier-dev/plugin-ui/presentation';

/** One explicit semantic binding shared by the list's existing row and section owners. */
export const SelectionListThemeSurfaceContext = React.createContext<ThemeSelectionSurfaceBinding | undefined>(undefined);
