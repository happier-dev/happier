import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import YAML from 'yaml';

import {
  collectCiSummary,
  jobsForSelectedInputs,
  SELECTOR_JOBS,
} from './ciSummaryCollector.mjs';

test('provider-only reusable calls do not inherit unrelated default lanes', () => {
  const workflow = YAML.parse(readFileSync(new URL('../../.github/workflows/tests.yml', import.meta.url), 'utf8'));
  const defaults = Object.fromEntries(Object.entries(workflow.on.workflow_call.inputs)
    .map(([key, definition]) => [key, definition.default]));
  const required = jobsForSelectedInputs({
    inputs: { ...defaults, select_jobs_explicitly: true, run_providers: true },
  });
  assert.deepEqual([...required].sort(), ['providers', 'release_actor_guard', 'trusted_ref_guard']);
});

test('explicit CLI selection owns the managed runtime without spilling into other callers', () => {
  for (const [selector, jobs] of [
    ['run_cli', ['cli', 'cliproxyapi-managed-runtime']],
    ['run_server', ['server']],
    ['run_stress', ['stress']],
    ['run_mobile_e2e_android', ['mobile-e2e-android']],
  ]) {
    assert.deepEqual([...jobsForSelectedInputs({ inputs: { select_jobs_explicitly: true, [selector]: true } })].sort(),
      [...jobs, 'trusted_ref_guard'].sort());
  }
  assert.deepEqual([...jobsForSelectedInputs({ inputs: { select_jobs_explicitly: true } })], ['trusted_ref_guard']);
});

test('every run selector resolves to its complete job set', () => {
  assert.deepEqual(SELECTOR_JOBS.run_ui, ['ui-unit', 'ui-integration', 'ui', 'action-map-drift']);
  assert.deepEqual(SELECTOR_JOBS.run_shared_packages, ['shared-packages-unit']);
  assert.deepEqual(SELECTOR_JOBS.run_build_smoke, ['build-smoke']);
  assert.deepEqual(SELECTOR_JOBS.run_installers_smoke, [
    'installers-smoke-linux',
    'installers-smoke-macos',
    'installers-smoke-windows',
  ]);
  assert.deepEqual(SELECTOR_JOBS.run_providers, ['release_actor_guard', 'providers']);
  assert.deepEqual(SELECTOR_JOBS.run_workspace_sync_real, ['workspace-sync-real']);
  assert.deepEqual(SELECTOR_JOBS.run_workspace_sync_performance, ['workspace-sync-real']);
  assert.ok(Object.keys(SELECTOR_JOBS).length > 20, 'the collector must cover the workflow, not one special lane');
  const workflow = readFileSync(new URL('../../.github/workflows/tests.yml', import.meta.url), 'utf8');
  const declaredSelectors = [...workflow.matchAll(/^      (run_[a-z0-9_]+):$/gmu)].map((match) => match[1]);
  assert.deepEqual(Object.keys(SELECTOR_JOBS).sort(), [...new Set(declaredSelectors)].sort());

  const jobs = YAML.parse(workflow)?.jobs ?? {};
  for (const [selector, selectedJobs] of Object.entries(SELECTOR_JOBS)) {
    const selectorPattern = new RegExp(`inputs\\.${selector}(?![a-z0-9_])`, 'u');
    const jobsUsingSelector = Object.entries(jobs)
      .filter(([, definition]) => selectorPattern.test(String(definition?.if ?? '')))
      .map(([id]) => id)
      .sort();
    assert.deepEqual(
      [...selectedJobs].sort(),
      jobsUsingSelector,
      `${selector} must be derived from every job whose actual if expression consumes it`,
    );
  }
});

test('explicit selection requires every selected job while leaving unrelated skipped jobs optional', () => {
  const required = jobsForSelectedInputs({
    inputs: { select_jobs_explicitly: true, run_ui: true, run_workspace_sync_real: false },
    eventName: 'workflow_call',
  });
  assert.deepEqual([...required].sort(), [
    'action-map-drift',
    'trusted_ref_guard',
    'ui',
    'ui-integration',
    'ui-unit',
  ]);

  const summary = collectCiSummary({
    needs: {
      ui: { result: 'skipped' },
      'ui-unit': { result: 'success' },
      'ui-integration': { result: 'success' },
      'action-map-drift': { result: 'success', outputs: { command_executed: 'true' } },
      // run_shared_packages owns this job; a UI-only selection skips it.
      'shared-packages-unit': { result: 'skipped' },
      'workspace-sync-real': { result: 'skipped' },
      trusted_ref_guard: { result: 'success' },
      'cliproxyapi-managed-runtime': { result: 'success' },
    },
    requiredJobs: required,
  });
  assert.deepEqual(summary.failures.map(({ id }) => id), ['ui']);
});

