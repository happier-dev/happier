import * as React from 'react';

import type { WorkflowRunSummariesResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { summarizeWorkflowRuns } from '@/sync/domains/workflows/workflowRunListActions';
import { subscribeVisibleWorkflowRunListInvalidation } from '@/sync/domains/workflows/workflowRunListInvalidation';

import { WORKFLOW_RUN_STRIP_LENGTH } from './workflowRunStrip';

export type WorkflowLibraryRunSummary = WorkflowRunSummariesResultV1['summaries'][number];
type SummaryMap = ReadonlyMap<string, WorkflowLibraryRunSummary>;
const EMPTY_SUMMARIES: SummaryMap = new Map();
const subscribeInactive = (_listener: () => void) => () => {};

/** One scoped request owner for library rows, Board cards and chrome. It holds summaries, never
 * Runs; the existing Run store remains authoritative for Run records. */
function createSummaryOwner(lifetime: ActiveServerAccountScopeLifetime) {
    let summaries: SummaryMap = EMPTY_SUMMARIES;
    const answered = new Set<string>();
    const listeners = new Set<() => void>();
    const demands = new Set<readonly string[]>();
    const pending = new Set<string>();
    const inFlight = new Set<string>();
    let queued = false;
    let unsubscribeWake: (() => void) | null = null;
    const publish = () => { for (const listener of listeners) listener(); };

    function schedule() {
        if (queued || !lifetime.isCurrent()) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            if (!lifetime.isCurrent()) return;
            const ids = [...pending].filter(id => !inFlight.has(id));
            if (ids.length === 0) return;
            for (const id of ids) { pending.delete(id); inFlight.add(id); }
            void read(ids);
        });
    }

    async function read(ids: readonly string[]) {
        try {
            const collected = new Map<string, WorkflowLibraryRunSummary>();
            let remaining = ids;
            while (remaining.length > 0) {
                const page = await summarizeWorkflowRuns({ sourceArtifactIds: remaining, recent: WORKFLOW_RUN_STRIP_LENGTH });
                if (!lifetime.isCurrent()) return;
                for (const summary of page.summaries) collected.set(summary.sourceArtifactId, summary);
                // The server emits a summary even for a definition with no Runs. An empty page
                // cannot progress and is not evidence that its unanswered ids have no Runs.
                if (page.summaries.length === 0) break;
                remaining = page.remainingSourceArtifactIds;
            }
            const next = new Map(summaries);
            let changed = false;
            for (const id of ids) {
                const incoming = collected.get(id);
                if (!incoming) continue;
                const stored = summaries.get(id);
                if (!stored || !sameStrictJsonValue(stored, incoming)) { next.set(id, incoming); changed = true; }
                if (!answered.has(id)) { answered.add(id); changed = true; }
            }
            if (changed) { summaries = next; publish(); }
        } catch {
            // A failed refresh keeps the last answer; missing facts remain unavailable.
        } finally {
            for (const id of ids) inFlight.delete(id);
            if (pending.size > 0) schedule();
        }
    }

    lifetime.onRetire(() => {
        unsubscribeWake?.(); unsubscribeWake = null;
        demands.clear(); pending.clear(); answered.clear();
        summaries = EMPTY_SUMMARIES;
        // Capturing a replacement scope can retire this lifetime during another consumer's render.
        queueMicrotask(publish);
    });
    return {
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        get: () => summaries,
        hasAnswered: (id: string) => answered.has(id),
        demand(ids: readonly string[]) {
            const returningFromIdle = demands.size === 0;
            demands.add(ids);
            if (!unsubscribeWake) unsubscribeWake = subscribeVisibleWorkflowRunListInvalidation({
                lifetime, isVisibleWindowLoaded: () => true,
                invalidate: () => { for (const demand of demands) for (const id of demand) pending.add(id); schedule(); },
            });
            // With no visible demand the wake subscription was detached. Retain last-known
            // facts, but refresh returning demand, including after an older in-flight reply.
            for (const id of ids) if (returningFromIdle || (!answered.has(id) && !inFlight.has(id))) pending.add(id);
            schedule();
            return () => {
                demands.delete(ids);
                if (demands.size === 0) { unsubscribeWake?.(); unsubscribeWake = null; pending.clear(); }
            };
        },
    };
}

const owners = new WeakMap<ActiveServerAccountScopeLifetime, ReturnType<typeof createSummaryOwner>>();

/** Concurrent mounts union their ids before transport; later mounts join in-flight ids. A single
 * Account wake refreshes current demand and equal replies retain row/map identities. */
export function useWorkflowLibrarySummaries(sourceArtifactIds: readonly string[]): SummaryMap | null {
    const scope = useActiveServerAccountScope();
    const scopeKey = scope === null ? null : serverAccountScopeKeySuffix(scope);
    const key = [...new Set(sourceArtifactIds)].sort().join('\u0000');
    const lifetime = key.length > 0 && scopeKey !== null ? captureActiveServerAccountScopeLifetime() : null;
    const selection = React.useMemo(() => {
        const ids = key.length > 0 ? key.split('\u0000') : [];
        let owner = lifetime ? owners.get(lifetime) : undefined;
        if (lifetime && !owner) { owner = createSummaryOwner(lifetime); owners.set(lifetime, owner); }
        let selected: SummaryMap | null = null;
        const get = (): SummaryMap | null => {
            if (ids.length === 0) return EMPTY_SUMMARIES;
            if (!owner || !lifetime?.isCurrent() || ids.every(id => !owner.hasAnswered(id))) return null;
            const current = owner.get();
            if (selected && ids.every(id => selected!.get(id) === current.get(id))) return selected;
            selected = new Map(ids.flatMap(id => { const summary = current.get(id); return summary ? [[id, summary] as const] : []; }));
            return selected;
        };
        return { owner, ids, get };
    }, [key, lifetime]);
    React.useEffect(() => selection.owner?.demand(selection.ids), [selection]);
    return React.useSyncExternalStore(selection.owner?.subscribe ?? subscribeInactive, selection.get, selection.get);
}
