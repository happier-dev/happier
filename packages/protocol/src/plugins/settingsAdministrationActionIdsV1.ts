
/** Action identity leaf: schema modules and the registry share these constants. */
/**
 * Canonical user-administration Actions for declared plugin Settings. These
 * Actions select one existing Settings/Secrets owner; they do not introduce a
 * new settings store or accept raw secret material.
 */
export const PLUGIN_SETTINGS_ADMINISTRATION_ACTION_IDS_V1 = [
  'plugins.settings.list',
  'plugins.settings.get',
  'plugins.settings.set',
  'plugins.settings.reset',
  'plugins.settings.secret.status',
  'plugins.settings.secret.bind',
  'plugins.settings.secret.unbind',
  'plugins.settings.secret.delete',
] as const;
