import { describe, expect, it } from 'vitest';
import { Session } from 'node:inspector/promises';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';

import { getActionRequiredServerFeatureId } from './actionRequiredServerFeature.js';

describe('getActionRequiredServerFeatureId', () => {
  it('keeps device-local SSH trust and exact tunnel cleanup available without the Home management service', () => {
    for (const actionId of ['remote_hosts.trusted_keys.list', 'remote_hosts.trusted_keys.remove', 'remote_hosts.trusted_keys.clear', 'remote_hosts.tunnel.stop']) {
      expect(getActionRequiredServerFeatureId(actionId)).toBeNull();
    }
    expect(getActionRequiredServerFeatureId('remote_hosts.connect')).toBe('remoteHosts.management');
  });
  it('classifies ordinary catalog misses without allocating validation errors', async () => {
    const inspector = new Session();
    inspector.connect();
    try {
      await inspector.post('Profiler.enable');
      await inspector.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
      const started = performance.now();
      const cpuBefore = process.cpuUsage();
      for (let index = 0; index < 1000; index += 1) {
        expect(getActionRequiredServerFeatureId('session.title.set')).toBeNull();
        expect(getActionRequiredServerFeatureId('workflow.unknown')).toBeNull();
      }
      const coverage = await inspector.post('Profiler.takePreciseCoverage');
      const errors = coverage.result.filter(script => script.url.endsWith('/zod/v4/core/errors.js'));
      const errorConstructionCount = errors.flatMap(script => script.functions)
        .filter(fn => fn.functionName === 'initializer')
        .reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0);
      const cpu = process.cpuUsage(cpuBefore);
      console.log('CHILD_ACTION_FEATURE_CLASSIFICATION', JSON.stringify({
        wallMs: performance.now() - started, cpuMs: (cpu.user + cpu.system) / 1000, errorConstructionCount,
      }));
      // V8 omits unexecuted scripts. Prove the allocation detector works with
      // one genuine validation failure, outside the measured classification.
      z.string().safeParse(null);
      const control = await inspector.post('Profiler.takePreciseCoverage');
      expect(control.result.filter(script => script.url.endsWith('/zod/v4/core/errors.js'))
        .flatMap(script => script.functions).filter(fn => fn.functionName === 'initializer')
        .reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0)).toBeGreaterThan(0);
      expect(errorConstructionCount).toBe(0);
    } finally {
      await inspector.post('Profiler.stopPreciseCoverage');
      inspector.disconnect();
    }
  });
  it('requires automation for agent navigation, not human sidecar controls', () => {
    for (const id of ['browser.navigate', 'browser.goBack', 'browser.goForward', 'browser.reload', 'browser.stop', 'browser.automation.snapshot']) {
      expect(getActionRequiredServerFeatureId(id)).toBe('browser.automation');
    }
    for (const id of ['browser.view.open', 'browser.control.takeControl', 'browser.control.handBack', 'browser.unknown']) {
      expect(getActionRequiredServerFeatureId(id)).toBeNull();
    }
  });
  it('owns the server feature required by each gated Action family', () => {
    expect(getActionRequiredServerFeatureId('workflow.run.start')).toBe('workflows');
    expect(getActionRequiredServerFeatureId('workflow.definition.get')).toBe('workflows');
    expect(getActionRequiredServerFeatureId('workflow.unknown')).toBeNull();
    expect(getActionRequiredServerFeatureId('session.discussion.list')).toBe('sessions.conversations');
    expect(getActionRequiredServerFeatureId('session.discussion.post')).toBe('sessions.conversations');
    expect(getActionRequiredServerFeatureId('session.board.get')).toBeNull();
    expect(getActionRequiredServerFeatureId('session.board.item.upsert')).toBeNull();
    expect(getActionRequiredServerFeatureId('session.board.item.remove')).toBeNull();
    expect(getActionRequiredServerFeatureId('session.board.layout.update')).toBe('sessions.board');
    expect(getActionRequiredServerFeatureId('teams.credentials.list')).toBe('teams.credentialResources');
    expect(getActionRequiredServerFeatureId('teams.credentials.create')).toBe('teams.credentialResources');
    expect(getActionRequiredServerFeatureId('teams.credentials.externalKeys.list'))
      .toBe('teams.credentialResources.externalApi');
    expect(getActionRequiredServerFeatureId('teams.credentials.externalKeys.create'))
      .toBe('teams.credentialResources.externalApi');
    expect(getActionRequiredServerFeatureId('teams.list')).toBe('teams');
    expect(getActionRequiredServerFeatureId('teams.invitations.create')).toBe('teams');
    expect(getActionRequiredServerFeatureId('session.follow.set')).toBe('sessions.following');
    expect(getActionRequiredServerFeatureId('session.follow.sources.list')).toBe('sessions.following');
    expect(getActionRequiredServerFeatureId('session.access.grant.set')).toBe('sharing.session');
    expect(getActionRequiredServerFeatureId('session.responsibility.set')).toBe('sharing.session');
    expect(getActionRequiredServerFeatureId('session.public_link.create')).toBe('sharing.public');
    expect(getActionRequiredServerFeatureId('artifact.public_link.create')).toBe('sharing.public');
    expect(getActionRequiredServerFeatureId('machines.pools.create')).toBe('machines.pools');
    for (const actionId of ['remote_hosts.list', 'remote_hosts.credential.change', 'remote_hosts.daemon.start']) {
      expect(getActionRequiredServerFeatureId(actionId)).toBe('remoteHosts.management');
    }
    expect(getActionRequiredServerFeatureId('remote_hosts.unknown')).toBeNull();
    expect(getActionRequiredServerFeatureId('sessions.runner.activation.create'))
      .toBe('sessions.ephemeralRunner');
    expect(getActionRequiredServerFeatureId('account.apiTokens.create')).toBeNull();
    expect(getActionRequiredServerFeatureId('session.title.set')).toBeNull();
  });
  it('keeps private Saved Secret resource Actions available without Teams', () => {
    for (const actionId of ['secrets.shared.list', 'secrets.shared.create', 'secrets.shared.promote',
      'secrets.shared.update', 'secrets.shared.delete', 'secrets.shared.grants.set']) {
      expect(getActionRequiredServerFeatureId(actionId)).toBeNull();
    }
    expect(getActionRequiredServerFeatureId('teams.list')).toBe('teams');
    expect(getActionRequiredServerFeatureId('teams.credentials.create')).toBe('teams.credentialResources');
  });
});
