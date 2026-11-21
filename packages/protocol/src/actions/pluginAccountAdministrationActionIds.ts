export const PLUGIN_PROJECT_SCOPE_SET_ACTION_ID = 'account.plugins.availability.intent.set' as const;

export const PLUGIN_ACCOUNT_ADMINISTRATION_ACTION_IDS = [
  'plugins.account.release.select', 'plugins.account.hosting.set',
  'plugins.account.hosting.remove', 'plugins.account.cache.clear', PLUGIN_PROJECT_SCOPE_SET_ACTION_ID,
] as const;
export type PluginAccountAdministrationActionId = typeof PLUGIN_ACCOUNT_ADMINISTRATION_ACTION_IDS[number];