test('explicit selection is authoritative regardless of the reusable caller event', () => {
  const inputs = {
    select_jobs_explicitly: true,
    run_mobile_e2e_android: true,
    run_release_assets_docker: true,
    run_self_host_systemd: true,
    run_e2e_core_slow: true,
    run_providers: true,
  };

  for (const eventName of ['push', 'pull_request', 'schedule', 'workflow_dispatch', 'workflow_call']) {
    const required = jobsForSelectedInputs({ inputs, eventName });
    for (const job of [
      'mobile-e2e-android',
      'release-assets-docker',
      'self-host-systemd-e2e',
      'e2e-core-slow',
      'release_actor_guard',
      'providers',
    ]) {
      assert.equal(required.has(job), true, `${job} must be required for caller event ${eventName}`);
    }
  }
});

test('selected jobs fail closed for missing and non-success conclusions', () => {
  for (const result of [undefined, null, 'skipped', 'cancelled', 'timed_out']) {
    const summary = collectCiSummary({
      needs: { cli: result === undefined ? undefined : { result } },
      requiredJobs: new Set(['cli']),
    });
    assert.deepEqual(summary.failures.map(({ id }) => id), ['cli']);
  }
});

test('a selected path-filtered job cannot report success without executing its command', () => {
  const summary = collectCiSummary({
    needs: {
      'ui-e2e': { result: 'success', outputs: { command_executed: 'false' } },
    },
    requiredJobs: new Set(['ui-e2e']),
  });
  assert.deepEqual(summary.failures.map(({ id }) => id), ['ui-e2e']);
});

test('every path-filtered job publishes whether its guarded command actually executed', () => {
  const workflow = YAML.parse(readFileSync(new URL('../../.github/workflows/tests.yml', import.meta.url), 'utf8'));
  const pathFilteredJobs = Object.entries(workflow?.jobs ?? {})
    .filter(([, job]) => (job?.steps ?? []).some((step) => String(step?.uses ?? '').includes('dorny/paths-filter')));
  assert.deepEqual(pathFilteredJobs.map(([id]) => id).sort(), ['action-map-drift', 'ui-e2e', 'workspace-sync-real']);
  const ordinary = jobsForSelectedInputs({ inputs: {}, eventName: 'push' });
  for (const [id, job] of pathFilteredJobs) {
    assert.match(
      String(job?.outputs?.command_executed ?? ''),
      /steps\.changes\.outputs\./u,
      `${id} must expose command execution to the generic summary collector`,
    );
    assert.equal(ordinary.has(id), false, `${id} path-filters in ordinary CI, so an irrelevant-path success is valid`);
  }
});

test('ordinary CI requires non-filtered default lanes but leaves path-filtered defaults outcome-driven', () => {
  const required = jobsForSelectedInputs({ inputs: {}, eventName: 'pull_request' });
  assert.equal(required.has('cli'), true);
  assert.equal(required.has('ui-e2e'), false);
  assert.equal(required.has('workspace-sync-real'), false);
  assert.equal(required.has('action-map-drift'), false);
  assert.equal(required.has('shared-packages-unit'), true);
  assert.equal(required.has('build-smoke'), true);
  // A non-explicit reusable call carries the workflow_call defaults (run_ui: true)
  // but still path-filters, so its path-filtered jobs stay outcome-driven.
  const ordinaryCall = jobsForSelectedInputs({ inputs: { select_jobs_explicitly: false, run_ui: true }, eventName: 'workflow_call' });
  assert.equal(ordinaryCall.has('ui'), true);
  assert.equal(ordinaryCall.has('action-map-drift'), false);
  assert.equal(required.has('mobile-e2e-android'), false);
  assert.equal(required.has('stress'), false);
});

test('ordinary path filtering accepts an irrelevant success but still reports a real lane failure', () => {
  const required = new Set([...jobsForSelectedInputs({ inputs: {}, eventName: 'pull_request' })]
    .filter((id) => id === 'workspace-sync-real'));
  const irrelevant = collectCiSummary({
    needs: {
      'workspace-sync-real': { result: 'success', outputs: { command_executed: 'false' } },
    },
    requiredJobs: required,
  });
  assert.deepEqual(irrelevant.failures, []);

  const failed = collectCiSummary({
    needs: {
      'workspace-sync-real': { result: 'failure', outputs: { command_executed: 'true' } },
    },
    requiredJobs: required,
  });
  assert.deepEqual(failed.failures.map(({ id }) => id), ['workspace-sync-real']);
});

test('an explicitly selected path-filtered lane must execute its guarded command', () => {
  const required = new Set([...jobsForSelectedInputs({
    inputs: { select_jobs_explicitly: true, run_workspace_sync_real: true },
    eventName: 'workflow_call',
  })].filter((id) => id === 'workspace-sync-real'));
  const summary = collectCiSummary({
    needs: {
      'workspace-sync-real': { result: 'success', outputs: { command_executed: 'false' } },
    },
    requiredJobs: required,
  });
  assert.deepEqual(summary.failures.map(({ id }) => id), ['workspace-sync-real']);
});
