// @ts-check

/**
 * When running EAS local builds inside Dagger containers, EAS writes metadata JSON
 * with container-local artifact paths (e.g. `/tmp/...`). That JSON is exported to
 * the host, so we rewrite it to point at the host artifact path for follow-up
 * steps (submit/publish) and for human debugging.
 *
 * @param {{ rawJson: string; artifactPath: string }} opts
 * @returns {string}
 */
export function rewriteEasLocalBuildArtifactPath({ rawJson, artifactPath }) {
  const parsed = JSON.parse(String(rawJson ?? ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return JSON.stringify(parsed, null, 2);
  }
  const out = /** @type {Record<string, unknown>} */ ({ ...parsed });
  out.artifactPath = String(artifactPath ?? '');
  return `${JSON.stringify(out, null, 2)}\n`;
}

