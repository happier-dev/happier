import { inspectDependencyRefresh, withDependencyRefresh } from '../proc/dependency_refresh.mjs';

// Worktree callers retain their frozen-lockfile/output policy, while dependency freshness,
// serialization, and successful refresh recording stay owned by the package-manager layer.
export async function shouldRunYarnInstall({ installDir, componentDir }) {
  return (await inspectDependencyRefresh({ installDir, componentDir })).required;
}

export async function withYarnInstallGuard({ installDir, componentDir }, install) {
  return await withDependencyRefresh({ installDir, componentDir }, install);
}
