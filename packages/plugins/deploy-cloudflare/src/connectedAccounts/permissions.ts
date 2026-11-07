import type { PluginConnectedAccountAuthenticationModeV2 } from '@happier-dev/plugin-sdk/connected-accounts';

/** Cloudflare v4 permission names, verified against the official API on 2026-11-03.
 * https://developers.cloudflare.com/fundamentals/api/reference/permissions/
 * https://developers.cloudflare.com/tunnel/get-started/
 * Each inner group contains equivalent permissions accepted by that API.
 */
const featurePermissions = {
  Workers: [['Workers Scripts Write'], ['Workers CI Write']],
  Pages: [['Pages Write']],
  Tunnel: [['Cloudflare Tunnel Write', 'Cloudflare One Connectors Write', 'Cloudflare One Connector: cloudflared Write']],
  DNS: [['DNS Write']],
} as const;

/** Readability is observed at Cloudflare; write authority is decided by the actual operation. */
export const cloudflareFeatureReadPaths = {
  Workers: '/workers/scripts', Pages: '/pages/projects', Tunnel: '/cfd_tunnel', DNS: null,
} satisfies Record<keyof typeof featurePermissions, string | null>;
export const cloudflareFeatureNames = Object.keys(cloudflareFeatureReadPaths);

const featureGuide = (token: boolean) => Object.entries(featurePermissions).map(([feature, groups]) => ({
  feature,
  items: [
    ...(token && feature === 'Workers' ? ['User-owned token'] : []),
    ...groups.map(([preferred]) => feature === 'DNS' ? `${preferred} for the selected zone` : preferred),
  ],
}));

export const cloudflarePermissionGuide = featureGuide(true) satisfies NonNullable<NonNullable<Extract<PluginConnectedAccountAuthenticationModeV2, { kind: 'manual' }>['setup']>['permissions']>;

/** The same feature permissions as scopes on an own OAuth client; the token-only rows do not apply. */
export const cloudflareClientPermissionGuide = featureGuide(false);

export const cloudflarePermissionNames = [...new Set(Object.values(featurePermissions).flat(2))];

export function cloudflarePermissionScope(name: string) {
  return name === 'DNS Write' ? 'com.cloudflare.api.account.zone' : 'com.cloudflare.api.account';
}

/** Account-owned tokens cannot use Workers Builds, even with CI permission.
 * https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/
 */
export function cloudflareEnabledFeatures(permissions: ReadonlySet<string>, accountOwned = false): string[] {
  return Object.entries(featurePermissions)
    .filter(([feature, groups]) => !(accountOwned && feature === 'Workers')
      && groups.every(alternatives => alternatives.some(name => permissions.has(name))))
    .map(([feature]) => feature);
}
