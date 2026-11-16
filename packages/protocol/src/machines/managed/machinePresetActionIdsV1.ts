export const MACHINE_PRESET_ARCHIVE_ACTION_ID_V1 = 'machines.presets.archive' as const;
export const MACHINE_PRESET_HTTP_ACTION_IDS_V1 = [
  'machines.presets.list', 'machines.presets.get', 'machines.presets.create',
  'machines.presets.update', MACHINE_PRESET_ARCHIVE_ACTION_ID_V1, 'machines.presets.restore',
] as const;

export type MachinePresetHttpActionIdV1 = typeof MACHINE_PRESET_HTTP_ACTION_IDS_V1[number];
export const MACHINE_PRESET_PREPARE_ACTION_ID_V1 = 'machines.presets.prepare' as const;
export const MACHINE_PRESET_ACTION_IDS_V1 = [
  ...MACHINE_PRESET_HTTP_ACTION_IDS_V1, MACHINE_PRESET_PREPARE_ACTION_ID_V1,
] as const;
export type MachinePresetActionIdV1 = typeof MACHINE_PRESET_ACTION_IDS_V1[number];

/** Finite preset lifecycle roots retain their admitted preset through content cleanup. */
export function isMachinePresetFiniteOperationActionIdV1(value: string): value is
  typeof MACHINE_PRESET_PREPARE_ACTION_ID_V1 | typeof MACHINE_PRESET_ARCHIVE_ACTION_ID_V1 {
  return value === MACHINE_PRESET_PREPARE_ACTION_ID_V1 || value === MACHINE_PRESET_ARCHIVE_ACTION_ID_V1;
}
