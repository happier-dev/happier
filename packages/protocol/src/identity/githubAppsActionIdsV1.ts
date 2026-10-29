
/** Action identity leaf: schema modules and the registry share these constants. */
export const MANAGED_GITHUB_APP_ACTION_IDS_V1 = [
  'identity.githubApps.list',
  'identity.githubApps.create',
  'identity.githubApps.manifestSetup.start',
  'identity.githubApps.update',
  'identity.githubApps.verifyInstallation',
  'identity.githubApps.remove',
] as const;
