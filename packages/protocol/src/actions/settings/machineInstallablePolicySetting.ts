import { z } from '../../zodRuntimePolicy.js';
import { ACCOUNT_SETTING_DEFINITIONS, type AccountSettings } from '../../account/settings/accountSettings.js';
import { InstallableAutoUpdateModeSchema } from '../../installables/descriptor.js';
import { applyInstallablePolicyOverride } from '../../installables/policy.js';

export const MachineInstallablePolicyKeySchema = z.string().check(z.trim(), z.minLength(1));
export const MachineInstallablePolicyChangeSchema = z.strictObject({
  installableKey: z.string().check(z.trim(), z.minLength(1)),
  patch: z.strictObject({
    autoInstallWhenNeeded: z.optional(z.boolean()),
    autoUpdateMode: z.optional(InstallableAutoUpdateModeSchema),
  }).check(z.refine(value => Object.keys(value).length > 0)),
});

export function readMachineInstallablePolicySetting(settings: Pick<AccountSettings, 'installablesPolicyByMachineId'>, machineId: string) {
  return Object.hasOwn(settings.installablesPolicyByMachineId, machineId)
    ? settings.installablesPolicyByMachineId[machineId] : {};
}

export function buildMachineInstallablePolicySettingMutation(settings: Pick<AccountSettings, 'installablesPolicyByMachineId'>, machineId: string, value: unknown) {
  const key = MachineInstallablePolicyKeySchema.safeParse(machineId);
  const change = MachineInstallablePolicyChangeSchema.safeParse(value);
  if (!key.success || !change.success) return null;
  const next = applyInstallablePolicyOverride({ prev: settings.installablesPolicyByMachineId,
    machineId: key.data, installableKey: change.data.installableKey, patch: change.data.patch });
  const admitted = ACCOUNT_SETTING_DEFINITIONS.installablesPolicyByMachineId.parseMutationValue(next);
  if (!admitted.success) return null;
  const policy = ACCOUNT_SETTING_DEFINITIONS.installablesPolicyByMachineId.schema.parse(admitted.data);
  if (!Object.hasOwn(policy, key.data)
    || !Object.hasOwn(policy[key.data], change.data.installableKey)) return null;
  return { installablesPolicyByMachineId: policy };
}
