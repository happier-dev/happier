import { TeamAuthenticationPolicyV1Schema } from '../../auth/teamAuthenticationPolicy.js';
import { TeamIdentityConnectionListResultV1Schema, TeamIdentityConnectionMutationResultV1Schema,
    TeamIdentityConnectionSettingsUpdateInputV1Schema, TeamIdentityConnectionSettingsV1Schema,
    TeamPolicySetInputV1Schema, TeamSummaryV1Schema, type TeamSummaryV1, type TeamPolicySetInputV1,
    type TeamIdentityConnectionSettingsV1 } from '../../teams/index.js';
import { ActionApprovalRequestCreatedResultSchema } from '../actionExecutionResult.js';
import { SettingsDeclarationValueV1Schema, type SettingsDeclarationTargetV1 } from '../settingsDeclarationActionFamily.js';
import type { ActionExecutorContext } from '../executor/types.js';
import type { TeamSettingBindingV1 as TeamBinding, SettingDomainValueV1 as SettingValue, SettingsOwnerActionExecuteV1 as SettingsOwnerActionExecute } from './settingsOwnerActions.js';

const refuse = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });

function teamValue(binding: Exclude<TeamBinding, { kind: 'teamIdentityConnection' }>, team: TeamSummaryV1) {
    if (binding.kind === 'teamAdmissionMode') return team.policy.admissionMode === binding.mode;
    if (team.policy.authenticationPolicyStatus === 'repair_required') return undefined;
    const policy = team.policy.authenticationPolicy;
    if (binding.field === 'inherit') return policy === null;
    if (binding.field === 'restricted') return policy !== null;
    return policy?.accepted ?? [];
}

function connectionValue(field: Extract<TeamBinding, { kind: 'teamIdentityConnection' }>['field'], settings: TeamIdentityConnectionSettingsV1) {
    if (field === 'organizationLogin') return settings.kind === 'github_app_identity' ? settings.organizationLogin : undefined;
    return settings.kind === 'oidc' ? settings[field] : undefined;
}

/** Thin declaration adapter: domain Actions retain admission, current revisions, approvals and writes. */
export async function executeTeamSettingDeclaration(params: Readonly<{
    actionId: 'settings.get' | 'settings.set'; anchor: string; binding: TeamBinding;
    target: Exclude<SettingsDeclarationTargetV1, { kind: 'home' }>; value?: SettingValue;
    execute: SettingsOwnerActionExecute; context: ActionExecutorContext; isCurrent(): boolean;
}>) {
    if (!params.isCurrent()) return refuse('setting_not_bound');
    const { binding, target } = params;
    if (binding.kind === 'teamIdentityConnection') {
        if (target.kind !== 'team_identity_connection') return refuse('setting_target_mismatch');
        const read = await params.execute({ actionId: 'teams.identity.connections.list',
            input: { v: 1, teamId: target.teamId }, context: params.context });
        if (!params.isCurrent()) return refuse('setting_not_bound');
        if (!read.ok) return read;
        const pendingRead = ActionApprovalRequestCreatedResultSchema.safeParse(read.result);
        if (pendingRead.success) return pendingRead.data;
        const list = TeamIdentityConnectionListResultV1Schema.safeParse(read.result);
        if (!list.success) return refuse('setting_value_unavailable');
        const connection = list.data.items.find(item => item.id === target.connectionId && item.teamId === target.teamId);
        if (!connection) return refuse('setting_target_unavailable');
        const current = connectionValue(binding.field, connection.settings);
        if (current === undefined) return refuse('setting_target_mismatch');
        if (params.actionId === 'settings.get') return { anchor: params.anchor, value: current };
        const settings = TeamIdentityConnectionSettingsV1Schema.safeParse({ ...connection.settings, [binding.field]: params.value });
        if (!settings.success) return refuse('invalid_setting_value');
        const input = TeamIdentityConnectionSettingsUpdateInputV1Schema.parse({ v: 1, teamId: target.teamId,
            connectionId: target.connectionId, expectedRevision: connection.revision, settings: settings.data });
        const result = await params.execute({ actionId: 'teams.identity.connections.settings.update', input, context: params.context });
        if (!params.isCurrent()) return refuse('setting_not_bound');
        if (!result.ok) return result;
        const pending = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        if (pending.success) return pending.data;
        const updated = TeamIdentityConnectionMutationResultV1Schema.safeParse(result.result);
        if (!updated.success || updated.data.connection.id !== target.connectionId || updated.data.connection.teamId !== target.teamId) return refuse('setting_value_unavailable');
        const value = connectionValue(binding.field, updated.data.connection.settings);
        return value === undefined ? refuse('setting_value_unavailable') : { anchor: params.anchor, value };
    }
    if (target.kind !== 'team') return refuse('setting_target_mismatch');
    const read = await params.execute({ actionId: 'teams.get', input: { v: 1, teamId: target.teamId }, context: params.context });
    if (!params.isCurrent()) return refuse('setting_not_bound');
    if (!read.ok) return read;
    const pendingRead = ActionApprovalRequestCreatedResultSchema.safeParse(read.result);
    if (pendingRead.success) return pendingRead.data;
    const parsed = TeamSummaryV1Schema.safeParse(read.result);
    if (!parsed.success || parsed.data.id !== target.teamId) return refuse('setting_value_unavailable');
    const team = parsed.data;
    const current = teamValue(binding, team);
    if (params.actionId === 'settings.get') return current === undefined ? refuse('setting_value_unavailable') : { anchor: params.anchor, value: current };
    let patch: Partial<Pick<TeamPolicySetInputV1, 'admissionMode' | 'authenticationPolicy' | 'previousAuthenticationPolicy'>>;
    if (binding.kind === 'teamAdmissionMode') {
        if (params.value !== true) return refuse('invalid_setting_value');
        patch = { admissionMode: binding.mode };
    } else {
        const policy = binding.field === 'inherit' && params.value === true
            ? TeamAuthenticationPolicyV1Schema.safeParse({ v: 1, mode: 'inherit' })
            : binding.field === 'accepted'
                ? TeamAuthenticationPolicyV1Schema.safeParse({ v: 1, mode: 'restricted', accepted: params.value })
                : null;
        if (!policy?.success) return refuse('invalid_setting_value');
        patch = { authenticationPolicy: policy.data,
            previousAuthenticationPolicy: team.policy.authenticationPolicyStatus === 'repair_required'
                ? { v: 1, status: 'repair_required' } : team.policy.authenticationPolicy };
    }
    const input = TeamPolicySetInputV1Schema.parse({ v: 1, teamId: target.teamId, ...patch });
    const result = await params.execute({ actionId: 'teams.policy.set', input, context: params.context });
    if (!params.isCurrent()) return refuse('setting_not_bound');
    if (!result.ok) return result;
    const pending = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (pending.success) return pending.data;
    const updated = TeamSummaryV1Schema.safeParse(result.result);
    const value = updated.success && updated.data.id === target.teamId ? teamValue(binding, updated.data) : undefined;
    const json = SettingsDeclarationValueV1Schema.safeParse(value);
    return json.success ? { anchor: params.anchor, value: json.data } : refuse('setting_value_unavailable');
}
