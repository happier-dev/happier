import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './rpc.js';

describe('RPC_METHODS prompt assets surface', () => {
  it('defines prompt asset method constants', () => {
    expect(RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES).toBe('daemon.promptAssets.listTypes');
    expect(RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER).toBe('daemon.promptAssets.discover');
    expect(RPC_METHODS.DAEMON_PROMPT_ASSETS_READ).toBe('daemon.promptAssets.read');
    expect(RPC_METHODS.DAEMON_PROMPT_ASSETS_WRITE).toBe('daemon.promptAssets.write');
    expect(RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE).toBe('daemon.promptAssets.delete');
  });
});
