import * as React from 'react';

import type { useDaemonVoiceModelCatalogState } from './useDaemonVoiceModelCatalogState';

export type DaemonVoiceModelCatalogController = ReturnType<typeof useDaemonVoiceModelCatalogState>;

const Context = React.createContext<DaemonVoiceModelCatalogController | null>(null);

export const DaemonVoiceModelCatalogProvider = Context.Provider;

export function useDaemonVoiceModelCatalogController(): DaemonVoiceModelCatalogController | null {
    return React.useContext(Context);
}
