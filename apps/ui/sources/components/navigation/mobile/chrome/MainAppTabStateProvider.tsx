import * as React from 'react';

import { useTabState } from '@/hooks/ui/useTabState';
import type { TabType } from '@/components/ui/navigation/tabTypes';

type MainAppTabStateValue = Readonly<{
    activeTab: TabType;
    setActiveTab: (tab: TabType) => Promise<void>;
    isLoading: boolean;
}>;

const MainAppTabStateContext = React.createContext<MainAppTabStateValue | null>(null);

export const MainAppTabStateProvider = React.memo((props: Readonly<{ children: React.ReactNode }>) => {
    const value = useTabState();
    return (
        <MainAppTabStateContext.Provider value={value}>
            {props.children}
        </MainAppTabStateContext.Provider>
    );
});

export function useMainAppTabState(): MainAppTabStateValue {
    const value = React.useContext(MainAppTabStateContext);
    if (!value) {
        throw new Error('useMainAppTabState must be used within MainAppTabStateProvider');
    }
    return value;
}
