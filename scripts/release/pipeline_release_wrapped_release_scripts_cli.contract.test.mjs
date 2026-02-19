import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const cases = [
  ['release-sync-installers', 'scripts/pipeline/release/sync-installers.mjs'],
  ['release-bump-version', 'scripts/pipeline/release/bump-version.mjs'],
  ['release-build-cli-binaries', 'scripts/pipeline/release/build-cli-binaries.mjs'],
  ['release-build-hstack-binaries', 'scripts/pipeline/release/build-hstack-binaries.mjs'],
  ['release-build-server-binaries', 'scripts/pipeline/release/build-server-binaries.mjs'],
  ['release-publish-manifests', 'scripts/pipeline/release/publish-manifests.mjs'],
  ['release-verify-artifacts', 'scripts/pipeline/release/verify-artifacts.mjs'],
  ['release-compute-changed-components', 'scripts/pipeline/release/compute-changed-components.mjs'],
  ['release-resolve-bump-plan', 'scripts/pipeline/release/resolve-bump-plan.mjs'],
  ['release-compute-deploy-plan', 'scripts/pipeline/release/compute-deploy-plan.mjs'],
  ['release-build-ui-web-bundle', 'scripts/pipeline/release/build-ui-web-bundle.mjs'],
];

for (const [subcommand, expectedRelPath] of cases) {
  test(`pipeline CLI supports ${subcommand} dry-run wrapper`, async () => {
    const out = execFileSync(
      process.execPath,
      [resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'), subcommand, '--dry-run'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          GH_TOKEN: '',
          GH_REPO: '',
          GITHUB_REPOSITORY: '',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );

    assert.match(out, /\[pipeline\] exec: node /);
    assert.match(out, new RegExp(expectedRelPath.replaceAll('/', '\\/')));
  });
}

