import { describe, expect, it } from 'vitest';

import {
  resolveDaemonStartupSourceFromEnv,
  resolveDaemonStartupSourceServiceManagedState,
} from './daemonOwnershipMetadata';

describe('resolveDaemonStartupSourceFromEnv', () => {
  it('defaults to manual when only service metadata env is present', () => {
    expect(
      resolveDaemonStartupSourceFromEnv({
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
      } as NodeJS.ProcessEnv),
    ).toBe('manual');
  });

  it('honors an explicit background-service startup source marker', () => {
    expect(
      resolveDaemonStartupSourceFromEnv({
        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
      } as NodeJS.ProcessEnv),
    ).toBe('background-service');
  });
});

describe('resolveDaemonStartupSourceServiceManagedState', () => {
  it('treats legacy daemon state without a service label as manual', () => {
    expect(resolveDaemonStartupSourceServiceManagedState(undefined, undefined)).toBe(false);
    expect(resolveDaemonStartupSourceServiceManagedState('unknown', undefined)).toBe(false);
  });

  it('treats legacy daemon state with a service label as service-managed', () => {
    expect(resolveDaemonStartupSourceServiceManagedState(undefined, 'com.happier.cli.daemon.default')).toBe(true);
    expect(resolveDaemonStartupSourceServiceManagedState('unknown', 'com.happier.cli.daemon.default')).toBe(true);
  });
});
