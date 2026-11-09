import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { sameStoredCredentials, type StoredCredentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { refreshSavedSecretCatalogForOperation } from "@/settings/secrets/hydrateSavedSecretCatalog";
import { createCliMcpServerStoreForOperation } from '@/settings/mcp/mcpServerStore';
import { projectMcpServerCatalogRefreshFailure } from '@/settings/mcp/hydrateMcpServerCatalog';
import type { AccountSettingsSnapshotResolver } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';

export function createExecutionRunAccountSettingsSnapshotResolver(input: Readonly<{
    machineId: string;
    serverHttpBaseUrl: string;
    readCredentials: () => Promise<StoredCredentials | null>;
    isOwnerCurrent: () => boolean;
    /** Physical host custody only; a Run must still bind its own admitted Account. */
    readHostAgentExecutionContext?: NonNullable<AccountSettingsSnapshotResolver['readAgentExecutionContext']>;
    onSettings: (settings: Awaited<ReturnType<typeof bootstrapAccountSettingsContext>>['settings'] | null) => void;
}>) {
    const machineId = input.machineId.trim();
    const authorizationChanged = () => createProviderErrorV1('provider_authorization_changed', machineId ? { machineId } : {});
    let operation: SavedSecretOperationContextV1 | null = null;
    let disposed = false;
    const resolveSnapshot = async (demand?: Readonly<{ mcpServerCatalog?: boolean; secretReferenceOverlay?: import('@happier-dev/protocol').SecretReferenceOverlayV1;
        savedSecretReferences?: readonly import('@/settings/secrets/hydrateSavedSecretCatalog').SavedSecretOperationReferenceV1[]; signal?: AbortSignal }>) => runWithServerHttpBaseUrl(input.serverHttpBaseUrl, async () => {
        demand?.signal?.throwIfAborted();
        const unavailable = () => {
            input.onSettings(null);
            return authorizationChanged();
        };
        const credentials = await input.readCredentials();
        if (!credentials || disposed) { await operation?.isCurrent(); throw unavailable(); }
        const isCurrent = async () => !disposed && input.isOwnerCurrent()
            && sameStoredCredentials(credentials, await input.readCredentials())
            && !disposed && input.isOwnerCurrent();
        const snapshot = await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', publication: 'invocation',
            honorAccountSettingsModeEnv: false, shouldCommit: () => !disposed && input.isOwnerCurrent() });
        if (!await isCurrent()) throw unavailable();
        if (!operation || operation.readSnapshot() === null || !sameStoredCredentials(operation.credentials, credentials)) {
            await operation?.isCurrent();
            operation = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
                serverHttpBaseUrl: input.serverHttpBaseUrl, isCurrent });
        } else if (!await operation.replaceAccountSettings(snapshot)) throw unavailable();
        if (!await operation.isCurrent()) throw unavailable();
        if (demand?.mcpServerCatalog) await createCliMcpServerStoreForOperation({ operationContext: operation, signal: demand.signal }).readCatalogForOperation();
        if ((demand?.secretReferenceOverlay || demand?.savedSecretReferences?.length) && snapshot.scopeKey) {
            await refreshSavedSecretCatalogForOperation({ expectedScopeKey: snapshot.scopeKey,
                secretReferenceOverlay: demand.secretReferenceOverlay, references: demand.savedSecretReferences, operationContext: operation, signal: demand.signal });
        }
        demand?.signal?.throwIfAborted();
        if (!await operation.isCurrent()) throw unavailable();
        const admitted = operation.readSnapshot();
        if (!admitted) throw unavailable();
        input.onSettings(admitted.settings);
        return admitted;
    });
    const createRequesterSnapshotReader = (source: Readonly<{
        serverHttpBaseUrl: string;
        savedSecretOperationContext: SavedSecretOperationContextV1;
        refreshAccountSettings(signal?: AbortSignal): Promise<boolean>;
        isCurrent(signal?: AbortSignal): Promise<boolean>;
        readAgentExecutionContext?: AccountSettingsSnapshotResolver['readAgentExecutionContext'];
    }>): AccountSettingsSnapshotResolver => {
        const read: AccountSettingsSnapshotResolver = async demand => runWithServerHttpBaseUrl(source.serverHttpBaseUrl, async () => {
            await source.readAgentExecutionContext?.(demand?.signal);
            if (!await source.isCurrent(demand?.signal) || !await source.refreshAccountSettings(demand?.signal)) throw authorizationChanged();
            const captured = source.savedSecretOperationContext;
            if (!await captured.isCurrent(demand?.signal)) throw authorizationChanged();
            if (demand?.mcpServerCatalog) await createCliMcpServerStoreForOperation({ operationContext: captured,
                signal: demand.signal }).readCatalogForOperation();
            const beforeSecrets = captured.readSnapshot();
            if ((demand?.secretReferenceOverlay || demand?.savedSecretReferences?.length) && beforeSecrets?.scopeKey) {
                await refreshSavedSecretCatalogForOperation({ expectedScopeKey: beforeSecrets.scopeKey,
                    secretReferenceOverlay: demand.secretReferenceOverlay, references: demand.savedSecretReferences,
                    operationContext: captured, signal: demand.signal });
            }
            demand?.signal?.throwIfAborted();
            if (!await source.isCurrent(demand?.signal) || !await captured.isCurrent(demand?.signal)) throw authorizationChanged();
            const snapshot = captured.readSnapshot();
            if (!snapshot) throw authorizationChanged();
            return snapshot;
        });
        return Object.assign(read, { readOperationContext: () => source.savedSecretOperationContext,
            ...(source.readAgentExecutionContext ? { readAgentExecutionContext: source.readAgentExecutionContext } : {}) });
    };
    const forInvocation = (ingress?: RpcHandlerContext): AccountSettingsSnapshotResolver => {
        const authorization = ingress?.callerInputAuthorization;
        const requester = readRequesterAccountActionContext(authorization);
        const bootstrap = ingress?.requesterSessionBootstrap;
        if (bootstrap && !requester) return createRequesterSnapshotReader({
            serverHttpBaseUrl: bootstrap.serverHttpBaseUrl,
            savedSecretOperationContext: bootstrap.savedSecretOperationContext,
            refreshAccountSettings: signal => bootstrap.refreshAccountSettings(undefined, signal),
            isCurrent: async signal => !disposed && input.isOwnerCurrent() && await bootstrap.isCurrent(signal),
        });
        // Preserve existing non-MCP readers, but do not invent an Agent source
        // for a historical or unbound invocation. The base reader has none.
        if (!requester || !ingress?.machineAdmission || !input.readHostAgentExecutionContext) return resolveSnapshot;
        const admission = ingress.machineAdmission;
        const isCurrent = async (signal?: AbortSignal) => {
            signal?.throwIfAborted();
            const current = !disposed && input.isOwnerCurrent()
                && readRequesterAccountActionContext(authorization) === requester
                && await (requester.isCustodyCurrent ?? requester.isCurrent)();
            signal?.throwIfAborted();
            return current && !disposed && input.isOwnerCurrent();
        };
        const readAgentExecutionContext: NonNullable<AccountSettingsSnapshotResolver['readAgentExecutionContext']> = async signal => {
            // MCP's SDK graph is needed only after host initialization, not while
            // installing the Account reader into the Machine transport itself.
            const { refuseMcpExecutionSource } = await import('@/mcp/runtime/mcpExecutionSource');
            if (!await isCurrent(signal)) return refuseMcpExecutionSource('requester_authority_unavailable');
            const host = await input.readHostAgentExecutionContext!(signal);
            const physical = host?.requesterIdentity;
            const binding = requester.authorization.binding;
            if (!host || !physical || physical.kind !== 'isolated' || physical.separationRequired || physical.accountAutomation
                || binding.serverIdentityId !== physical.requester.serverId
                || admission.actorAccountId !== binding.accountId
                || binding.machineId !== admission.machineId || binding.installationId !== admission.installationId
                || binding.custodianAccountId !== admission.custodianAccountId
                || admission.machineId !== physical.requester.machineId
                || admission.installationId !== physical.requester.installationId
                || !await isCurrent(signal)) return refuseMcpExecutionSource('requester_authority_unavailable');
            // The opened Account facet proves the caller, while the separately
            // qualified host proves custody. Only the identity owner compares them.
            const requesterIdentity = selectHostRequesterExecutionIdentity({
                hostHomeServerIdentityId: binding.serverIdentityId,
                hostAccountAgent: { accountId: binding.accountId, custodianAccountId: physical.requester.accountId,
                    machineId: admission.machineId, installationId: admission.installationId },
            });
            if (requesterIdentity.kind !== 'isolated') return refuseMcpExecutionSource('requester_authority_unavailable');
            return { requesterIdentity, isolationEnabled: host.isolationEnabled };
        };
        return createRequesterSnapshotReader({ serverHttpBaseUrl: requester.serverHttpBaseUrl,
            savedSecretOperationContext: requester.savedSecretOperationContext,
            refreshAccountSettings: signal => requester.refreshAccountSettings(signal), isCurrent, readAgentExecutionContext });
    };
    return Object.assign(resolveSnapshot, {
        forInvocation,
        readOperationContext: () => operation,
        refreshDemandedMcpCatalog: async (signal?: AbortSignal) => {
            const captured = operation;
            if (captured?.readSnapshot()?.mcpServerCatalog === undefined) return;
            try {
                if (!await captured.isCurrent()) throw authorizationChanged();
                await createCliMcpServerStoreForOperation({ operationContext: captured, signal }).readCatalogForOperation();
            } catch (error) {
                const current = await captured.isCurrent();
                if (!current) throw authorizationChanged();
                await captured.commitMcpCatalog(projectMcpServerCatalogRefreshFailure({ error, current, signal }));
                throw error;
            }
        },
        dispose: async () => { disposed = true; await operation?.isCurrent(); },
    });
}
