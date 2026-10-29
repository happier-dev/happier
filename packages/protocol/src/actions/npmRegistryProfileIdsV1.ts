
/** Action identity leaf: schema modules and the registry share these constants. */
export const NPM_REGISTRY_PROFILE_ACTION_IDS_V1 = [
  'plugins.npm_registry_profiles.list', 'plugins.npm_registry_profiles.add', 'plugins.npm_registry_profiles.update',
  'plugins.npm_registry_profiles.remove', 'plugins.npm_registry_profiles.login', 'plugins.npm_registry_profiles.logout',
  'plugins.npm_registry_profiles.test',
] as const;
