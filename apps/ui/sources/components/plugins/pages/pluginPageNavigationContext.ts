import { createContext } from 'react';
import type { PluginUiPageNavigationProjectionV1 } from '@happier-dev/protocol/plugins/ui/pageNavigation';
import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';

/** The existing context factory carries this same projection to both physical renderers. */
export const PluginPageNavigationContext = createContext<PluginUiPageNavigationProjectionV1 | null>(null);

/** A page companion's opener: the page's launch input and current location, provided only around that companion. */
export type PluginCompanionOpenedFrom = NonNullable<SurfaceContext['openedFrom']>;
export const PluginCompanionOpenedFromContext = createContext<PluginCompanionOpenedFrom | null>(null);
