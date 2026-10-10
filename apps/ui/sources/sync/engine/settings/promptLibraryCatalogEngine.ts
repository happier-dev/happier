import { parsePromptLibraryPhysicalKeyV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readPromptLibraryCatalogProjection } from '@/sync/api/account/apiPromptLibraryCatalog';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { applyPromptLibraryCatalogSnapshot, beginPromptLibraryCatalogLoad, getPromptLibraryCatalogSnapshot,
    invalidatePromptLibraryCatalogsForServer } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
type Target = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope }>;
const targetFor = (scope: ServerAccountScope): Target => ({ key: `prompt-library:${serverAccountScopeKeySuffix(scope)}`, serverId: scope.serverId, scope });
const publicationGuards = new Map<string, () => void>();
const loader = createScopedSnapshotLoader<Target>({
    load: async ({ key, scope }, context) => {
        const guard = publicationGuards.get(key);
        try { guard?.(); } catch { return; }
        beginPromptLibraryCatalogLoad(scope);
        return context.readWithMaintenance({
            read: publication => readPromptLibraryCatalogProjection(scope, undefined, guard, publication),
            publish: (projection, current) => {
                try { guard?.(); } catch { return; }
                applyPromptLibraryCatalogSnapshot(scope, projection, current);
            },
            getPublication: () => getPromptLibraryCatalogSnapshot(scope),
        });
    },
    shouldLoadOnObserve: ({ scope }) => getPromptLibraryCatalogSnapshot(scope)?.catalog.status !== 'ready',
    invalidateServer: invalidatePromptLibraryCatalogsForServer,
    invalidateTarget: ({ scope }) => beginPromptLibraryCatalogLoad(scope),
    // Exact focused-Home wakes identify catalog rows or their retained Settings source.
    // Content-free wakes still revalidate through the existing lifecycle owner.
    matchesWake: event => event.entityIds === undefined || event.entityIds.some(id =>
        id === 'self' || parsePromptLibraryPhysicalKeyV1(id) !== null),
    onCredentialMutation: (_event, { scope }) => {
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'unavailable', reason: 'unauthorized' }, rawSettings: {}, sourceSettingsVersion: 0 }, true);
        return true;
    },
});
export function observePromptLibraryCatalog(scope: ServerAccountScope): () => void { return loader.observe(targetFor(scope)); }
export function refreshPromptLibraryCatalog(scope: ServerAccountScope): Promise<void> { return loader.refresh(targetFor(scope)); }
export function invalidatePromptLibraryCatalogProjection(scope: ServerAccountScope): Promise<void> { return loader.invalidate(targetFor(scope)); }
/** Durable receipts use uncancelled reads, but never borrow authority from a replacement Account lifetime. */
export function invalidatePromptLibraryCatalogAfterAcknowledgedMutation(scope: ServerAccountScope, assertCapturedAccountCurrent: () => void): Promise<void> {
    try { assertCapturedAccountCurrent(); } catch { return Promise.resolve(); }
    const target = targetFor(scope);
    publicationGuards.set(target.key, assertCapturedAccountCurrent);
    return loader.invalidate(target).finally(() => {
        if (publicationGuards.get(target.key) === assertCapturedAccountCurrent) publicationGuards.delete(target.key);
    });
}
export function resetPromptLibraryCatalogEngineForTests(): void { loader.resetForTests(); publicationGuards.clear(); }
