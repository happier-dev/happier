import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logConnectedServiceDaemonRestartDiagnostic } from './logConnectedServiceDaemonRestartDiagnostic';
import type { ConnectedServiceDaemonRestartDiagnosticRecord } from '../connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';

describe('logConnectedServiceDaemonRestartDiagnostic', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits restart diagnostics at info level so daemon timelines are visible by default', () => {
    const record: ConnectedServiceDaemonRestartDiagnosticRecord = {
      type: 'connected_service_daemon_restart',
      trigger: 'manual_switch',
      status: 'requested',
      sessionId: 'session-1',
      agentId: 'claude',
      serviceId: 'claude-subscription',
      profileId: 'profile-1',
      groupId: null,
      generation: null,
      reason: 'manual',
      pid: 123,
      processGroupPid: 123,
      delayMs: 250,
      atMs: 1_700_000_000_000,
    };

    logConnectedServiceDaemonRestartDiagnostic(logger, record);

    expect(logger.info).toHaveBeenCalledWith(
      '[DAEMON RUN] Connected-service daemon restart diagnostic',
      record,
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
