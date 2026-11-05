import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageDataActionContext } from '../actions/dataContext.js';
import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import type { CorpusRowV1 } from '../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1 } from '../corpus/collections/rows.js';
import { sameTriageEntryReference } from '../corpus/identity/components.js';
import { contractMigratedEntrySessionLink } from './entrySessionLinks.js';
import { readTriageSessionLinksPageV1 } from './readEntrySessionLinks.js';
import { createTriageSourceSessionRelations, type TriageSourceSessionLinkV1 } from './sourceSessionRelations.js';

type Collections = Pick<CorpusCollectionsV1, 'sourceInstances' | 'sessionLinks'>;
type Context = Pick<TriageDataActionContext, 'signal'> & Readonly<{
    services: Pick<TriageDataActionContext['services'], 'actions' | 'targetedContributions'>;
}>;
type Retained = Readonly<{ record: CorpusRowV1<CorpusSessionLinkRowV1>; sourceInstanceId: string | null }>;
export type TriageRetainedSessionRelationsUpgrade = Readonly<{
    signal: AbortSignal;
    ensure(context: Context, collections: Collections): Promise<void>;
    reconcile(input: Readonly<{ source: TriageEntryRefV1['source']; kindIds: readonly string[]; sourceInstanceId: string;
        entryRef?: TriageEntryRefV1; sessionId?: string;
        links: readonly TriageSourceSessionLinkV1[];
        collections: Collections; signal: AbortSignal }>): Promise<boolean>;
    dispose(): Promise<void>;
}>;

function provesDuplicate(link: TriageSourceSessionLinkV1, row: CorpusSessionLinkRowV1): boolean {
    return link.sessionId === row.sessionId && sameTriageEntryReference(link.entryRef, row.entryRef);
}

/** One lazy upgrade per real activate(api) occurrence. The host owns its Account
 * custody and retirement; no module cache or reconstructed Account key exists.
 * Only already-authoritative native relationships permit contraction. Missing
 * proof retains the old row; reads never invoke a relationship write Action. */
export function createTriageRetainedSessionRelationsUpgrade(): TriageRetainedSessionRelationsUpgrade {
    const lifetime = new AbortController();
    let migration: Promise<boolean> | undefined;
    let cleanup: Promise<void> | undefined;
    const pending: Retained[] = [];
    function removePending(retained: Retained) {
        const index = pending.indexOf(retained);
        if (index >= 0) pending.splice(index, 1);
    }
    async function run(context: Context, collections: Collections) {
        const signal = AbortSignal.any([lifetime.signal, context.signal]);
        // Deliberately omit the upgrade from this private migration invocation:
        // source reads use the existing owner, not a recursive lazy initializer.
        const owner = createTriageSourceSessionRelations({ signal, services: context.services }, collections);
        const records: Array<CorpusRowV1<CorpusSessionLinkRowV1>> = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
            if (signal.aborted) return false;
            const page = await readTriageSessionLinksPageV1(collections.sessionLinks, { cursor }, { signal });
            records.push(...page.records);
            if (page.nextCursor !== undefined && seen.has(page.nextCursor)) throw new Error('triage:sessionLinks:cursorDidNotAdvance');
            if (page.nextCursor !== undefined) seen.add(page.nextCursor);
            cursor = page.nextCursor;
        } while (cursor !== undefined);
        const retainedRows: Retained[] = records.map(record => ({ record, sourceInstanceId: null }));
        pending.push(...retainedRows);
        for (const unresolved of retainedRows) {
            if (signal.aborted) return false;
            const record = unresolved.record;
            const row = record.value;
            const scopes = (await owner.readScopes({ entryRef: row.entryRef })).filter(scope => scope.kind === 'ready'
                && scope.roleKinds.includes(row.entryRef.kindId)
                && scope.source.descriptor.kinds.some(kind => kind.id === row.entryRef.kindId && kind.workflowSubject === 'pullRequest'));
            if (scopes.length === 0) {
                // An absent descriptor/configuration cannot prove non-ownership.
                // Keep exact retained bytes in this occurrence's unresolved set;
                // only a later claimed PR slice is affected by their coverage.
                continue;
            }
            const selected = scopes.length === 1 && scopes[0]?.kind === 'ready' ? scopes[0] : undefined;
            const retained = { record, sourceInstanceId: selected?.lane.sourceInstanceId ?? null };
            pending[pending.indexOf(unresolved)] = retained;
            if (selected === undefined || selected.source.operations?.readSessionLinks === undefined) continue;
            try {
                const native = await owner.read({ entryRef: row.entryRef, sourceInstanceId: selected.lane.sourceInstanceId,
                    sessionId: row.sessionId });
                if (signal.aborted || native.kind !== 'complete' || !native.links.some(link => provesDuplicate(link, row))) continue;
                if ((await contractMigratedEntrySessionLink({ collections, retained: record, signal })).status === 'unlinked') {
                    removePending(retained);
                }
            } catch { /* An unverified duplicate never permits destroying the retained row. */ }
        }
        return !signal.aborted;
    }
    return {
        signal: lifetime.signal,
        async ensure(context, collections) {
            while (!context.signal.aborted && !lifetime.signal.aborted) {
                const startedHere = migration === undefined;
                if (migration === undefined) {
                    const initialization: Promise<boolean> = run(context, collections).catch(() => false).then(completed => {
                        // A failed or cancelled census can be retried by the next
                        // explicit demand; never retry the initiating read in a loop.
                        if (!completed && migration === initialization) {
                            migration = undefined;
                            pending.length = 0;
                        }
                        return completed;
                    });
                    migration = initialization;
                }
                const current = migration;
                await current;
                if (migration === current || startedHere) return;
            }
        },
        async reconcile(input) {
            let incomplete = migration === undefined;
            for (const retained of [...pending]) {
                const row = retained.record.value;
                if (row.entryRef.source.pluginId !== input.source.pluginId || row.entryRef.source.localId !== input.source.localId
                    || !input.kindIds.includes(row.entryRef.kindId)
                    || (input.entryRef !== undefined && !sameTriageEntryReference(input.entryRef, row.entryRef))
                    || (input.sessionId !== undefined && input.sessionId !== row.sessionId)) continue;
                if (retained.sourceInstanceId !== null && retained.sourceInstanceId !== input.sourceInstanceId) continue;
                if (!input.signal.aborted && input.links.some(link => provesDuplicate(link, row))) {
                    if ((await contractMigratedEntrySessionLink({ collections: input.collections, retained: retained.record,
                        signal: input.signal })).status === 'unlinked') {
                        removePending(retained);
                        continue;
                    }
                }
                // Explicit unlink may have retired the retained row through its
                // normal writer. An absent row needs no native import or CAS.
                const current = await input.collections.sessionLinks.get(retained.record.rowId, { signal: input.signal });
                if (current === null) { removePending(retained); continue; }
                incomplete = true;
            }
            return incomplete;
        },
        dispose() {
            lifetime.abort();
            return cleanup ??= Promise.resolve(migration).then(() => {});
        },
    };
}
