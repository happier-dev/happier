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
  assert.match(
    npmWorkflow,
    /approve_public_sdk_release:\n        description: "Maintainer approval for public packages without SDK API governance"/mu,
  );
  assert.match(releaseWorkflow, /uses: \.\/\.github\/workflows\/release-npm\.yml/mu);
  assert.match(releaseWorkflow, /authorized_sha: \$\{\{ needs\.prepare_release_candidate\.outputs\.source_sha \}\}/mu);
  assert.match(
    releaseWorkflow,
    /approve_public_sdk_release: \$\{\{ inputs\.approve_public_sdk_release \}\}/mu,
  );
  assert.match(releaseWorkflow, /PLUGIN_SDK_API_CLASSIFICATION: \$\{\{ inputs\.plugin_sdk_api_classification \}\}/mu);
  assert.match(releaseWorkflow, /SDK_API_CLASSIFICATION: \$\{\{ inputs\.sdk_api_classification \}\}/mu);
  assert.match(
    releaseWorkflow,
    /- name: Enforce stable and risk-selected publication admission[\s\S]*?env:\n[\s\S]*?WAIVE_CI: \$\{\{ inputs\.waive_ci \}\}[\s\S]*?PUBLISH_PLUGIN_SDK:/mu,
  );
  assert.doesNotMatch(releaseWorkflow, /public_sdk_release_decision|comparison_evidence/mu);
});

test('npm publication workflow leaves public-package preparation to package tests and the scripted pack owner', async () => {
  const npmWorkflow = await readFile(resolve(repositoryRoot, '.github/workflows/release-npm.yml'), 'utf8');

  assert.doesNotMatch(
    npmWorkflow,
    /yarn --cwd packages\/plugin-sdk -s prepare:declarations/u,
  );
  assert.match(npmWorkflow, /node scripts\/pipeline\/run\.mjs npm-release/u);
});

test('npm publication leaves feature QA on moving source and validates only exported public archives', async () => {
  const releasePackages = await readFile(resolve(repositoryRoot, 'scripts/pipeline/npm/release-packages.mjs'), 'utf8');
  assert.match(releasePackages, /validatePublicSdkPublicationTarballs/u);
  assert.doesNotMatch(releasePackages, /sdk-dual-origin|HAPPIER_RELEASE_VALIDATION_SDK_TARBALL/u);
});
