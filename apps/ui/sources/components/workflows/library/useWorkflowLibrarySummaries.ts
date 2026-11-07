import * as React from 'react';

import type { WorkflowRunSourceSummariesResultV1, WorkflowRunAutomationSummariesResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { summarizeWorkflowRuns, summarizeWorkflowAutomationRuns } from '@/sync/domains/workflows/workflowRunListActions';
import { subscribeVisibleWorkflowRunListInvalidation } from '@/sync/domains/workflows/workflowRunListInvalidation';
import { readServerAccountScopeOwnerLifetime, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';

import { WORKFLOW_RUN_STRIP_LENGTH } from './workflowRunStrip';

export type WorkflowLibraryRunSummary = WorkflowRunSourceSummariesResultV1['summaries'][number];
export type WorkflowAutomationRunSummary = WorkflowRunAutomationSummariesResultV1['automationSummaries'][number];
type SummaryKind = 'source' | 'automation';
type Summary = WorkflowLibraryRunSummary | WorkflowAutomationRunSummary;
type SummaryMap<T> = ReadonlyMap<string, T>;
export type SummaryRead<T> = Readonly<{ summaries: SummaryMap<T> | null; failed: boolean; failedIds: ReadonlySet<string>; retry: () => void }>;
type SummarySelection<T> = Readonly<{ kind: SummaryKind; empty: SummaryMap<T>; select: (summary: Summary) => T | undefined }>;
const EMPTY_SUMMARIES: SummaryMap<WorkflowLibraryRunSummary> = new Map();
const SOURCE_SELECTION: SummarySelection<WorkflowLibraryRunSummary> = {
    kind: 'source', empty: EMPTY_SUMMARIES,
    select: summary => 'sourceArtifactId' in summary ? summary : undefined,
};
const AUTOMATION_SELECTION: SummarySelection<WorkflowAutomationRunSummary> = {
    kind: 'automation', empty: new Map(),
    select: summary => 'automationId' in summary ? summary : undefined,
};
const subscribeInactive = (_listener: () => void) => () => {};

/** One scoped request owner for library rows, Board cards and chrome. It holds summaries, never
 * Runs; the existing Run store remains authoritative for Run records. */
function createSummaryOwner(lifetime: ActiveServerAccountScopeLifetime) {
    let summaries: SummaryMap<Summary> = EMPTY_SUMMARIES;
    const failed = new Set<string>();
    const listeners = new Set<() => void>();
    const demands = new Set<readonly string[]>();
    const pending = new Set<string>();
    const inFlight = new Map<string, AbortController>();
    let queued = false;
    let unsubscribeWake: (() => void) | null = null;
    const publish = () => { for (const listener of listeners) listener(); };

    function schedule() {
        if (queued || !lifetime.isCurrent()) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            if (!lifetime.isCurrent()) return;
            const keys = [...pending].filter(key => !inFlight.has(key));
            for (const kind of ['source', 'automation'] as const) {
                const selected = keys.filter(key => key.startsWith(`${kind}:`));
                if (selected.length === 0) continue;
                const controller = new AbortController();
                for (const key of selected) { pending.delete(key); inFlight.set(key, controller); }
                void read(kind, selected, controller);
            }
        });
    }

    async function read(kind: SummaryKind, keys: readonly string[], controller: AbortController) {
        const collected = new Map<string, Summary>();
        try {
            let remaining = keys.map(key => key.slice(kind.length + 1));
            while (remaining.length > 0) {
                const page = kind === 'source'
                    ? await summarizeWorkflowRuns({ sourceArtifactIds: remaining, recent: WORKFLOW_RUN_STRIP_LENGTH, signal: controller.signal, accountLifetime: lifetime })
                    : await summarizeWorkflowAutomationRuns({ automationIds: remaining, signal: controller.signal, accountLifetime: lifetime });
                if (!lifetime.isCurrent() || controller.signal.aborted) return;
                if ('summaries' in page) {
                    for (const summary of page.summaries) collected.set(`source:${summary.sourceArtifactId}`, summary);
                    if (page.summaries.length === 0) break;
                    remaining = page.remainingSourceArtifactIds;
                } else {
                    for (const summary of page.automationSummaries) collected.set(`automation:${summary.automationId}`, summary);
                    if (page.automationSummaries.length === 0) break;
                    remaining = page.remainingAutomationIds;
                }
            }
        } catch {
            // Retain admitted page facts and last-known answers; unanswered ids fail below.
        } finally {
            if (lifetime.isCurrent() && !controller.signal.aborted) {
                const next = new Map(summaries);
                let changed = false;
                for (const key of keys) {
                    const incoming = collected.get(key);
                    if (incoming) {
                        const stored = summaries.get(key);
                        if (!stored || !sameStrictJsonValue(stored, incoming)) { next.set(key, incoming); changed = true; }
                        if (failed.delete(key)) changed = true;
                    } else if (!failed.has(key)) {
                        // Missing, empty and failed continuations never establish lastRun:null.
                        failed.add(key); changed = true;
                    }
                }
                if (changed) { summaries = next; publish(); }
            }
            for (const key of keys) if (inFlight.get(key) === controller) inFlight.delete(key);
            if (pending.size > 0) schedule();
        }
    }

    lifetime.onRetire(() => {
        unsubscribeWake?.(); unsubscribeWake = null;
        for (const controller of inFlight.values()) controller.abort();
        inFlight.clear();
        demands.clear(); pending.clear(); failed.clear();
        summaries = EMPTY_SUMMARIES;
        // Capturing a replacement scope can retire this lifetime during another consumer's render.
        queueMicrotask(publish);
    });
    return {
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        get: () => summaries,
        hasFailed: (key: string) => failed.has(key),
        retry(keys: readonly string[]) {
            const superseded = new Set(keys.flatMap(key => {
                const controller = inFlight.get(key);
                return controller ? [controller] : [];
            }));
            const demanded = new Set([...demands].flat());
            for (const [key, controller] of inFlight) {
                if (!superseded.has(controller)) continue;
                controller.abort();
                inFlight.delete(key);
                // Cancelling one shared batch also releases its other current borrowers.
                if (demanded.has(key)) pending.add(key);
            }
            for (const key of keys) pending.add(key);
            schedule();
        },
        demand(keys: readonly string[]) {
            const activeKeys = new Set([...demands].flat());
            demands.add(keys);
            if (!unsubscribeWake) unsubscribeWake = subscribeVisibleWorkflowRunListInvalidation({
                lifetime, isVisibleWindowLoaded: () => true,
                sourceArtifactIds: () => [...demands].flatMap(keys => keys.flatMap(key => key.startsWith('source:') ? [key.slice('source:'.length)] : [])),
                invalidate: change => {
                    if (change.sourceArtifactIds) for (const id of change.sourceArtifactIds) pending.add(`source:${id}`);
                    else for (const demand of demands) for (const id of demand) pending.add(id);
                    schedule();
                },
            });
            // An id may miss wakes while hidden even if a sibling remains visible. Keep its
            // last-known row, but refresh new demand after any older in-flight reply.
            for (const key of keys) if (!activeKeys.has(key)) pending.add(key);
            schedule();
            return () => {
                demands.delete(keys);
                if (demands.size === 0) {
                    unsubscribeWake?.(); unsubscribeWake = null; pending.clear();
                    for (const controller of inFlight.values()) controller.abort();
                    inFlight.clear();
                }
            };
        },
    };
}

