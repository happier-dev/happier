import * as React from 'react';

/** A surface dialog consumes the title already chosen by its mounted refusal presenter. */
export const PluginSurfaceStateTitleContext = React.createContext<((title: string | null) => void) | undefined>(undefined);

export function usePublishPluginSurfaceStateTitle(title: string | null): void {
    const publishTitle = React.useContext(PluginSurfaceStateTitleContext);
    React.useEffect(() => {
        publishTitle?.(title);
        return () => publishTitle?.(null);
    }, [publishTitle, title]);
}
