/**
 * Every off-site destination the docs link to.
 *
 * These values are COPIES. The originals live in the website workspace:
 *
 *   - `apps/website/src/data/community.ts`  → DISCORD_INVITE_URL
 *   - `apps/website/src/data/downloads.ts`  → GITHUB_REPO_URL, GUIDES_URL
 *
 * The docs app does not depend on the website package, so the values are
 * duplicated rather than imported. They are duplicated *here*, in one file,
 * instead of inline in a layout — because the last time an invite was typed
 * inline it was `discord.gg/happier`, which Discord answers with
 * `10006 Unknown Invite`, and nothing caught it because no other surface shared
 * the value. If you change one of these, change the website's copy in the same
 * commit; `apps/website/scripts/check-download-links.mjs` HEADs the originals
 * before every website deploy, so the website is the side that gets caught.
 */

/** Invite for the "Happier devs" server (guild 1467127365317558402). */
export const DISCORD_INVITE_URL = 'https://discord.gg/W6Pb8KuHfg';

export const GITHUB_REPO_URL = 'https://github.com/happier-dev/happier';

export const WEBSITE_URL = 'https://happier.dev/';

export const GUIDES_URL = 'https://guides.happier.dev/';

/**
 * The website prerenders exactly one route (`/`), so there is no `/download`
 * page to point at. `#get-started` is a real anchor in the prerendered HTML and
 * is the section that carries the App Store badge, the Android APK and the four
 * desktop installers.
 */
export const DOWNLOAD_URL = 'https://happier.dev/#get-started';

/**
 * Where the MDX for a page lives on GitHub, for the "Open in GitHub" link.
 *
 * `main` rather than the repo's default branch (`dev`) on purpose: production
 * docs are promoted from `main` (see `.github/workflows/promote-docs.yml`), so
 * `main` is the branch whose content a reader is actually looking at.
 */
export const CONTENT_REPO = {
  owner: 'happier-dev',
  repo: 'happier',
  branch: 'main',
  /** Path of the docs collection root, relative to the repository root. */
  contentRoot: 'apps/docs/content/docs',
} as const;

export function githubEditUrl(pagePath: string): string {
  const { owner, repo, branch, contentRoot } = CONTENT_REPO;
  return `https://github.com/${owner}/${repo}/blob/${branch}/${contentRoot}/${pagePath}`;
}
