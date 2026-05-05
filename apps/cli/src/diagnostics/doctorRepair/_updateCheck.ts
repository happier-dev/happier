/**
 * Shared update-check primitives used by the CLI-self-update and relay-server
 * latest-version classifiers. Keeps the timeout/extraction logic in one place
 * instead of duplicating it per consumer.
 */

/** Bound any in-flight promise on a best-effort timeout; null on miss/fail. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }).catch(() => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * Best-effort extraction of a semver string from a GitHub release JSON body.
 *
 * Our published releases include a `version: X.Y.Z-…` line in the body —
 * when present we prefer that (it matches the npm dist-tag value). If the
 * body is absent or doesn't match, we fall back to parsing the numeric
 * semver suffix from `tag_name`.
 */
export function extractSemverFromReleaseJson(release: unknown): string | null {
  if (!release || typeof release !== 'object') return null;
  const r = release as Record<string, unknown>;
  const body = typeof r.body === 'string' ? r.body : '';
  const bodyMatch = body.match(/(?:^|\n)\s*version\s*:\s*([\w.\-+]+)/i);
  if (bodyMatch) return bodyMatch[1];
  const tag = typeof r.tag_name === 'string' ? r.tag_name : '';
  const tagMatch = tag.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
  if (tagMatch) return tagMatch[1];
  return null;
}
