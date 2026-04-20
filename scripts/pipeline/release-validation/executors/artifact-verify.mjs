// @ts-check

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolveArtifactVerifyExecution, resolveArtifactVerifyTarget } from '../../release/publishing/artifact-verify-target.mjs';

export { resolveArtifactVerifyExecution, resolveArtifactVerifyTarget };

/**
 * @param {readonly string[]} paths
 */
function assertPathsExist(paths) {
  for (const path of paths) {
    if (!existsSync(path)) {
      throw new Error(`artifact-verify expected path to exist: ${path}`);
    }
  }
}

/**
 * @param {{
 *   repoRoot: string;
 *   source: import('../../release/publishing/artifact-verify-target.mjs').ReleaseValidationSource;
 *   options?: import('../../release/publishing/artifact-verify-target.mjs').ArtifactVerifyOptions;
 * }} params
 */
export function runArtifactVerifyValidation({ repoRoot, source, options }) {
  const target = resolveArtifactVerifyTarget({ repoRoot, source, options });
  assertPathsExist(target.preflightPaths);
  const execution = resolveArtifactVerifyExecution({ repoRoot, source, options });
  execFileSync(execution.command, execution.args, {
    cwd: execution.cwd,
    stdio: 'inherit',
  });
}
