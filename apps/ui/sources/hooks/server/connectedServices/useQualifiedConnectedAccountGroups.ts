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
    const index = groups.findIndex((candidate) => sameGroupRef(candidate, group));
    if (index === -1) return [...groups, group];
    const next = [...groups];
    next[index] = group;
    return next;
}

function sameGroupRef(
    left: QualifiedConnectedAccountUiGroup,
    right: QualifiedConnectedAccountUiGroup,
): boolean {
    return left.ref.groupId === right.ref.groupId
        && left.ref.service.pluginId === right.ref.service.pluginId
        && left.ref.service.localId === right.ref.service.localId;
}

function sameGroupRevision(
    left: QualifiedConnectedAccountUiGroup,
    right: QualifiedConnectedAccountUiGroup,
): boolean {
    const leftRevision = left.revision;
    const rightRevision = right.revision;
    if (leftRevision.protocol !== rightRevision.protocol) return false;
    if (leftRevision.generation !== rightRevision.generation) return false;
    return leftRevision.protocol === 'legacy-v3'
        || (
            rightRevision.protocol === 'v4'
            && leftRevision.incarnation === rightRevision.incarnation
            && leftRevision.runtimeStateRevision === rightRevision.runtimeStateRevision
        );
}

/**
 * Group actions are fenced by the revision they sent to the peer. A freshly
 * listed group with the same id but a different generation/revision is a newer
 * authority (or a recreated group), so a late response must not replace it.
 */
function isCurrentGroupRevision(params: Readonly<{
    state: State;
    basis: LoadBasis | null;
    group: QualifiedConnectedAccountUiGroup;
}>): boolean {
    return params.state.basis === params.basis
        && params.state.groups.some((candidate) => (
            sameGroupRef(candidate, params.group)
            && sameGroupRevision(candidate, params.group)
        ));
}

function isGroupRevisionConflict(error: unknown): boolean {
    const code = readConnectedServiceSettingsErrorCode(error);
    return code === 'connect_group_generation_conflict'
        || code === 'connect_group_incarnation_conflict'
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
    const stateRef = React.useRef(state);
    stateRef.current = state;
    // List responses may arrive after a local group mutation under the same
    // basis. Keep their request epoch with the hook state they are allowed to
    // replace, rather than giving a consumer its own reconciliation path.
    const groupsEpochRef = React.useRef(0);

    const load = React.useCallback(async (
        preserveGroups: readonly QualifiedConnectedAccountUiGroup[],
    ) => {
        if (!basis) {
            setState(EMPTY_STATE);
            return;
        }
        const listEpoch = ++groupsEpochRef.current;
        // Last-known-good stays visible while the list reloads: only a CHANGED
        // basis clears the previous groups.
        setState((previous) => ({
            basis,
            status: 'loading',
            source: basis.source,
            groups: previous.basis === basis ? previous.groups : [],
            error: null,
        }));
        try {
            const client = createQualifiedConnectedAccountGroupsClient({
                credentials: basis.credentials,
                service: basis.service,
                source: basis.source,
            });
            const groups = await client.list();
            if (
                currentBasisRef.current !== basis
                || groupsEpochRef.current !== listEpoch
            ) return;
            setState({
                basis,
                status: 'loaded',
                source: basis.source,
                groups,
                error: null,
            });
        } catch (error) {
            if (
                currentBasisRef.current !== basis
                || groupsEpochRef.current !== listEpoch
            ) return;
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
            return;
        }
        // Groups from a DIFFERENT basis are never preserved through a failure;
        // a reload under the same basis keeps what is already on screen.
        void load(
            stateRef.current.basis === basis ? stateRef.current.groups : [],
        );
    }, [basis, load, params.peer.error, params.peer.status]);

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
        currentGroup: QualifiedConnectedAccountUiGroup | null,
    ): Promise<QualifiedConnectedAccountUiGroup | null> => {
        if (!client) return null;
        const operationBasis = basis;
        const operationEpoch = groupsEpochRef.current;
        setMutating(true);
        try {
            const group = await operation(client);
            if (
                currentBasisRef.current !== operationBasis
                || (
                    currentGroup
                        ? !isCurrentGroupRevision({
                            state: stateRef.current,
                            basis: operationBasis,
                            group: currentGroup,
                        })
                        : groupsEpochRef.current !== operationEpoch
                )
            ) return null;
            groupsEpochRef.current += 1;
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
            (input) => mutate((activeClient) => activeClient.create(input), null),
            [mutate],
        ),
        patch: React.useCallback(
            (input) => mutate((activeClient) => activeClient.patch(input), input.group),
            [mutate],
        ),
        delete: React.useCallback(async (group) => {
            if (!client) return false;
            const operationBasis = basis;
            setMutating(true);
            try {
                await client.delete(group);
                if (
                    currentBasisRef.current !== operationBasis
                    || !isCurrentGroupRevision({
                        state: stateRef.current,
                        basis: operationBasis,
                        group,
                    })
                ) return false;
                groupsEpochRef.current += 1;
                setState((previous) => ({
                    ...previous,
                    basis,
                    status: 'loaded',
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
            (input) => mutate((activeClient) => activeClient.addMember(input), input.group),
            [mutate],
        ),
        patchMember: React.useCallback(
            (input) => mutate((activeClient) => activeClient.patchMember(input), input.group),
            [mutate],
        ),
        removeMember: React.useCallback(
            (input) => mutate((activeClient) => activeClient.removeMember(input), input.group),
            [mutate],
        ),
        setActiveAccount: React.useCallback(async (input) => {
            if (!client) return null;
            const operationBasis = basis;
            setMutating(true);
            try {
                const group = await client.setActiveAccount(input);
                if (
                    currentBasisRef.current !== operationBasis
                    || !isCurrentGroupRevision({
                        state: stateRef.current,
                        basis: operationBasis,
                        group: input.group,
                    })
                ) return null;
                groupsEpochRef.current += 1;
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
