import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionAddressV1';
import { ActionApprovalRequestCreatedResultSchema, readUnexpectedActionErrorDiagnosticV1, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionSessionFanoutResultV1Schema } from '@happier-dev/protocol/actions/sessionTargetV1';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { filterExistingSessionStageTargets, type ExistingSessionChangePlan, type ExistingSessionStageTargetResult } from '@happier-dev/protocol/sessions/authoring/existingSessionPlanner';
import type { createDefaultActionExecutor, UiActionExecutorContext } from '@/sync/ops/actions/defaultActionExecutor';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';

export type BulkSessionChangeRow = Readonly<{
    target: ActionSessionAddressV1;
    actionId: ActionId;
    state: 'applying' | 'sent' | 'applied' | 'switched' | 'failed' | 'waking' | 'approval_pending' | 'skipped';
    code?: string;
    reason?: string;
    result?: ActionExecuteResult;
    /** An earlier stage switched this target's Agent (qualified Agent ids): the row keeps saying so after its message. */
    switchedFrom?: string;
    switchedTo?: string;
}>;
export const bulkChangeTargetKey = sessionAddressKey;

export function projectBulkSessionInitialRows(
    plan: ExistingSessionChangePlan,
    targets: readonly ActionSessionAddressV1[],
): BulkSessionChangeRow[] {
    const firstActions = new Map<string, ActionId>();
    for (const stage of plan.stages) {
        for (const target of stage.targets) {
            const key = bulkChangeTargetKey(target);
            if (!firstActions.has(key)) firstActions.set(key, stage.actionId);
        }
    }
    return targets.map(target => {
        const actionId = firstActions.get(bulkChangeTargetKey(target));
        return actionId ? { target, actionId, state: 'applying' }
            : { target, actionId: 'session.message.send', state: 'skipped', code: 'no_change' };
    });
}

function projectRow(target: ActionSessionAddressV1, actionId: ActionId, result: ActionExecuteResult): BulkSessionChangeRow {
    if (!result.ok) return { target, actionId, result, state: result.errorCode === 'managed_wake_unconfirmed' ? 'waking' : 'failed',
        code: result.errorCode ?? 'action_failed', reason: result.error };
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success) return { target, actionId, result, state: 'approval_pending', code: 'approval_request_created' };
    const value = readRecord(result.result);
    if (actionId === 'session.connected_services_auth.set' && value.ok === true && value.action === 'unchanged') {
        return { target, actionId, result, state: 'skipped', code: 'no_change' };
    }
    if (actionId === 'session.agent.transition' && value.type !== 'accepted') return {
        target, actionId, result, state: 'failed', code: typeof value.code === 'string' ? value.code : String(value.type),
        ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    };
    if (actionId === 'session.message.send' && value.status !== 'accepted' && value.status !== 'alreadyAccepted' && value.status !== 'replied') {
        return { target, actionId, result, state: value.status === 'held' ? 'approval_pending' : 'failed',
            code: typeof value.code === 'string' ? value.code : String(value.status),
            ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) };
    }
    return { target, actionId, result, state: actionId === 'session.message.send' ? 'sent'
        : actionId === 'session.agent.transition' ? 'switched' : 'applied' };
}
export function isBulkSessionRetryable(row: BulkSessionChangeRow): boolean {
    return row.state === 'failed';
}
export function orderBulkSessionChangeRows(rows: readonly BulkSessionChangeRow[]): BulkSessionChangeRow[] {
    const rank: Record<BulkSessionChangeRow['state'], number> = { failed: 0, waking: 1, approval_pending: 1, applying: 2, sent: 3, applied: 3, switched: 3, skipped: 4 };
    return [...rows].sort((a, b) => rank[a.state] - rank[b.state]);
}

/** One confirmed fanout per grouped planner stage. The executor alone enumerates effects. */
export async function executeBulkSessionChanges(input: Readonly<{
    plan: ExistingSessionChangePlan;
    executeConfirmed: ReturnType<typeof createDefaultActionExecutor>['executeConfirmed'];
    context?: UiActionExecutorContext;
    onResult?: (row: BulkSessionChangeRow) => void;
}>): Promise<readonly BulkSessionChangeRow[]> {
    const previous: ExistingSessionStageTargetResult[] = [];
    const rows = new Map<string, BulkSessionChangeRow>();
    const switches = new Map<string, Readonly<{ switchedFrom?: string; switchedTo?: string }>>();
    for (const skipped of input.plan.skippedTargets) {
        const row: BulkSessionChangeRow = {
            target: skipped.address, actionId: 'session.message.send', state: 'skipped', code: skipped.reason, reason: skipped.reason,
        };
        rows.set(bulkChangeTargetKey(skipped.address), row);
        input.onResult?.(row);
    }
    for (const planned of input.plan.stages) {
        const stage = filterExistingSessionStageTargets(planned, previous);
        if (!stage.targets.length) continue;
        const completed = new Set<string>();
        const accept = (target: ActionSessionAddressV1, result: ActionExecuteResult) => {
            const key = bulkChangeTargetKey(target);
            if (completed.has(key)) return;
            completed.add(key);
            const projected = projectRow(target, stage.actionId, result);
            if (projected.state === 'switched') {
                const selection = readRecord(stage.input.selection);
                switches.set(key, {
                    ...(typeof stage.input.expectedCurrentAgentId === 'string' ? { switchedFrom: stage.input.expectedCurrentAgentId } : {}),
                    ...(typeof selection.agentId === 'string' ? { switchedTo: selection.agentId } : {}),
                });
            }
            const row: BulkSessionChangeRow = { ...projected, ...switches.get(key) };
            rows.set(key, row);
            previous.push({ ...target, actionId: stage.actionId,
                ok: row.state === 'sent' || row.state === 'applied' || row.state === 'switched'
                    || (row.state === 'skipped' && row.code === 'no_change'),
                ...(result.ok ? { result: result.result } : {}) });
            input.onResult?.(row);
        };
        let result: ActionExecuteResult;
        try {
            result = await input.executeConfirmed(stage.actionId, { ...stage.input,
                sessionId: { selector: 'sessions', addresses: stage.targets } }, { ...input.context,
                onSessionTargetResult: event => {
                    input.context?.onSessionTargetResult?.(event);
                    accept(event.target, event.result);
                } });
        } catch (error) {
            const diagnostic = readUnexpectedActionErrorDiagnosticV1(error);
            result = { ok: false, errorCode: diagnostic.errorCode ?? 'action_failed', error: diagnostic.errorClass };
        }
        const fanout = result.ok ? ActionSessionFanoutResultV1Schema.safeParse(result.result) : null;
        if (fanout?.success) for (const leaf of fanout.data.results) accept(leaf.target, leaf.result);
        else for (const target of stage.targets) accept(target, result);
    }
    return orderBulkSessionChangeRows([...rows.values()]);
}

/** Counts distinct recipients, not grouped Action calls; BC-D localizes these facts. */
export function summarizeBulkSessionChanges(plan: ExistingSessionChangePlan) {
    const count = (actionId: ActionId) => new Set(plan.stages.filter(stage => stage.actionId === actionId)
        .flatMap(stage => stage.targets.map(bulkChangeTargetKey))).size;
    return { restarts: count('session.connected_services_auth.set'), engineSwitches: count('session.agent.transition'),
        messages: count('session.message.send'), skipped: plan.skippedTargets.length,
        hasSettingsChanges: plan.stages.some(stage => stage.actionId !== 'session.message.send'),
        unsupportedFields: plan.unsupportedFields };
}
