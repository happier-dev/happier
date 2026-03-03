import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveChecksProfilePlan } from './checks-profile.mjs';

test('resolveChecksProfilePlan keeps self-host checks disabled by default', () => {
  const plan = resolveChecksProfilePlan({ profile: 'full', customChecks: '' });
  assert.equal(plan.runSelfHostLaunchd, false);
  assert.equal(plan.runSelfHostSystemd, false);
  assert.equal(plan.runSelfHostDaemon, false);
});

test('resolveChecksProfilePlan enables self-host checks via custom toggles', () => {
  const plan = resolveChecksProfilePlan({
    profile: 'custom',
    customChecks: 'self_host_launchd,self_host_systemd,self_host_daemon',
  });
  assert.equal(plan.runSelfHostLaunchd, true);
  assert.equal(plan.runSelfHostSystemd, true);
  assert.equal(plan.runSelfHostDaemon, true);
});

