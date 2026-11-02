import test from 'node:test';
import assert from 'node:assert/strict';

import { admitRelease, admitReleaseFromEnvironment } from './admit-release.mjs';

const base = {
  sourceSha: 'a'.repeat(40),
  validatedSourceSha: 'a'.repeat(40),
  ciGateResult: 'success',
  checksProfile: 'fast',
  environment: 'preview',
  publishServerRuntimeNeeded: true,
  publishCliBinariesNeeded: true,
  publishStack: false,
  sourceChecksWaived: false,
  risks: { mysqlContract: false, platformServices: false, trustRoots: false },
  gates: { mysql: 'skipped', platform: 'skipped', trustRoots: 'skipped' },
};

test('admits a preview when no heavy risk gate applies', () => {
  assert.deepEqual(admitRelease(base), { admitted: true });
});

test('requires platform evidence when a stack artifact changes the self-host runtime', () => {
  assert.throws(() => admitRelease({
    ...base,
    publishServerRuntimeNeeded: false,
    publishCliBinariesNeeded: false,
    publishStack: true,
    risks: { ...base.risks, platformServices: true },
    gates: { ...base.gates, platform: 'skipped' },
  }), /platform gates/);
});

test('an explicit source-CI waiver also waives source-only MySQL and platform gates but not artifact trust', () => {
  assert.deepEqual(admitRelease({
    ...base,
    sourceChecksWaived: true,
    risks: { mysqlContract: true, platformServices: true, trustRoots: false },
  }), { admitted: true });

  assert.throws(() => admitRelease({
    ...base,
    sourceChecksWaived: true,
    risks: { mysqlContract: true, platformServices: true, trustRoots: true },
  }), /trust validation/);
});

test('requires full checks for production and successful selected risk gates', () => {
  assert.throws(() => admitRelease({ ...base, environment: 'production' }), /checks_profile=full/);
  assert.throws(() => admitRelease({
    ...base,
    risks: { ...base.risks, mysqlContract: true },
    gates: { ...base.gates, mysql: 'failure' },
  }), /MySQL gate/);
  assert.throws(() => admitRelease({
    ...base,
    risks: { ...base.risks, trustRoots: true },
    gates: { ...base.gates, trustRoots: 'skipped' },
  }), /trust validation/);
});


test('channel admission binds successful shared source evidence to its exact planned source', () => {
  const sourceSha = 'a'.repeat(40);
  const shared = { sourceSha, validatedSourceSha: sourceSha, ciGateResult: 'success' };
  assert.deepEqual(admitRelease({ ...base, ...shared }), { admitted: true });
  assert.throws(() => admitRelease({ ...base, ...shared, validatedSourceSha: 'b'.repeat(40) }), /source/i);
  assert.throws(() => admitRelease({ ...base, ...shared, ciGateResult: 'failure' }), /CI/i);
});

test('channel admission refuses missing planned source even when source CI is waived', () => {
  const env = {
    PLANNED_SOURCE_SHA: base.sourceSha,
    VALIDATED_SOURCE_SHA: base.validatedSourceSha,
    CI_GATE_RESULT: 'success',
    CHECKS_PROFILE: 'fast',
    DEPLOY_ENVIRONMENT: 'preview',
  };
  assert.deepEqual(admitReleaseFromEnvironment(env), { admitted: true });
  for (const missingSource of [undefined, '']) {
    assert.throws(() => admitReleaseFromEnvironment({ ...env, PLANNED_SOURCE_SHA: missingSource }), /source/i);
    assert.throws(() => admitReleaseFromEnvironment({ ...env, PLANNED_SOURCE_SHA: missingSource, WAIVE_SOURCE_CHECKS: 'true' }), /source/i);
    assert.throws(() => admitRelease({ ...base, sourceSha: missingSource }), /source/i);
  }
});
