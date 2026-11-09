import * as React from 'react';
import type { DaemonProviderConnectionsDescribeResponseV1 } from '@happier-dev/protocol/rpc';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { describeAccountProviderConnectionsV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import { useProviderActionClient, type ProviderPendingApproval } from '@/providers/actions/useProviderActionClient';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { PROVIDER_DECLARATION_CONTEXT_SECTIONS, readAccountProviderDeclarations, type ProviderDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { getProviderCatalogSnapshot, type ProviderCatalogSnapshot,
    beginProviderConnectionCheckRead, getProviderConnectionCheckSnapshot, isProviderConnectionCheckReadRequired, providerConnectionCheckQueryKey,
    subscribeProviderModelProjectionSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';
import { refreshProviderCatalog } from '@/sync/engine/settings/providerCatalogEngine';
import { useProviderCatalog } from '@/sync/store/useProviderCatalog';
export type ProviderConnectionRefreshScope = 'account' | 'machine';

type Success = Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }>;
type ProviderConnectionsState = Readonly<{
    scopeKey: string | null;
    accountScopeKey?: string;
    accountData?: Success | null;
    catalog?: ProviderCatalogSnapshot | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    data: Success | null;
    error: Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'error' }>['error'] | null;
    machineError?: Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'error' }>['error'] | null;
    accountAnswered?: boolean;
    loading: boolean;
}>;

export type ProviderConnectionsQuery = Readonly<{
    data: Success | null;
    catalog: ProviderCatalogSnapshot['data'];
    error: ProviderConnectionsState['error'];
    machineError: NonNullable<ProviderConnectionsState['machineError']> | null;
    loading: boolean;
    refresh: (refreshScope?: ProviderConnectionRefreshScope) => Promise<Success | null | undefined>;
    pendingApproval: ProviderPendingApproval | null;
    declarationProjection: PluginProjectionV2 | null;
    declarationContext: ProviderDeclarationContext;
}>;

