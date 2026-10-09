export const MACHINE_PRESET_ACTION_IDS_V1 = [
  'machines.presets.list', 'machines.presets.get', 'machines.presets.create',
  'machines.presets.update', 'machines.presets.archive', 'machines.presets.restore',
] as const;

export type MachinePresetActionIdV1 = typeof MACHINE_PRESET_ACTION_IDS_V1[number];
