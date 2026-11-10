import { z } from '../../zodRuntimePolicy.js';
import { ACCOUNT_SETTING_DEFINITIONS, type AccountSettings } from '../../account/settings/accountSettings.js';
import { MachineOfflineAlertsV1Schema } from '../../account/settings/machineOfflineAlertsV1.js';

export const MachineOfflineAlertSettingKeySchema = z.string().check(z.trim(), z.minLength(1));
export const MachineOfflineAlertSettingChangeSchema = z.boolean();

export function readMachineOfflineAlertSetting(settings: Pick<AccountSettings, 'machineOfflineAlertsV1'>, machineId: string): boolean {
  const key = MachineOfflineAlertSettingKeySchema.safeParse(machineId);
  return key.success && settings.machineOfflineAlertsV1.machineIds.includes(key.data);
}

/** Rebased by the Account mutation owner: only the named machine membership changes. */
export function buildMachineOfflineAlertSettingMutation(settings: Pick<AccountSettings, 'machineOfflineAlertsV1'>, machineId: string, value: unknown) {
  const key = MachineOfflineAlertSettingKeySchema.safeParse(machineId);
  const change = MachineOfflineAlertSettingChangeSchema.safeParse(value);
  if (!key.success || !change.success) return null;
  const current = settings.machineOfflineAlertsV1.machineIds;
  const machineIds = change.data
    ? current.includes(key.data) ? current : [...current, key.data]
    : current.filter((id) => id !== key.data);
  const parsed = ACCOUNT_SETTING_DEFINITIONS.machineOfflineAlertsV1.parseMutationValue({ machineIds });
  return parsed.success ? { machineOfflineAlertsV1: MachineOfflineAlertsV1Schema.parse(parsed.data) } : null;
}
