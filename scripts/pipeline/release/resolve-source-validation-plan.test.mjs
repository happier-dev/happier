import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSourceValidationPlan } from './resolve-source-validation-plan.mjs';

const base = {
  deployTargets: [],
  forceDeploy: false,
  candidate: { cli: false },
  changed: { ui: false, cli: false, cliStackShared: false, server: false, shared: false, stack: false, runner: false },
  resume: { cli: false, stack: false, server: false, runner: false },
  risks: { mysqlContract: false, platformServices: false, trustRoots: false },
};

test('selects no expensive source gates when the unioned change has no matching risk', () => {
  assert.deepEqual(resolveSourceValidationPlan(base), {
    runMysql: false,
    runPlatform: false,
    runTrustRoots: false,
  });
});

test('selects the union of channel-relevant source risks once', () => {
  assert.deepEqual(resolveSourceValidationPlan({
    ...base,
    deployTargets: ['cli', 'stack'],
    changed: { ...base.changed, server: true },
    risks: { mysqlContract: true, platformServices: true, trustRoots: true },
  }), {
    runMysql: true,
    runPlatform: true,
    runTrustRoots: true,
  });
});

test('uses evolved stack and shared-CLI ownership when selecting platform validation', () => {
  for (const changed of [
    { ...base.changed, stack: true },
    { ...base.changed, cliStackShared: true },
  ]) {
    assert.equal(resolveSourceValidationPlan({
      ...base,
      changed,
      risks: { ...base.risks, platformServices: true },
    }).runPlatform, true);
  }
});

test('does not run service gates when no affected binary or runtime is being published', () => {
  assert.deepEqual(resolveSourceValidationPlan({
    ...base,
    risks: { mysqlContract: true, platformServices: true, trustRoots: false },
  }), {
    runMysql: false,
    runPlatform: false,
    runTrustRoots: false,
  });
});

test('resume and force inputs preserve validation for reused publish surfaces', () => {
  assert.equal(resolveSourceValidationPlan({
    ...base,
    resume: { ...base.resume, server: true },
    risks: { ...base.risks, mysqlContract: true },
  }).runMysql, true);
  assert.equal(resolveSourceValidationPlan({
    ...base,
    forceDeploy: true,
    risks: { ...base.risks, platformServices: true },
  }).runPlatform, true);
});

test('an existing CLI candidate selects platform validation even without a CLI deploy target', () => {
  assert.equal(resolveSourceValidationPlan({
    ...base,
    deployTargets: ['website'],
    candidate: { cli: true },
    risks: { ...base.risks, platformServices: true },
  }).runPlatform, true);
});

test('Runner changes and resumed Runner publication select platform validation without selecting MySQL', () => {
  for (const input of [
    { ...base, changed: { ...base.changed, runner: true } },
    { ...base, resume: { ...base.resume, runner: true } },
  ]) {
    assert.deepEqual(resolveSourceValidationPlan({
      ...input,
      risks: { ...base.risks, platformServices: true, mysqlContract: true },
    }), { runMysql: false, runPlatform: true, runTrustRoots: false });
  }
});

// G1: exercise the real selection owner before a release reaches these checks.
import * as sourcePlanner from './resolve-source-validation-plan.mjs';

test('pre-release planner selects release-only checks for their owning paths and nightly schedules', () => {
  const select = (changedPaths, eventName = 'push') => sourcePlanner.resolvePreReleaseCheckPlan({ changedPaths, eventName });
  for (const [path, lane] of [
    ['apps/stack/scripts/self_host_schtasks.real.integration.test.mjs', 'run_self_host_schtasks'],
    ['packages/cli-common/native/windows/service-launcher.c', 'run_self_host_schtasks'],
    ['apps/cli/src/cli.ts', 'run_packaged_cli'],
    ['scripts/pipeline/release/build-cli-binaries.mjs', 'run_packaged_cli'],
    ['apps/ui/app.config.js', 'run_mobile_native'],
    ['apps/ui/sources/app.tsx', 'run_mobile_native'],
  ]) {
    assert.equal(select([path])[lane], true, `${path} must select ${lane}`);
    assert.equal(select([path], 'pull_request')[lane], true, `PR ${path} must select ${lane}`);
  }
  const all = { run_self_host_schtasks: true, run_packaged_cli: true, run_mobile_native: true };
  assert.deepEqual(select([], 'schedule'), all);
  assert.deepEqual(select(['.github/workflows/tests.yml']), all);
  assert.deepEqual(select(['docs/release-process.md']), {
    run_self_host_schtasks: false, run_packaged_cli: false, run_mobile_native: false,
  });
  assert.equal(select(['apps/cli/src/cli.ts']).run_mobile_native, false);
});
