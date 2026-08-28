import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './index.js';

describe('RPC_METHODS (session handoff)', () => {
  it('includes daemon session handoff orchestration methods', () => {
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_START).toBe('daemon.sessionHandoff.start');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_PREPARE_TARGET).toBe('daemon.sessionHandoff.prepareTarget');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET).toBe('daemon.sessionHandoff.prepareTargetResult.get');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_COMMIT).toBe('daemon.sessionHandoff.commit');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_ABORT).toBe('daemon.sessionHandoff.abort');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_STATUS_GET).toBe('daemon.sessionHandoff.status.get');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET).toBe('daemon.sessionHandoff.capability.v2.get');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2).toBe('daemon.sessionHandoff.prepareTarget.v2');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2).toBe(
      'daemon.sessionHandoff.prepareTargetResult.get.v2',
    );
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2).toBe('daemon.sessionHandoff.targetResume.v2');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_TARGET_CONFIRM_V2).toBe('daemon.sessionHandoff.targetConfirm.v2');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_COMMIT_V2).toBe('daemon.sessionHandoff.commit.v2');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_ABORT_V2).toBe('daemon.sessionHandoff.abort.v2');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_START_V3).toBe('daemon.sessionHandoff.start.v3');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3).toBe('daemon.sessionHandoff.prepareTarget.v3');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESUME_V3).toBe('daemon.sessionHandoff.prepareTarget.resume.v3');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3).toBe(
      'daemon.sessionHandoff.prepareTargetResult.get.v3',
    );
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_COMMIT_V3).toBe('daemon.sessionHandoff.commit.v3');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_ABORT_V3).toBe('daemon.sessionHandoff.abort.v3');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_STATUS_GET_V3).toBe('daemon.sessionHandoff.status.get.v3');
    expect(RPC_METHODS).not.toHaveProperty('DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESUME');
  });
});
