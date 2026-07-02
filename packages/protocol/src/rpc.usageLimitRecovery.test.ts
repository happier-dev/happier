import { describe, expect, it } from 'vitest';

import { RPC_METHODS, SESSION_RPC_METHODS } from './rpc.js';

describe('RPC_METHODS usage-limit recovery surface', () => {
  it('declares daemon and session-scoped usage-limit recovery controls', () => {
    expect((RPC_METHODS as any).DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE).toBe('daemon.sessionUsageLimit.waitResume.enable');
    expect((RPC_METHODS as any).DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL).toBe('daemon.sessionUsageLimit.waitResume.cancel');
    expect((RPC_METHODS as any).DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW).toBe('daemon.sessionUsageLimit.checkNow');

    expect((SESSION_RPC_METHODS as any).SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE).toBe('session.usageLimit.waitResume.enable');
    expect((SESSION_RPC_METHODS as any).SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL).toBe('session.usageLimit.waitResume.cancel');
    expect((SESSION_RPC_METHODS as any).SESSION_USAGE_LIMIT_CHECK_NOW).toBe('session.usageLimit.checkNow');
  });
});
