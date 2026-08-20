import { createMDX } from 'fumadocs-mdx/next';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const withMDX = createMDX();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // The build script runs the repository-owned native TypeScript 7 gate first.
  // Do not let Next run a second, version-dependent embedded compiler afterward.
  typescript: {
    ignoreBuildErrors: true,
  },
  turbopack: {
    root: repoRoot,
  },
  async redirects() {
    return [
      // Historical: docs used to live under /docs. Keep old URLs working.
      { source: '/docs', destination: '/', permanent: true },
      { source: '/docs/:path*', destination: '/:path*', permanent: true },

      // Pages that were pure "this moved" stubs, now served as real redirects
      // so they stop occupying a sidebar row, a search result and an llms.txt
      // entry that all promised content the page did not have.
      { source: '/clients/notifications', destination: '/advanced/notifications', permanent: true },
      { source: '/clients/voice', destination: '/features/voice', permanent: true },

      // Section landing pages that only restated their own sidebar.
      { source: '/legal', destination: '/legal/terms', permanent: true },
      { source: '/advanced', destination: '/advanced/provider-integrations', permanent: true },
      { source: '/platforms', destination: '/platforms/windows', permanent: true },

      // Maintainer-only pages that were never public documentation.
      { source: '/development/bootstrap-qa', destination: '/development/desktop-qa', permanent: true },
      { source: '/hstack/edison', destination: '/hstack', permanent: true },
      { source: '/hstack/monorepo-port', destination: '/hstack', permanent: true },
    ];
  },
  async rewrites() {
    return [
      {
        source: '/:path*.mdx',
        destination: '/llms.mdx/docs/:path*',
      },
    ];
  },
};

export default withMDX(config);
