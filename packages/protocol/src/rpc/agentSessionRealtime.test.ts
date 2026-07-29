import { describe, expect, it } from 'vitest';

import { SESSION_RPC_METHODS } from './index.js';

describe('SESSION_RPC_METHODS (Agent-session realtime Voice)', () => {
  it('publishes only the bounded session-scoped control methods', () => {
    expect(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT)
      .toBe('session.agentRealtime.inspect');
    expect(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)
      .toBe('session.agentRealtime.start');
    expect(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP)
      .toBe('session.agentRealtime.stop');
    expect(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH)
      .toBe('session.agentRealtime.watch');
  });
});
