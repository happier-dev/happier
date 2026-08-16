import { describe, expect, it } from 'vitest';

import {
  resolveDaemonSessionConnectedServiceAuthSwitchTimeoutMs,
} from './controlClient';

describe('resolveDaemonSessionConnectedServiceAuthSwitchTimeoutMs', () => {
  it('defaults to a completion-sized bound for continuity checks and one bounded group convergence', () => {
    expect(resolveDaemonSessionConnectedServiceAuthSwitchTimeoutMs({})).toBe(180_000);
  });

  it('honors the operation-specific override within daemon-control bounds', () => {
    expect(resolveDaemonSessionConnectedServiceAuthSwitchTimeoutMs({
      HAPPIER_DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH_HTTP_TIMEOUT_MS: '90000',
    })).toBe(90_000);
    expect(resolveDaemonSessionConnectedServiceAuthSwitchTimeoutMs({
      HAPPIER_DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH_HTTP_TIMEOUT_MS: '1',
    })).toBe(1_000);
    expect(resolveDaemonSessionConnectedServiceAuthSwitchTimeoutMs({
      HAPPIER_DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH_HTTP_TIMEOUT_MS: '99999999',
    })).toBe(300_000);
  });
});
