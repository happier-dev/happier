// @ts-check

/**
 * The canonical CI summary carries facts from the command's actual invocation.
 * A green workflow without these facts remains ordinary CI, never suite proof.
 * @param {unknown} value
 * @param {{ runId: string; sourceSha: string; profile: string; policy: string; suite: string }} expected
 */
export function resolveSourceSuiteReuse(value, expected) {
  if (!value || typeof value !== 'object') return false;
  const summary = /** @type {Record<string, unknown>} */ (value);
  if (summary.schemaVersion !== 1 || String(summary.runId) !== expected.runId
    || summary.sourceSha !== expected.sourceSha || !Array.isArray(summary.failures)
    || summary.failures.length || !Array.isArray(summary.lanes)) return false;
  return summary.lanes.some((lane) => lane?.result === 'success'
    && lane.outputs?.source_suite === expected.suite
    && lane.outputs?.source_sha === expected.sourceSha
    && lane.outputs?.source_profile === expected.profile
    && lane.outputs?.source_policy === expected.policy);
}

/** @param {unknown} summary @param {{runId: string; sourceSha: string; profile: string}} expected */
export function projectSourceSuiteReuse(summary, expected) {
  return Object.fromEntries(['preview', 'production'].flatMap((policy) =>
    ['release-contracts', 'binary-smoke'].map((suite) => [
      `${suite === 'release-contracts' ? 'source_contracts' : 'binary_smoke'}_${policy}`,
      resolveSourceSuiteReuse(summary, { ...expected, policy, suite }) ? 'success' : '',
    ])));
}
