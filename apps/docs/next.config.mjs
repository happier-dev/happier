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
  /**
   * docs.happier.dev is a fully static export served by Cloudflare Workers.
   *
   * WHY EXPORT AND NOT THE OPENNEXT ADAPTER. Every page is content known at
   * build time. The only routes that genuinely needed a server were /ingest/*
   * (the analytics proxy) and /health, and both are now the Worker script in
   * worker/index.ts. Exporting makes the pages static assets: free and
   * unlimited on the Workers asset layer, with no invocation per page view.
   * `@opennextjs/cloudflare` would have preserved SSR semantics nothing here
   * uses, and its peer range (`next >=16.2.11`) does not admit the version this
   * app is pinned to anyway.
   *
   * WHAT MOVED OUT OF THIS FILE, AND WHY IT CANNOT COME BACK:
   *   - `redirects()` — 2 permanent URL moves. Export drops the hook SILENTLY,
   *     so they live in redirects.mjs and are compiled to public/_redirects by
   *     scripts/generateRedirects.mjs on every build. Adding a `redirects()` key
   *     here again would work in `next dev` and do nothing in production.
   *   - `rewrites()` — `/:path*.mdx` served the plain-text source of a page.
   *     A rewrite is a server behaviour with no `_redirects` equivalent (that
   *     file only does 3xx), so the Worker performs it by mapping the request
   *     onto the already-exported /llms.mdx/docs/* asset.
   *
   * Route handlers must also be statically renderable (`force-static`, GET
   * only) — see the notes on each one under src/app.
   */
  output: 'export',
};

export default withMDX(config);
