import * as React from 'react';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { normalizeWorkspaceRootPathV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationMachineAddressKey, type QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';

import { createProjectManifestActionClient } from './projectManifestActionClient';

export type ProjectDefinitionInspection = Awaited<ReturnType<ReturnType<typeof createProjectManifestActionClient>['inspect']>>;
export type ProjectDefinitionInspectionRead =
    | Readonly<{ key: string; value: ProjectDefinitionInspection; refreshing?: boolean; error?: string }>
    | Readonly<{ key: string; error: string }>;

/** One exact checkout's identity for the inspection it belongs to. */
export function projectDefinitionInspectionKey(workspace: WorkspaceAddressV1): string {
    return `${buildWorkspaceCacheKey(workspace)}:${workspace.workspaceId}`;
}

/**
 * One exact checkout's project definition and what reading its files found (`projects.inspect`, plan
 * 20's passive owner); nothing here executes. A read for another checkout is never shown as this one's.
 */
export function useProjectDefinitionInspection(workspace: WorkspaceAddressV1 | null, binding: ServerCredentialAccountScopeBinding | null): Readonly<{
    read: ProjectDefinitionInspectionRead | null;
    retry: () => void;
}> {
    const accountId = binding?.isCurrent() ? binding.accountId : null;
    const key = workspace ? projectDefinitionInspectionKey(workspace) : null;
    const scopeKey = accountId && key ? JSON.stringify([binding?.serverId, accountId, key]) : null;
    const [read, setRead] = React.useState<Readonly<{ scopeKey: string; read: ProjectDefinitionInspectionRead }> | null>(null);
    const [refresh, setRefresh] = React.useState(0);
    const workspaceRef = React.useRef(workspace);
    workspaceRef.current = workspace;
    const retry = React.useCallback(() => {
        // Keep the definition usable, but do not retain an authoritative readiness claim while its
        // captured requester is reading the target again.
        setRead(previous => previous?.scopeKey === scopeKey && 'value' in previous.read
            ? { ...previous, read: { ...previous.read, value: { ...previous.read.value, setupReadiness: undefined }, refreshing: true } } : previous);
        setRefresh(value => value + 1);
    }, [scopeKey]);
    React.useEffect(() => {
        const current = workspaceRef.current;
        if (!accountId || !scopeKey || !current || !binding?.isCurrent()) return;
        const root = normalizeWorkspaceRootPathV1(current.rootPath);
        const serverId = binding.serverId;
        const machineKey = actionOperationMachineAddressKey({ serverId, machineId: current.machineId });
        const belongs = (operation: QualifiedActionOperation | undefined) => {
            const source = operation?.snapshot.domainRef?.kind === 'projectCommand'
                ? operation.snapshot.domainRef.sourceWorkspace : undefined;
            return operation?.serverId === serverId && operation.snapshot.scope.accountId === accountId
                && source?.serverId === serverId && source.machineId === current.machineId
                && source.workspaceId === current.workspaceId && normalizeWorkspaceRootPathV1(source.rootPath) === root;
        };
        let previous = actionOperationStore.getSnapshot();
        return actionOperationStore.subscribe(() => {
            const next = actionOperationStore.getSnapshot();
            if (previous.operationsByKey === next.operationsByKey
                && previous.machineObservationByKey === next.machineObservationByKey
                && previous.unavailableOperationKeys === next.unavailableOperationKeys) {
                previous = next;
                return;
            }
            const beforeObservation = previous.machineObservationByKey.get(machineKey);
            const afterObservation = next.machineObservationByKey.get(machineKey);
            let changed = beforeObservation !== afterObservation
                && (beforeObservation !== undefined || afterObservation !== 'available');
            for (const operationKey of new Set([...previous.operationsByKey.keys(), ...next.operationsByKey.keys()])) {
                const before = previous.operationsByKey.get(operationKey);
                const after = next.operationsByKey.get(operationKey);
                if (!belongs(before) && !belongs(after)) continue;
                // Output/progress, seen and dismissal revisions are not target readiness changes.
                if (before?.snapshot.state !== after?.snapshot.state
                    || before?.snapshot.startedAt !== after?.snapshot.startedAt
                    || before?.snapshot.settledAt !== after?.snapshot.settledAt
                    || before?.snapshot.setupReview?.reviewedEffectDigest !== after?.snapshot.setupReview?.reviewedEffectDigest
                    || before?.snapshot.observation?.kind !== after?.snapshot.observation?.kind
                    || previous.unavailableOperationKeys.has(operationKey) !== next.unavailableOperationKeys.has(operationKey)) changed = true;
            }
            previous = next;
            if (changed && binding.isCurrent()) retry();
        });
    }, [accountId, binding, key, scopeKey, retry]);
    React.useEffect(() => {
        const current = workspaceRef.current;
        if (!accountId || !key || !scopeKey || !current || !binding?.isCurrent()) return;
        const controller = new AbortController();
        const retirement = binding.onRetire(() => { controller.abort(); setRead(null); });
        const client = createProjectManifestActionClient({ workspace: current, expectedAccountId: accountId, signal: controller.signal });
        void client.inspect().then(value => {
            if (!controller.signal.aborted && binding.isCurrent()) setRead({ scopeKey, read: { key, value } });
        }).catch((error: unknown) => {
            if (controller.signal.aborted || !binding.isCurrent()) return;
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                ? error.code : 'project_definition_inspection_failed';
            setRead(previous => previous?.scopeKey === scopeKey && 'value' in previous.read
                ? { ...previous, read: { ...previous.read, value: { ...previous.read.value, setupReadiness: undefined }, refreshing: false, error: code } }
                : { scopeKey, read: { key, error: code } });
        });
        return () => { retirement.dispose(); controller.abort(); };
    }, [accountId, binding, key, scopeKey, refresh]);
    return { read: binding?.isCurrent() && read?.scopeKey === scopeKey ? read.read : null, retry };
}
