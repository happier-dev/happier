import { describe, expect, it } from 'vitest';

import { SESSION_RPC_METHODS } from './rpc.js';

describe('SESSION_RPC_METHODS (execution runs)', () => {
  it('includes execution.run.* methods', () => {
    expect(SESSION_RPC_METHODS.EXECUTION_RUN_START).toBe('execution.run.start');
    expect(SESSION_RPC_METHODS.EXECUTION_RUN_LIST).toBe('execution.run.list');
    expect(SESSION_RPC_METHODS.EXECUTION_RUN_GET).toBe('execution.run.get');
    expect(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION).toBe('execution.run.action');
  });
});
