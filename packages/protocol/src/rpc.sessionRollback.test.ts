import { describe, expect, it } from 'vitest';

import { SESSION_RPC_METHODS } from './rpc.js';

describe('SESSION_RPC_METHODS (session rollback)', () => {
  it('includes session RPC method for rolling back conversations', () => {
    expect((SESSION_RPC_METHODS as any).SESSION_ROLLBACK).toBe('session.rollback');
  });
});