const owners = new WeakMap<ActiveServerAccountScopeLifetime, ReturnType<typeof createSummaryOwner>>();

/** Concurrent mounts union their ids before transport; later mounts join in-flight ids. A single
 * Account wake refreshes current demand and equal replies retain row/map identities. */
function useWorkflowSummaries<T>(requestedIds: readonly string[], selector: SummarySelection<T>, explicitLifetime?: ServerAccountScopeLifetime | null): SummaryRead<T> {
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const addressedLifetime = useWorkflowAccountLifetime(explicitLifetime);
    const selectedLifetime = addressedLifetime === undefined ? activeLifetime : addressedLifetime;
    const uniqueIds = [...new Set(requestedIds)];
    // Source rows retain their incumbent canonical ordering; Automation demand and all
    // server continuations preserve input order.
    const key = JSON.stringify(selector.kind === 'source' ? uniqueIds.sort() : uniqueIds);
    const lifetime = uniqueIds.length > 0 && selectedLifetime ? readServerAccountScopeOwnerLifetime(selectedLifetime) : null;
    const selection = React.useMemo(() => {
        // The key is encoded immediately above; JSON preserves opaque ids and their boundaries.
        const ids = JSON.parse(key) as string[];
        const keys = ids.map(id => `${selector.kind}:${id}`);
        let owner = lifetime ? owners.get(lifetime) : undefined;
        if (lifetime && !owner) { owner = createSummaryOwner(lifetime); owners.set(lifetime, owner); }
        const retry = () => owner?.retry(keys);
        let selected: SummaryMap<T> | null = null;
        let snapshot: SummaryRead<T> | undefined;
        const get = (): SummaryRead<T> => {
            const current = owner?.get() ?? EMPTY_SUMMARIES;
            const readable = owner && lifetime?.isCurrent();
            const nextFailedIds = readable ? ids.filter((_id, index) => owner?.hasFailed(keys[index]!)) : [];
            const failedIds = snapshot && snapshot.failedIds.size === nextFailedIds.length
                && nextFailedIds.every(id => snapshot!.failedIds.has(id)) ? snapshot.failedIds : new Set(nextFailedIds);
            if (ids.length === 0) selected = selector.empty;
            else if (!readable || keys.every(key => !current.has(key))) selected = null;
            else if (!selected || !ids.every((id, index) => {
                const value = current.get(keys[index]!);
                return selected!.get(id) === (value ? selector.select(value) : undefined);
            })) {
                selected = new Map(ids.flatMap((id, index) => {
                    const value = current.get(keys[index]!);
                    const summary = value ? selector.select(value) : undefined;
                    return summary ? [[id, summary] as const] : [];
                }));
            }
            if (!snapshot || snapshot.summaries !== selected || snapshot.failedIds !== failedIds) {
                snapshot = { summaries: selected, failed: failedIds.size > 0, failedIds, retry };
            }
            return snapshot;
        };
        return { owner, keys, get };
    }, [key, lifetime, selector]);
    React.useEffect(() => selection.owner?.demand(selection.keys), [selection]);
    return React.useSyncExternalStore(selection.owner?.subscribe ?? subscribeInactive, selection.get, selection.get);
}

export function useWorkflowLibrarySummaries(sourceArtifactIds: readonly string[], options?: Readonly<{ accountLifetime?: ServerAccountScopeLifetime | null }>): SummaryRead<WorkflowLibraryRunSummary> {
    return useWorkflowSummaries(sourceArtifactIds, SOURCE_SELECTION, options?.accountLifetime);
}

export function useWorkflowAutomationSummaries(automationIds: readonly string[]): SummaryRead<WorkflowAutomationRunSummary> {
    return useWorkflowSummaries(automationIds, AUTOMATION_SELECTION);
}
