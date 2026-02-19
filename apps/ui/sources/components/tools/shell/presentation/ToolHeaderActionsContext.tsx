import * as React from 'react';

type ToolHeaderActionsApi = Readonly<{
    setHeaderActions: (node: React.ReactNode | null) => void;
}>;

export const ToolHeaderActionsContext = React.createContext<ToolHeaderActionsApi | null>(null);

export function useToolHeaderActions(node: React.ReactNode | null) {
    const api = React.useContext(ToolHeaderActionsContext);

    React.useEffect(() => {
        if (!api) return;
        api.setHeaderActions(node);
        return () => api.setHeaderActions(null);
    }, [api, node]);
}

