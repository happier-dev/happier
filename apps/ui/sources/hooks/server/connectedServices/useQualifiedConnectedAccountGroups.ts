import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    readConnectedServiceSettingsErrorCode,
    resolveConnectedServiceSettingsErrorMessage,
} from '@/components/settings/connectedServices/connectedServiceSettingsErrors';
import {
    createQualifiedConnectedAccountGroupsClient,
    type QualifiedConnectedAccountUiGroup,
    type QualifiedConnectedAccountUiPeerTransport,
    type QualifiedConnectedAccountUiSource,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';
import type {
    ConnectedServiceAuthGroupPolicyV1,
    PluginContributionIdentityV1,
    QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

export type QualifiedConnectedAccountPeerTransportState = Readonly<{
    status: 'loading' | 'ready' | 'error';
    transport: QualifiedConnectedAccountUiPeerTransport | null;
    error: string | null;
}>;

export type QualifiedConnectedAccountGroupsStatus =
    | 'idle'
    | 'loading'
    | 'loaded'
    | 'unsupported'
    | 'error';

export type UseQualifiedConnectedAccountGroupsResult = Readonly<{
    status: QualifiedConnectedAccountGroupsStatus;
    source: QualifiedConnectedAccountUiSource | null;
    groups: readonly QualifiedConnectedAccountUiGroup[];
    error: string | null;
    mutating: boolean;
    refresh(): Promise<void>;
    create(params: Readonly<{
        groupId: string;
        displayName: string | null;
    }>): Promise<QualifiedConnectedAccountUiGroup | null>;
    patch(params: Readonly<{
        group: QualifiedConnectedAccountUiGroup;
        displayName?: string | null;
        policy?: Partial<ConnectedServiceAuthGroupPolicyV1>;
    }>): Promise<QualifiedConnectedAccountUiGroup | null>;
    delete(group: QualifiedConnectedAccountUiGroup): Promise<boolean>;
    addMember(params: Readonly<{
        group: QualifiedConnectedAccountUiGroup;
        account: QualifiedConnectedAccountRef;
    }>): Promise<QualifiedConnectedAccountUiGroup | null>;
    patchMember(params: Readonly<{
        group: QualifiedConnectedAccountUiGroup;
        account: QualifiedConnectedAccountRef;
        enabled?: boolean;
        priority?: number;
    }>): Promise<QualifiedConnectedAccountUiGroup | null>;
    removeMember(params: Readonly<{
        group: QualifiedConnectedAccountUiGroup;
        account: QualifiedConnectedAccountRef;
    }>): Promise<QualifiedConnectedAccountUiGroup | null>;
    setActiveAccount(params: Readonly<{
        group: QualifiedConnectedAccountUiGroup;
        account: QualifiedConnectedAccountRef;
        overrideRuntimeCooldown?: boolean;
    }>): Promise<QualifiedConnectedAccountUiGroup | null>;
}>;

type State = Readonly<{
    basis: LoadBasis | null;
    status: QualifiedConnectedAccountGroupsStatus;
    source: QualifiedConnectedAccountUiSource | null;
    groups: readonly QualifiedConnectedAccountUiGroup[];
    error: string | null;
}>;

type LoadBasis = Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    service: PluginContributionIdentityV1;
    source: QualifiedConnectedAccountUiSource;
}>;

const EMPTY_STATE: State = {
    basis: null,
    status: 'idle',
    source: null,
    groups: [],
    error: null,
};

function upsertGroup(
    groups: readonly QualifiedConnectedAccountUiGroup[],
    group: QualifiedConnectedAccountUiGroup,
): readonly QualifiedConnectedAccountUiGroup[] {
    const index = groups.findIndex((candidate) => (
        candidate.ref.groupId === group.ref.groupId
        && candidate.ref.service.pluginId === group.ref.service.pluginId
        && candidate.ref.service.localId === group.ref.service.localId
    ));
    if (index === -1) return [...groups, group];
    const next = [...groups];
    next[index] = group;
    return next;
}

function isGroupRevisionConflict(error: unknown): boolean {
    const code = readConnectedServiceSettingsErrorCode(error);
    return code === 'connect_group_generation_conflict'
        || code === 'connect_group_runtime_state_revision_conflict'
        || code === 'connect_group_source_revision_conflict';
}

export function useQualifiedConnectedAccountGroups(params: Readonly<{
    serverId: string;
    service: PluginContributionIdentityV1 | null;
    peer: QualifiedConnectedAccountPeerTransportState;
}>): UseQualifiedConnectedAccountGroupsResult {
    const credentials = useAuth().credentials;
    const [state, setState] = React.useState<State>(EMPTY_STATE);
    const [mutating, setMutating] = React.useState(false);
    const servicePluginId = params.service?.pluginId ?? '';
    const serviceLocalId = params.service?.localId ?? '';

    const service = React.useMemo<PluginContributionIdentityV1 | null>(
        () => servicePluginId && serviceLocalId
            ? { pluginId: servicePluginId, localId: serviceLocalId }
            : null,
        [serviceLocalId, servicePluginId],
    );
    const source = React.useMemo<QualifiedConnectedAccountUiSource | null>(
        () => {
            if (params.peer.status !== 'ready' || !params.peer.transport) {
                return null;
            }
            if (params.peer.transport.protocol === 'v4') {
                return { protocol: 'v4' };
            }
            if (params.peer.transport.peerClass === 'revisioned-v2-v3') {
                return {
                    protocol: 'legacy-v3',
                    legacyServiceId:
                        params.peer.transport.legacyServiceId,
                };
            }
            return null;
        },
        [params.peer.status, params.peer.transport],
    );
    const basis = React.useMemo<LoadBasis | null>(
        () => credentials && params.serverId && service && source
            ? {
                credentials,
                serverId: params.serverId,
                service,
                source,
            }
            : null,
        [credentials, params.serverId, service, source],
    );
    const currentBasisRef = React.useRef(basis);
    currentBasisRef.current = basis;

    const load = React.useCallback(async (
        preserveGroups: readonly QualifiedConnectedAccountUiGroup[],
    ) => {
        if (!basis) {
            setState(EMPTY_STATE);
            return;
        }
        setState((previous) => ({
            basis,
            status: 'loading',
            source: previous.basis === basis ? previous.source : null,
            groups: previous.basis === basis ? previous.groups : [],
            error: null,
        }));
        try {
            setState({
                basis,
                status: 'loading',
                source: basis.source,
                groups: [],
                error: null,
            });
            const client = createQualifiedConnectedAccountGroupsClient({
                credentials: basis.credentials,
                service: basis.service,
                source: basis.source,
            });
            const groups = await client.list();
            if (currentBasisRef.current !== basis) return;
            setState({
                basis,
                status: 'loaded',
                source: basis.source,
                groups,
                error: null,
            });
        } catch (error) {
            if (currentBasisRef.current !== basis) return;
            setState({
                basis,
                status: 'error',
                source: basis.source,
                groups: preserveGroups,
                error: resolveConnectedServiceSettingsErrorMessage(error),
            });
        }
    }, [basis]);

    React.useEffect(() => {
        let active = true;
        if (!basis) {
            setState({
                basis: null,
                status: params.peer.status === 'loading'
                    ? 'loading'
                    : params.peer.status === 'error'
                        ? 'error'
                        : 'unsupported',
                source: null,
                groups: [],
                error: params.peer.error,
            });
            return () => {
                active = false;
            };
        }
        setState({
            basis,
            status: 'loading',
            source: null,
            groups: [],
            error: null,
        });
        void (async () => {
            try {
                setState({
                    basis,
                    status: 'loading',
                    source: basis.source,
                    groups: [],
                    error: null,
                });
                const client = createQualifiedConnectedAccountGroupsClient({
                    credentials: basis.credentials,
                    service: basis.service,
                    source: basis.source,
                });
                const groups = await client.list();
                if (!active) return;
                setState({
                    basis,
                    status: 'loaded',
                    source: basis.source,
                    groups,
                    error: null,
                });
            } catch (error) {
                if (!active) return;
                setState({
                    basis,
                    status: 'error',
                    source: basis.source,
                    groups: [],
                    error: resolveConnectedServiceSettingsErrorMessage(error),
                });
            }
        })();
        return () => {
            active = false;
        };
    }, [basis, params.peer.error, params.peer.status]);

    const visibleState: State = state.basis === basis
        ? state
        : basis
            ? {
                basis,
                status: 'loading',
                source: null,
                groups: [],
                error: null,
            }
            : {
                basis: null,
                status: params.peer.status === 'loading'
                    ? 'loading'
                    : params.peer.status === 'error'
                        ? 'error'
                        : 'unsupported',
                source: null,
                groups: [],
                error: params.peer.error,
            };

    const client = React.useMemo(
        () => basis && visibleState.source
            ? createQualifiedConnectedAccountGroupsClient({
                credentials: basis.credentials,
                service: basis.service,
                source: visibleState.source,
            })
            : null,
        [basis, visibleState.source],
    );

    const mutate = React.useCallback(async (
        operation: (
            client: ReturnType<typeof createQualifiedConnectedAccountGroupsClient>,
        ) => Promise<QualifiedConnectedAccountUiGroup>,
    ): Promise<QualifiedConnectedAccountUiGroup | null> => {
        if (!client) return null;
        const operationBasis = basis;
        setMutating(true);
        try {
            const group = await operation(client);
            if (currentBasisRef.current !== operationBasis) return null;
            setState((previous) => ({
                ...previous,
                basis,
                status: 'loaded',
                groups: upsertGroup(previous.groups, group),
                error: null,
            }));
            return group;
        } catch (error) {
            if (currentBasisRef.current !== operationBasis) return null;
            if (isGroupRevisionConflict(error)) {
                await load([]);
            }
            setState((previous) => ({
                ...previous,
                error: resolveConnectedServiceSettingsErrorMessage(error),
            }));
            return null;
        } finally {
            setMutating(false);
        }
    }, [basis, client, load]);

    return {
        status: visibleState.status,
        source: visibleState.source,
        groups: visibleState.groups,
        error: visibleState.error,
        mutating,
        refresh: React.useCallback(
            () => load(visibleState.groups),
            [load, visibleState.groups],
        ),
        create: React.useCallback(
            (input) => mutate((activeClient) => activeClient.create(input)),
            [mutate],
        ),
        patch: React.useCallback(
            (input) => mutate((activeClient) => activeClient.patch(input)),
            [mutate],
        ),
        delete: React.useCallback(async (group) => {
            if (!client) return false;
            const operationBasis = basis;
            setMutating(true);
            try {
                await client.delete(group);
                if (currentBasisRef.current !== operationBasis) return false;
                setState((previous) => ({
                    ...previous,
                    basis,
                    groups: previous.groups.filter((candidate) => (
                        candidate.ref.groupId !== group.ref.groupId
                    )),
                    error: null,
                }));
                return true;
            } catch (error) {
                if (currentBasisRef.current !== operationBasis) return false;
                if (isGroupRevisionConflict(error)) {
                    await load([]);
                }
                setState((previous) => ({
                    ...previous,
                    error: resolveConnectedServiceSettingsErrorMessage(error),
                }));
                return false;
            } finally {
                setMutating(false);
            }
        }, [basis, client, load]),
        addMember: React.useCallback(
            (input) => mutate((activeClient) => activeClient.addMember(input)),
            [mutate],
        ),
        patchMember: React.useCallback(
            (input) => mutate((activeClient) => activeClient.patchMember(input)),
            [mutate],
        ),
        removeMember: React.useCallback(
            (input) => mutate((activeClient) => activeClient.removeMember(input)),
            [mutate],
        ),
        setActiveAccount: React.useCallback(async (input) => {
            if (!client) return null;
            const operationBasis = basis;
            setMutating(true);
            try {
                const group = await client.setActiveAccount(input);
                if (currentBasisRef.current !== operationBasis) return null;
                setState((previous) => ({
                    ...previous,
                    basis,
                    status: 'loaded',
                    groups: upsertGroup(previous.groups, group),
                    error: null,
                }));
                return group;
            } catch (error) {
                if (currentBasisRef.current !== operationBasis) return null;
                if (isGroupRevisionConflict(error)) {
                    await load([]);
                }
                setState((previous) => ({
                    ...previous,
                    error: resolveConnectedServiceSettingsErrorMessage(error),
                }));
                throw error;
            } finally {
                setMutating(false);
            }
        }, [basis, client, load]),
    };
}
