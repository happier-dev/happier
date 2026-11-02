import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('publish-ui-mobile-dev installs the Dagger CLI version declared by the local module', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'publish-ui-mobile-dev.yml'), 'utf8');
  const daggerConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'dagger', 'dagger.json'), 'utf8'));
  const expectedVersion = String(daggerConfig.engineVersion ?? '').replace(/^v/, '');

  assert.match(expectedVersion, /^\d+\.\d+\.\d+$/);
  assert.match(workflow, new RegExp(`version:\\s*["']${expectedVersion.replaceAll('.', '\\.')}["']`));
});

test('dev APK publishing uses a fresh write-scoped App token after the native build', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(repoRoot, '.github/workflows/publish-ui-mobile-dev.yml'), 'utf8'));
  const steps = workflow.jobs.publish.steps;
  const builds = steps.filter((step) => step.run?.includes('node scripts/pipeline/run.mjs ui-mobile-release'));
  assert.equal(builds.length, 2, 'cloud and local build paths must share the publication boundary');
  for (const build of builds) {
    assert.match(build.run, /--publish-apk-release false/);
  }
  const token = steps.find((step) => step.name === 'Create GitHub App token (APK publishing)');
  const publish = steps.find((step) => step.name === 'Publish built dev APK');
  assert.ok(token && publish);
  assert.equal(token.with['permission-contents'], 'write');
  assert.ok(steps.indexOf(token) > Math.max(...builds.map((step) => steps.indexOf(step))));
  assert.ok(steps.indexOf(publish) > steps.indexOf(token));
  assert.equal(publish.env.GH_TOKEN, '${{ steps.apk_token.outputs.token }}');
  assert.match(publish.run, /scripts\/pipeline\/expo\/publish-apk-release\.mjs/);
  assert.match(publish.run, /--target-sha "\$AUTHORIZED_SHA"/);
  assert.match(publish.run, /--release-message(?:=|\s+)"\$RELEASE_MESSAGE"/);
});
