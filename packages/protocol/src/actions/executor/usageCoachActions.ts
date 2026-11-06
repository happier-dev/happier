import type { ActionId } from '../actionIds.js';
import type { ActionExecuteResult, ActionExecuteFailure } from '../actionExecutionResult.js';
import { ActionApprovalRequestCreatedResultSchema } from '../actionExecutionResult.js';
import { SettingsDeclarationActionOutputSchemasV1 } from '../settingsDeclarationActionFamily.js';
import { UsageCoachApplyInputSchema, UsageCoachUndoInputSchema, UsageCoachDismissInputSchema,
    UsageCoachSnoozeInputSchema, type UsageCoachReversal } from '../../usage/coach/coachActions.js';
import { UsageCoachEvaluationSchema } from '../../usage/coach/coachFinding.js';
import type { UsageCoachActionId } from '../specs/usageCoach.js';
import type { UsageCoachSuppressionPort } from '../../usage/coach/coachActions.js';
import { UsageQueryBatchResultSchema } from '../../usage/resolveUsagePageAggregation.js';
import { getUsageQueryKey } from '../../inputs/usageQuery.js';
import { SessionModelSetResultV1Schema } from '../../sessions/control/modelTransitionV1.js';
import { McpRulesSetOutputV1Schema } from '../specs/capabilityRules.js';
import { reachRulesToDraftsV1 } from '../../reach/reachRulesChangeV1.js';
import { SessionSpawnNewActionResultV1Schema } from '../../sessions/creation/sessionSpawnNewResultV1.js';
import { projectSessionSpawnNewActionInputV2 } from '../../sessions/creation/sessionSpawnNewInputV2.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';

export const USAGE_COACH_PREFERENCES_ANCHOR = 'usage.coachPreferences';
type Child = (actionId: ActionId, input: unknown) => Promise<ActionExecuteResult>;
const failure = (errorCode: string, details?: unknown): ActionExecuteFailure =>
    ({ ok: false, errorCode, error: errorCode, ...(details === undefined ? {} : { details }) });
const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
const paused = (result: ActionExecuteResult) => !result.ok || ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success;

