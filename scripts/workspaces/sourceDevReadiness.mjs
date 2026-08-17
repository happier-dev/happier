import { resolve } from 'node:path';

const SOURCE_DEV_SHARED_DEPS_STAMP_RELATIVE_PATH =
  '.project/tmp/cli-source-dev-shared-deps-sync.json';

export function resolveSourceDevSharedDepsStampPath(repoRoot) {
  return resolve(repoRoot, SOURCE_DEV_SHARED_DEPS_STAMP_RELATIVE_PATH);
}
