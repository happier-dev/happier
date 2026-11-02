import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSourceValidationPlan } from './resolve-source-validation-plan.mjs';

const base = {
  deployTargets: [],
  forceDeploy: false,
  changed: { ui: false, cli: false, server: false, shared: false },
  resume: { cli: false, stack: false, server: false },
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

test('does not run service gates for risky paths when no affected binary or runtime is being published', () => {
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
  assert.deepEqual(resolveSourceValidationPlan({
    ...base,
    resume: { ...base.resume, server: true },
    risks: { ...base.risks, mysqlContract: true },
  }), {
    runMysql: true,
    runPlatform: false,
    runTrustRoots: false,
  });

  assert.deepEqual(resolveSourceValidationPlan({
    ...base,
    forceDeploy: true,
    risks: { ...base.risks, platformServices: true },
  }), {
    runMysql: false,
    runPlatform: true,
    runTrustRoots: false,
  });
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