/** Query Apply evidence and delegate effects; only mutation owners capture or restore state. */
export async function executeUsageCoachAction(actionId: UsageCoachActionId, value: unknown, child: Child,
    suppressionsOwner?: UsageCoachSuppressionPort): Promise<ActionExecuteResult> {
    const parsedRequest = actionId === 'usage.coach.undo' ? { actionId, request: UsageCoachUndoInputSchema.parse(value) } as const
        : actionId === 'usage.coach.dismiss' ? { actionId, request: UsageCoachDismissInputSchema.parse(value) } as const
        : actionId === 'usage.coach.snooze' ? { actionId, request: UsageCoachSnoozeInputSchema.parse(value) } as const
        : { actionId, request: UsageCoachApplyInputSchema.parse(value) } as const;
    const request = parsedRequest.request;
    // A successful remedy can remove its finding. The original mutation
    // owner's atomic receipt admits Undo without requiring fresh advice.
    if (parsedRequest.actionId === 'usage.coach.undo') {
        const reversal = parsedRequest.request.reversal;
        if (reversal.kind === 'model' && request.query.session !== null
            && !(typeof request.query.session === 'string' ? [request.query.session] : request.query.session).includes(reversal.sessionId)) {
            return failure('coach_reversal_target_mismatch');
        }
        let restored: ActionExecuteResult;
        switch (reversal.kind) {
            case 'setting':
                restored = await child('settings.set', { anchor: reversal.anchor, value: reversal.appliedValue,
                    reversal: { kind: 'restore', ...reversal.owner } });
                break;
            case 'model':
                restored = await child('session.model.set', { sessionId: reversal.sessionId, modelId: reversal.owner.before.modelId,
                    providerConnectionId: reversal.owner.before.providerConnectionId,
                    expected: { owner: reversal.owner.owner, ...(reversal.owner.owner === 'active' ? { runId: reversal.owner.runId } : {}),
                        selection: reversal.owner.applied, updatedAt: reversal.owner.updatedAt, scope: reversal.owner.scope } });
                break;
            case 'mcp_binding':
                restored = await child('mcp.rules.set', { items: [{ serverId: reversal.owner.serverId }],
                    expectedRevision: reversal.appliedRevision,
                    change: { kind: 'replace', rules: reachRulesToDraftsV1(reversal.owner.previous) } });
                break;
        }
        if (paused(restored)) return restored;
        const result = restored.ok ? restored.result : undefined;
        if (reversal.kind === 'setting') {
            if (!SettingsDeclarationActionOutputSchemasV1['settings.set'].safeParse(result).success) return failure('coach_owner_result_invalid');
        } else if (reversal.kind === 'model') {
            const model = SessionModelSetResultV1Schema.safeParse(result);
            if (!model.success) return failure('coach_owner_result_invalid');
            if (model.data.status === 'armed') return failure('coach_owner_refused', result);
        } else {
            const receipt = McpRulesSetOutputV1Schema.safeParse(result);
            if (!receipt.success) return failure('coach_owner_result_invalid');
            if (!receipt.data.ok) return failure('coach_owner_refused', receipt.data);
        }
        return { ok: true, result: { kind: 'undone', evidenceKey: request.evidenceKey } };
    }
    if (parsedRequest.actionId === 'usage.coach.dismiss' || parsedRequest.actionId === 'usage.coach.snooze') {
        const preferenceRequest = parsedRequest.request;
        if (!suppressionsOwner) return failure('coach_preferences_unavailable');
        await suppressionsOwner.edit({ evidenceKey: request.evidenceKey,
            ...('dismissed' in preferenceRequest ? { dismissed: preferenceRequest.dismissed } : { untilMs: preferenceRequest.untilMs }) });
        return { ok: true, result: { kind: 'preference_updated', evidenceKey: request.evidenceKey,
            ...('dismissed' in preferenceRequest ? { dismissed: preferenceRequest.dismissed } : {}), ...('untilMs' in preferenceRequest ? { untilMs: preferenceRequest.untilMs } : {}) } };
    }
    const queried = await child('usage.query', { queries: [request.query] });
    if (paused(queried)) return queried;
    const batch = UsageQueryBatchResultSchema.safeParse(queried.ok ? queried.result : undefined);
    if (!batch.success || batch.data.results.length !== 1 || batch.data.results[0]?.key !== getUsageQueryKey(request.query))
        return failure('usage_query_result_invalid');
    const slice = record(batch.data.results[0]);
    const coach = UsageCoachEvaluationSchema.safeParse(slice?.coach);
    if (!coach.success || coach.data.currentness !== 'current') return failure('coach_evidence_not_current');
    const matches = coach.data.findings.filter(finding => finding.evidenceKey === request.evidenceKey);
    const finding = matches.length === 1 ? matches[0] : undefined;
    if (!finding || finding.currentness !== 'current' || finding.queryKey !== getUsageQueryKey(request.query))
        return failure('coach_evidence_not_current');
    const remedy = finding.remedy;
    if (!remedy) return failure('coach_remedy_unavailable');
    if ((remedy.kind === 'model' || remedy.kind === 'recovery') && request.query.session !== null
        && !(typeof request.query.session === 'string' ? [request.query.session] : request.query.session).includes(remedy.sessionId)) {
        return failure('coach_remedy_target_mismatch');
    }
    let applied: ActionExecuteResult;
    switch (remedy.kind) {
        case 'setting': applied = await child('settings.set', { anchor: remedy.anchor, value: remedy.value, reversal: { kind: 'capture' } }); break;
        case 'model': applied = await child('session.model.set', { sessionId: remedy.sessionId, modelId: remedy.modelId,
            ...(remedy.providerConnectionId !== undefined ? { providerConnectionId: remedy.providerConnectionId } : {}),
            ...(remedy.expected ? { expected: remedy.expected } : {}), captureBefore: true }); break;
        case 'mcp_binding': applied = await child('mcp.rules.set', { items: [{ serverId: remedy.serverId }],
            expectedRevision: remedy.expectedRevision,
            change: { kind: 'write', write: { place: remedy.target, state: remedy.enabled ? 'on' : 'off',
                ...(remedy.agentId ? { agentId: remedy.agentId } : {}) } } }); break;
        case 'prepared_session': applied = await child('session.spawn_new', projectSessionSpawnNewActionInputV2(remedy.input)); break;
        case 'recovery': applied = await child(remedy.actionId, { sessionId: remedy.sessionId }); break;
    }
    if (paused(applied)) return applied;
    const result = record(applied.ok ? applied.result : undefined);
    let reversal: UsageCoachReversal | undefined;
    let noChange = false;
    if (remedy.kind === 'setting') {
        const setting = SettingsDeclarationActionOutputSchemasV1['settings.set'].safeParse(result);
        if (!setting.success || !('value' in setting.data)) return failure('coach_owner_result_invalid');
        if (!sameStrictJsonValue(setting.data.value, remedy.value)) return failure('coach_owner_result_invalid');
        if (setting.data.reversalUnavailableReason === 'no_change') {
            if (setting.data.reversal) return failure('coach_owner_result_invalid');
            noChange = true;
        } else {
            if (!setting.data.reversal) return failure('coach_owner_result_invalid');
            reversal = { kind: 'setting', anchor: remedy.anchor, appliedValue: setting.data.value, owner: setting.data.reversal };
        }
    } else if (remedy.kind === 'model') {
        const model = SessionModelSetResultV1Schema.safeParse(result);
        if (!model.success) return failure('coach_owner_result_invalid');
        if (model.data.status === 'armed') return failure('coach_owner_refused', result);
        if (!('reversal' in model.data) || !model.data.reversal) return failure('coach_owner_result_invalid');
        reversal = { kind: 'model', sessionId: remedy.sessionId, owner: model.data.reversal };
    } else if (remedy.kind === 'mcp_binding') {
        const receipt = McpRulesSetOutputV1Schema.safeParse(result);
        if (!receipt.success) return failure('coach_owner_result_invalid');
        if (!receipt.data.ok) return failure('coach_owner_refused', receipt.data);
        if (receipt.data.items.length !== 1) return failure('coach_owner_result_invalid');
        reversal = { kind: 'mcp_binding', owner: receipt.data.items[0]!, appliedRevision: receipt.data.revision };
    } else if (remedy.kind === 'prepared_session') {
        const spawned = SessionSpawnNewActionResultV1Schema.safeParse(result);
        if (!spawned.success || spawned.data.type !== 'success') return failure('coach_session_not_created', result);
        if (!['accepted', 'alreadyAccepted'].includes(spawned.data.initialInput.status)) return failure('coach_prompt_not_admitted', result);
    } else if (result?.ok === false) {
        return failure(typeof result.errorCode === 'string' ? result.errorCode : 'coach_owner_refused', result);
    }
    return { ok: true, result: { kind: 'applied', evidenceKey: request.evidenceKey, remedy,
        ...(reversal ? { reversal } : { reversalUnavailableReason: noChange ? 'no_change' : 'not_reversible' }),
        ...(remedy.kind === 'prepared_session' && typeof result?.sessionId === 'string' ? { spawnedSessionId: result.sessionId } : {}) } };
}
