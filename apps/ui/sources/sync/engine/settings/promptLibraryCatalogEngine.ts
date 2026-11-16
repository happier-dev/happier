import { buildPromptLibraryPhysicalKeyV1, parsePromptLibraryPhysicalKeyV1, type PromptLibraryCatalogKeyV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readPromptLibraryCatalogProjection, readPromptLibraryCatalogRowsProjection,
    type PromptLibraryAccountContext } from '@/sync/api/account/apiPromptLibraryCatalog';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { subscribeAccountCatalogInvalidation } from './accountCatalogInvalidation';
import { homeAccountChangeAffectsPrivateAccountRows } from '@/sync/runtime/orchestration/changesPlanner';
import { applyPromptLibraryCatalogSnapshot, beginPromptLibraryCatalogLoad, getPromptLibraryCatalogSnapshot,
    applyPromptLibraryCatalogRowsSnapshot, beginPromptLibraryCatalogRowsLoad, getAcknowledgedPromptLibraryCatalogValue,
    invalidatePromptLibraryCatalogsForServer, getPromptLibraryCatalogValue, type PromptLibraryCatalogProjection,
    type PromptLibraryCatalogValueSnapshot } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { withActionAccountRequestSignal } from '@/sync/ops/actions/actionAccountContext';
type Target = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope; finite?: true }>;
const targetFor = (scope: ServerAccountScope): Target => ({ key: `prompt-library:${serverAccountScopeKeySuffix(scope)}`, serverId: scope.serverId, scope });
const publicationGuards = new Map<string, () => void>();
// Demand pending on the existing single-flight loader, consumed by its next pass.
// null requires a full activation/maintenance pass; numeric hints permit skipping a received revision.
const pendingRows = new Map<string, Map<PromptLibraryCatalogKeyV1, number | undefined> | null>();
const loader = createScopedSnapshotLoader<Target>({
    subscribeRetainedInvalidation: subscribeAccountCatalogInvalidation,
    load: async ({ key, scope, finite }, context) => {
        const guard = publicationGuards.get(key);
        try { guard?.(); } catch { return; }
        const demand = pendingRows.get(key);
        pendingRows.delete(key);
        if (demand) {
            const keys = [...demand].filter(([row, revision]) => {
                const received = getAcknowledgedPromptLibraryCatalogValue(scope, row);
                return revision === undefined || typeof received.revision !== 'number' || received.revision < revision;
            }).map(([row]) => row);
            if (keys.length === 0) {
                const projection = getPromptLibraryCatalogSnapshot(scope);
                if (projection) applyPromptLibraryCatalogSnapshot(scope, projection, context.isCurrent(), [...demand.keys()]);
                return;
            }
            const read = await readPromptLibraryCatalogRowsProjection(scope, keys);
            // Row reads publish directly rather than through readWithMaintenance.
            // A canceled reader's late success or refusal belongs to no consumer.
            if (context.signal.aborted) return;
            try { guard?.(); } catch { return; }
            if (read) {
                if (!read.isAccountCurrent()) return;
                applyPromptLibraryCatalogRowsSnapshot(scope, keys, read.projection, true, !context.isCurrent());
                return;
            }
        }
        beginPromptLibraryCatalogLoad(scope);
        if (finite) {
            // Finite Actions use this same acquisition without the observer's retained-source cleanup.
            const projection = await readPromptLibraryCatalogProjection(scope, context.signal, guard);
            if (context.signal.aborted) return;
            try { guard?.(); } catch { return; }
            applyPromptLibraryCatalogSnapshot(scope, projection, context.isCurrent());
            return;
        }
        return context.readWithMaintenance<PromptLibraryCatalogProjection>({
            read: publication => readPromptLibraryCatalogProjection(scope, undefined, guard, publication),
            publish: (projection, current, isAccountCurrent) => {
                try { guard?.(); } catch { return; }
                // A wake lapses freshness, not the captured Account's right to
                // retain readable data while the coalesced current read runs.
                const accountCurrent = isAccountCurrent ? isAccountCurrent() : current;
                applyPromptLibraryCatalogSnapshot(scope, projection, accountCurrent, undefined, !current);
            },
            getPublication: () => getPromptLibraryCatalogSnapshot(scope),
        });
    },
    shouldLoadOnObserve: ({ scope }) => getPromptLibraryCatalogSnapshot(scope)?.catalog.status !== 'ready',
    invalidateServer: invalidatePromptLibraryCatalogsForServer,
    invalidateTarget: ({ key, scope }) => {
        const rows = pendingRows.get(key);
        if (rows) beginPromptLibraryCatalogRowsLoad(scope, [...rows.keys()]);
        else beginPromptLibraryCatalogLoad(scope);
    },
    // Reach must follow remote edits while unrelated historical changes are
    // still being materialized. Reuse the same scoped, coalesced catalog read.
    observeCatchUpPending: true,
    // Exact focused-Home wakes identify catalog rows or their retained Settings source.
    // Content-free wakes still revalidate through the existing lifecycle owner.
    matchesWake: event => event.entityIds === undefined ? homeAccountChangeAffectsPrivateAccountRows(event)
        : event.entityIds.some(id => id === 'self' || parsePromptLibraryPhysicalKeyV1(id) !== null),
    prepareWake: (event, { key, scope }) => {
        const catalog = getPromptLibraryCatalogSnapshot(scope)?.catalog;
        if ((catalog?.status !== 'ready' && catalog?.status !== 'partial') || event.entityIds?.includes('self')
            || (event.entityIds === undefined && event.source !== 'catch-up-pending')) {
            pendingRows.set(key, null);
            return true;
        }
        // Only reach needs to bypass held historical materialization. Other rows
        // consume their exact page, avoiding full maintenance on every socket wake.
        const keys = event.source === 'catch-up-pending' ? ['skill-rules' as const]
            : (event.entityIds ?? []).flatMap(id => { const parsed = parsePromptLibraryPhysicalKeyV1(id); return parsed ? [parsed] : []; });
        if (keys.some(row => row !== 'skill-rules')) { pendingRows.set(key, null); return true; }
        const required = keys.filter(row => {
            const revision = event.entityRevisions?.[buildPromptLibraryPhysicalKeyV1(row)];
            const received = getAcknowledgedPromptLibraryCatalogValue(scope, row);
            return revision === undefined || typeof received.revision !== 'number' || received.revision < revision;
        });
        if (required.length === 0) return false;
        if (pendingRows.has(key) && pendingRows.get(key) === null) return true;
        const rows = pendingRows.get(key) ?? new Map<PromptLibraryCatalogKeyV1, number | undefined>();
        for (const row of required) {
            const revision = event.entityRevisions?.[buildPromptLibraryPhysicalKeyV1(row)];
            const previous = rows.get(row);
            rows.set(row, !rows.has(row) ? revision
                : revision === undefined || previous === undefined ? undefined : Math.max(previous, revision));
        }
        pendingRows.set(key, rows);
        return true;
    },
    onCredentialMutation: (_event, { key, scope }) => {
        pendingRows.delete(key);
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'unavailable', reason: 'unauthorized' }, rawSettings: {}, sourceSettingsVersion: 0 }, true);
        return true;
    },
});
export function observePromptLibraryCatalog(scope: ServerAccountScope): () => void { return loader.observe(targetFor(scope)); }
/** Finite readers borrow current foreground acquisition without starting its retained-source cleanup. */
export async function readPromptLibraryCatalogInCapturedAccount(account: PromptLibraryAccountContext,
    signal?: AbortSignal, key: PromptLibraryCatalogKeyV1 = 'folders'): Promise<PromptLibraryCatalogProjection> {
    return withActionAccountRequestSignal(account, signal, async signal => {
        throwIfAborted(signal);
        account.assertCurrent();
        const scope = { serverId: account.serverId, accountId: account.accountId };
        if (!isPromptLibraryCatalogRowHeldCurrent(scope, key)) await loader.refresh({ ...targetFor(scope), finite: true }, signal);
        throwIfAborted(signal);
        account.assertCurrent();
        const projection = getPromptLibraryCatalogSnapshot(scope);
        if (!projection) throw new Error('Artifact folder catalog is unavailable');
        return projection;
    });
}
/**
 * A held row stays current until its retained wake, credential or observer-gap
 * invalidation marks it stale, so a use of the catalog never re-reads it.
 */
