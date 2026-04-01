import * as React from 'react';

import { areReactNodesStructurallyEqual } from '@/utils/react/areReactNodesStructurallyEqual';

type ToolHeaderActionsApi = Readonly<{
    setHeaderActions: (node: React.ReactNode | null) => void;
}>;

export const ToolHeaderActionsContext = React.createContext<ToolHeaderActionsApi | null>(null);

export function useToolHeaderActions(node: React.ReactNode | null) {
    const api = React.useContext(ToolHeaderActionsContext);
    const setHeaderActions = api?.setHeaderActions ?? null;
    const lastNodeRef = React.useRef<React.ReactNode | null>(null);

    React.useEffect(() => {
        if (!setHeaderActions) return;
        return () => {
            lastNodeRef.current = null;
            setHeaderActions(null);
        };
    }, [setHeaderActions]);

    React.useEffect(() => {
        if (!setHeaderActions) return;
        if (areReactNodesStructurallyEqual(lastNodeRef.current, node)) {
            return;
        }
        lastNodeRef.current = node;
        setHeaderActions(node);
    }, [node, setHeaderActions]);
}
