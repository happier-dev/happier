import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './rpc.js';

describe('RPC_METHODS (daemon server work)', () => {
  it('includes daemon.serverWork.status', () => {
    expect((RPC_METHODS as any).DAEMON_SERVER_WORK_STATUS).toBe('daemon.serverWork.status');
  });
});