function isPromptLibraryCatalogRowHeldCurrent(scope: ServerAccountScope, key: PromptLibraryCatalogKeyV1): boolean {
    const row = getPromptLibraryCatalogValue(scope, key);
    return row.status === 'ready' && !row.stale;
}
/** A use (Send, slash suggestions, launch) reads the held row and acquires the catalog only when it is not current. */
export async function readCurrentPromptLibraryCatalogValue<K extends PromptLibraryCatalogKeyV1>(scope: ServerAccountScope,
    key: K): Promise<PromptLibraryCatalogValueSnapshot<K>> {
    if (!isPromptLibraryCatalogRowHeldCurrent(scope, key)) await loader.refresh(targetFor(scope));
    return getPromptLibraryCatalogValue(scope, key);
}
/** Explicit retry and post-acknowledgement settlement: always reads. */
export function refreshPromptLibraryCatalog(scope: ServerAccountScope): Promise<void> { return loader.refresh(targetFor(scope)); }
export function invalidatePromptLibraryCatalogProjection(scope: ServerAccountScope): Promise<void> {
    const target = targetFor(scope);
    pendingRows.delete(target.key);
    return loader.invalidate(target);
}
/** Durable receipts use uncancelled reads, but never borrow authority from a replacement Account lifetime. */
export function invalidatePromptLibraryCatalogAfterAcknowledgedMutation(scope: ServerAccountScope, assertCapturedAccountCurrent: () => void): Promise<void> {
    try { assertCapturedAccountCurrent(); } catch { return Promise.resolve(); }
    const target = targetFor(scope);
    pendingRows.delete(target.key);
    publicationGuards.set(target.key, assertCapturedAccountCurrent);
    return loader.invalidate(target).finally(() => {
        if (publicationGuards.get(target.key) === assertCapturedAccountCurrent) publicationGuards.delete(target.key);
    });
}
export function resetPromptLibraryCatalogEngineForTests(): void { loader.resetForTests(); publicationGuards.clear(); pendingRows.clear(); }
