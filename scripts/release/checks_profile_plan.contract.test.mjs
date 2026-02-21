import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveChecksProfilePlan } from '../pipeline/checks/lib/checks-profile.mjs';

test('checks profile: none disables CI checks', () => {
  const plan = resolveChecksProfilePlan({ profile: 'none', customChecks: '' });
  assert.equal(plan.runCi, false);
  assert.equal(plan.runUiE2e, false);
  assert.equal(plan.runE2eCore, false);
  assert.equal(plan.runE2eCoreSlow, false);
  assert.equal(plan.runServerDbContract, false);
  assert.equal(plan.runStress, false);
  assert.equal(plan.runBuildWebsite, false);
  assert.equal(plan.runBuildDocs, false);
  assert.equal(plan.runCliSmokeLinux, false);
});

test('checks profile: fast runs CI but skips slow lanes', () => {
  const plan = resolveChecksProfilePlan({ profile: 'fast', customChecks: 'e2e_core,stress,build_website' });
  assert.equal(plan.runCi, true);
  assert.equal(plan.runUiE2e, true);
  assert.equal(plan.runE2eCore, false);
  assert.equal(plan.runE2eCoreSlow, false);
  assert.equal(plan.runServerDbContract, false);
  assert.equal(plan.runStress, false);
  assert.equal(plan.runBuildWebsite, false);
  assert.equal(plan.runBuildDocs, false);
  assert.equal(plan.runCliSmokeLinux, false);
});

test('checks profile: full enables e2e/db-contract/builds/smoke', () => {
  const plan = resolveChecksProfilePlan({ profile: 'full', customChecks: '' });
  assert.equal(plan.runCi, true);
  assert.equal(plan.runUiE2e, true);
  assert.equal(plan.runE2eCore, true);
  assert.equal(plan.runE2eCoreSlow, true);
  assert.equal(plan.runServerDbContract, true);
  assert.equal(plan.runStress, false);
  assert.equal(plan.runBuildWebsite, true);
  assert.equal(plan.runBuildDocs, true);
  assert.equal(plan.runCliSmokeLinux, true);
});

test('checks profile: custom toggles lanes from CSV', () => {
  const plan = resolveChecksProfilePlan({
    profile: 'custom',
    customChecks: 'e2e_core_slow,server_db_contract,build_docs,cli_smoke_linux,stress',
  });
  assert.equal(plan.runCi, true);
  assert.equal(plan.runUiE2e, false);
  assert.equal(plan.runE2eCore, true);
  assert.equal(plan.runE2eCoreSlow, true);
  assert.equal(plan.runServerDbContract, true);
  assert.equal(plan.runStress, true);
  assert.equal(plan.runBuildWebsite, false);
  assert.equal(plan.runBuildDocs, true);
  assert.equal(plan.runCliSmokeLinux, true);
});

test('checks profile: custom with e2e_core enables fast e2e only', () => {
  const plan = resolveChecksProfilePlan({ profile: 'custom', customChecks: 'e2e_core' });
  assert.equal(plan.runCi, true);
  assert.equal(plan.runUiE2e, false);
  assert.equal(plan.runE2eCore, true);
  assert.equal(plan.runE2eCoreSlow, false);
});

test('checks profile: custom ui e2e toggle', () => {
  const plan = resolveChecksProfilePlan({ profile: 'custom', customChecks: 'ui_e2e' });
  assert.equal(plan.runCi, true);
  assert.equal(plan.runUiE2e, true);
});
