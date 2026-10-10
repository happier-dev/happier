/** Client runtime controls and connected-Machine restart use the incumbent SystemTask owners. */
export const HOME_RUNTIME_ACTION_IDS_V1 = [
  'relay.access.status', 'relay.access.configure', 'relay.access.disable',
  'relay.runtime.status', 'relay.runtime.install_or_update', 'relay.runtime.start',
  'relay.runtime.stop', 'relay.runtime.restart', 'relay.runtime.uninstall',
  'relay.runtime.personal_home.inspect', 'relay.runtime.personal_home.backup',
  'relay.runtime.personal_home.verify_backup', 'relay.runtime.personal_home.restore',
  'relay.runtime.personal_home.recover_restore', 'relay.runtime.personal_home.erase',
  'relay.runtime.personal_home.claim', 'relay.runtime.personal_home.relocate',
  'relay.runtime.personal_home.choose_archive', 'relay.runtime.personal_home.choose_backup_destination',
  'relay.runtime.open_path', 'relay.runtime.reveal_output',
  'home.runtime.get', 'home.runtime.restart',
] as const;
export type HomeRuntimeActionIdV1 = typeof HOME_RUNTIME_ACTION_IDS_V1[number];
export function isHomeRuntimeActionIdV1(value: string): value is HomeRuntimeActionIdV1 {
  return (HOME_RUNTIME_ACTION_IDS_V1 as readonly string[]).includes(value);
}
