import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './rpc.js';

describe('RPC_METHODS (machine resources)', () => {
  it('includes daemon.resources.get', () => {
    expect(RPC_METHODS.DAEMON_RESOURCES_GET).toBe('daemon.resources.get');
  });
});