export function useProviderConnections(input: Readonly<{
    enabled: boolean;
    active?: boolean;
    machineId: string | null;
    serverId: string | null;
    connectionId?: string;
}>): ProviderConnectionsQuery {
    // A missing addressed Home must not use the Action client's omitted-target
    // fallback to the active Home. Account reads may omit a Machine, not a Home.
    const { describeProviderConnections, ready, retryReadiness, pendingApproval, accountScope: { resolution, binding } } = useProviderActionClient(input.serverId ?? []);
    const active = input.active ?? true;
    const declarations = useDaemonMergedProjectionInputs({ machineId: input.machineId, serverId: input.serverId,
        enabled: input.enabled && active && Boolean(input.machineId), sections: PROVIDER_DECLARATION_CONTEXT_SECTIONS });
    const declarationProjection = declarations.phase === 'ready' ? declarations.inputs?.pluginProjectionV2 ?? null : null;
    // These readers present Account configuration; optional Machine declarations
    // augment it without making saved counts or preferences depend on that Machine.
    const declarationContext = React.useMemo<ProviderDeclarationContext>(() => ({ kind: 'account', projection: declarationProjection }),
        [declarationProjection]);
    const declarationsStatus = !input.machineId || declarations.phase === 'ready' ? 'ready'
        : declarations.phase === 'error' || declarations.phase === 'unsupported' ? 'unavailable' : 'loading';
    const declarationsRef = React.useRef<Readonly<{ context: ProviderDeclarationContext; status: typeof declarationsStatus }>>({ context: declarationContext, status: declarationsStatus });
    declarationsRef.current = { context: declarationContext, status: declarationsStatus };
    const activeRef = React.useRef(active);
    activeRef.current = active;
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const readCatalogAdmission = React.useCallback(() => (
        input.enabled && binding?.isCurrent() && (accountLifetime?.isCurrent() ?? true)
            ? getProviderCatalogSnapshot(binding.scope) : null
    ), [accountLifetime, binding, input.enabled]);
    const catalogAdmission = useProviderCatalog(input.enabled && binding?.isCurrent() && (accountLifetime?.isCurrent() ?? true)
        ? binding.scope : null, { enabled: active && input.enabled });
    const [state, setState] = React.useState<ProviderConnectionsState>({
        scopeKey: null,
        accountLifetime: null,
        data: null,
        error: null,
        loading: false,
    });
    const generation = React.useRef(0);
    const pendingRead = React.useRef<AbortController | null>(null);
    const currentAccountLifetimeRef = React.useRef(accountLifetime);
    currentAccountLifetimeRef.current = accountLifetime;
    const scopeKey = JSON.stringify([
        input.enabled,
        input.machineId,
        input.serverId,
        input.connectionId ?? null,
        resolution.kind === 'bound' ? serverAccountScopeKeySuffix(resolution.scope) : null,
    ]);
    const accountScopeKey = JSON.stringify([input.enabled, input.serverId, input.connectionId ?? null,
        resolution.kind === 'bound' ? serverAccountScopeKeySuffix(resolution.scope) : null]);
    const stateMatchesScope = state.scopeKey === scopeKey
        && state.accountLifetime === accountLifetime;
    const machineQueryKey = input.machineId ? providerConnectionCheckQueryKey(input.machineId, input.connectionId) : null;
    const readMachineSnapshot = React.useCallback(() => input.enabled && machineQueryKey && binding?.credentialKey
        && binding.isCurrent() && (accountLifetime?.isCurrent() ?? true)
        ? getProviderConnectionCheckSnapshot(binding.scope, binding.credentialKey, machineQueryKey) : null,
    [accountLifetime, binding, input.enabled, machineQueryKey]);
    const subscribeMachineSnapshot = React.useCallback((listener: () => void) => active && input.enabled
        && machineQueryKey && binding?.credentialKey && binding.isCurrent()
        ? subscribeProviderModelProjectionSnapshot(binding.scope, binding.credentialKey, machineQueryKey, listener) : () => {},
    [active, binding, input.enabled, machineQueryKey]);
    const cachedMachine = React.useSyncExternalStore(subscribeMachineSnapshot, readMachineSnapshot, readMachineSnapshot);
    const scopeEnabled = input.enabled;
    const accountMatchesScope = state.accountScopeKey === accountScopeKey && state.accountLifetime === accountLifetime;
    const answeredCatalog = accountMatchesScope && catalogAdmission?.data
        && state.catalog?.cryptoAdmission?.contentPublicKeyFingerprint === catalogAdmission.cryptoAdmission?.contentPublicKeyFingerprint
        ? state.catalog?.data ?? null : null;
    // Remote refreshes leave an editor's draft basis alone. A local write's
    // producer-set ACK revision advances every reader immediately, without a describe.
    const catalog = !catalogAdmission?.data ? null : input.connectionId && answeredCatalog
        && state.catalog?.acknowledgedRevision === catalogAdmission.acknowledgedRevision
        ? answeredCatalog : catalogAdmission.data;
    React.useEffect(() => {
        if (!catalogAdmission?.data || catalogAdmission.acknowledgedRevision === undefined) return;
        setState(current => current.accountScopeKey === accountScopeKey && current.accountLifetime === accountLifetime
            && current.catalog?.acknowledgedRevision !== catalogAdmission.acknowledgedRevision
            ? { ...current, catalog: catalogAdmission } : current);
    }, [accountLifetime, accountScopeKey, catalogAdmission]);
    const baseData = React.useMemo(() => catalog ? describeAccountProviderConnectionsV1(
        catalog, readAccountProviderDeclarations(declarationContext), input.connectionId, { declarationsStatus },
    ) : null, [catalog, declarationContext, declarationsStatus, input.connectionId]);
    const data = React.useMemo(() => {
        if (!baseData) return baseData;
        const checks = new Map(cachedMachine?.connections.map(row => [row.connectionId, row]));
        const connections = baseData.connections.map(row => {
            const checked = checks.get(row.connectionId);
            checks.delete(row.connectionId);
            if (!checked) return row;
            return checked.revision === row.revision && checked.displayName === row.displayName
                && checked.displayNameMode === row.displayNameMode ? checked
                : { ...checked, revision: row.revision, displayName: row.displayName, displayNameMode: row.displayNameMode };
        });
        // A Machine answer can also carry its own observed rows. Keep their
        // captured configuration, but never resurrect a check the owner retired.
        const machineBasis = stateMatchesScope && state.accountAnswered ? state.data : cachedMachine;
        for (const row of machineBasis?.connections ?? []) {
            const checked = checks.get(row.connectionId);
            if (!checked) continue;
            connections.push(row.runtime === checked.runtime && row.probeObservationIdentity === checked.probeObservationIdentity
                ? row : { ...row, runtime: checked.runtime, probeObservationIdentity: checked.probeObservationIdentity });
        }
        return { ...(cachedMachine ?? baseData), connections };
    }, [baseData, cachedMachine, state.accountAnswered, state.data, stateMatchesScope]);
    const error = resolution.kind === 'unavailable' ? createProviderErrorV1('provider_authorization_changed')
        : stateMatchesScope ? state.error : null;
    const machineError = stateMatchesScope ? state.machineError ?? null : null;
    // Account rows are already usable while optional Machine facts refresh.
    // Consumers use loading to replace their values, so reserve it for the first answer.
    const loading = data === null && active && scopeEnabled
        && (resolution.kind === 'resolving' || resolution.kind === 'bound')
        && (!ready || !stateMatchesScope || state.loading);

    React.useEffect(() => {
        const registration = accountLifetime?.onRetire(() => {
            if (currentAccountLifetimeRef.current !== accountLifetime) return;
            generation.current += 1;
            setState((current) => current.accountLifetime === accountLifetime
                ? { scopeKey: null, accountLifetime: null, data: null, error: null, loading: false }
                : current);
        });
        return () => registration?.dispose();
    }, [accountLifetime]);

    const read = React.useCallback(async (mode: 'initial' | 'account' | 'machine' = 'initial') => {
        if (!activeRef.current) return null;
        const requestGeneration = ++generation.current;
        const requestStillCurrent = (): boolean => (
            activeRef.current && currentAccountLifetimeRef.current === accountLifetime
            && (accountLifetime?.isCurrent() ?? true)
            && (resolution.kind !== 'bound' || binding?.isCurrent() === true)
        );
        if (!requestStillCurrent()) return null;
        if (!input.enabled) {
            setState({ scopeKey, accountLifetime, data: null, error: null, loading: false });
            return null;
        }
        if (!ready) return null;
        pendingRead.current?.abort();
        const controller = new AbortController();
        pendingRead.current = controller;
        const machineId = input.machineId;
        const serverId = input.serverId;
        setState((current) => current.scopeKey === scopeKey
            && current.accountLifetime === accountLifetime
            ? { ...current, loading: true }
            : { scopeKey, accountScopeKey, accountLifetime,
                catalog: current.accountScopeKey === accountScopeKey && current.accountLifetime === accountLifetime ? current.catalog ?? null : null,
                data: current.accountScopeKey === accountScopeKey && current.accountLifetime === accountLifetime ? current.accountData ?? null : null,
                error: null, loading: true });
        let accountData: Success | null = null;
        let catalog: ProviderCatalogSnapshot | null = null;
        try {
            // The shared catalog loader owns Account I/O. Readers only project its admitted facts.
            if (!binding?.isCurrent()) return null;
            if (mode === 'account' || mode === 'initial' && readCatalogAdmission()?.status !== 'ready') {
                await refreshProviderCatalog(binding.scope);
            }
            if (requestGeneration !== generation.current || !requestStillCurrent()) return;
            const admitted = readCatalogAdmission();
            if (!admitted?.data) {
                setState({ scopeKey, accountScopeKey, accountLifetime, data: null, accountData: null,
                    error: createProviderErrorV1('provider_catalog_unavailable'), machineError: null, accountAnswered: true, loading: true });
                return null;
            }
            const accountResult = describeAccountProviderConnectionsV1(admitted.data,
                readAccountProviderDeclarations(declarationsRef.current.context), input.connectionId,
                { declarationsStatus: declarationsRef.current.status });
            accountData = accountResult;
            // The rows above come from this same admitted catalog, so it is already the
            // editor basis. Keep it whole: a detail reader describes one connection, and
            // dropping the others would orphan their grants and bindings.
            catalog = admitted;
            setState((current) => {
                const sameTarget = machineId && current.scopeKey === scopeKey
                    && current.accountLifetime === accountLifetime;
                const previousRows = new Map(readMachineSnapshot()?.connections.map(row => [row.connectionId, row]));
                const connections = accountResult.connections.map(row => {
                    const previousRow = previousRows.get(row.connectionId);
                    if (!previousRow) return row;
                    if (previousRow.displayName === row.displayName && previousRow.displayNameMode === row.displayNameMode
                        && previousRow.revision === row.revision) return previousRow;
                    return { ...previousRow, displayName: row.displayName, displayNameMode: row.displayNameMode, revision: row.revision };
                });
                const machineCollections = sameTarget && current.data ? {
                    discoveryCandidates: current.data.discoveryCandidates,
                    discoveryCandidatesTruncated: current.data.discoveryCandidatesTruncated,
                    localInstallations: current.data.localInstallations,
                    ...(current.data.localInstallationsStatus ? { localInstallationsStatus: current.data.localInstallationsStatus } : {}),
                } : {};
                return { scopeKey, accountScopeKey, accountLifetime, data: { ...accountResult, ...machineCollections, connections }, accountData: accountResult, catalog,
                    error: null, machineError: null, accountAnswered: true, loading: true };
            });
            if (!machineId) return accountData;
            const publishMachine = machineQueryKey && binding?.credentialKey
                ? beginProviderConnectionCheckRead(binding.scope, binding.credentialKey, machineQueryKey) : null;
            const result = await describeProviderConnections({ machineId, serverId,
                ...(input.connectionId ? { connectionId: input.connectionId } : {}),
            }, { signal: controller.signal });
            if (requestGeneration !== generation.current || !requestStillCurrent()) return;
            if (result.status === 'success') {
                publishMachine?.(result);
                const connections = new Map(result.connections.map(connection => [connection.connectionId, connection]));
                for (const connection of accountData.connections) {
                    const machineConnection = connections.get(connection.connectionId);
                    if (!machineConnection || machineConnection.revision !== connection.revision) {
                        connections.set(connection.connectionId, connection);
                    }
                }
                const augmented = { ...result, connections: [...connections.values()] };
                setState({ scopeKey, accountScopeKey, accountLifetime, data: augmented, accountData, catalog,
                    error: null, machineError: null, accountAnswered: true, loading: true });
                return augmented;
            } else {
                setState({ scopeKey, accountScopeKey, accountLifetime, data: accountData, accountData, catalog,
                    error: null, machineError: result.error, accountAnswered: true, loading: true });
            }
            return readMachineSnapshot() ?? accountData;
        } catch (caught) {
            if (requestGeneration !== generation.current || !requestStillCurrent()) return;
            const failure = providerErrorFromRpcFailure(caught, {
                    ...(machineId ? { machineId } : {}),
                    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
                });
            setState({ scopeKey, accountScopeKey, accountLifetime, data: accountData, accountData, catalog,
                error: accountData ? null : failure, machineError: accountData ? failure : null, accountAnswered: accountData !== null, loading: true });
            return readMachineSnapshot() ?? accountData;
        } finally {
            if (pendingRead.current === controller) pendingRead.current = null;
            if (requestGeneration === generation.current && requestStillCurrent()) {
                setState((current) => current.scopeKey === scopeKey
                    && current.accountLifetime === accountLifetime
                    ? { ...current, loading: false }
                    : current);
            }
        }
    }, [accountLifetime, binding, resolution.kind, accountScopeKey, describeProviderConnections, ready, input.connectionId, input.enabled, input.machineId, input.serverId, machineQueryKey, readCatalogAdmission, readMachineSnapshot, scopeKey]);

    React.useEffect(() => {
        if (active && input.enabled && binding?.isCurrent() && binding.credentialKey && machineQueryKey
            && isProviderConnectionCheckReadRequired(binding.scope, binding.credentialKey, machineQueryKey)) {
            void read('machine');
        }
    }, [active, binding, cachedMachine, input.enabled, machineQueryKey, read]);

    React.useEffect(() => {
        // Visibility pauses demand; it does not change the authority of a
        // retained projection or the metadata an editor draft was built from.
        setState((current) => current.scopeKey === scopeKey && current.accountLifetime === accountLifetime
            ? current
            : { scopeKey, accountScopeKey, accountLifetime,
                catalog: current.accountScopeKey === accountScopeKey && current.accountLifetime === accountLifetime ? current.catalog ?? null : null,
                accountData: current.accountScopeKey === accountScopeKey && current.accountLifetime === accountLifetime ? current.accountData ?? null : null,
                data: current.accountScopeKey === accountScopeKey && current.accountLifetime === accountLifetime ? current.accountData ?? null : null,
                error: null, loading: false });
        void read();
        return () => {
            generation.current += 1;
            pendingRead.current?.abort();
            pendingRead.current = null;
        };
    }, [accountLifetime, accountScopeKey, active, input.enabled, input.machineId, input.serverId, read, scopeKey]);

    const refresh = React.useCallback(async (_refreshScope: ProviderConnectionRefreshScope = 'machine') => {
        if (activeRef.current && input.enabled && currentAccountLifetimeRef.current === accountLifetime
            && (accountLifetime?.isCurrent() ?? true)) retryReadiness();
        return await read('account');
    }, [accountLifetime, input.enabled, read, retryReadiness]);

    return { data, catalog, error, machineError, loading, refresh, pendingApproval, declarationProjection, declarationContext };
}
