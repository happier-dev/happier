import { CLOUDFLARE_BUILD_IMAGE, CLOUDFLARE_WRANGLER_VERSION } from './cloudflareToolchain.js';

/** Inspect, Create and Prepare disclose the same source consequences. */
export function cloudflareReviewNotice(target: 'pages' | 'workers', sourceMethod: 'gitIntegration' | 'upload'): string {
  const deployment = sourceMethod === 'upload'
    ? `Uploads build on the controller using ${CLOUDFLARE_BUILD_IMAGE} and Wrangler ${CLOUDFLARE_WRANGLER_VERSION}.`
    : target === 'pages' ? 'Deploys the latest commit on the configured branch.'
      : 'Cloudflare Workers Builds deploys the configured repository branch.';
  return target === 'pages' ? `A Pages source is final at creation. ${deployment}` : deployment;
}
