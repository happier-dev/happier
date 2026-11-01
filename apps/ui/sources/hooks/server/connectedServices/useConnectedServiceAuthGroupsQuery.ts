import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { listConnectedServiceAuthGroupsV3 } from '@/sync/api/account/apiConnectedServiceAuthGroupsV3';
import { useConnectedServiceGroupsRefreshSignal } from '@/sync/domains/connectedServices/connectedServiceGroupsRefreshSignal';
import type { ConnectedServiceAuthGroupV1, ConnectedServiceId } from '@happier-dev/protocol';

export type ConnectedServiceAuthGroupsLoadStatus = 'idle' | 'loading' | 'refreshing' | 'loaded' | 'error';

const CONNECTED_SERVICE_AUTH_GROUPS_LOAD_STATUS_KEY = '__connectedServiceAuthGroupsLoadStatus';

type GroupsWithLoadStatus = ReadonlyArray<ConnectedServiceAuthGroupV1> & Readonly<{
    [CONNECTED_SERVICE_AUTH_GROUPS_LOAD_STATUS_KEY]?: ConnectedServiceAuthGroupsLoadStatus;
}>;

type State = Readonly<{
    groups: ReadonlyArray<ConnectedServiceAuthGroupV1>;
    loadStatus: ConnectedServiceAuthGroupsLoadStatus;
    hasLoaded: boolean;
}>;

const EMPTY_STATE: State = { groups: [], loadStatus: 'idle', hasLoaded: false };

function withLoadStatus(
    groups: ReadonlyArray<ConnectedServiceAuthGroupV1>,
    loadStatus: ConnectedServiceAuthGroupsLoadStatus,
): GroupsWithLoadStatus {
    const tagged = groups.slice() as ConnectedServiceAuthGroupV1[] & {
        [CONNECTED_SERVICE_AUTH_GROUPS_LOAD_STATUS_KEY]?: ConnectedServiceAuthGroupsLoadStatus;
    };
    Object.defineProperty(tagged, CONNECTED_SERVICE_AUTH_GROUPS_LOAD_STATUS_KEY, {
        value: loadStatus,
        enumerable: false,
        configurable: true,
    });
    return tagged;
}

export function readConnectedServiceAuthGroupsLoadStatus(value: unknown): ConnectedServiceAuthGroupsLoadStatus | undefined {
    if (!Array.isArray(value)) return undefined;
    const status = (value as GroupsWithLoadStatus)[CONNECTED_SERVICE_AUTH_GROUPS_LOAD_STATUS_KEY];
    return status === 'idle' || status === 'loading' || status === 'refreshing' || status === 'loaded' || status === 'error'
        ? status
        : undefined;
}

export function useConnectedServiceAuthGroupsQuery(params: Readonly<{
    serviceId: ConnectedServiceId | null;
    enabled: boolean;
    serviceProjectionSignature: string;
}>): Readonly<{
    groups: ReadonlyArray<ConnectedServiceAuthGroupV1>;
    loadStatus: ConnectedServiceAuthGroupsLoadStatus;
    refresh: () => Promise<ReadonlyArray<ConnectedServiceAuthGroupV1>>;
    upsertGroup: (group: ConnectedServiceAuthGroupV1) => void;
}> {
    const auth = useAuth();
    const credentials = auth.credentials ?? null;
    const refreshSignal = useConnectedServiceGroupsRefreshSignal();
    const [state, setState] = React.useState<State>(EMPTY_STATE);
    const loadedServiceIdRef = React.useRef<ConnectedServiceId | null>(null);

    const fetchGroups = React.useCallback(async () => {
        if (!params.serviceId || !params.enabled || !credentials) return [];
        try {
            return await listConnectedServiceAuthGroupsV3(credentials, { serviceId: params.serviceId });
        } catch (error) {
            console.warn('[connectedServices] Failed to load authoritative account pools', { serviceId: params.serviceId });
            throw error;
        }
    }, [credentials, params.enabled, params.serviceId]);

    const refresh = React.useCallback(async () => {
        setState((prev) => ({
            ...prev,
            loadStatus: prev.hasLoaded || prev.groups.length > 0 ? 'refreshing' : 'loading',
        }));
        try {
            const groups = await fetchGroups();
            setState({ groups, loadStatus: 'loaded', hasLoaded: true });
            return groups;
        } catch (error) {
            setState((prev) => ({
                groups: prev.hasLoaded ? prev.groups : [],
                loadStatus: 'error',
                hasLoaded: prev.hasLoaded,
            }));
            throw error;
        }
    }, [fetchGroups]);

    React.useEffect(() => {
        let cancelled = false;
        if (!params.serviceId || !params.enabled || !credentials) {
            loadedServiceIdRef.current = params.serviceId;
            setState(EMPTY_STATE);
            return () => { cancelled = true; };
        }

        const serviceChanged = loadedServiceIdRef.current !== params.serviceId;
        loadedServiceIdRef.current = params.serviceId;
        setState((prev) => ({
            groups: serviceChanged ? [] : prev.groups,
            hasLoaded: serviceChanged ? false : prev.hasLoaded,
            loadStatus: serviceChanged || (!prev.hasLoaded && prev.groups.length === 0) ? 'loading' : 'refreshing',
        }));
        void fetchGroups().then(
            (groups) => {
                if (!cancelled) setState({ groups, loadStatus: 'loaded', hasLoaded: true });
            },
            () => {
                if (!cancelled) {
                    setState((prev) => ({
                        groups: prev.hasLoaded ? prev.groups : [],
                        loadStatus: 'error',
                        hasLoaded: prev.hasLoaded,
                    }));
                }
            },
        );
        return () => { cancelled = true; };
    }, [credentials, fetchGroups, params.enabled, params.serviceId, params.serviceProjectionSignature, refreshSignal]);

    const upsertGroup = React.useCallback((group: ConnectedServiceAuthGroupV1) => {
        setState((prev) => {
            const index = prev.groups.findIndex((candidate) => candidate.groupId === group.groupId);
            const groups = index === -1 ? [...prev.groups, group] : [...prev.groups];
            if (index !== -1) groups[index] = group;
            return { groups, loadStatus: 'loaded', hasLoaded: true };
        });
    }, []);

    return {
        groups: React.useMemo(() => withLoadStatus(state.groups, state.loadStatus), [state.groups, state.loadStatus]),
        loadStatus: state.loadStatus,
        refresh,
        upsertGroup,
    };
}
