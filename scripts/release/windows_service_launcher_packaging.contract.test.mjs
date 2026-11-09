import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { collectWorkspacePackageDeclaredFileEntries } from '../../packages/cli-common/workspaceRuntimeDependencies.mjs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const workflow = (name) => parse(read(`.github/workflows/${name}.yml`));
const buildsLauncher = (steps) => steps.some((step) => step.run?.includes('build-windows-service-launcher.mjs'));
const testsLauncher = (steps) => steps.some((step) => step.run?.includes('service-launcher.test.ps1'));

test('cli-common declares native launcher resources through the canonical files inventory', () => {
  const manifest = JSON.parse(read('packages/cli-common/package.json'));
  assert.ok(collectWorkspacePackageDeclaredFileEntries(manifest).includes('native/windows'));
  assert.equal(manifest.happierWorkspaceBundleFiles, undefined);
});

test('CLI native Windows publication compiles and tests the GUI launcher before packaging', () => {
  const job = workflow('publish-cli-binaries').jobs.build_native;
  const windows = job.strategy.matrix.include.find((entry) => entry.platform_key === 'windows-x64');
  assert.ok(windows);
  assert.equal(windows.runner, 'windows-2022', 'the hard-coded VS2022 toolchain must use its supported image');
  assert.ok(buildsLauncher(job.steps), 'the native Windows matrix must produce its launcher');
  assert.ok(testsLauncher(job.steps), 'native lifecycle admission must precede archive production');
  const compile = job.steps.findIndex((step) => step.run?.includes('build-windows-service-launcher.mjs'));
  const packageIndex = job.steps.findIndex((step) => step.run?.includes('release-build-cli-binaries'));
  assert.ok(compile < packageIndex);
});

test('HStack transports the exact source launcher with a product-specific artifact name', () => {
  const jobs = workflow('publish-hstack-binaries').jobs;
  assert.ok(jobs.build_windows_service_launcher, 'cross-platform HStack packaging needs an MSVC producer');
  assert.ok(buildsLauncher(jobs.build_windows_service_launcher.steps));
  assert.ok(testsLauncher(jobs.build_windows_service_launcher.steps));
  const upload = jobs.build_windows_service_launcher.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  const download = jobs.build_candidate.steps.find((step) => step.uses?.startsWith('actions/download-artifact@') && step.with?.name?.includes('windows-service-launcher'));
  assert.ok(upload.with.name.startsWith('hstack-windows-service-launcher-'));
  assert.equal(download?.with.name, upload.with.name);
  assert.ok(jobs.build_candidate.needs.includes('build_windows_service_launcher'));
});

test('npm packaging admits the same exact source launcher before either package builds', () => {
  const jobs = workflow('release-npm').jobs;
  assert.ok(jobs.build_windows_service_launcher);
  assert.ok(buildsLauncher(jobs.build_windows_service_launcher.steps));
  assert.ok(testsLauncher(jobs.build_windows_service_launcher.steps));
  assert.ok(jobs.release.needs.includes('build_windows_service_launcher'));
  assert.ok(jobs.release.steps.some((step) => step.env?.LAUNCHER_SOURCE_SHA));
  assert.ok(jobs.release.steps.some((step) => step.with?.name === 'windows-service-launcher-npm'));
});

test('existing Windows CI owners compile and exercise the native launcher', () => {
  const jobs = workflow('tests').jobs;
  for (const id of ['installers-smoke-windows', 'self-host-schtasks-e2e']) {
    assert.ok(buildsLauncher(jobs[id].steps), `${id} must prepare the native task action`);
    assert.ok(testsLauncher(jobs[id].steps), `${id} must exercise launcher lifecycle`);
  }
});
