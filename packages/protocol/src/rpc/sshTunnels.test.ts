import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './index.js';

describe('RPC_METHODS (daemon SSH tunnels)', () => {
  it('keeps local daemon SSH tunnel lifecycle out of machine RPC methods', () => {
    expect(Object.values(RPC_METHODS).filter((method) => method.startsWith('daemon.sshTunnels.'))).toEqual([]);
    expect(RPC_METHODS).not.toHaveProperty('DAEMON_SSH_TUNNELS_ENSURE');
    expect(RPC_METHODS).not.toHaveProperty('DAEMON_SSH_TUNNELS_LIST');
    expect(RPC_METHODS).not.toHaveProperty('DAEMON_SSH_TUNNELS_PROBE');
    expect(RPC_METHODS).not.toHaveProperty('DAEMON_SSH_TUNNELS_RELEASE');
    expect(RPC_METHODS).not.toHaveProperty('DAEMON_SSH_TUNNELS_STOP');
  });
});
