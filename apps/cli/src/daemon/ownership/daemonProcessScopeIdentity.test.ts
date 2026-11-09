import { expect, it } from 'vitest';
import { configuration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import type { HappyProcessInfo } from '@/daemon/doctor';
import { daemonProcessMatchesCurrentScope } from './daemonProcessScopeIdentity';

it('binds a published standalone owner to its recorded home and endpoint without requiring launcher scope variables', () => {
  const scope = createEnvKeyScope(['HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID']);
  scope.patch({ HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined });
  try {
    const candidate: HappyProcessInfo = {
      pid: process.pid + 1, type: 'daemon', command: 'node /repo/apps/cli/src/index.ts daemon start-sync',
      daemonOwnershipEnvironmentVariables: {
        HAPPIER_HOME_DIR: configuration.happyHomeDir,
        HAPPIER_SERVER_URL: configuration.serverUrl,
      },
    };
    expect(daemonProcessMatchesCurrentScope(candidate, { requireRecordedScopeFacts: true })).toBe(true);
    expect(daemonProcessMatchesCurrentScope(candidate, { requireScopeIdentity: true })).toBe(false);
    for (const mismatch of [
      { HAPPIER_HOME_DIR: `${configuration.happyHomeDir}-foreign` },
      { HAPPIER_SERVER_URL: 'https://foreign.invalid' },
      { HAPPIER_HOME_DIR: '' },
      { HAPPIER_SERVER_URL: '' },
      { HAPPIER_ACTIVE_SERVER_ID: 'foreign' },
      { HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'foreign' },
    ]) {
      expect(daemonProcessMatchesCurrentScope({ ...candidate, daemonOwnershipEnvironmentVariables: {
        ...candidate.daemonOwnershipEnvironmentVariables, ...mismatch,
      } }, { requireRecordedScopeFacts: true })).toBe(false);
    }
    scope.patch({ HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'explicit-caller' });
    expect(daemonProcessMatchesCurrentScope(candidate, { requireRecordedScopeFacts: true })).toBe(false);
  } finally {
    scope.restore();
  }
});

it('requires home and lifecycle proof for recovery while retaining force-stop endpoint proof', () => {
  const scope = createEnvKeyScope(['HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID']);
  scope.patch({ HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'scope-test' });
  try {
    const candidate: HappyProcessInfo = {
      pid: process.pid + 1, type: 'daemon-spawned-session', command: 'happier',
      daemonOwnershipEnvironmentVariables: {
        HAPPIER_HOME_DIR: configuration.happyHomeDir,
        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'scope-test',
        HAPPIER_SERVER_URL: 'https://previous-endpoint.invalid',
      },
    };
    expect(daemonProcessMatchesCurrentScope(candidate, { requireScopeIdentity: true })).toBe(true);
    expect(daemonProcessMatchesCurrentScope(candidate, { requireRecordedScopeFacts: true })).toBe(false);
    expect(daemonProcessMatchesCurrentScope({ ...candidate, daemonOwnershipEnvironmentVariables: undefined }, { requireScopeIdentity: true })).toBe(false);
  } finally {
    scope.restore();
  }
});

it('recognizes a released runner scoped to the active server when a standalone replacement daemon has no explicit lifecycle env', () => {
  const scope = createEnvKeyScope(['HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID']);
  scope.patch({ HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined });
  try {
    const candidate: HappyProcessInfo = {
      pid: process.pid + 1, type: 'daemon-spawned-session', command: 'happier',
      daemonOwnershipEnvironmentVariables: {
        HAPPIER_HOME_DIR: configuration.happyHomeDir,
        HAPPIER_ACTIVE_SERVER_ID: configuration.activeServerId,
        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: configuration.activeServerId,
      },
    };
    expect(daemonProcessMatchesCurrentScope(candidate, { requireScopeIdentity: true })).toBe(true);
    expect(daemonProcessMatchesCurrentScope({
      ...candidate,
      daemonOwnershipEnvironmentVariables: {
        ...candidate.daemonOwnershipEnvironmentVariables,
        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'foreign-scope',
      },
    }, { requireScopeIdentity: true })).toBe(false);
  } finally {
    scope.restore();
  }
});
