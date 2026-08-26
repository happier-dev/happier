import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('npm publication workflow is reusable-only and receives its exact source identity from release admission', async () => {
  const [npmWorkflow, releaseWorkflow] = await Promise.all([
    readFile(resolve(repositoryRoot, '.github/workflows/release-npm.yml'), 'utf8'),
    readFile(resolve(repositoryRoot, '.github/workflows/release.yml'), 'utf8'),
  ]);

  assert.match(npmWorkflow, /^on:\n  workflow_call:/mu);
  assert.doesNotMatch(npmWorkflow, /^  workflow_dispatch:/mu);
  assert.match(npmWorkflow, /authorized_sha:\n        description: "Release-admitted exact source SHA"\n        required: true/mu);
  assert.match(npmWorkflow, /approve_public_sdk_release:\n        description: "Maintainer approval — publish this exact public SDK candidate"/mu);
  assert.match(releaseWorkflow, /uses: \.\/\.github\/workflows\/release-npm\.yml/mu);
  assert.match(releaseWorkflow, /authorized_sha: \$\{\{ needs\.prepare_release_candidate\.outputs\.source_sha \}\}/mu);
  assert.match(releaseWorkflow, /approve_public_sdk_release: \$\{\{ inputs\.approve_public_sdk_release \}\}/mu);
});

test('npm publication workflow leaves public-package candidate preparation to package tests and the scripted pack owner', async () => {
  const npmWorkflow = await readFile(resolve(repositoryRoot, '.github/workflows/release-npm.yml'), 'utf8');

  assert.doesNotMatch(
    npmWorkflow,
    /yarn --cwd packages\/plugin-sdk -s prepare:declarations/u,
  );
  assert.match(npmWorkflow, /node scripts\/pipeline\/run\.mjs npm-release/u);
});

test('the existing SDK candidate-byte validation phase runs dual-origin validation before publication', async () => {
  const [releasePackages, publicTarballValidator] = await Promise.all([
    readFile(resolve(repositoryRoot, 'scripts/pipeline/npm/release-packages.mjs'), 'utf8'),
    readFile(resolve(repositoryRoot, 'scripts/pipeline/npm/validate-public-sdk-tarballs.mjs'), 'utf8'),
  ]);

  const candidateValidationIndex = releasePackages.indexOf('runPublicSdkTarballValidationPhase(repoRoot, publicTarballs, opts);');
  const publishSdkIndex = releasePackages.indexOf("if (mode === 'pack+publish' && publishSdk)");
  assert.ok(candidateValidationIndex >= 0, 'the pack owner must retain its canonical candidate-validation phase');
  assert.ok(publishSdkIndex > candidateValidationIndex, 'SDK candidate validation must precede the SDK publisher');

  assert.match(
    publicTarballValidator,
    /runSdkDualOriginValidation\s*\(\s*\{\s*repoRoot,\s*source:\s*\{\s*kind:\s*'local-pack',\s*ref:\s*sdkTarball\s*\}/su,
    'the validation phase must run the existing dual-origin executor against its exact SDK tarball',
  );
});
