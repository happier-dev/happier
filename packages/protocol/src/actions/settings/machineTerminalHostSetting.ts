import { z } from '../../zodRuntimePolicy.js';
import { ACCOUNT_SETTING_DEFINITIONS } from '../../account/settings/accountSettings.js';
import { buildMachineTerminalSettingsPatch, resolveTerminalHost } from './accountSettingBindings.js';

export const MachineTerminalHostSettingKeySchema = z.string().check(z.trim(), z.minLength(1), z.refine((value) => value !== '__proto__', { message: 'Prototype setter keys are not valid machine ids' }));
export const MachineTerminalHostSettingChangeSchema = z.strictObject({
  host: z.optional(z.nullable(z.enum(['none', 'tmux', 'zellij', 'herdr']))),
  tmux: z.optional(z.strictObject({
    sessionName: z.optional(z.string()),
    isolated: z.optional(z.boolean()),
    tmpDir: z.optional(z.nullable(z.string())),
  }).check(z.refine(value => Object.keys(value).length > 0))),
}).check(z.refine(value => Object.keys(value).length > 0));

export function readMachineTerminalHostSetting(settings: Parameters<typeof resolveTerminalHost>[0]['settings'], machineId: string) {
  const override = Object.hasOwn(settings.sessionTmuxByMachineId, machineId) ? settings.sessionTmuxByMachineId[machineId] : undefined;
  const explicitHost = Object.hasOwn(settings.sessionTerminalHostByMachineId, machineId) ? settings.sessionTerminalHostByMachineId[machineId] : undefined;
  return {
    host: override || explicitHost ? resolveTerminalHost({ settings, machineId }) : null,
    tmux: override ? { sessionName: override.sessionName, isolated: override.isolated, tmpDir: override.tmpDir } : null,
  };
}

export function buildMachineTerminalHostSettingMutation(settings: Parameters<typeof buildMachineTerminalSettingsPatch>[0]['settings'], machineId: string, value: unknown) {
  const key = MachineTerminalHostSettingKeySchema.safeParse(machineId);
  const change = MachineTerminalHostSettingChangeSchema.safeParse(value);
  if (!key.success || !change.success) return null;
  const patch = buildMachineTerminalSettingsPatch({ settings, machineId: key.data, change: change.data });
  const tmux = ACCOUNT_SETTING_DEFINITIONS.sessionTmuxByMachineId.parseMutationValue(patch.sessionTmuxByMachineId);
  const hosts = ACCOUNT_SETTING_DEFINITIONS.sessionTerminalHostByMachineId.parseMutationValue(patch.sessionTerminalHostByMachineId);
  if (!tmux.success || !hosts.success) return null;
  return { sessionTmuxByMachineId: tmux.data, sessionTerminalHostByMachineId: hosts.data };
}
