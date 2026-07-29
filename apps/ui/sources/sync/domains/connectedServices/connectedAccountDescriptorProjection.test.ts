import { describe, expect, it } from 'vitest';

import type { ConnectedAccountUiProjectionEntryV1 } from '@happier-dev/protocol';
import type { DaemonContributionRegistryProjection } from '@/sync/api/daemon/daemonContributionRegistryProjectionProtocol';

import {
  advanceConnectedAccountDescriptorProjectionState,
  createConnectedAccountDescriptorProjectionLoadingState,
  mergeConnectedAccountDescriptorProjections,
  readConnectedAccountDescriptorProjection,
} from './connectedAccountDescriptorProjection';

function descriptor(overrides: Partial<ConnectedAccountUiProjectionEntryV1> = {}): ConnectedAccountUiProjectionEntryV1 {
  return {
    id: 'account',
    serviceId: 'bitbucket',
    pluginId: 'acme.accounts',
    provenance: 'external',
    sourceKind: 'bundled',
    title: 'Acme account',
    description: 'Connect an Acme account',
    authentication: {
      defaultModeId: 'manual',
      modes: [{
        id: 'manual',
        kind: 'manual',
        outcomeReconciliation: 'none',
        fields: [{
          id: 'token',
          title: 'Token',
          schema: { type: 'string' },
          secret: true,
        }],
      }],
    },
    capabilities: ['account.connect'],
    availability: { state: 'available', reason: 'resolved' },
    diagnostics: [],
    ...overrides,
  };
}

function projection(entries: Record<string, Readonly<{ id: string }> & Record<string, unknown>>): DaemonContributionRegistryProjection {
  const fixture = {
    v: 2,
    generation: 1,
    installedPackagesById: {},
    agentsById: {},
    backendsById: {},
    actionsById: {},
    toolsById: {},
    commandsById: {},
    resourcesById: {},
    settingsById: {},
    familiesById: {
      connectedAccounts: { family: 'connectedAccounts', entriesById: entries },
    },
    diagnostics: [],
  };
  // This boundary fixture deliberately permits malformed wire entries so the reader's fail-closed path is exercised.
  return fixture as unknown as DaemonContributionRegistryProjection;
}

describe('connectedAccountDescriptorProjection', () => {
  it('distinguishes authoritative empty from malformed and unsupported projections', () => {
    expect(readConnectedAccountDescriptorProjection(projection({}))).toEqual({ kind: 'ready', descriptors: [] });
    expect(readConnectedAccountDescriptorProjection(projection({ broken: { id: 'broken' } }))).toEqual({
      kind: 'error',
      reason: 'malformed',
    });
    expect(readConnectedAccountDescriptorProjection(null)).toEqual({ kind: 'error', reason: 'unsupported' });
  });

  it('deduplicates equal multi-machine facts without rebuilding descriptor references', () => {
    const projected = descriptor();
    const merged = mergeConnectedAccountDescriptorProjections([
      { kind: 'ready', descriptors: [projected] },
      { kind: 'ready', descriptors: [projected] },
    ]);

    expect(merged).toEqual({ kind: 'ready', descriptors: [projected], conflicts: [] });
    if (merged.kind === 'error') throw new Error('expected a ready projection');
    expect(merged.descriptors[0]).toBe(projected);
  });

  it('keeps divergent identity candidates visible as a fail-closed conflict', () => {
    const left = descriptor({ title: 'Machine A account' });
    const right = descriptor({ title: 'Machine B account' });
    const merged = mergeConnectedAccountDescriptorProjections([
      { kind: 'ready', descriptors: [left] },
      { kind: 'ready', descriptors: [right] },
    ]);

    expect(merged.kind).toBe('conflict');
    if (merged.kind === 'error') throw new Error('expected a conflict projection');
    expect(merged.descriptors).toEqual(expect.arrayContaining([left, right]));
    expect(merged.conflicts).toEqual([
      expect.objectContaining({ kind: 'identity_divergence', descriptorIdentity: 'acme.accounts\u0000account' }),
    ]);
  });

  it('keeps every claimant visible when descriptor owners conflict on one service id', () => {
    const left = descriptor({ id: 'left', pluginId: 'acme.left' });
    const right = descriptor({ id: 'right', pluginId: 'acme.right' });
    const merged = mergeConnectedAccountDescriptorProjections([
      { kind: 'ready', descriptors: [left] },
      { kind: 'ready', descriptors: [right] },
    ]);

    expect(merged.kind).toBe('conflict');
    if (merged.kind === 'error') throw new Error('expected a conflict projection');
    expect(merged.descriptors).toEqual(expect.arrayContaining([left, right]));
    expect(merged.conflicts).toEqual([
      expect.objectContaining({ kind: 'service_ownership', serviceId: 'bitbucket' }),
    ]);
  });

  it('retains last-known-good as stale for one or all machine failures and recovers in place', () => {
    const projected = descriptor();
    const loading = createConnectedAccountDescriptorProjectionLoadingState('server-a');
    const ready = advanceConnectedAccountDescriptorProjectionState(loading, {
      kind: 'ready', descriptors: [projected], conflicts: [],
    });
    const repeatedReady = advanceConnectedAccountDescriptorProjectionState(ready, {
      kind: 'ready', descriptors: [{ ...projected }], conflicts: [],
    });
    expect(repeatedReady).toBe(ready);
    const stale = advanceConnectedAccountDescriptorProjectionState(ready, {
      kind: 'error', reason: 'partial_machine_failure',
    });

    expect(stale).toMatchObject({ scopeKey: 'server-a', status: 'stale', descriptors: [projected] });
    expect(stale.descriptors).toBe(ready.descriptors);

    const recovered = advanceConnectedAccountDescriptorProjectionState(stale, {
      kind: 'ready', descriptors: [projected], conflicts: [],
    });
    expect(recovered).toMatchObject({ status: 'ready', descriptors: [projected] });
    expect(recovered.descriptors).toBe(stale.descriptors);
  });

  it('clears last-known-good only on authoritative successful absence', () => {
    const projected = descriptor();
    const ready = advanceConnectedAccountDescriptorProjectionState(
      createConnectedAccountDescriptorProjectionLoadingState('server-a'),
      { kind: 'ready', descriptors: [projected], conflicts: [] },
    );
    const cleared = advanceConnectedAccountDescriptorProjectionState(ready, {
      kind: 'ready', descriptors: [], conflicts: [],
    });

    expect(cleared).toMatchObject({ status: 'ready', descriptors: [] });
  });

  it('keeps an initial failure distinct from loading and does not leak state across server scopes', () => {
    const failed = advanceConnectedAccountDescriptorProjectionState(
      createConnectedAccountDescriptorProjectionLoadingState('server-a'),
      { kind: 'error', reason: 'transport' },
    );
    expect(failed).toMatchObject({ scopeKey: 'server-a', status: 'error', descriptors: [] });

    const switched = createConnectedAccountDescriptorProjectionLoadingState('server-b');
    expect(switched).toEqual({
      scopeKey: 'server-b',
      status: 'loading',
      descriptors: [],
      conflicts: [],
      errorReason: null,
    });
  });
});
