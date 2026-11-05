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

export function createExecutionRunAccountSettingsSnapshotResolver(input: Readonly<{
    machineId: string;
    serverHttpBaseUrl: string;
    readCredentials: () => Promise<StoredCredentials | null>;
    isOwnerCurrent: () => boolean;
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
            minSettingsVersion: operation && sameStoredCredentials(operation.credentials, credentials)
                ? operation.readSnapshot()?.settingsVersion : undefined,
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
    }>): AccountSettingsSnapshotResolver => {
        const read: AccountSettingsSnapshotResolver = async demand => runWithServerHttpBaseUrl(source.serverHttpBaseUrl, async () => {
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
        return Object.assign(read, { readOperationContext: () => source.savedSecretOperationContext });
    };
    const forInvocation = (ingress?: RpcHandlerContext): AccountSettingsSnapshotResolver => {
        const bootstrap = ingress?.requesterSessionBootstrap;
        if (!bootstrap) return resolveSnapshot;
        return createRequesterSnapshotReader({
            serverHttpBaseUrl: bootstrap.serverHttpBaseUrl,
            savedSecretOperationContext: bootstrap.savedSecretOperationContext,
            refreshAccountSettings: signal => bootstrap.refreshAccountSettings(undefined, signal),
            isCurrent: async signal => !disposed && input.isOwnerCurrent() && await bootstrap.isCurrent(signal),
        });
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
