import { describe, expect, it } from 'vitest';

import { resolveDaemonStartupSourceFromEnv } from './daemonOwnershipMetadata';

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
