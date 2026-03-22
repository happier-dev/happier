import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './rpc.js';

describe('RPC_METHODS (session handoff)', () => {
  it('includes daemon session handoff orchestration methods', () => {
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_START).toBe('daemon.sessionHandoff.start');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_PREPARE_TARGET).toBe('daemon.sessionHandoff.prepareTarget');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET).toBe('daemon.sessionHandoff.prepareTargetResult.get');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_COMMIT).toBe('daemon.sessionHandoff.commit');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_ABORT).toBe('daemon.sessionHandoff.abort');
    expect((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_STATUS_GET).toBe('daemon.sessionHandoff.status.get');
  });
});
