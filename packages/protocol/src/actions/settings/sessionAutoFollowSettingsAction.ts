import { SessionFollowActionInputSchemasV1, SessionFollowActionOutputSchemasV1 } from '../../sessions/follow/actions.js';
import { ActionApprovalRequestCreatedResultSchema } from '../actionExecutionResult.js';
import type { ActionExecutorContext } from '../executor/types.js';
import type { SettingDomainValueV1 as SettingValue, SettingsOwnerActionExecuteV1 as SettingsOwnerActionExecute } from './settingsOwnerActions.js';

function refuse(errorCode: string) { return { ok: false as const, errorCode, error: errorCode }; }

/** Auto-follow fields belong to the captured Home's Follow API, not encrypted Account preferences. */
export async function executeSessionAutoFollowSetting(input: Readonly<{
    actionId: 'settings.get' | 'settings.set'; anchor: string; field: 'assigned' | 'direct' | 'team' | 'group';
    value?: SettingValue; execute: SettingsOwnerActionExecute; context: ActionExecutorContext; isCurrent(): boolean;
}>) {
    if (!input.isCurrent()) return refuse('setting_not_bound');
    if (input.actionId === 'settings.set' && typeof input.value !== 'boolean') return refuse('invalid_setting_value');
    const read = await input.execute({ actionId: 'session.follow.preferences.get', input: {}, context: input.context });
    if (!input.isCurrent()) return refuse('setting_not_bound');
    if (!read.ok) return read;
    const readApproval = ActionApprovalRequestCreatedResultSchema.safeParse(read.result);
    if (readApproval.success) return readApproval.data;
    const current = SessionFollowActionOutputSchemasV1['session.follow.preferences.get'].safeParse(read.result);
    if (!current.success) return refuse('setting_value_unavailable');
    if (input.actionId === 'settings.get') return { anchor: input.anchor, value: current.data[input.field] };
    const result = await input.execute({ actionId: 'session.follow.preferences.set',
        input: SessionFollowActionInputSchemasV1['session.follow.preferences.set'].parse({ ...current.data, [input.field]: input.value }),
        context: input.context });
    if (!input.isCurrent()) return refuse('setting_not_bound');
    if (!result.ok) return result;
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success) return approval.data;
    const updated = SessionFollowActionOutputSchemasV1['session.follow.preferences.set'].safeParse(result.result);
    return updated.success ? { anchor: input.anchor, value: updated.data[input.field] } : refuse('setting_value_unavailable');
}

