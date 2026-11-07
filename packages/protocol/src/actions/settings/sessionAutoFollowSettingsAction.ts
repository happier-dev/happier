import { SessionFollowActionInputSchemasV1, SessionFollowActionOutputSchemasV1 } from '../../sessions/follow/actions.js';
import { DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1, type SessionAutoFollowPreferencesV1 } from '../../sessions/follow/accountFollow.js';
import { ActionApprovalRequestCreatedResultSchema } from '../actionExecutionResult.js';
import type { ActionExecutorContext } from '../executor/types.js';
import type { SettingDomainValueV1 as SettingValue, SettingsOwnerActionExecuteV1 as SettingsOwnerActionExecute } from './settingsOwnerActions.js';

function refuse(errorCode: string) { return { ok: false as const, errorCode, error: errorCode }; }

/** Auto-follow fields belong to the captured Home's Follow API, not encrypted Account preferences. */
export async function executeSessionAutoFollowSetting(input: Readonly<{
    actionId: 'settings.get' | 'settings.set'; anchor: string; field: keyof SessionAutoFollowPreferencesV1;
    value?: SettingValue; execute: SettingsOwnerActionExecute; context: ActionExecutorContext; isCurrent(): boolean;
}>) {
    if (!input.isCurrent()) return refuse('setting_not_bound');
    const read = await input.execute({ actionId: 'follow.preferences.get', input: {}, context: input.context });
    if (!input.isCurrent()) return refuse('setting_not_bound');
    if (!read.ok) return read;
    const readApproval = ActionApprovalRequestCreatedResultSchema.safeParse(read.result);
    if (readApproval.success) return readApproval.data;
    const current = SessionFollowActionOutputSchemasV1['follow.preferences.get'].safeParse(read.result);
    if (!current.success) return refuse('setting_value_unavailable');
    const value = (preferences: SessionAutoFollowPreferencesV1) => {
        const field = input.field;
        if (field === 'managerPolicy' || field === 'runReportPolicy' || field === 'discussionReceivePolicy') {
            return preferences[field] ?? DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1[field];
        }
        return preferences[field];
    };
    if (input.actionId === 'settings.get') return { anchor: input.anchor, value: value(current.data) };
    const mutation = SessionFollowActionInputSchemasV1['follow.preferences.set'].safeParse({ ...current.data, [input.field]: input.value });
    if (!mutation.success || input.value === undefined) return refuse('invalid_setting_value');
    const result = await input.execute({ actionId: 'follow.preferences.set',
        input: mutation.data,
        context: input.context });
    if (!input.isCurrent()) return refuse('setting_not_bound');
    if (!result.ok) return result;
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success) return approval.data;
    const updated = SessionFollowActionOutputSchemasV1['follow.preferences.set'].safeParse(result.result);
    return updated.success ? { anchor: input.anchor, value: value(updated.data) } : refuse('setting_value_unavailable');
}

