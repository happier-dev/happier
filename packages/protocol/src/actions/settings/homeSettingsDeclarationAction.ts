import { HomeSettingsGetInputV1Schema, HomeSettingsProjectionV1Schema, HomeSettingsSetInputV1Schema,
    type HomeSettingEntryV1, type HomeSettingsProjectionV1 } from '../../home/governance/index.js';
import { SERVER_CONFIG_REGISTRY_BASE } from '../../serverConfig/registry.js';
import { validateServerConfigValue } from '../../serverConfig/serverConfigCodec.js';
import { SettingsDeclarationValueV1Schema } from '../settingsDeclarationActionFamily.js';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteFailure, type ActionApprovalRequestCreatedResult } from '../actionExecutionResult.js';
import type { ActionExecutorContext } from '../executor/types.js';
import type { SettingDomainValueV1 as SettingValue, SettingsOwnerActionExecuteV1 as SettingsOwnerActionExecute } from './settingsOwnerActions.js';

function refuse(errorCode: string): ActionExecuteFailure { return { ok: false, errorCode, error: errorCode }; }
export type HomeSettingsDeclarationRead = Readonly<{ ok: true; projection: HomeSettingsProjectionV1 }>
    | Readonly<{ ok: false; result: ActionExecuteFailure | ActionApprovalRequestCreatedResult }>;

export async function readHomeSettingsDeclarationOwner(execute: SettingsOwnerActionExecute,
    context: ActionExecutorContext, isCurrent: () => boolean): Promise<HomeSettingsDeclarationRead> {
    if (!isCurrent()) return { ok: false, result: refuse('setting_not_bound') };
    const result = await execute({ actionId: 'home.settings.get', input: HomeSettingsGetInputV1Schema.parse({}), context });
    if (!isCurrent()) return { ok: false, result: refuse('setting_not_bound') };
    if (!result.ok) return { ok: false, result };
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success) return { ok: false, result: approval.data };
    const parsed = HomeSettingsProjectionV1Schema.safeParse(result.result);
    return parsed.success ? { ok: true, projection: parsed.data }
        : { ok: false, result: refuse('setting_value_unavailable') };
}

/** Only registry keys and controls the incumbent generic field can render are admitted. */
export function homeSettingDeclarationUnavailable(key: string, entry: HomeSettingEntryV1 | undefined) {
    const registry = SERVER_CONFIG_REGISTRY_BASE[key];
    if (!registry || !entry || !entry.declaration || registry.editable === 'internal') return 'not_bound' as const;
    if (registry.sensitivity === 'secret' || entry.secretSet !== undefined) return 'sensitive' as const;
    if (entry.declaration.type === 'json' || (entry.declaration.type === 'enum' && !entry.declaration.bounds?.values?.length)) return 'not_bound' as const;
    if (entry.fixed || entry.editable === 'bootstrap') return 'read_only' as const;
    return undefined;
}

export async function executeHomeSettingDeclaration(params: Readonly<{
    actionId: 'settings.get' | 'settings.set'; anchor: string; key: string; value?: SettingValue;
    read: HomeSettingsDeclarationRead; execute: SettingsOwnerActionExecute; context: ActionExecutorContext; isCurrent(): boolean;
}>) {
    if (!params.isCurrent()) return refuse('setting_not_bound');
    if (!params.read.ok) return params.read.result;
    const entry = params.read.projection.entries.find(candidate => candidate.key === params.key);
    const unavailable = homeSettingDeclarationUnavailable(params.key, entry);
    if (unavailable && (params.actionId === 'settings.set' || unavailable !== 'read_only')) return refuse(`setting_${unavailable}`);
    if (!entry) return refuse('setting_not_bound');
    if (params.actionId === 'settings.get') {
        const value = SettingsDeclarationValueV1Schema.safeParse(entry.value);
        return value.success ? { anchor: params.anchor, value: value.data } : refuse('setting_value_unavailable');
    }
    const registry = SERVER_CONFIG_REGISTRY_BASE[params.key];
    if (!registry) return refuse('setting_not_bound');
    const parsed = params.value === null ? { ok: true as const, value: null } : validateServerConfigValue(registry, params.value);
    if (!parsed.ok) return refuse('invalid_setting_value');
    const input = HomeSettingsSetInputV1Schema.parse({ expectedRevision: params.read.projection.revision, values: { [params.key]: parsed.value } });
    const result = await params.execute({ actionId: 'home.settings.set', input, context: params.context });
    if (!params.isCurrent()) return refuse('setting_not_bound');
    if (!result.ok) return result;
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success) return approval.data;
    const updated = HomeSettingsProjectionV1Schema.safeParse(result.result);
    const updatedEntry = updated.success ? updated.data.entries.find(candidate => candidate.key === params.key) : undefined;
    if (!updatedEntry || homeSettingDeclarationUnavailable(params.key, updatedEntry) === 'sensitive') return refuse('setting_value_unavailable');
    const value = SettingsDeclarationValueV1Schema.safeParse(updatedEntry.value);
    return value.success ? { anchor: params.anchor, value: value.data } : refuse('setting_value_unavailable');
}
