import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './rpc.js';

describe('RPC_METHODS (daemon execution runs)', () => {
  it('includes daemon.executionRuns.list', () => {
    expect((RPC_METHODS as any).DAEMON_EXECUTION_RUNS_LIST).toBe('daemon.executionRuns.list');
  });
});

