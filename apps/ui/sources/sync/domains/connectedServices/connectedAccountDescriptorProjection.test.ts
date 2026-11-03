import { describe, expect, it, vi } from 'vitest';

import type { ConnectedAccountUiProjectionEntryV1 } from '@happier-dev/protocol';
import type { DaemonContributionRegistryProjection } from '@/sync/api/daemon/daemonContributionRegistryProjectionProtocol';
import { BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';

import {
  advanceConnectedAccountDescriptorProjectionState,
  createConnectedAccountDescriptorProjectionLoadingState,
  createConnectedAccountDescriptorProjectionPublication,
  mergeConnectedAccountDescriptorProjections,
  readConnectedAccountDescriptorProjection,
} from './connectedAccountDescriptorProjection';
import { getConnectedAccountAuthentication, projectConnectedServiceRegistryEntries } from './connectedServiceRegistry';
import { resolveConnectedAccountPurposeTargetEligibility } from './connectedAccountPurposeTargetEligibility';

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
    actionsById: {},


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
  it('keeps Machine availability and diagnostics when adopting the admitted bundled declaration', () => {
    const bundled = BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS['happier.agent.codex/openai-codex']!;
    const supplied = descriptor({
      ...bundled.descriptor, pluginId: bundled.service.pluginId, serviceId: bundled.service.localId,
      provenance: 'first_party', sourceKind: 'bundled', title: 'Older declaration',
      availability: { state: 'blocked', reason: 'runtime_unavailable' }, diagnostics: ['machine-a'],
    });
    const resolution = createConnectedAccountDescriptorProjectionPublication().publish([
      { kind: 'ready', descriptors: [supplied] },
      { kind: 'ready', descriptors: [{ ...supplied, title: 'Another build', diagnostics: ['machine-b'] }] },
    ]);
    expect(resolution.kind).toBe('ready');
    expect(resolution.descriptors).toHaveLength(1);
    expect(resolution.descriptors?.[0]).toMatchObject({
      ...bundled.descriptor, availability: supplied.availability, diagnostics: ['machine-a', 'machine-b'],
    });
  });

  it('compares declarations directly without serializing cold agreement or diagnostics', () => {
    const entry = descriptor({ diagnostics: ['machine_refused'] });
    const source = readConnectedAccountDescriptorProjection(projection({ account: entry }));
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const merged = mergeConnectedAccountDescriptorProjections([{ kind: 'ready', descriptors: [entry] }]);
      const declarationSerializations = stringify.mock.calls.filter(([value]) => (
        typeof value === 'object' && value !== null && 'authentication' in value
      ));
      expect(declarationSerializations).toHaveLength(0);
      expect(merged.descriptors?.[0]?.diagnostics).toEqual(['machine_refused']);
      createConnectedAccountDescriptorProjectionPublication().publish([source]);
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it('publishes stable snapshots without fingerprint work for unchanged immutable source revisions', () => {
    const source = readConnectedAccountDescriptorProjection(projection({ account: descriptor() }));
    const publication = createConnectedAccountDescriptorProjectionPublication();
    const first = publication.publish([source]);
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      for (let index = 0; index < 100; index += 1) {
        expect(publication.getSnapshot()).toBe(first);
        expect(publication.publish([{ ...source }])).toBe(first);
      }
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it('agrees on structural declaration values and orders actual variants independently of supplier order', () => {
    const left = descriptor({ title: 'A account', diagnostics: ['machine-a'] });
    const mode = left.authentication.modes[0]!;
    if (mode.kind !== 'manual') throw new Error('expected manual authentication');
    const right = descriptor({ title: 'A account', diagnostics: ['machine-b'], authentication: {
      ...left.authentication, modes: [{ ...mode, fields: [{ ...mode.fields[0]!, schema: { minLength: 1, type: 'string' } }] }],
    } });
    mode.fields[0]!.schema = { type: 'string', minLength: 1 };
    const different = descriptor({ title: 'Z account' });
    const resolve = (entries: readonly ConnectedAccountUiProjectionEntryV1[]) => mergeConnectedAccountDescriptorProjections(
      entries.map(entry => ({ kind: 'ready', descriptors: [entry] })),
    );
    expect(resolve([left, right])).toMatchObject({ kind: 'ready', descriptors: [{ diagnostics: ['machine-a', 'machine-b'] }] });
    const forward = resolve([left, right, different]);
    const reverse = resolve([different, right, left]);
    expect(forward.kind).toBe('conflict');
    expect(forward.descriptors?.map(entry => entry.title)).toEqual(['A account', 'Z account']);
    expect(reverse.descriptors?.map(entry => entry.title)).toEqual(['A account', 'Z account']);
    expect(reverse.conflicts).toEqual(forward.conflicts);
  });

  it('does not trust arbitrary frozen inputs or retain mutable descriptors as snapshots', () => {
    const entry = descriptor();
    const source = Object.freeze({ kind: 'ready' as const, descriptors: Object.freeze([Object.freeze(entry)]) });
    const publication = createConnectedAccountDescriptorProjectionPublication();
    const first = publication.publish([source]);
    const mode = entry.authentication.modes[0]!;
    if (mode.kind !== 'manual') throw new Error('expected manual authentication');
    mode.fields[0]!.title = 'Changed token';
    const second = publication.publish([source]);
    expect(second).not.toBe(first);
    expect(second.descriptors?.[0]?.authentication.modes[0]).toMatchObject({ fields: [{ title: 'Changed token' }] });
    expect(first.descriptors?.[0]?.authentication.modes[0]).toMatchObject({ fields: [{ title: 'Token' }] });
  });

  it('shares unaffected declaration, diagnostic and conflict rows when another source revision changes', () => {
    const stable = readConnectedAccountDescriptorProjection(projection({ account: descriptor({ diagnostics: ['machine_refused'] }) }));
    const divergent = readConnectedAccountDescriptorProjection(projection({ account: descriptor({ title: 'Divergent account' }) }));
    const other = readConnectedAccountDescriptorProjection(projection({ other: descriptor({ id: 'other', serviceId: 'other' }) }));
    const publication = createConnectedAccountDescriptorProjectionPublication();
    const first = publication.publish([stable, divergent, other]);
    const changed = readConnectedAccountDescriptorProjection(projection({ other: descriptor({ id: 'other', serviceId: 'other', title: 'Updated other' }) }));
    const second = publication.publish([stable, divergent, changed]);
    expect(second.kind).toBe('conflict');
    expect(second.conflicts?.[0]).toBe(first.conflicts?.[0]);
    for (const row of first.descriptors?.filter(entry => entry.id === 'account') ?? []) {
      const unchanged = second.descriptors?.find(entry => entry.id === row.id && entry.title === row.title);
      expect(unchanged).toBe(row);
      expect(unchanged?.diagnostics).toBe(row.diagnostics);
    }
    expect(second.descriptors?.find(entry => entry.id === 'other')?.title).toBe('Updated other');
  });

  it('publishes execution withdrawal and recovery with unchanged descriptor revisions', () => {
    const source = readConnectedAccountDescriptorProjection(projection({ account: descriptor() }));
    if (source.kind !== 'ready') throw new Error('expected ready descriptors');
    const publication = createConnectedAccountDescriptorProjectionPublication();
    const available = publication.publish([source]);
    const withdrawn = publication.publish([{ ...source, executionUnavailablePluginIds: ['acme.accounts'] }]);
    expect(withdrawn.descriptors?.[0]).toMatchObject({
      title: 'Acme account', availability: { state: 'blocked', reason: 'execution_origin_unavailable' },
    });
    const state = advanceConnectedAccountDescriptorProjectionState(
      createConnectedAccountDescriptorProjectionLoadingState('server-a'), withdrawn,
    );
    expect(projectConnectedServiceRegistryEntries(state)[0]?.executable).toBe(false);
    const stringify = vi.spyOn(JSON, 'stringify');
    let restored: ReturnType<typeof publication.publish>;
    try {
      restored = publication.publish([source]);
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
    expect(restored).toEqual(available);
    expect(projectConnectedServiceRegistryEntries(advanceConnectedAccountDescriptorProjectionState(state, restored))[0]?.executable).toBe(true);
  });

  it('retains static descriptors without execution admission and prefers an admitted declaration when it returns', () => {
    const projected = descriptor();
    const unavailable = { kind: 'ready' as const, descriptors: [projected], executionUnavailablePluginIds: ['acme.accounts'] };
    const initial = createConnectedAccountDescriptorProjectionLoadingState('server-a');
    const state = advanceConnectedAccountDescriptorProjectionState(initial, mergeConnectedAccountDescriptorProjections([unavailable]));
    expect(projectConnectedServiceRegistryEntries(state)[0]).toMatchObject({
      projectedTitle: 'Acme account', executable: false, supportsToken: false, projectionStatus: 'ready',
    });
    const admitted = descriptor({ title: 'Current account' });
    const restored = advanceConnectedAccountDescriptorProjectionState(state, mergeConnectedAccountDescriptorProjections([
      unavailable, { kind: 'ready', descriptors: [admitted] },
    ]));
    expect(projectConnectedServiceRegistryEntries(restored)[0]).toMatchObject({
      projectedTitle: 'Current account', executable: true, projectionStatus: 'ready',
    });
    const withdrawn = advanceConnectedAccountDescriptorProjectionState(restored, mergeConnectedAccountDescriptorProjections([unavailable]));
    expect(projectConnectedServiceRegistryEntries(withdrawn)[0]).toMatchObject({ projectedTitle: 'Acme account', executable: false });
  });

  it('settles answering descriptors while another machine is still resolving', () => {
    const projected = descriptor();
    const merged = mergeConnectedAccountDescriptorProjections([
      { kind: 'ready', descriptors: [projected] },
      { kind: 'loading' },
    ]);
    const state = advanceConnectedAccountDescriptorProjectionState(
      createConnectedAccountDescriptorProjectionLoadingState('server-a'), merged,
    );
    expect(state).toMatchObject({ status: 'stale', descriptors: [projected], errorReason: 'partial_machine_failure' });
    expect(projectConnectedServiceRegistryEntries(state)[0]).toMatchObject({
      executable: true, supportsToken: true, projectionStatus: 'ready',
    });
    expect(getConnectedAccountAuthentication({ pluginId: 'acme.accounts', localId: 'account' }, {
      entries: projectConnectedServiceRegistryEntries(state),
    })).toEqual(projected.authentication);
  });

  it('settles a retrying transport read beside an answering machine as degraded coverage', () => {
    const projected = descriptor();
    const merged = mergeConnectedAccountDescriptorProjections([
      { kind: 'ready', descriptors: [projected] },
      { kind: 'error', reason: 'transport' },
    ]);
    expect(advanceConnectedAccountDescriptorProjectionState(
      createConnectedAccountDescriptorProjectionLoadingState('server-a'), merged,
    )).toMatchObject({ status: 'stale', descriptors: [projected], errorReason: 'partial_machine_failure' });
  });

  it('refreshes answered identities and retains unanswered services until a complete read', () => {
    const old = descriptor({ title: 'Old details' });
    const unanswered = descriptor({ id: 'other', serviceId: 'other' });
    const fresh = descriptor({ title: 'Current details' });
    const previous = advanceConnectedAccountDescriptorProjectionState(
      createConnectedAccountDescriptorProjectionLoadingState('server-a'),
      { kind: 'ready', descriptors: [old, unanswered], conflicts: [] },
    );
    const partial = advanceConnectedAccountDescriptorProjectionState(previous, mergeConnectedAccountDescriptorProjections([
      { kind: 'ready', descriptors: [fresh] }, { kind: 'loading' },
    ]));
    expect(partial.status).toBe('stale');
    expect(partial.descriptors).toEqual(expect.arrayContaining([fresh, unanswered]));
    expect(partial.descriptors).not.toContainEqual(old);
    expect(projectConnectedServiceRegistryEntries(partial).find(entry => entry.service?.localId === 'account'))
      .toMatchObject({ executable: true, projectedDescriptor: fresh });
    expect(projectConnectedServiceRegistryEntries(partial).find(entry => entry.service?.localId === 'other'))
      .toMatchObject({ executable: false, projectedDescriptor: unanswered });
    expect(advanceConnectedAccountDescriptorProjectionState(partial, {
      kind: 'ready', descriptors: [fresh], conflicts: [],
    }).descriptors).toEqual([fresh]);
  });

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

  it('keeps equal Account declarations usable across different machine runtime occurrences', () => {
    const declaration = descriptor();
    const left = { ...declaration, occurrenceId: 'acme.accounts:41' };
    const right = { ...declaration, occurrenceId: 'acme.accounts:52' };
    const resolution = mergeConnectedAccountDescriptorProjections([
      { kind: 'ready', descriptors: [left] },
      { kind: 'ready', descriptors: [right] },
    ]);
    const state = advanceConnectedAccountDescriptorProjectionState(
      createConnectedAccountDescriptorProjectionLoadingState('server-a'), resolution,
    );
    const entries = projectConnectedServiceRegistryEntries(state);
    expect(state).toMatchObject({ status: 'ready', descriptors: [declaration], conflicts: [] });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ executable: true, supportsToken: true });
    expect(entries[0]?.projectedDescriptor).not.toHaveProperty('occurrenceId');
    // The raw machine publication retains its exact admission occurrence.
    expect(left.occurrenceId).toBe('acme.accounts:41');
    expect(right.occurrenceId).toBe('acme.accounts:52');
    expect(advanceConnectedAccountDescriptorProjectionState(state,
      mergeConnectedAccountDescriptorProjections([
        { kind: 'ready', descriptors: [{ ...declaration, occurrenceId: 'acme.accounts:53' }] },
      ]))).toBe(state);
  });

  it('still refuses divergent authentication declarations across machine occurrences', () => {
    const left = descriptor({ occurrenceId: 'acme.accounts:41' });
    const right = descriptor({ occurrenceId: 'acme.accounts:52', authentication: {
      defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode',
      callbackUrl: 'http://127.0.0.1:4000/auth/callback',
        pkce: 'required', outcomeReconciliation: 'none' }],
    } });
    const resolution = mergeConnectedAccountDescriptorProjections([
      { kind: 'ready', descriptors: [left] }, { kind: 'ready', descriptors: [right] },
    ]);
    const entries = projectConnectedServiceRegistryEntries(advanceConnectedAccountDescriptorProjectionState(
      createConnectedAccountDescriptorProjectionLoadingState('server-a'), resolution,
    ));
    expect(resolution.kind).toBe('conflict');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ executable: false, supportsToken: false, supportsOauth: false });
    expect(entries[0]?.projectedDescriptorCandidates).toHaveLength(2);
  });

  it('keeps Account purpose targets usable when equal declarations carry different machine diagnostics', () => {
    const healthy = descriptor({ occurrenceId: 'acme.accounts:41' });
    const refused = descriptor({ occurrenceId: 'acme.accounts:52',
      diagnostics: ['plugin_external_session_source_refused', 'plugin_activation_failed'],
    });
    const service = { pluginId: 'acme.accounts', localId: 'account' };
    for (const descriptors of [[healthy, refused], [refused, healthy]]) {
      const resolution = mergeConnectedAccountDescriptorProjections(descriptors.map(value => (
        readConnectedAccountDescriptorProjection(projection({ account: value }))
      )));
      const state = advanceConnectedAccountDescriptorProjectionState(
        createConnectedAccountDescriptorProjectionLoadingState('server-a'), resolution,
      );
      const entries = projectConnectedServiceRegistryEntries(state);
      const authentication = getConnectedAccountAuthentication(service, {
        entries,
      });
      expect(state.status).toBe('ready');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ executable: true, projectionStatus: 'ready',
        diagnostics: ['plugin_activation_failed', 'plugin_external_session_source_refused'],
      });
      expect(entries[0]?.projectedDescriptorCandidates).toHaveLength(1);
      expect(resolveConnectedAccountPurposeTargetEligibility({
        target: { kind: 'account', account: { service, accountId: 'work' } },
        declaredServices: [service],
        accounts: [{ ref: { service, accountId: 'work' }, status: 'connected',
          authenticationModeId: 'manual', revisionSemantics: 'revisioned',
          credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
          configurationReady: true, configurationRevision: null, scopes: [],
        }],
        groups: [],
        resolveAuthentication: () => authentication,
      })).toBe('usable');
    }
    expect(healthy.diagnostics).toEqual([]);
    expect(refused.diagnostics).toEqual(['plugin_external_session_source_refused', 'plugin_activation_failed']);
  });

  it('keeps blocked declaration availability authoritative when diagnostics differ', () => {
    const blocked = descriptor({ availability: { state: 'blocked', reason: 'plugin_declaration_unusable' },
      diagnostics: ['plugin_untrusted'],
    });
    for (const descriptors of [[blocked], [blocked, descriptor()]]) {
      const state = advanceConnectedAccountDescriptorProjectionState(
        createConnectedAccountDescriptorProjectionLoadingState('server-a'),
        mergeConnectedAccountDescriptorProjections(descriptors.map(value => ({ kind: 'ready', descriptors: [value] }))),
      );
      expect(projectConnectedServiceRegistryEntries(state)[0]).toMatchObject({ executable: false, supportsToken: false });
    }
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

  it('keeps same-local-id descriptors from different plugins independently qualified', () => {
    const left = descriptor({ id: 'shared-service', pluginId: 'acme.left' });
    const right = descriptor({ id: 'shared-service', pluginId: 'acme.right' });
    const merged = mergeConnectedAccountDescriptorProjections([
      { kind: 'ready', descriptors: [left] },
      { kind: 'ready', descriptors: [right] },
    ]);

    expect(merged.kind).toBe('ready');
    if (merged.kind === 'error') throw new Error('expected a ready projection');
    expect(merged.descriptors).toEqual(expect.arrayContaining([left, right]));
    expect(merged.conflicts).toEqual([]);
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

  it('keeps the answering machines descriptors when another machine fails before any good load', () => {
    const projected = descriptor();
    const merged = mergeConnectedAccountDescriptorProjections([
      { kind: 'ready', descriptors: [projected] },
      { kind: 'error', reason: 'unsupported' },
    ]);

    expect(merged).toMatchObject({ kind: 'error', reason: 'partial_machine_failure' });
    expect(merged.kind === 'error' ? merged.descriptors : null).toEqual([projected]);

    const state = advanceConnectedAccountDescriptorProjectionState(
      createConnectedAccountDescriptorProjectionLoadingState('server-a'),
      merged,
    );
    expect(state).toMatchObject({
      status: 'stale',
      errorReason: 'partial_machine_failure',
      descriptors: [projected],
    });
    expect(projectConnectedServiceRegistryEntries(state)[0]).toMatchObject({
      executable: true, supportsToken: true, projectionStatus: 'ready',
    });
  });

  it('refreshes current answers on partial failure and refuses divergence or an unanswered retained service', () => {
    const old = descriptor({ title: 'Old details' });
    const unanswered = descriptor({ id: 'other', serviceId: 'other' });
    const fresh = descriptor({ title: 'Current details' });
    const loading = createConnectedAccountDescriptorProjectionLoadingState('server-a');
    const ready = advanceConnectedAccountDescriptorProjectionState(loading, {
      kind: 'ready', descriptors: [old, unanswered], conflicts: [],
    });
    const partial = advanceConnectedAccountDescriptorProjectionState(ready, mergeConnectedAccountDescriptorProjections([
      { kind: 'ready', descriptors: [fresh] }, { kind: 'error', reason: 'unsupported' },
    ]));
    const entries = projectConnectedServiceRegistryEntries(partial);
    expect(partial).toMatchObject({ status: 'stale', errorReason: 'partial_machine_failure' });
    expect(entries.find(entry => entry.service?.localId === 'account'))
      .toMatchObject({ executable: true, projectedDescriptor: fresh });
    expect(entries.find(entry => entry.service?.localId === 'other'))
      .toMatchObject({ executable: false, projectedDescriptor: unanswered });

    const divergent = advanceConnectedAccountDescriptorProjectionState(partial, mergeConnectedAccountDescriptorProjections([
      { kind: 'ready', descriptors: [fresh] }, { kind: 'ready', descriptors: [old] },
      { kind: 'error', reason: 'unsupported' },
    ]));
    expect(divergent.status).toBe('stale');
    expect(projectConnectedServiceRegistryEntries(divergent).find(entry => entry.service?.localId === 'account'))
      .toMatchObject({ executable: false, supportsToken: false,
        projectedDescriptorCandidates: expect.arrayContaining([fresh, old]),
        projectionConflicts: [expect.objectContaining({ kind: 'identity_divergence' })] });

    const recovered = advanceConnectedAccountDescriptorProjectionState(divergent, mergeConnectedAccountDescriptorProjections([
      { kind: 'ready', descriptors: [fresh] }, { kind: 'error', reason: 'unsupported' },
    ]));
    expect(projectConnectedServiceRegistryEntries(recovered).find(entry => entry.service?.localId === 'account'))
      .toMatchObject({ executable: true, projectedDescriptor: fresh, projectionConflicts: [] });
    const noSupplier = advanceConnectedAccountDescriptorProjectionState(recovered, mergeConnectedAccountDescriptorProjections([
      { kind: 'error', reason: 'unsupported' },
    ]));
    expect(noSupplier.descriptors).toEqual(recovered.descriptors);
    expect(projectConnectedServiceRegistryEntries(noSupplier).every(entry => entry.executable === false)).toBe(true);
  });

  it('never retracts last-known-good descriptors on a degraded partial read', () => {
    const projected = descriptor();
    const ready = advanceConnectedAccountDescriptorProjectionState(
      createConnectedAccountDescriptorProjectionLoadingState('server-a'),
      { kind: 'ready', descriptors: [projected], conflicts: [] },
    );
    const degraded = advanceConnectedAccountDescriptorProjectionState(ready, {
      kind: 'error', reason: 'partial_machine_failure', descriptors: [], conflicts: [],
    });

    expect(degraded).toMatchObject({ status: 'stale', descriptors: [projected] });
    expect(degraded.descriptors).toBe(ready.descriptors);
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
      answeredDescriptorIdentities: [],
      conflicts: [],
      errorReason: null,
    });
  });
});
