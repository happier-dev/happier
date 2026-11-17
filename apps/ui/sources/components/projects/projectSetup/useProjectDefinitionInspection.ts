import * as React from 'react';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { normalizeWorkspaceRootPathV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { ProjectDefinitionInspectRead } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';

import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationMachineAddressKey, type QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { createSharedSubscriptionStore, type SharedSubscriptionStore } from '@/sync/runtime/subscriptions/sharedSubscriptionStore';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { createProjectManifestActionClient } from './projectManifestActionClient';
import { readProjectEffectiveDefinition, type ProjectEffectiveDefinitionInspection } from './projectEffectiveDefinition';
export { readProjectEffectiveDefinition, type ProjectEffectiveDefinitionInspection } from './projectEffectiveDefinition';

export type ProjectDefinitionInspection = Awaited<ReturnType<ReturnType<typeof createProjectManifestActionClient>['inspect']>>;
export type ProjectDefinitionInspectionRead =
    | Readonly<{ key: string; value: ProjectDefinitionInspection; refreshing?: boolean; error?: string }>
    | Readonly<{ key: string; error: string }>;

/** One exact checkout's identity for the inspection it belongs to. */
export function projectDefinitionInspectionKey(workspace: WorkspaceAddressV1): string {
    return `${buildWorkspaceCacheKey(workspace)}:${workspace.workspaceId}`;
}

type InspectionStore = SharedSubscriptionStore<WorkspaceAddressV1, ProjectDefinitionInspectionRead | null,
    ProjectDefinitionInspectionRead | null, typeof createProjectManifestActionClient>;
type InspectionReader = Readonly<{ workspace: WorkspaceAddressV1; store: InspectionStore; retained: boolean;
    bindings: Map<() => void, ServerCredentialAccountScopeBinding>; release(): void }>;

// Hook bindings have distinct object lifetimes. Share only their exact credential-backed
// display identity while demanded; the last consumer or credential mutation evicts it.
// The Scripts list is the exception: its narrow read (names and files, no author document or
// per-row resolution) belongs to the Account, not its bearer. It stays as the last-good list
// until that Account leaves the Home, and a revisit revalidates it by revision so an unchanged
// checkout resends no body.
const retainsLastGood = (read: ProjectDefinitionInspectRead) => read.kind === 'scripts';
const readers = new Map<string, InspectionReader>();
const unqualifiedReaders = new WeakMap<ServerCredentialAccountScopeBinding, Map<string, InspectionReader>>();
subscribeHomeCredentialChange((event, { accountLeft }) => {
    for (const [key, reader] of readers) {
        if (!areServerProfileIdentifiersEquivalent(event.serverId, reader.workspace.serverId)) continue;
        if (reader.retained && !accountLeft) continue;
        reader.store.publish(reader.workspace, null);
        reader.store.reset();
        readers.delete(key);
    }
});

function createInspectionStore(read: ProjectDefinitionInspectRead, currentBinding: () => ServerCredentialAccountScopeBinding | undefined): InspectionStore {
    const retained = retainsLastGood(read);
    const store: InspectionStore = createSharedSubscriptionStore<WorkspaceAddressV1, ProjectDefinitionInspectionRead | null,
        ProjectDefinitionInspectionRead | null, typeof createProjectManifestActionClient>({
        emptyState: null,
        createState: () => null,
        normalizeInput: input => input,
        storeKey: projectDefinitionInspectionKey,
        defaultSnapshotClient: createProjectManifestActionClient,
        retainState: retained,
        beginRefresh: state => state && 'value' in state ? { ...state, refreshing: true } : state,
        refresh: async ({ input, snapshotClient, signal }) => {
            const binding = currentBinding();
            if (!binding) return null;
            const client = snapshotClient({ workspace: input, expectedAccountId: binding.accountId, signal });
            const shown = retained ? store.getState(input) : null;
            const held = shown && 'value' in shown ? shown.value : undefined;
            const reply = held?.revision ? await client.revalidate(read, held.revision) : await client.inspect(read);
            return current => {
                if (!binding.isCurrent() && !currentBinding()) return null;
                if ('unchanged' in reply) {
                    const value = current && 'value' in current ? current.value : held;
                    return value ? { key: projectDefinitionInspectionKey(input), value, refreshing: false } : current;
                }
                const value = reply;
                let facts = value;
                if (current && 'value' in current) {
                    if (sameStrictJsonValue(current.value, value)) facts = current.value;
                    else {
                        facts = { ...value };
                        for (const field of Object.keys(value) as Array<keyof ProjectDefinitionInspection>) {
                            if (sameStrictJsonValue(current.value[field], value[field])) {
                                Object.assign(facts, { [field]: current.value[field] });
                            }
                        }
                    }
                }
                return { key: projectDefinitionInspectionKey(input), value: facts, refreshing: false };
            };
        },
        failRefresh: (state, input, _now, error: unknown) => {
            if (!currentBinding()) return null;
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                ? error.code : 'project_definition_inspection_failed';
            // Machine/root/content refusals withdraw the inspection even while Account
            // credentials remain current. A transport failure keeps the last-good facts at full
            // strength with its error as the freshness line; a Run is still admitted at invocation.
            if (!state || !('value' in state) || ['permission_denied', 'not_authenticated',
                'access_denied', 'admission_unavailable', 'content_unavailable'].includes(code)) {
                return { key: projectDefinitionInspectionKey(input), error: code };
            }
            return { ...state, refreshing: false, error: code };
        },
        applySnapshot: (_state, snapshot) => snapshot,
        subscribeRecovery: (input, refresh) => {
            // Only these presented reads consume setup readiness from Project operation changes.
            if (!['scripts', 'overview', 'rail', 'services', 'setup'].includes(read.kind)) return () => {};
            const current = input;
            const binding = currentBinding()!;
            const accountId = binding.accountId;
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
            const unsubscribe = actionOperationStore.subscribe(() => {
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
                if (changed && currentBinding()) refresh(true);
            });
            return unsubscribe;
        },
    });
    return store;
}

function inspectionReader(workspace: WorkspaceAddressV1, binding: ServerCredentialAccountScopeBinding, read: ProjectDefinitionInspectRead,
    create: boolean): InspectionReader | undefined {
    const workspaceKey = projectDefinitionInspectionKey(workspace);
    const selectionKey = JSON.stringify([workspaceKey, read]);
    const retained = retainsLastGood(read);
    // A retained list belongs to the Account; others to the exact bearer that read them.
    const key = binding.credentialKey
        ? JSON.stringify([binding.serverId, binding.accountId, retained ? null : binding.credentialKey, selectionKey]) : null;
    let unqualified = unqualifiedReaders.get(binding);
    let reader = key ? readers.get(key) : unqualified?.get(selectionKey);
    if (!reader && create) {
        const bindings = new Map<() => void, ServerCredentialAccountScopeBinding>();
        const created: InspectionReader = { workspace, bindings, retained,
            store: createInspectionStore(read, () => [...bindings.values()].find(current => current.isCurrent())),
            release() {
                if (bindings.size > 0 || retained) return;
                if (key) { if (readers.get(key) === created) readers.delete(key); }
                else if (unqualified?.get(selectionKey) === created) unqualified.delete(selectionKey);
            } };
        reader = created;
        if (key) readers.set(key, reader);
        else {
            if (!unqualified) { unqualified = new Map(); unqualifiedReaders.set(binding, unqualified); }
            unqualified.set(selectionKey, reader);
        }
    }
    return reader;
}

/** One demand-owned inspection per exact checkout, read selection and credential scope; nothing here executes. */
export function useProjectDefinitionInspection(workspace: WorkspaceAddressV1 | null, binding: ServerCredentialAccountScopeBinding | null,
    selection: ProjectDefinitionInspectRead = { kind: 'scripts' }): Readonly<{
    read: ProjectDefinitionInspectionRead | null;
    effectiveDefinition: ProjectEffectiveDefinitionInspection | null;
    retry: () => void;
}> {
    const presented = useLayoutPresentationActive();
    const key = workspace ? projectDefinitionInspectionKey(workspace) : null;
    const selectionKey = JSON.stringify(selection);
    // The semantic checkout key owns demand, not a caller's freshly allocated address object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const lookupReader = React.useCallback((create: boolean) => workspace && binding
        ? inspectionReader(workspace, binding, selection, create) : undefined, [binding, key, selectionKey]);
    const subscribe = React.useCallback((listener: () => void) => {
        if (!presented || !binding?.isCurrent()) return () => {};
        const reader = lookupReader(true);
        if (!reader) return () => {};
        reader.bindings.set(listener, binding);
        const dispose = reader.store.subscribe(reader.workspace, listener);
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            reader.bindings.delete(listener);
            dispose();
            reader.release();
        };
        const retirement = binding.onRetire(() => {
            release();
            listener();
        });
        return () => { retirement.dispose(); release(); };
    }, [binding, presented, lookupReader]);
    const getSnapshot = React.useCallback(() => {
        const reader = presented && binding?.isCurrent() ? lookupReader(false) : undefined;
        return reader ? reader.store.getState(reader.workspace) : null;
    }, [binding, presented, lookupReader]);
    const read = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const inspection = read && 'value' in read ? read.value : null;
    const effective = inspection?.effectiveDefinition;
    const effectiveDefinition = React.useMemo(() => readProjectEffectiveDefinition({ effectiveDefinition: effective }), [effective]);
    const retry = React.useCallback(() => {
        const reader = presented && binding?.isCurrent() ? lookupReader(false) : undefined;
        if (reader) reader.store.invalidate(reader.workspace);
    }, [binding, presented, lookupReader]);
    return { read, retry, effectiveDefinition: inspection ? effectiveDefinition : null };
}
