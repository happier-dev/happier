import * as React from 'react';
import { createContext, useContext, useMemo, useReducer, useRef, useState } from 'react';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import type { PaneDriver, PaneScopeId } from './types';
import { appPaneReduce, createAppPaneState, type AppPaneAction, type AppPaneState, type PaneScopeState } from './model/appPaneReducer';
import { migrateLegacyDetailsWorkspaceState, serializeDetailsWorkspaceState } from './details/workspace/migrateLegacyDetailsWorkspaceState';

type AppPaneContextValue = Readonly<{
    state: AppPaneState;
    dispatch: (action: AppPaneAction) => void;
    registerDriver: (driver: PaneDriver) => () => void;
    getDriver: (scopeId: PaneScopeId) => PaneDriver | null;
    driverRegistryVersion: number;
}>;

const AppPaneContext = createContext<AppPaneContextValue | null>(null);

function normalizePersistedPaneScopes(
    value: Readonly<Record<string, {
        right: { isOpen: boolean; activeTabId: string | null; tabState: Record<string, unknown> };
        details: unknown;
        bottom: { isOpen: boolean; activeTabId: string | null; tabState: Record<string, unknown> };
    }>> | null | undefined,
): Readonly<Record<string, PaneScopeState>> {
    if (!value) return {};
    return Object.fromEntries(
        Object.entries(value).map(([scopeId, scope]) => [
            scopeId,
            {
                right: {
                    isOpen: scope.right.isOpen,
                    activeTabId: scope.right.activeTabId ?? null,
                    tabState: scope.right.tabState,
                },
                details: migrateLegacyDetailsWorkspaceState(scope.details),
                bottom: {
                    isOpen: scope.bottom.isOpen,
                    activeTabId: scope.bottom.activeTabId ?? null,
                    tabState: scope.bottom.tabState,
                },
            } satisfies PaneScopeState,
        ]),
    );
}

function serializePersistedPaneScopes(
    value: Readonly<Record<string, PaneScopeState>>,
): Record<string, {
    right: { isOpen: boolean; activeTabId: string | null; tabState: Record<string, unknown> };
    details: ReturnType<typeof serializeDetailsWorkspaceState>;
    bottom: { isOpen: boolean; activeTabId: string | null; tabState: Record<string, unknown> };
}> {
    return Object.fromEntries(
        Object.entries(value).map(([scopeId, scope]) => [
            scopeId,
            {
                right: {
                    isOpen: scope.right.isOpen,
                    activeTabId: scope.right.activeTabId,
                    tabState: { ...scope.right.tabState },
                },
                details: serializeDetailsWorkspaceState(scope.details),
                bottom: {
                    isOpen: scope.bottom.isOpen,
                    activeTabId: scope.bottom.activeTabId,
                    tabState: { ...scope.bottom.tabState },
                },
            },
        ]),
    );
}

export const AppPaneProvider = React.memo((props: Readonly<{ children: React.ReactNode }>) => {
    const persistedScopesValue = useLocalSetting('appPaneScopesV1');
    const persistedScopes = useMemo(
        () => normalizePersistedPaneScopes(persistedScopesValue),
        [persistedScopesValue],
    );
    const [, setPersistedScopes] = useLocalSettingMutable('appPaneScopesV1');
    const [state, dispatch] = useReducer(
        appPaneReduce,
        persistedScopes ?? {},
        (initialScopes) => createAppPaneState({
            maxScopesInMemory: 12,
            persistedScopes: initialScopes,
        }),
    );
    const driversRef = useRef<Map<PaneScopeId, PaneDriver>>(new Map());
    const [driverRegistryVersion, setDriverRegistryVersion] = useState(0);

    React.useEffect(() => {
        if (Object.keys(persistedScopes).length === 0) return;
        dispatch({ type: 'mergePersistedScopes', scopes: persistedScopes });
    }, [dispatch, persistedScopes]);

    React.useEffect(() => {
        setPersistedScopes(serializePersistedPaneScopes(state.scopes));
    }, [setPersistedScopes, state.scopes]);

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
