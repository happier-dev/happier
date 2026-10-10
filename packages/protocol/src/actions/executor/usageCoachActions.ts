import type { ActionId } from '../actionIds.js';
import type { ActionExecuteResult, ActionExecuteFailure } from '../actionExecutionResult.js';
import { ActionApprovalRequestCreatedResultSchema } from '../actionExecutionResult.js';
import { SettingsDeclarationActionOutputSchemasV1 } from '../settingsDeclarationActionFamily.js';
import { UsageCoachApplyInputSchema, UsageCoachUndoInputSchema, UsageCoachDismissInputSchema,
    UsageCoachSnoozeInputSchema, type UsageCoachReversal } from '../../usage/coach/coachActions.js';
import { UsageCoachEvaluationSchema } from '../../usage/coach/coachFinding.js';
import type { UsageCoachRemedy } from '../../usage/coach/coachRemedy.js';
import type { UsageCoachActionId } from '../specs/usageCoach.js';
import { UsageCoachPreferencesV1Schema } from '../../account/settings/usageCoachPreferencesV1.js';
import { UsageQueryBatchResultSchema } from '../../usage/resolveUsagePageAggregation.js';
import { getUsageQueryKey } from '../../inputs/usageQuery.js';
import { SessionModelMutationReversalV1Schema } from '../../sessions/control/modelTransitionV1.js';
import { McpServerBindingEnabledReversalV1Schema } from '../../mcp/servers/catalogSchemasV1.js';
import { SessionSpawnNewResultV1Schema } from '../../sessions/creation/sessionSpawnNewResultV1.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';

export const USAGE_COACH_PREFERENCES_ANCHOR = 'usage.coachPreferences';
type Child = (actionId: ActionId, input: unknown) => Promise<ActionExecuteResult>;
const failure = (errorCode: string, details?: unknown): ActionExecuteFailure =>
    ({ ok: false, errorCode, error: errorCode, ...(details === undefined ? {} : { details }) });
const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
const paused = (result: ActionExecuteResult) => !result.ok || ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success;

/** Re-query admission and delegate effects; only mutation owners capture or restore state. */
export async function executeUsageCoachAction(actionId: UsageCoachActionId, value: unknown, child: Child): Promise<ActionExecuteResult> {
    const parsedRequest = actionId === 'usage.coach.undo' ? { actionId, request: UsageCoachUndoInputSchema.parse(value) } as const
        : actionId === 'usage.coach.dismiss' ? { actionId, request: UsageCoachDismissInputSchema.parse(value) } as const
        : actionId === 'usage.coach.snooze' ? { actionId, request: UsageCoachSnoozeInputSchema.parse(value) } as const
        : { actionId, request: UsageCoachApplyInputSchema.parse(value) } as const;
    const request = parsedRequest.request;
    const queried = await child('usage.query', { queries: [request.query] });
    if (paused(queried)) return queried;
    const batch = UsageQueryBatchResultSchema.safeParse(queried.ok ? queried.result : undefined);
    if (!batch.success || batch.data.results.length !== 1 || batch.data.results[0]?.key !== getUsageQueryKey(request.query))
        return failure('usage_query_result_invalid');
    // A successful remedy can remove its finding. Undo is admitted by this
    // authorized query and the original owner's atomic receipt, not fresh advice.
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
                    expectedSettingsVersion: reversal.owner.appliedVersion,
                    reversal: { kind: 'restore', ...reversal.owner } });
                break;
            case 'model':
                restored = await child('session.model.set', { sessionId: reversal.sessionId, modelId: reversal.owner.before.modelId,
                    providerConnectionId: reversal.owner.before.providerConnectionId,
                    expected: { owner: reversal.owner.owner, ...(reversal.owner.owner === 'active' ? { runId: reversal.owner.runId } : {}),
                        selection: reversal.owner.applied, updatedAt: reversal.owner.updatedAt, scope: reversal.owner.scope } });
                break;
            case 'mcp_binding':
                restored = await child(reversal.owner.before ? 'mcp.bindings.enable' : 'mcp.bindings.disable',
                    { bindingId: reversal.owner.bindingId, expectedRevision: reversal.owner.revision,
                        expectedEnabled: reversal.owner.applied, expectedScope: reversal.owner.scope });
                break;
        }
        if (paused(restored)) return restored;
        const semantic = semanticFailure(restored, reversal.kind);
        if (semantic) return semantic;
        return { ok: true, result: { kind: 'undone', evidenceKey: request.evidenceKey } };
    }
    const slice = record(batch.data.results[0]);
    const coach = UsageCoachEvaluationSchema.safeParse(slice?.coach);
    if (!coach.success || coach.data.currentness !== 'current') return failure('coach_evidence_not_current');
    const matches = coach.data.findings.filter(finding => finding.evidenceKey === request.evidenceKey);
    const finding = matches.length === 1 ? matches[0] : undefined;
    if (!finding || finding.currentness !== 'current' || finding.queryKey !== getUsageQueryKey(request.query))
        return failure('coach_evidence_not_current');

    if (parsedRequest.actionId === 'usage.coach.dismiss' || parsedRequest.actionId === 'usage.coach.snooze') {
        const preferenceRequest = parsedRequest.request;
        const read = await child('settings.get', { anchor: USAGE_COACH_PREFERENCES_ANCHOR, includeVersion: true });
        if (paused(read)) return read;
        const current = SettingsDeclarationActionOutputSchemasV1['settings.get'].safeParse(read.ok ? read.result : undefined);
        if (!current.success || current.data.settingsVersion === undefined || !('value' in current.data)) return failure('coach_preferences_unavailable');
        const preferences = UsageCoachPreferencesV1Schema.safeParse(current.data.value);
        if (!preferences.success) return failure('coach_preferences_unavailable');
        const suppressions = preferences.data.suppressions.filter(row => row.evidenceKey !== request.evidenceKey);
        if ('dismissed' in preferenceRequest && preferenceRequest.dismissed) suppressions.push({ kind: 'dismissed', evidenceKey: request.evidenceKey });
        if ('untilMs' in preferenceRequest && preferenceRequest.untilMs !== null) suppressions.push({ kind: 'snoozed', evidenceKey: request.evidenceKey, untilMs: preferenceRequest.untilMs });
        const written = await child('settings.set', { anchor: USAGE_COACH_PREFERENCES_ANCHOR,
            value: { ...preferences.data, suppressions }, expectedSettingsVersion: current.data.settingsVersion });
        if (paused(written)) return written;
        const refused = semanticFailure(written, 'setting');
        if (refused) return refused;
        return { ok: true, result: { kind: 'preference_updated', evidenceKey: request.evidenceKey,
            ...('dismissed' in preferenceRequest ? { dismissed: preferenceRequest.dismissed } : {}), ...('untilMs' in preferenceRequest ? { untilMs: preferenceRequest.untilMs } : {}) } };
    }
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
        case 'mcp_binding': applied = await child(remedy.enabled ? 'mcp.bindings.enable' : 'mcp.bindings.disable',
            { bindingId: remedy.bindingId, expectedRevision: remedy.expectedRevision, captureBefore: true }); break;
        case 'prepared_session': applied = await child('session.spawn_new', remedy.input); break;
        case 'recovery': applied = await child(remedy.actionId, { sessionId: remedy.sessionId }); break;
    }
    if (paused(applied)) return applied;
    const semantic = semanticFailure(applied, remedy.kind);
    if (semantic) return semantic;
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
        const owner = SessionModelMutationReversalV1Schema.safeParse(result?.reversal);
        if (!owner.success) return failure('coach_owner_result_invalid');
        reversal = { kind: 'model', sessionId: remedy.sessionId, owner: owner.data };
    } else if (remedy.kind === 'mcp_binding') {
        const owner = McpServerBindingEnabledReversalV1Schema.safeParse(result?.reversal);
        if (!owner.success) return failure('coach_owner_result_invalid');
        reversal = { kind: 'mcp_binding', owner: owner.data };
    }
    if (reversal && !matchesRemedy(remedy, reversal)) return failure('coach_owner_result_invalid');
    return { ok: true, result: { kind: 'applied', evidenceKey: request.evidenceKey, remedy,
        ...(reversal ? { reversal } : { reversalUnavailableReason: noChange ? 'no_change' : 'not_reversible' }),
        ...(remedy.kind === 'prepared_session' && typeof result?.sessionId === 'string' ? { spawnedSessionId: result.sessionId } : {}) } };
}

