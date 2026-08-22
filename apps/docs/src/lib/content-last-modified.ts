import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { CONTENT_REPO } from '@/lib/site-links';

/**
 * Last-commit date per MDX file, for `<lastmod>` in the sitemap.
 *
 * WHY GIT AND NOT FRONTMATTER OR MTIME
 * ------------------------------------
 * All 225 files carry exactly two frontmatter keys, `title` and `description`
 * (checked: no `date`, `lastModified` or `updated` anywhere), and fumadocs-mdx
 * 14 exposes no git timestamp of its own. So there is nothing to read.
 *
 * Filesystem mtime is available and wrong: a fresh CI clone stamps every file
 * with the checkout time, which would tell Google that all 225 pages changed
 * this morning, on every build. A sitemap that cries wolf is worse than one
 * with no dates — Google discounts a `lastmod` it has learned not to trust, and
 * you cannot un-teach it.
 *
 * Git commit time is the only honest source. It is read in ONE `git log` pass
 * (~50 KB of output, ~150 ms) at build time, not one spawn per page.
 *
 * WHEN IT IS UNAVAILABLE
 * ----------------------
 * A shallow clone, an exported tarball, or a build image without `git` all make
 * this impossible. Then the map is empty and the sitemap omits `lastModified`
 * entirely — a missing date is a non-signal, a fabricated one is a lie. This
 * never throws and never fails a build.
 */

/**
 * Repository root. `next build` runs with the workspace directory as cwd, so
 * `apps/docs` → two levels up. If that assumption ever stops holding, `git log`
 * fails, the map comes back empty, and the sitemap loses its dates rather than
 * emitting wrong ones.
 */
const REPO_ROOT = path.resolve(process.cwd(), '../..');

/** ASCII record separator — cannot occur in a path or an ISO-8601 timestamp. */
const RS = String.fromCharCode(30);

function readGitLastModified(): Map<string, Date> {
  const map = new Map<string, Date>();

  let output: string;
  try {
    output = execFileSync(
      'git',
      [
        'log',
        '--no-merges',
        `--pretty=format:${RS}%cI`,
        '--name-only',
        '--',
        CONTENT_REPO.contentRoot,
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
  } catch {
    return map;
  }

  // `git log` walks newest-first, so the FIRST commit that touches a path is its
  // most recent change. Older commits touching it again hit the `has` guard.
  for (const chunk of output.split(RS)) {
    const lines = chunk.split('\n');
    const iso = lines.shift()?.trim();
    if (!iso) continue;
    const commitDate = new Date(iso);
    if (Number.isNaN(commitDate.getTime())) continue;

    for (const line of lines) {
      const file = line.trim();
      if (!file.endsWith('.mdx')) continue;
      const rel = path.posix.relative(CONTENT_REPO.contentRoot, file);
      if (!rel || rel.startsWith('..')) continue;
      if (!map.has(rel)) map.set(rel, commitDate);
    }
  }

  return map;
}

let cached: Map<string, Date> | undefined;

/**
 * @param pagePath collection-relative path of the MDX file — fumadocs'
 *   `page.path`, e.g. `sessions/inbox-and-approvals.mdx`.
 * @returns the last commit date, or `undefined` when git could not be read.
 */
export function contentLastModified(pagePath: string): Date | undefined {
  cached ??= readGitLastModified();
  return cached.get(pagePath);
}
