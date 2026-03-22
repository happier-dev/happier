import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './rpc.js';

describe('RPC_METHODS prompt registries surface', () => {
  it('defines prompt registry method constants', () => {
    expect(RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_ADAPTERS).toBe('daemon.promptRegistry.listAdapters');
    expect(RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_SOURCES).toBe('daemon.promptRegistry.listSources');
    expect(RPC_METHODS.DAEMON_PROMPT_REGISTRY_SCAN_SOURCE).toBe('daemon.promptRegistry.scanSource');
    expect('DAEMON_PROMPT_REGISTRY_FETCH_ITEM' in RPC_METHODS).toBe(false);
    expect(RPC_METHODS.DAEMON_PROMPT_REGISTRY_INSTALL).toBe('daemon.promptRegistry.install');
  });
});