function matchesRemedy(remedy: UsageCoachRemedy, reversal: UsageCoachReversal): boolean {
    if (remedy.kind === 'setting' && reversal.kind === 'setting') return remedy.anchor === reversal.anchor
        && sameStrictJsonValue(remedy.value, reversal.appliedValue);
    if (remedy.kind === 'model' && reversal.kind === 'model') return remedy.sessionId === reversal.sessionId
        && remedy.modelId === reversal.owner.applied.modelId && (remedy.providerConnectionId === undefined
            || remedy.providerConnectionId === reversal.owner.applied.providerConnectionId)
        && (!remedy.expected || remedy.expected.owner === reversal.owner.owner
            && sameStrictJsonValue(remedy.expected.scope, reversal.owner.scope)
            && sameStrictJsonValue(remedy.expected.selection, reversal.owner.before)
            && (remedy.expected.owner !== 'active' || reversal.owner.owner === 'active' && remedy.expected.runId === reversal.owner.runId));
    return remedy.kind === 'mcp_binding' && reversal.kind === 'mcp_binding' && remedy.bindingId === reversal.owner.bindingId
        && remedy.enabled === reversal.owner.applied;
}

function semanticFailure(result: ActionExecuteResult, kind: UsageCoachRemedy['kind']): ActionExecuteFailure | null {
    if (!result.ok) return result;
    const value = record(result.result);
    if (value?.ok === false) return failure(typeof value.errorCode === 'string' ? value.errorCode : 'coach_owner_refused', result.result);
    if (kind === 'mcp_binding' && value?.status !== 'updated') return failure('coach_owner_refused', result.result);
    if (kind === 'model' && !['applied', 'already_active', 'intent_updated'].includes(String(value?.status))) return failure('coach_owner_refused', result.result);
    if (kind === 'prepared_session') {
        const spawned = SessionSpawnNewResultV1Schema.safeParse(result.result);
        if (!spawned.success || spawned.data.type !== 'success') return failure('coach_session_not_created', result.result);
        if (!['accepted', 'alreadyAccepted'].includes(spawned.data.initialInput.status)) return failure('coach_prompt_not_admitted', result.result);
    }
    return null;
}
