import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './rpc.js';

describe('RPC_METHODS (daemon memory)', () => {
  it('includes daemon.memory.* methods', () => {
    expect((RPC_METHODS as any).DAEMON_MEMORY_SEARCH).toBe('daemon.memory.search');
    expect((RPC_METHODS as any).DAEMON_MEMORY_GET_WINDOW).toBe('daemon.memory.getWindow');
    expect((RPC_METHODS as any).DAEMON_MEMORY_ENSURE_UP_TO_DATE).toBe('daemon.memory.ensureUpToDate');
    expect((RPC_METHODS as any).DAEMON_MEMORY_STATUS).toBe('daemon.memory.status');
    expect((RPC_METHODS as any).DAEMON_MEMORY_SETTINGS_GET).toBe('daemon.memory.settings.get');
    expect((RPC_METHODS as any).DAEMON_MEMORY_SETTINGS_SET).toBe('daemon.memory.settings.set');
  });
});

