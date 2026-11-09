import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import { applyReachRulesChangeV1, reachRulesToDraftsV1, ReachRulesChangeV1Schema, type ReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import { readReachRulesAcknowledgment } from './reachRulesAcknowledgment';
import { projectMcpServerActionFailureV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { randomUUID } from '@/platform/randomUUID';

export type ReachRulesWriteResult = Readonly<{ ok: true }> | Readonly<{ ok: false; message: string }>;
export type ReachRulesSource = Readonly<{ key: string; kind: 'skill' | 'mcp_server'; itemId: string; rules: ReachRulesV1;
    revision: number | 'absent'; status: 'ready' | 'loading' | 'unavailable'; valueAvailable: boolean }>;
type McpRulesInput = Readonly<{
    items: readonly Readonly<{ serverId: string }>[]; change: ReachRulesChangeV1;
}>;
type SkillRulesInput = Readonly<{
    items: readonly Readonly<{ skillId: string }>[]; change: ReachRulesChangeV1;
}>;
export type ExecuteReachRules = (...args: [actionId: 'mcp.rules.set', input: McpRulesInput]
    | [actionId: 'skills.rules.set', input: SkillRulesInput]) => Promise<ActionExecuteResult>;

type PendingChange = {
    change: ReachRulesChangeV1; nowMs: number; ids: string[]; execute: ExecuteReachRules;
    resolve: (result: ReachRulesWriteResult) => void;
};
type State = {
    rules: ReachRulesV1; written: ReachRulesV1; revision: number | 'absent';
    previous: ReachRulesV1 | null; pending: PendingChange[]; running: boolean; active: boolean;
    publishOptimistic?: (rules: ReachRulesV1 | null) => void;
};

function project(state: State): ReachRulesV1 {
    return state.pending.reduce<ReachRulesV1>((rules, operation) => {
        let index = 0;
        return applyReachRulesChangeV1(rules, operation.change, { nowMs: operation.nowMs,
            newId: () => {
                const position = index++;
                return operation.ids[position] ?? (operation.ids[position] = randomUUID());
            } });
    }, state.written);
}

/** One optimistic/Undo owner, retained by the operation whose lifetime it serves. */
export function createReachRulesController(source: ReachRulesSource, execute: ExecuteReachRules,
    publishOptimistic?: (rules: ReachRulesV1 | null) => void, previous: ReachRulesV1 | null = null) {
    let latest = source;
    let latestExecute = execute;
    const state: State = { rules: source.rules,
        written: source.rules, revision: source.revision, previous, pending: [], running: false, active: true, publishOptimistic };
    let snapshot = { rules: state.rules, revision: state.revision };
    const listeners = new Set<() => void>();
    const publish = (current: State, operation = false) => {
        const next = project(current);
        if (operation) current.publishOptimistic?.(current.pending.length ? next : null);
        const sameRules = JSON.stringify(next) === JSON.stringify(current.rules);
        if (sameRules && snapshot.revision === current.revision) return;
        if (!sameRules) current.rules = next;
        snapshot = { rules: current.rules, revision: current.revision };
        for (const listener of listeners) listener();
    };

    const drain = async (current: State) => {
        if (current.running) return;
        current.running = true;
        while (current.pending.length > 0) {
            const operation = current.pending[0]!;
            let result: ReachRulesWriteResult;
            if (!current.active) result = { ok: false, message: 'scope-retired' };
            else if (latest.status === 'unavailable') result = { ok: false, message: 'catalog_unavailable' };
            else {
                try {
                    const receipt = source.kind === 'skill'
                        ? await operation.execute('skills.rules.set', { items: [{ skillId: source.itemId }], change: operation.change })
                        : await operation.execute('mcp.rules.set', { items: [{ serverId: source.itemId }], change: operation.change });
                    const acknowledgment = readReachRulesAcknowledgment(source.kind, source.itemId, receipt);
                    if (!acknowledgment.ok) result = acknowledgment;
                    else {
                        if (current.revision === 'absent' || acknowledgment.revision >= current.revision) {
                            current.written = acknowledgment.item.rules;
                            current.revision = acknowledgment.revision;
                        }
                        current.previous = acknowledgment.item.previous;
                        result = { ok: true };
                    }
                } catch (error) {
                    const refusal = projectMcpServerActionFailureV1(error);
                    result = { ok: false, message: refusal.errorCode ?? refusal.error };
                }
            }
            current.pending.shift();
            publish(current, true);
            operation.resolve(result);
        }
        current.running = false;
    };

    const change = (input: ReachRulesChangeV1): Promise<ReachRulesWriteResult> => {
        if (!state.active) return Promise.resolve({ ok: false, message: 'scope-retired' });
        if (latest.status !== 'ready') return Promise.resolve({ ok: false, message: 'catalog_unavailable' });
        const parsed = ReachRulesChangeV1Schema.safeParse(input);
        if (!parsed.success) return Promise.resolve({ ok: false, message: 'invalid_action_input' });
        return new Promise(resolve => {
            const operation: PendingChange = { change: parsed.data, nowMs: Date.now(), ids: [], execute: latestExecute, resolve };
            state.pending.push(operation);
            try { publish(state, true); }
            catch (error) {
                state.pending.pop();
                resolve({ ok: false, message: error instanceof Error ? error.message : 'invalid_action_input' });
                return;
            }
            void drain(state);
        });
    };
    const undoLast = () => state.previous ? change({ kind: 'replace', rules: reachRulesToDraftsV1(state.previous) })
        : Promise.resolve<ReachRulesWriteResult>({ ok: false, message: 'nothing_to_undo' });
    return { change, undoLast, getSnapshot: () => snapshot, getUndoRules: () => state.previous,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        activate() { state.active = true; },
        retire() { state.active = false; if (state.pending.length) state.publishOptimistic?.(null); },
        updateSource(next: ReachRulesSource, nextExecute = latestExecute) {
            latest = next;
            latestExecute = nextExecute;
            if (!next.valueAvailable) return;
            if (state.revision !== 'absent' && (next.revision === 'absent' || next.revision < state.revision)) return;
            state.written = next.rules;
            state.revision = next.revision;
            publish(state);
        },
    };
}

/** Mounted editors retire their controller; an approval request retains the same owner outside a view. */
export function useReachRulesState(source: ReachRulesSource, execute: ExecuteReachRules,
    publishOptimistic?: (rules: ReachRulesV1 | null) => void) {
    const controller = React.useMemo(() => createReachRulesController(source, execute, publishOptimistic), [source.key]);
    React.useLayoutEffect(() => { controller.updateSource(source, execute); });
    React.useEffect(() => {
        controller.activate();
        return () => controller.retire();
    }, [controller]);
    const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    return { rules: source.valueAvailable ? snapshot.rules : source.rules, revision: snapshot.revision,
        status: source.status, valueAvailable: source.valueAvailable, change: controller.change, undoLast: controller.undoLast };
}
