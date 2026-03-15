import * as React from 'react';
import { createContext, useContext, useMemo, useReducer, useRef, useState } from 'react';
import type { PaneDriver, PaneScopeId } from './types';
import { appPaneReduce, createAppPaneState, type AppPaneAction, type AppPaneState } from './model/appPaneReducer';

type AppPaneContextValue = Readonly<{
    state: AppPaneState;
    dispatch: (action: AppPaneAction) => void;
    registerDriver: (driver: PaneDriver) => () => void;
    getDriver: (scopeId: PaneScopeId) => PaneDriver | null;
    driverRegistryVersion: number;
}>;

const AppPaneContext = createContext<AppPaneContextValue | null>(null);

export const AppPaneProvider = React.memo((props: Readonly<{ children: React.ReactNode }>) => {
    const [state, dispatch] = useReducer(appPaneReduce, createAppPaneState({ maxScopesInMemory: 12 }));
    const driversRef = useRef<Map<PaneScopeId, PaneDriver>>(new Map());
    const [driverRegistryVersion, setDriverRegistryVersion] = useState(0);

    const registerDriver = React.useCallback((driver: PaneDriver) => {
        driversRef.current.set(driver.scopeId, driver);
        setDriverRegistryVersion((v) => v + 1);
        return () => {
            const current = driversRef.current.get(driver.scopeId);
            if (current === driver) {
                driversRef.current.delete(driver.scopeId);
                setDriverRegistryVersion((v) => v + 1);
            }
        };
    }, []);

    const getDriver = React.useCallback((scopeId: PaneScopeId) => {
        return driversRef.current.get(scopeId) ?? null;
    }, []);

    const value: AppPaneContextValue = useMemo(() => ({
        state,
        dispatch,
        registerDriver,
        getDriver,
        driverRegistryVersion,
    }), [driverRegistryVersion, dispatch, getDriver, registerDriver, state]);

    return <AppPaneContext.Provider value={value}>{props.children}</AppPaneContext.Provider>;
});

export function useAppPaneContext(): AppPaneContextValue {
    const ctx = useContext(AppPaneContext);
    if (!ctx) throw new Error('useAppPaneContext must be used within <AppPaneProvider>');
    return ctx;
}

export function useOptionalAppPaneContext(): AppPaneContextValue | null {
    return useContext(AppPaneContext);
}
