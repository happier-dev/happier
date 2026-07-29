import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './index.js';

describe('RPC_METHODS marketplace source registry surface', () => {
  it('exposes marketplace registry and daemon index query methods', () => {
    expect(RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_GET).toBe('daemon.marketplaceSourceRegistry.get');
    expect(RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_SET).toBe('daemon.marketplaceSourceRegistry.set');
    expect(RPC_METHODS.DAEMON_MARKETPLACE_INDEX_QUERY).toBe('daemon.marketplaceIndex.query');
  });
});
