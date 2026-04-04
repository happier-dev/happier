import { describe, expect, it } from 'vitest';

import * as sessionHandoffWorkspaceReplicationAdapterModule from './sessionHandoffWorkspaceReplicationAdapter';

describe('sessionHandoffWorkspaceReplicationAdapter', () => {
  it('exposes a factory seam for handoff workspace replication orchestration', () => {
    const exported = sessionHandoffWorkspaceReplicationAdapterModule as Record<string, unknown>;

    expect(typeof exported.createSessionHandoffWorkspaceReplicationAdapter).toBe('function');

    const adapter = (exported.createSessionHandoffWorkspaceReplicationAdapter as (() => Readonly<{
      createState: () => Promise<unknown>;
      resolveSourceOffer: () => Promise<unknown>;
    }>))();

    expect(typeof adapter.createState).toBe('function');
    expect(typeof adapter.resolveSourceOffer).toBe('function');
  });
});
