import { createContext } from 'react';
import type { PluginUiPageNavigationProjectionV1 } from '@happier-dev/protocol/plugins/ui/pageNavigation';

/** The existing context factory carries this same projection to both physical renderers. */
export const PluginPageNavigationContext = createContext<PluginUiPageNavigationProjectionV1 | null>(null);
