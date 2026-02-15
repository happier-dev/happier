import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './rpc.js';

describe('RPC_METHODS (session replay)', () => {
  it('includes machine RPC method for continuing sessions with Happier replay', () => {
    expect(RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY).toBe('session.continueWithReplay');
  });
});

