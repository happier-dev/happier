import * as React from 'react';
import type { TabType } from '@/components/ui/navigation/tabTypes';
import { vi } from 'vitest';

export type MainAppTabStateMockOptions = Readonly<{
    activeTab?: TabType;
    isLoading?: boolean;
    setActiveTab?: (tab: TabType) => Promise<void>;
}>;

export function createMainAppTabStateProviderMock(options: MainAppTabStateMockOptions = {}) {
    const setActiveTab = vi.fn(options.setActiveTab ?? (async () => {}));
    const state = {
        activeTab: options.activeTab ?? 'sessions',
        setActiveTab,
        isLoading: options.isLoading ?? false,
    } satisfies Readonly<{
        activeTab: TabType;
        setActiveTab: (tab: TabType) => Promise<void>;
        isLoading: boolean;
    }>;

    return {
        spies: {
            setActiveTab,
        },
        state,
        module: {
            MainAppTabStateProvider: ({ children }: { children?: React.ReactNode }) =>
                React.createElement(React.Fragment, null, children ?? null),
            useMainAppTabState: () => state,
        },
    };
}
