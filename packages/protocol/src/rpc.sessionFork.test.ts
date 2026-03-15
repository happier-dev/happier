import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './rpc.js';

describe('RPC_METHODS (session fork)', () => {
  it('includes machine RPC method for forking sessions', () => {
    expect(RPC_METHODS.SESSION_FORK).toBe('session.fork');
  });
});

