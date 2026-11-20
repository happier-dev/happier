/** Shared by portable preparation and the daemon's container executor. */
export const CLOUDFLARE_BUILD_NODE_VERSION = '24.21.0';
export const CLOUDFLARE_BUILD_IMAGE_PIN = 'sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0';
export const CLOUDFLARE_BUILD_IMAGE = `node:${CLOUDFLARE_BUILD_NODE_VERSION}-bookworm@${CLOUDFLARE_BUILD_IMAGE_PIN}`;
export const CLOUDFLARE_WRANGLER_VERSION = '4.156.0';
