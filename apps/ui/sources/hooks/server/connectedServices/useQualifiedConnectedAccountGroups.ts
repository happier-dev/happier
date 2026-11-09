import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { getQualifiedConnectedAccountGroupV4 } from '@/sync/api/account/apiQualifiedConnectedAccountsV4';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { resolveConnectedAccountUiNegotiation } from '@/sync/domains/connectedServices/resolveConnectedAccountUiNegotiation';
import { parseToken } from '@/utils/auth/parseToken';
import { useActiveServerAccountScope, useProfile } from '@/sync/store/hooks';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { sync } from '@/sync/sync';
import {
    readConnectedServiceSettingsErrorCode,
    resolveConnectedServiceSettingsErrorMessage,
} from '@/components/settings/connectedServices/connectedServiceSettingsErrors';
import {
    createQualifiedConnectedAccountGroupsClient,
    fromQualifiedGroup,
    QualifiedConnectedAccountUiSourceError,
    type QualifiedConnectedAccountUiGroup,
    type QualifiedConnectedAccountUiSource,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';
import { sameQualifiedConnectedAccountGroupRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ConnectedServiceAuthGroupPolicyV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';

export type QualifiedConnectedAccountGroupsStatus =
    | 'idle'
    | 'loading'
    | 'loaded'
    | 'unsupported'
    | 'error';

export type QualifiedConnectedAccountGroupDeleteReceipt = ReturnType<
    (typeof CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1)['connectedServices.pools.delete']['parse']
>;

export type UseQualifiedConnectedAccountGroupsResult = Readonly<{
    status: QualifiedConnectedAccountGroupsStatus;
    source: QualifiedConnectedAccountUiSource | null;
    groups: readonly QualifiedConnectedAccountUiGroup[];
    error: string | null;
    mutating: boolean;
    execution?: ReturnType<typeof useMountedActionExecution>;
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
    delete(group: QualifiedConnectedAccountUiGroup): Promise<QualifiedConnectedAccountGroupDeleteReceipt | false>;
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

type LoadBasis = Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    service: PluginContributionIdentityV1;
    source: QualifiedConnectedAccountUiSource;
}>;

const EMPTY_GROUPS: readonly QualifiedConnectedAccountUiGroup[] = [];

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
}>): UseQualifiedConnectedAccountGroupsResult {
    const credentials = useAuth().credentials;
    const serverFeatures = useServerFeaturesSnapshotForServerId(params.serverId, { enabled: Boolean(credentials) });
    const negotiation = resolveConnectedAccountUiNegotiation(serverFeatures);
    const actionScope = React.useMemo(() => {
        try {
            const accountId = credentials ? parseToken(credentials.token) : null;
            return accountId ? { serverId: params.serverId, accountId } : null;
        } catch { return null; }
    }, [credentials, params.serverId]);
    const execution = useMountedActionExecution(actionScope);
    const profileScope = useActiveServerAccountScope();
    const profileGroups = useProfile(profile => profile.connectedAccountGroupsV4);
    const [failure, setFailure] = React.useState<Readonly<{ basis: LoadBasis; error: string }> | null>(null);
    const [refreshing, setRefreshing] = React.useState<LoadBasis | null>(null);
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
        () => negotiation === 'advertised-v4' ? { protocol: 'v4' } : null,
        [negotiation],
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
    const profileCurrent = Boolean(basis && areServerAccountScopesEqual(profileScope, actionScope));
    const groups = React.useMemo(() => profileCurrent && service
        ? (profileGroups ?? []).filter(group => group.ref.service.pluginId === service.pluginId
            && group.ref.service.localId === service.localId).map(group => fromQualifiedGroup(group, service))
        : EMPTY_GROUPS, [profileCurrent, profileGroups, service]);
    const refresh = React.useCallback(async () => {
        if (!basis) return;
        setRefreshing(basis);
        setFailure(null);
        try {
            await sync.refreshProfile();
        } catch (error) {
            if (currentBasisRef.current === basis) {
                setFailure({ basis, error: resolveConnectedServiceSettingsErrorMessage(error) });
            }
        } finally {
            setRefreshing(previous => previous === basis ? null : previous);
        }
    }, [basis]);

    const client = React.useMemo(
        () => basis
            ? createQualifiedConnectedAccountGroupsClient({
                service: basis.service,
                mutation: {
                    execute: async (actionId, input) => {
                        if (currentBasisRef.current !== basis) throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
                        const result = await execution.execute(actionId, input);
                        if (!result.ok) throw createActionExecuteFailureError(result);
                        return result.result;
                    },
                    readGroup: async group => {
                        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
                        const account = await captureLazyActionAccountContext(basis.serverId);
                        try {
                            if (currentBasisRef.current !== basis || resolveAuthCredentialsScopeKey(account.credentials)
                                !== resolveAuthCredentialsScopeKey(basis.credentials)) {
                                throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
                            }
                            const response = await getQualifiedConnectedAccountGroupV4(account.credentials, { group, request: account.request });
                            account.assertCurrent();
                            if (currentBasisRef.current !== basis) throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
                            return response.group;
                        } finally { account.dispose(); }
                    },
                },
            })
            : null,
        [basis, execution.execute],
    );

    const mutate = React.useCallback(async (
        operation: (
            client: ReturnType<typeof createQualifiedConnectedAccountGroupsClient>,
        ) => Promise<QualifiedConnectedAccountUiGroup>,
        throwOnError = false,
    ): Promise<QualifiedConnectedAccountUiGroup | null> => {
        if (!client) return null;
        const operationBasis = basis;
        setMutating(true);
        try {
            const group = await operation(client);
            if (currentBasisRef.current !== operationBasis) return null;
            // The caller threads this receipt into its next CAS; displayed groups
            // remain owned by the Account profile push, not a second local list.
            setFailure(null);
            return group;
        } catch (error) {
            if (currentBasisRef.current !== operationBasis) return null;
            if (isActionApprovalDeclinedErrorCode(readConnectedServiceSettingsErrorCode(error))) return null;
            if (isGroupRevisionConflict(error)) {
                await refresh();
            }
            if (operationBasis) setFailure({ basis: operationBasis, error: resolveConnectedServiceSettingsErrorMessage(error) });
            if (throwOnError) throw error;
            return null;
        } finally {
            setMutating(false);
        }
    }, [basis, client, refresh]);

    return {
        status: !basis ? negotiation === 'indeterminate' ? 'loading' : 'unsupported'
            : failure?.basis === basis ? 'error' : !profileCurrent || refreshing === basis ? 'loading' : 'loaded',
        source: basis?.source ?? null,
        groups,
        error: failure?.basis === basis ? failure.error : null,
        mutating,
        execution,
        refresh,
        create: React.useCallback(
            (input) => mutate((activeClient) => activeClient.create(input)),
            [mutate],
        ),
        patch: React.useCallback(
            (input) => mutate((activeClient) => activeClient.patch(input)),
            [mutate],
        ),
        delete: React.useCallback(async (group) => {
            if (!client || !basis) return false;
            const operationBasis = basis;
            setMutating(true);
            try {
                if (!sameQualifiedConnectedAccountGroupRef(group.ref, {
                    service: operationBasis.service,
                    groupId: group.ref.groupId,
                })) {
                    throw new QualifiedConnectedAccountUiSourceError('qualified_connected_accounts_cross_source_ref');
                }
                if (currentBasisRef.current !== operationBasis) {
                    throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
                }
                const result = await execution.execute('connectedServices.pools.delete', {
                        group: group.ref,
                        expectedIncarnation: group.revision.incarnation,
                        expectedGeneration: group.revision.generation,
                        expectedRuntimeStateRevision: group.revision.runtimeStateRevision,
                    });
                if (!result.ok) throw createActionExecuteFailureError(result);
                const receipt = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.pools.delete'].parse(result.result);
                if (currentBasisRef.current === operationBasis) setFailure(null);
                return receipt;
            } catch (error) {
                if (currentBasisRef.current !== operationBasis) return false;
                if (isActionApprovalDeclinedErrorCode(readConnectedServiceSettingsErrorCode(error))) return false;
                if (isGroupRevisionConflict(error)) {
                    await refresh();
                }
                setFailure({ basis: operationBasis, error: resolveConnectedServiceSettingsErrorMessage(error) });
                return false;
            } finally {
                setMutating(false);
            }
        }, [basis, client, execution.execute, refresh]),
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
        setActiveAccount: React.useCallback(
            input => mutate(activeClient => activeClient.setActiveAccount(input), true),
            [mutate],
        ),
    };
}
