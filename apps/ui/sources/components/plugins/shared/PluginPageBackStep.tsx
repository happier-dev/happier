import * as React from 'react';

import type { PluginPageLocationOwner } from '@/components/plugins/pages/pluginPageLocation';

const PluginPageBackStepContext = React.createContext(false);

/**
 * Whether the page declares a detail source in the navigation's own history
 * (`pluginPageLocation`). The page's chrome reads it so a pushed detail does not
 * draw a second Back beside the one the header already answers.
 */
export function PluginPageBackStepProvider(props: Readonly<{
    owner: Pick<PluginPageLocationOwner, 'hasBackStep' | 'subscribe'>;
    children: React.ReactNode;
}>): React.ReactElement {
    const armed = React.useSyncExternalStore(props.owner.subscribe, props.owner.hasBackStep, props.owner.hasBackStep);
    return <PluginPageBackStepContext.Provider value={armed}>{props.children}</PluginPageBackStepContext.Provider>;
}

export function usePluginPageBackStepArmed(): boolean {
    return React.useContext(PluginPageBackStepContext);
}
