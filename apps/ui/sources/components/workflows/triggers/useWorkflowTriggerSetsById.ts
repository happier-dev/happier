import * as React from 'react';
import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { listWorkflowTriggerPage } from '@/sync/domains/workflows/workflowTriggerActions';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

type ExactTriggerReader = {
    ids: ReadonlySet<string>;
    demanded: boolean;
    notify: () => void;
};

type ExactTriggerRead = {
    readers: Set<ExactTriggerReader>;
    set: WorkflowTriggerSetV1 | null | undefined;
    // Undefined needs a read, null is settled, and a controller owns a pending answer.
    pending: AbortController | null | undefined;
};

const NO_SETS_BY_ID: ReadonlyMap<string, WorkflowTriggerSetV1 | null> = new Map();
const NO_EXACT_TRIGGER_IDS: ReadonlySet<string> = new Set();

function createExactTriggerReads(lifetime: ServerAccountScopeLifetime) {
    const reads = new Map<string, ExactTriggerRead>();
    let stop: (() => void) | undefined;

    function hasDemand(read: ExactTriggerRead) {
        for (const reader of read.readers) if (reader.demanded) return true;
        return false;
    }

    function cancel(read: ExactTriggerRead) {
        if (read.pending) {
            read.pending.abort();
            read.pending = undefined;
        }
    }

    function start(id: string, read: ExactTriggerRead) {
        if (read.pending !== undefined || !hasDemand(read)) return;
        const controller = new AbortController();
        read.pending = controller;
        const settle = (set: WorkflowTriggerSetV1 | null) => {
            if (read.pending !== controller || !lifetime.isCurrent()) return;
            read.pending = null;
            const previous = read.set;
            read.set = retainDeep(previous, set);
            if (read.set !== previous) for (const reader of read.readers) reader.notify();
        };
        void listWorkflowTriggerPage({ automationId: id }, { signal: controller.signal, accountLifetime: lifetime })
            .then(result => settle(result.sets.find(candidate => candidate.automationId === id) ?? null), () => settle(null));
    }

    function observeHome() {
        const unsubscribe = subscribeHomeAccountChange(event => {
            if (!areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)) return;
            // A planner-proven exact scope can accompany unrelated rows on the same feed page.
            // Trigger-source-only changes do not affect the saved Workflow name projection.
            if (event.workflowDefinitionsAffect === false) return;
            for (const id of event.workflowDefinitionAutomationIds ?? reads.keys()) {
                const read = reads.get(id);
                if (!read) continue;
                cancel(read);
                read.pending = undefined;
                start(id, read);
            }
        }, { reconnect: 'refresh' });
        const retirement = lifetime.onRetire(() => {
            for (const read of reads.values()) {
                cancel(read);
                read.set = undefined;
                for (const reader of read.readers) reader.notify();
            }
            reads.clear();
            stop?.();
        });
        stop = () => { unsubscribe(); retirement.dispose(); stop = undefined; };
    }

    return {
        observe(reader: ExactTriggerReader, ids: ReadonlySet<string>, demanded: boolean) {
            const previousIds = reader.ids;
            reader.ids = ids;
            reader.demanded = demanded;
            if (!lifetime.isCurrent()) return;
            for (const id of previousIds) {
                const read = reads.get(id);
                if (!read) continue;
                if (!ids.has(id)) read.readers.delete(reader);
                if (!hasDemand(read)) cancel(read);
                if (read.readers.size === 0) reads.delete(id);
            }
            if (ids.size > 0 && !stop) observeHome();
            let alreadySettled = false;
            for (const id of ids) {
                let read = reads.get(id);
                if (!read) {
                    read = { readers: new Set(), set: undefined, pending: undefined };
                    reads.set(id, read);
                }
                if (!read.readers.has(reader)) {
                    read.readers.add(reader);
                    alreadySettled ||= read.set !== undefined;
                }
                start(id, read);
            }
            if (alreadySettled) reader.notify();
            if (reads.size === 0) stop?.();
        },
        snapshot(ids: ReadonlySet<string>) {
            const sets = new Map<string, WorkflowTriggerSetV1 | null>();
            for (const id of ids) {
                const set = reads.get(id)?.set;
                if (set !== undefined) sets.set(id, set);
            }
            return sets.size > 0 ? sets : NO_SETS_BY_ID;
        },
    };
}

const exactTriggerReads = new WeakMap<ServerAccountScopeLifetime, ReturnType<typeof createExactTriggerReads>>();

/**
 * The Run surfaces share the exact Automation read and its Home change subscription.
 * A hidden surface retains settled names, and only visible demand starts a read.
 */
export function useWorkflowTriggerSetsById(automationIds: readonly string[], options: Readonly<{
    demanded: boolean;
    accountLifetime?: ServerAccountScopeLifetime | null;
}>): ReadonlyMap<string, WorkflowTriggerSetV1 | null> {
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = options.accountLifetime === undefined ? activeLifetime : options.accountLifetime;
    const idsKey = [...new Set(automationIds)].sort().join('\n');
    const ids = React.useMemo(() => new Set(idsKey ? idsKey.split('\n') : []), [idsKey]);
    const owner = React.useMemo(() => {
        if (!lifetime) return null;
        const existing = exactTriggerReads.get(lifetime);
        if (existing) return existing;
        const reads = createExactTriggerReads(lifetime);
        exactTriggerReads.set(lifetime, reads);
        return reads;
    }, [lifetime]);
    const [revision, notify] = React.useReducer((value: number) => value + 1, 0);
    const reader = React.useMemo<ExactTriggerReader>(() => ({
        ids: NO_EXACT_TRIGGER_IDS, demanded: false, notify,
    }), [owner, notify]);

    React.useEffect(() => () => owner?.observe(reader, NO_EXACT_TRIGGER_IDS, false), [owner, reader]);
    React.useEffect(() => {
        // Demand loss empties the Run rows upstream. Keep their settled names and
        // change observation until this surface is presented again or unmounts.
        owner?.observe(reader, options.demanded ? ids : reader.ids, options.demanded);
    }, [owner, reader, ids, options.demanded]);

    return React.useMemo(() => owner?.snapshot(ids) ?? NO_SETS_BY_ID, [owner, ids, revision]);
}
