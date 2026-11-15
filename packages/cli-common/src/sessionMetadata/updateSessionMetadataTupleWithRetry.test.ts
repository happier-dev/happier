import {
  createSessionOwnerMetadataV1,
  projectSessionSharedMetadataV1,
  type SessionOwnerMetadataEnvelopeV1,
  type SessionOwnerMetadataV1,
  type SessionMetadataTuplePatchV1,
  type SessionSharedMetadataV1,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { ExternalSessionOperationProgressV1Schema, projectExternalSessionOperationSharedPresentationV1 } from '@happier-dev/protocol/sessions/external/operationV1';
import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { projectSessionDisplayV1, SessionDisplayProjectionV1Schema,
  sealSessionSharedDisplayEnvelopeV1Sync, sealSessionOwnerDisplayEnvelopeV1,
  openSessionOwnerDisplayEnvelopeV1, openSessionSharedDisplayEnvelopeV1Sync,
  sealSessionOwnerMetadataEnvelopeV1,
  createAccountScopedCryptoMaterialSnapshotV1,
  type SessionSharedDisplayV1, type SessionOwnerDisplayV1,
} from '@happier-dev/protocol';

import {
  prepareSessionMetadataTuplePatchV1,
  updateSessionMetadataTupleWithRetry,
  type SessionMetadataLegacyOwnerTupleMutationSnapshotV1,
  type SessionMetadataOwnerTupleMutationSnapshotV1,
  type SessionMetadataTupleMutationSnapshotV1,
} from './updateSessionMetadataTupleWithRetry.js';

type Metadata = Readonly<Record<string, unknown>>;
type AgentState = Readonly<Record<string, unknown>>;
function ownerSnapshot(params: Readonly<{
  metadata?: Metadata;
  agentState?: AgentState | null;
  metadataVersion?: number;
  sharedMetadataCiphertext?: string;
  ownerMetadataEnvelope?: SessionOwnerMetadataEnvelopeV1;
  agentStateVersion?: number;
  agentStateCiphertext?: string | null;
}> = {}): SessionMetadataOwnerTupleMutationSnapshotV1<Metadata, AgentState> {
  const metadata = params.metadata ?? {
    path: '/workspace',
    host: 'local',
    summary: { text: 'before', updatedAt: 1 },
  };
  const created = createSessionOwnerMetadataV1({ metadata });
  if (!created.ok) throw new Error('invalid owner fixture');
  return {
    mode: 'owner',
    metadataLayoutVersion: 1,
    metadataVersion: params.metadataVersion ?? 2,
    sharedMetadataCiphertext:
      params.sharedMetadataCiphertext ?? 'shared-before',
    ownerMetadataEnvelope:
      params.ownerMetadataEnvelope ?? {
        t: 'plain',
        v: created.ownerMetadata,
      },
    agentStateVersion: params.agentStateVersion ?? 4,
    agentStateCiphertext:
      params.agentStateCiphertext ?? null,
    value: {
      metadata,
      sharedMetadata: projectSessionSharedMetadataV1({
        metadata,
        agentState: params.agentState ?? null,
      }),
      ownerMetadata: created.ownerMetadata,
      agentState: params.agentState ?? null,
    },
  };
}

function cryptoAdapter() {
  return {
    encryptPayload: vi.fn(async (payload: unknown) =>
      `encrypted:${JSON.stringify(payload)}`),
    encodeOwnerMetadata: vi.fn(async (owner: SessionOwnerMetadataV1) => ({
      t: 'plain' as const,
      v: owner,
    })),
  };
}

const displayAccountMaterial = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
const displayOwnerCurrentness = {
  expectedAccountEncryptionMode: 'e2ee' as const,
  expectedAccountContentPublicKeyFingerprint: createAccountScopedCryptoMaterialSnapshotV1({
    accountEncryptionMode: 'e2ee', material: displayAccountMaterial,
  }).contentPublicKeyFingerprint,
};
function displayCryptoAdapter() {
  return {
    encryptPayload: async (payload: unknown) => JSON.stringify(payload),
    encodeOwnerMetadata: (ownerMetadata: SessionOwnerMetadataV1) => sealSessionOwnerMetadataEnvelopeV1({
      material: displayAccountMaterial, ownerMetadata, randomBytes,
    }),
    encodeSharedDisplay: (display: SessionSharedDisplayV1) => {
      const sealed = sealSessionSharedDisplayEnvelopeV1Sync({ sessionMode: 'plain', display });
      if (!sealed.ok) throw new Error(sealed.reason);
      return sealed.envelope;
    },
    encodeOwnerDisplay: (display: SessionOwnerDisplayV1) => {
      const sealed = sealSessionOwnerDisplayEnvelopeV1({ accountMode: 'e2ee', display,
        material: displayAccountMaterial, randomBytes });
      if (!sealed.ok) throw new Error(sealed.reason);
      return sealed.envelope;
    },
  };
}

function linkedDisplaySnapshot(params: Parameters<typeof ownerSnapshot>[0] = {}) {
  const current = ownerSnapshot(params);
  if (current.mode !== 'owner') throw new Error('Expected owner fixture');
  const display = projectSessionDisplayV1(current.value);
  if (!display.owner) throw new Error('Expected owner display');
  const crypto = displayCryptoAdapter();
  return { ...current,
    sharedMetadataCiphertext: JSON.stringify(current.value.sharedMetadata),
    ownerMetadataEnvelope: crypto.encodeOwnerMetadata(current.value.ownerMetadata),
    displayProjectionV1: SessionDisplayProjectionV1Schema.parse({
    v: 1, metadataLayoutVersion: 1, sourceMetadataVersion: current.metadataVersion,
    shared: crypto.encodeSharedDisplay(display.shared), owner: crypto.encodeOwnerDisplay(display.owner),
  }) };
}

function legacyOwnerSnapshot(params: Readonly<{
  metadata: Metadata;
  agentState?: AgentState | null;
  metadataVersion: number;
  metadataCiphertext: string;
  agentStateVersion: number;
  agentStateCiphertext?: string | null;
}>): SessionMetadataLegacyOwnerTupleMutationSnapshotV1<
  Metadata,
  AgentState
> {
  return {
    mode: 'legacy_owner',
    metadataLayoutVersion: 0,
    metadataVersion: params.metadataVersion,
    metadataCiphertext: params.metadataCiphertext,
    ownerMetadata: null,
    agentStateVersion: params.agentStateVersion,
    agentStateCiphertext: params.agentStateCiphertext ?? null,
    value: {
      metadata: params.metadata,
      agentState: params.agentState ?? null,
    },
  };
}

describe('updateSessionMetadataTupleWithRetry', () => {
  it('publishes timing from the winning state attempt without disclosing request content', async () => {
    const initialSnapshot = ownerSnapshot({ agentState: { requests: { privateId: { tool: 'Private tool',
      arguments: { secret: 'Private arguments' }, createdAt: 10 } } } });
    const refreshed = ownerSnapshot({ metadataVersion: 3, agentStateVersion: 5,
      agentState: { requests: { privateId: { tool: 'Private tool', arguments: {}, createdAt: 20 } } } });
    const patches: SessionMetadataTuplePatchV1[] = [];
    await updateSessionMetadataTupleWithRetry({ initialSnapshot, crypto: cryptoAdapter(),
      mutation: { kind: 'agentState', update: state => ({ ...state, requests: {}, completedRequests: {
        privateId: { ...(state.requests as Record<string, object>).privateId, completedAt: 80, status: 'approved' },
      } }) },
      commit: async patch => { patches.push(patch); return patches.length === 1 ? { result: 'conflict' as const }
        : { result: 'success' as const, metadataVersion: 4, agentStateVersion: 6 }; },
      refreshAfterConflict: async () => refreshed,
    });
    expect(patches.map(patch => Reflect.get(patch, 'usageTimingV1'))).toEqual([
      { v: 1, metadata: { v: 1, minMs: null, maxMs: null }, agentState: { v: 1, minMs: 10, maxMs: 80 } },
      { v: 1, metadata: { v: 1, minMs: null, maxMs: null }, agentState: { v: 1, minMs: 20, maxMs: 80 } },
    ]);
    expect(JSON.stringify(patches.map(patch => Reflect.get(patch, 'usageTimingV1')))).not.toContain('privateId');
  });

  it('leaves owner timing unknown for a shared-only editor', async () => {
    const owner = ownerSnapshot();
    const patch = await prepareSessionMetadataTuplePatchV1({ current: {
      mode: 'shared_editor', metadataLayoutVersion: 1, metadataVersion: 2,
      sharedMetadataCiphertext: 'shared', value: { metadata: owner.value.sharedMetadata,
        sharedMetadata: owner.value.sharedMetadata, ownerMetadata: null, agentState: null },
    }, mutation: { kind: 'metadata', update: metadata => ({ ...metadata, summary: { text: 'changed', updatedAt: 4 } }) },
      crypto: cryptoAdapter(),
    });
    expect(Reflect.get(patch ?? {}, 'usageTimingV1')).toEqual({ v: 1, metadata: null, agentState: null });
  });

  it('carries timing on the legacy mutation callback from the exact prepared value', async () => {
    const initialSnapshot = legacyOwnerSnapshot({ metadata: { path: '/repo', host: 'host' },
      metadataVersion: 1, metadataCiphertext: 'legacy', agentStateVersion: 1,
      agentState: { requests: { pending: { tool: 'Private tool', turnId: 'turn-private', arguments: {}, createdAt: 10 } } } });
    let timing: unknown;
    await updateSessionMetadataTupleWithRetry({ initialSnapshot, crypto: cryptoAdapter(),
      mutation: { kind: 'metadata', update: metadata => ({ ...metadata, name: 'changed' }) },
      commit: async () => { throw new Error('Legacy callback owns this transport'); },
      mutateLegacy: async request => { timing = Reflect.get(request, 'usageTimingV1'); return initialSnapshot; },
    });
    expect(timing).toEqual({ v: 1, metadata: { v: 1, minMs: null, maxMs: null }, agentState: { v: 1, minMs: 10, maxMs: null } });
  });

  it.each(['shared', 'owner'] as const)('withdraws display after a %s seal failure on an ordinary mutation, but refuses explicit repair', async leaf => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const crypto = displayCryptoAdapter();
    const failure = new Error('display sealing unavailable');
    if (leaf === 'shared') crypto.encodeSharedDisplay = () => { throw failure; };
    else crypto.encodeOwnerDisplay = () => { throw failure; };
    const initialSnapshot = ownerSnapshot();
    const patches: SessionMetadataTuplePatchV1[] = [];
    try {
      const result = await updateSessionMetadataTupleWithRetry({ initialSnapshot,
        mutation: { kind: 'metadata', update: metadata => ({ ...metadata, name: 'renamed', summary: { text: 'changed', updatedAt: 2 } }) },
        crypto, commit: async patch => { patches.push(patch); return { result: 'success', metadataVersion: 3, agentStateVersion: 4 }; },
      });
      expect(result.value.metadata).toMatchObject({ name: 'renamed', summary: { text: 'changed' } });
      expect(patches).toMatchObject([{ mode: 'owner', displayProjectionV1: null }]);
      expect(warning).toHaveBeenCalled();
      const commit = vi.fn();
      await expect(updateSessionMetadataTupleWithRetry({ initialSnapshot,
        mutation: { kind: 'ensureDisplayProjection' }, crypto,
        ownerMigrationCurrentness: displayOwnerCurrentness, commit,
      })).rejects.toBe(failure);
      expect(commit).not.toHaveBeenCalled();
    } finally { warning.mockRestore(); }
  });

  it('ensures a missing display without changing any full tuple value or encrypted source bytes', async () => {
    const retainedState = { privateLifecycle: 'retained owner state' };
    const source = linkedDisplaySnapshot({ agentState: retainedState, agentStateCiphertext: JSON.stringify(retainedState) });
    const initialSnapshot = { ...source, displayProjectionV1: null,
      displayProjectionV1Availability: { shared: false, owner: false } };
    const patches: SessionMetadataTuplePatchV1[] = [];
    const result = await updateSessionMetadataTupleWithRetry({ initialSnapshot,
      mutation: { kind: 'ensureDisplayProjection' }, crypto: displayCryptoAdapter(),
      ownerMigrationCurrentness: displayOwnerCurrentness,
      commit: async patch => { patches.push(patch); return { result: 'success', metadataVersion: 3, agentStateVersion: 4 }; },
    });
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ mode: 'owner',
      sharedMetadata: { ciphertext: source.sharedMetadataCiphertext, expectedVersion: 2 },
      ownerMetadata: source.ownerMetadataEnvelope,
      agentState: { ciphertext: source.agentStateCiphertext, expectedVersion: 4 },
    });
    const display = SessionDisplayProjectionV1Schema.parse(Reflect.get(patches[0] ?? {}, 'displayProjectionV1'));
    expect(display.sourceMetadataVersion).toBe(3);
    const semantic = projectSessionDisplayV1(source.value);
    expect(openSessionSharedDisplayEnvelopeV1Sync({ sessionMode: 'plain', envelope: display.shared }))
      .toEqual({ ok: true, display: semantic.shared });
    expect(openSessionOwnerDisplayEnvelopeV1({ accountMode: 'e2ee', envelope: display.owner, material: displayAccountMaterial }))
      .toEqual({ ok: true, display: semantic.owner });
    expect(result.value).toEqual(source.value);
    expect(result).toMatchObject({ metadataVersion: 3, agentStateVersion: 4,
      displayProjectionV1Availability: { shared: true, owner: true } });
  });

  it('does not rewrite an already available display on repeated ensure reads', async () => {
    const initialSnapshot = { ...linkedDisplaySnapshot(), displayProjectionV1Availability: { shared: true, owner: true } };
    const commit = vi.fn(async () => ({ result: 'success' as const, metadataVersion: 3, agentStateVersion: 4 }));
    const result = await updateSessionMetadataTupleWithRetry({ initialSnapshot,
      mutation: { kind: 'ensureDisplayProjection' }, crypto: displayCryptoAdapter(),
      ownerMigrationCurrentness: displayOwnerCurrentness, commit,
    });
    expect(result).toBe(initialSnapshot);
    expect(commit).not.toHaveBeenCalled();
  });

  it.each(['shared', 'owner'] as const)('repairs only the unproven %s display leaf', async leaf => {
    const source = linkedDisplaySnapshot();
    const initialSnapshot = { ...source, displayProjectionV1Availability: { shared: leaf !== 'shared', owner: leaf !== 'owner' } };
    let committed: SessionMetadataTuplePatchV1 | undefined;
    await updateSessionMetadataTupleWithRetry({ initialSnapshot,
      mutation: { kind: 'ensureDisplayProjection' }, crypto: displayCryptoAdapter(),
      ownerMigrationCurrentness: displayOwnerCurrentness,
      commit: async patch => { committed = patch; return { result: 'success', metadataVersion: 3, agentStateVersion: 4 }; },
    });
    const projection = SessionDisplayProjectionV1Schema.parse(Reflect.get(committed ?? {}, 'displayProjectionV1'));
    if (leaf === 'shared') expect(projection.owner).toEqual(source.displayProjectionV1.owner);
    else {
      expect(projection.shared).toEqual(source.displayProjectionV1.shared);
      expect(projection.owner).not.toEqual(source.displayProjectionV1.owner);
    }
    expect(openSessionOwnerDisplayEnvelopeV1({ accountMode: 'e2ee', envelope: projection.owner, material: displayAccountMaterial }))
      .toEqual({ ok: true, display: projectSessionDisplayV1(source.value).owner });
  });

  it('recomputes ensure from the winning full tuple after a real CAS conflict', async () => {
    const initialSnapshot = { ...linkedDisplaySnapshot(), displayProjectionV1: null,
      displayProjectionV1Availability: { shared: false, owner: false } };
    const winner = { ...linkedDisplaySnapshot({ metadataVersion: 8, metadata: {
      path: '/concurrent/workspace', host: 'winner-host', name: 'Winning owner name', summary: { text: 'Winning summary', updatedAt: 8 },
    } }), displayProjectionV1: null, displayProjectionV1Availability: { shared: false, owner: false } };
    const patches: SessionMetadataTuplePatchV1[] = [];
    const result = await updateSessionMetadataTupleWithRetry({ initialSnapshot,
      mutation: { kind: 'ensureDisplayProjection' }, crypto: displayCryptoAdapter(),
      ownerMigrationCurrentness: displayOwnerCurrentness,
      commit: async patch => {
        patches.push(patch);
        return patches.length === 1 ? { result: 'conflict', currentSnapshot: winner }
          : { result: 'success', metadataVersion: 9, agentStateVersion: 4 };
      },
    });
    expect(patches).toHaveLength(2);
    expect(patches[1]).toMatchObject({ mode: 'owner',
      sharedMetadata: { ciphertext: winner.sharedMetadataCiphertext, expectedVersion: 8 },
      ownerMetadata: winner.ownerMetadataEnvelope,
    });
    const projection = SessionDisplayProjectionV1Schema.parse(Reflect.get(patches[1] ?? {}, 'displayProjectionV1'));
    expect(projection.sourceMetadataVersion).toBe(9);
    expect(openSessionSharedDisplayEnvelopeV1Sync({ sessionMode: 'plain', envelope: projection.shared }))
      .toEqual({ ok: true, display: projectSessionDisplayV1(winner.value).shared });
    expect(openSessionOwnerDisplayEnvelopeV1({ accountMode: 'e2ee', envelope: projection.owner, material: displayAccountMaterial }))
      .toEqual({ ok: true, display: projectSessionDisplayV1(winner.value).owner });
    expect(result.value).toEqual(winner.value);
  });

  it('does not overwrite a conflict winner whose captured read already proves both leaves available', async () => {
    const initialSnapshot = { ...linkedDisplaySnapshot(), displayProjectionV1: null,
      displayProjectionV1Availability: { shared: false, owner: false } };
    const winner = { ...linkedDisplaySnapshot({ metadataVersion: 3 }), displayProjectionV1Availability: { shared: true, owner: true } };
    const commit = vi.fn(async () => ({ result: 'conflict' as const, currentSnapshot: winner }));
    const result = await updateSessionMetadataTupleWithRetry({ initialSnapshot,
      mutation: { kind: 'ensureDisplayProjection' }, crypto: displayCryptoAdapter(),
      ownerMigrationCurrentness: displayOwnerCurrentness, commit,
    });
    expect(result).toBe(winner);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('does not turn matching encrypted bytes into availability proof after an ambiguous ensure commit', async () => {
    const initialSnapshot = { ...linkedDisplaySnapshot(), displayProjectionV1: null,
      displayProjectionV1Availability: { shared: false, owner: false } };
    let submitted: SessionMetadataTuplePatchV1 | undefined;
    const lostResponse = new Error('Transport lost the commit response');
    await expect(updateSessionMetadataTupleWithRetry({ initialSnapshot,
      mutation: { kind: 'ensureDisplayProjection' }, crypto: displayCryptoAdapter(),
      ownerMigrationCurrentness: displayOwnerCurrentness,
      commit: async patch => { submitted = patch; throw lostResponse; },
      isAmbiguousCommitError: error => error === lostResponse,
      refreshAfterConflict: async () => {
        if (!submitted || submitted.mode !== 'owner') throw new Error('Expected submitted owner tuple');
        return { ...initialSnapshot, metadataVersion: 3, displayProjectionV1: submitted.displayProjectionV1,
          // A refetch without the same actual leaf-open/material proof cannot
          // certify maintenance just by matching the submitted ciphertext.
          displayProjectionV1Availability: { shared: false, owner: false } };
      },
    })).rejects.toMatchObject({ code: 'metadata_tuple_ambiguous', retryable: false });
  });

  it.each(['currentness', 'owner_encoder'] as const)('refuses ensure without proven %s rather than writing an incomplete projection', async unavailable => {
    const initialSnapshot = { ...linkedDisplaySnapshot(), displayProjectionV1: null };
    const commit = vi.fn(async () => ({ result: 'success' as const, metadataVersion: 3, agentStateVersion: 4 }));
    const { encodeOwnerDisplay: _ownerEncoder, ...withoutOwnerEncoder } = displayCryptoAdapter();
    await expect(updateSessionMetadataTupleWithRetry({ initialSnapshot,
      mutation: { kind: 'ensureDisplayProjection' }, crypto: unavailable === 'owner_encoder' ? withoutOwnerEncoder : displayCryptoAdapter(),
      ...(unavailable === 'currentness' ? {} : { ownerMigrationCurrentness: displayOwnerCurrentness }), commit,
    })).rejects.toMatchObject({ code: 'metadata_privacy_upgrade_required', retryable: false });
    expect(commit).not.toHaveBeenCalled();
  });

  it('invalidates a current display when a metadata producer cannot encode its changed shared leaf', async () => {
    const initialSnapshot = linkedDisplaySnapshot();
    let committed: SessionMetadataTuplePatchV1 | undefined;
    await updateSessionMetadataTupleWithRetry({
      initialSnapshot,
      mutation: { kind: 'metadata', update: metadata => ({ ...metadata, summary: { text: 'after', updatedAt: 2 } }) },
      crypto: { encryptPayload: displayCryptoAdapter().encryptPayload, encodeOwnerMetadata: displayCryptoAdapter().encodeOwnerMetadata },
      commit: async patch => {
        committed = patch;
        return { result: 'success', metadataVersion: 3, agentStateVersion: 4 };
      },
    });
    expect(committed).toHaveProperty('displayProjectionV1', null);
  });

  it.each(['summary', 'owner', 'unrelated', 'agent_state'] as const)('commits the canonical %s display and preserves unchanged encrypted leaves', async change => {
    const initialSnapshot = linkedDisplaySnapshot();
    let committed: SessionMetadataTuplePatchV1 | undefined;
    const updated = await updateSessionMetadataTupleWithRetry({ initialSnapshot,
      mutation: change === 'agent_state' ? { kind: 'agentState', update: state => ({ ...state, privateHeartbeat: 1 }) }
        : { kind: 'metadata', update: metadata => ({ ...metadata,
        ...(change === 'summary' ? { summary: { text: 'after', updatedAt: 2 } }
          : change === 'owner' ? { name: 'Private renamed Session' } : { version: '0.3.1-display-test' }),
      }) },
      crypto: displayCryptoAdapter(), commit: async patch => {
        committed = patch;
        return { result: 'success', metadataVersion: 3, agentStateVersion: change === 'agent_state' ? 5 : 4 };
      },
    });
    const projection = SessionDisplayProjectionV1Schema.parse(Reflect.get(committed ?? {}, 'displayProjectionV1'));
    expect(projection).toMatchObject({ sourceMetadataVersion: 3, metadataLayoutVersion: 1 });
    if (updated.mode !== 'owner') throw new Error('Expected committed owner');
    const semantic = projectSessionDisplayV1(updated.value);
    expect(openSessionSharedDisplayEnvelopeV1Sync({ sessionMode: 'plain', envelope: projection.shared }))
      .toEqual({ ok: true, display: semantic.shared });
    expect(openSessionOwnerDisplayEnvelopeV1({ accountMode: 'e2ee', envelope: projection.owner,
      material: displayAccountMaterial })).toEqual({ ok: true, display: semantic.owner });
    if (change !== 'summary') expect(projection.shared).toEqual(initialSnapshot.displayProjectionV1.shared);
    if (change !== 'owner') expect(projection.owner).toEqual(initialSnapshot.displayProjectionV1.owner);
    else expect(projection.owner).not.toEqual(initialSnapshot.displayProjectionV1.owner);
    expect(Reflect.get(updated, 'displayProjectionV1')).toEqual(projection);
  });

  it('never includes an owner leaf in a shared-editor patch', async () => {
    const owner = linkedDisplaySnapshot();
    let committed: SessionMetadataTuplePatchV1 | undefined;
    const updated = await updateSessionMetadataTupleWithRetry({ initialSnapshot: {
      mode: 'shared_editor', metadataLayoutVersion: 1, metadataVersion: owner.metadataVersion,
      sharedMetadataCiphertext: owner.sharedMetadataCiphertext,
      displayProjectionV1: { ...owner.displayProjectionV1, owner: undefined },
      value: { metadata: owner.value.sharedMetadata, sharedMetadata: owner.value.sharedMetadata, ownerMetadata: null, agentState: null },
    }, mutation: { kind: 'metadata', update: metadata => ({ ...metadata, summary: { text: 'shared edit', updatedAt: 3 } }) },
      crypto: { ...displayCryptoAdapter(), encodeOwnerDisplay: () => { throw new Error('Shared editor reached Account crypto'); } },
      commit: async patch => { committed = patch; return { result: 'success', metadataVersion: 3 }; },
    });
    const projection = SessionDisplayProjectionV1Schema.parse(Reflect.get(committed ?? {}, 'displayProjectionV1'));
    expect(projection).not.toHaveProperty('owner');
    expect(openSessionSharedDisplayEnvelopeV1Sync({ sessionMode: 'plain', envelope: projection.shared }))
      .toEqual({ ok: true, display: { v: 1, summaryText: 'shared edit' } });
    expect(Reflect.get(updated, 'displayProjectionV1')).toEqual(projection);
  });

  it('invalidates only the changed owner leaf when its producer is unavailable', async () => {
    const initialSnapshot = linkedDisplaySnapshot();
    const { encodeOwnerDisplay: _unavailable, ...crypto } = displayCryptoAdapter();
    let committed: SessionMetadataTuplePatchV1 | undefined;
    await updateSessionMetadataTupleWithRetry({ initialSnapshot,
      mutation: { kind: 'metadata', update: metadata => ({ ...metadata, name: 'new owner name' }) }, crypto,
      commit: async patch => { committed = patch; return { result: 'success', metadataVersion: 3, agentStateVersion: 4 }; },
    });
    const projection = SessionDisplayProjectionV1Schema.parse(Reflect.get(committed ?? {}, 'displayProjectionV1'));
    expect(projection.shared).toEqual(initialSnapshot.displayProjectionV1.shared);
    expect(projection).not.toHaveProperty('owner');
  });

  it('recomputes from the conflict winner while preserving that winner’s unchanged owner bytes', async () => {
    const initialSnapshot = linkedDisplaySnapshot();
    const winner = linkedDisplaySnapshot({ metadataVersion: 3,
      metadata: { ...initialSnapshot.value.metadata, name: 'Concurrent private name' } });
    const patches: SessionMetadataTuplePatchV1[] = [];
    const updated = await updateSessionMetadataTupleWithRetry({ initialSnapshot,
      mutation: { kind: 'metadata', update: metadata => ({ ...metadata, summary: { text: 'requested summary', updatedAt: 2 } }) },
      crypto: displayCryptoAdapter(), commit: async patch => {
        patches.push(patch);
        return patches.length === 1 ? { result: 'conflict', currentSnapshot: winner }
          : { result: 'success', metadataVersion: 4, agentStateVersion: 4 };
      },
    });
    const projection = SessionDisplayProjectionV1Schema.parse(Reflect.get(patches.at(-1) ?? {}, 'displayProjectionV1'));
    expect(projection.sourceMetadataVersion).toBe(4);
    expect(projection.owner).toEqual(winner.displayProjectionV1.owner);
    expect(projection.owner).not.toEqual(initialSnapshot.displayProjectionV1.owner);
    expect(openSessionSharedDisplayEnvelopeV1Sync({ sessionMode: 'plain', envelope: projection.shared }))
      .toEqual({ ok: true, display: { v: 1, summaryText: 'requested summary' } });
    expect(updated.value.metadata).toMatchObject({ name: 'Concurrent private name' });
  });

  it('does not confirm an ambiguous full-tuple commit whose display was not committed', async () => {
    const initialSnapshot = linkedDisplaySnapshot();
    let committed: SessionMetadataTuplePatchV1 | undefined;
    await expect(updateSessionMetadataTupleWithRetry({ initialSnapshot,
      mutation: { kind: 'metadata', update: metadata => ({ ...metadata, summary: { text: 'after', updatedAt: 2 } }) },
      crypto: displayCryptoAdapter(), isAmbiguousCommitError: () => true,
      commit: async patch => { committed = patch; throw new Error('lost response'); },
      refreshAfterConflict: async () => {
        if (!committed || committed.mode !== 'owner') throw new Error('Expected owner patch');
        const refreshed = ownerSnapshot({ metadata: { ...initialSnapshot.value.metadata, summary: { text: 'after', updatedAt: 2 } },
          metadataVersion: 3, sharedMetadataCiphertext: committed.sharedMetadata.ciphertext,
          ownerMetadataEnvelope: committed.ownerMetadata, agentStateVersion: 4, agentStateCiphertext: null });
        if (refreshed.mode !== 'owner') throw new Error('Expected refreshed owner');
        return { ...refreshed, displayProjectionV1: null };
      },
    })).rejects.toMatchObject({ code: 'metadata_tuple_ambiguous' });
  });

  it('commits an accepted Project column without rewriting unchanged private metadata', async () => {
    const current = ownerSnapshot();
    const commit = vi.fn(async (_patch: SessionMetadataTuplePatchV1) => ({ result: 'success' as const, metadataVersion: 3, agentStateVersion: 5 }));
    const crypto = cryptoAdapter();
    await updateSessionMetadataTupleWithRetry({ initialSnapshot: current,
      mutation: { kind: 'metadata', update: metadata => metadata },
      projectKey: 'accepted-project', crypto, commit });
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ mode: 'owner', projectKey: 'accepted-project',
      ownerMetadata: current.mode === 'owner' ? current.ownerMetadataEnvelope : undefined }));
    expect(crypto.encodeOwnerMetadata).not.toHaveBeenCalled();
  });
  it.each(['legacy_writer', 'owner_migration'] as const)('cannot add attestation through %s on an older Session', async (path) => {
    const initialSnapshot = legacyOwnerSnapshot({ metadata: { path: '/repo', host: 'host' }, metadataVersion: 1,
      metadataCiphertext: 'legacy-before', agentStateVersion: 0 });
    const commit = vi.fn(async () => ({ result: 'success' as const, metadataVersion: 3, agentStateVersion: 5 }));
    const mutateLegacy = vi.fn(async () => initialSnapshot);
    await expect(updateSessionMetadataTupleWithRetry({ initialSnapshot,
      mutation: { kind: 'metadata', update: metadata => ({ ...metadata, attestedContext: {
        externalPrincipalId: 'forged@example.test', sourceMessageId: '<forged@example.test>',
      } }) }, crypto: cryptoAdapter(), commit,
      ...(path === 'owner_migration' ? { ownerMigrationCurrentness: {
        expectedAccountEncryptionMode: 'plain' as const, expectedAccountContentPublicKeyFingerprint: null,
      } } : { mutateLegacy }),
    })).rejects.toMatchObject({ code: 'session_attested_context_read_only' });
    expect(commit).not.toHaveBeenCalled();
    expect(mutateLegacy).not.toHaveBeenCalled();
  });

  it.each(['replace', 'remove', 'add'] as const)('rejects an attested identity %s after Session birth', async (mode) => {
    const attestedContext = { externalPrincipalId: 'sales@batiplus.ch', sourceMessageId: '<lead@example.test>' };
    const initialSnapshot = ownerSnapshot({ metadata: mode === 'add' ? {} : { attestedContext } });
    const commit = vi.fn(async () => ({ result: 'success' as const, metadataVersion: 3, agentStateVersion: 5 }));
    await expect(updateSessionMetadataTupleWithRetry({ initialSnapshot,
      mutation: { kind: 'metadata', update: () => mode === 'remove' ? {} : {
        attestedContext: { ...attestedContext, externalPrincipalId: 'forged@example.test' },
      } }, crypto: cryptoAdapter(), commit,
    })).rejects.toMatchObject({ code: 'session_attested_context_read_only' });
    expect(commit).not.toHaveBeenCalled();
  });

  it('rejects an in-place attestation mutation without poisoning the current snapshot', async () => {
    const attestedContext = { externalPrincipalId: 'sales@batiplus.ch', sourceMessageId: '<lead@example.test>' };
    const initialSnapshot = ownerSnapshot({ metadata: { attestedContext } });
    const commit = vi.fn(async () => ({ result: 'success' as const, metadataVersion: 3, agentStateVersion: 5 }));
    await expect(updateSessionMetadataTupleWithRetry({ initialSnapshot,
      mutation: { kind: 'metadata', update: metadata => {
        const context = metadata.attestedContext;
        if (context && typeof context === 'object') Reflect.set(context, 'externalPrincipalId', 'forged@example.test');
        return metadata;
      } }, crypto: cryptoAdapter(), commit,
    })).rejects.toMatchObject({ code: 'session_attested_context_read_only' });
    expect(initialSnapshot.value.metadata.attestedContext).toEqual({
      externalPrincipalId: 'sales@batiplus.ch', sourceMessageId: '<lead@example.test>',
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('keeps attestation admission on a legacy writer reapplication after a conflict', async () => {
    const initialSnapshot = legacyOwnerSnapshot({ metadata: { path: '/repo', host: 'host' },
      metadataVersion: 1, metadataCiphertext: 'legacy-before', agentStateVersion: 0 });
    let written: Metadata | null = null;
    await expect(updateSessionMetadataTupleWithRetry({ initialSnapshot,
      mutation: { kind: 'metadata', update: metadata => ({ ...metadata,
        summary: 'updated', ...(metadata.summary ? { attestedContext: {
          externalPrincipalId: 'forged@example.test', sourceMessageId: '<forged@example.test>',
        } } : {}),
      }) }, crypto: cryptoAdapter(), commit: async () => { throw new Error('Legacy writes do not commit a tuple'); },
      // Persistence boundary: the first CAS conflicts and re-applies its
      // admitted callback against the newly read row, as SessionClient does.
      mutateLegacy: async request => {
        if (request.kind !== 'metadata') throw new Error('Expected metadata mutation');
        const next = await request.mutation.update({ ...request.current.value.metadata, summary: 'concurrent update' });
        written = next;
        return initialSnapshot;
      },
    })).rejects.toMatchObject({ code: 'session_attested_context_read_only' });
    expect(written).toBeNull();
  });

  it('preserves synchronous legacy writer reapplication for ordinary metadata', async () => {
    const initialSnapshot = legacyOwnerSnapshot({ metadata: { path: '/repo', host: 'host' },
      metadataVersion: 1, metadataCiphertext: 'legacy-before', agentStateVersion: 0 });
    let written: Metadata | null = null;
    await expect(updateSessionMetadataTupleWithRetry({ initialSnapshot,
      mutation: { kind: 'metadata', update: metadata => ({ ...metadata, summary: 'updated' }) },
      crypto: cryptoAdapter(), commit: async () => { throw new Error('Legacy writes do not commit a tuple'); },
      mutateLegacy: async request => {
        if (request.kind !== 'metadata') throw new Error('Expected metadata mutation');
        const next = request.mutation.update({ ...request.current.value.metadata, summary: 'concurrent update' });
        if (next && typeof next === 'object' && 'then' in next) throw new Error('Legacy socket updates must remain synchronous');
        written = next as Metadata;
        return initialSnapshot;
      },
    })).resolves.toEqual(initialSnapshot);
    expect(written).toMatchObject({ path: '/repo', summary: 'updated' });
  });

  it('refuses a stale reviewed metadata revision before effects and never rebases it after a conflict', async () => {
    const initial = ownerSnapshot({ metadataVersion: 2 });
    let writes = 0;
    const update = (metadata: Metadata) => ({ ...metadata, summary: { text: 'reviewed', updatedAt: 2 } });
    const commit = async () => { writes += 1; return { result: 'conflict' as const,
      currentSnapshot: ownerSnapshot({ metadataVersion: 3 }) }; };
    await expect(updateSessionMetadataTupleWithRetry({ initialSnapshot: initial,
      mutation: { kind: 'metadata', expectedMetadataRevision: 1, update }, crypto: cryptoAdapter(), commit }))
      .rejects.toMatchObject({ code: 'metadata_tuple_conflict' });
    expect(writes).toBe(0);
    await expect(updateSessionMetadataTupleWithRetry({ initialSnapshot: initial,
      mutation: { kind: 'metadata', expectedMetadataRevision: 2, update }, crypto: cryptoAdapter(), commit }))
      .rejects.toMatchObject({ code: 'metadata_tuple_conflict' });
    expect(writes).toBe(1);
  });
  it('atomically seals complete operation progress for the owner and only its shared presentation', async () => {
    const progress = ExternalSessionOperationProgressV1Schema.parse({
      v: 1,
      operationId: 'operation-private-1',
      revision: 4,
      request: {
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
      },
      status: 'running',
      phase: 'staging',
      timeline: ['validating', 'staging', 'importing', 'publishing'],
      updatedAtMs: 1_700_000_000_004,
      priorStableStorage: { state: 'machine_only' },
      currentStorageState: 'machine_only',
      checkpoint: {
        sourcePagesRead: 3,
        stagedItemCount: 2,
        importedItemCount: 0,
        requiredItemFailures: {
          total: 0,
          record: 0,
          media: 0,
          conversion: 0,
          diagnosticsTruncated: false,
        },
      },
      fence: { kind: 'none' },
    });
    const crypto = cryptoAdapter();
    const commit = vi.fn(async () => ({
      result: 'success' as const,
      metadataVersion: 3,
      agentStateVersion: 5,
    }));

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: ownerSnapshot(),
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          externalSessionOperationV1: { v: 1, progress },
          externalSessionOperationPresentationV1:
            projectExternalSessionOperationSharedPresentationV1(progress),
        }),
      },
      crypto,
      commit,
    });

    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      ownerMetadata: expect.objectContaining({
        t: 'plain',
        v: expect.objectContaining({
          runtime: expect.objectContaining({
            externalSessionOperationV1: { v: 1, progress },
          }),
        }),
      }),
      sharedMetadata: expect.objectContaining({
        ciphertext: expect.stringContaining(
          '"externalSessionOperationPresentationV1"',
        ),
      }),
    }));
    const encryptedShared = crypto.encryptPayload.mock.calls[0]?.[0];
    expect(JSON.stringify(encryptedShared)).not.toContain(
      'sourcePagesRead',
    );
    expect(result).toMatchObject({
      mode: 'owner',
      value: {
        metadata: {
          externalSessionOperationV1: { v: 1, progress },
          externalSessionOperationPresentationV1:
            projectExternalSessionOperationSharedPresentationV1(progress),
        },
        ownerMetadata: {
          runtime: {
            externalSessionOperationV1: { v: 1, progress },
          },
        },
        sharedMetadata: {
          externalSessionOperationPresentationV1:
            projectExternalSessionOperationSharedPresentationV1(progress),
        },
      },
    });
  });

  it('preserves the exact owner envelope for a shared-only metadata mutation', async () => {
    const crypto = cryptoAdapter();
    const initialSnapshot = ownerSnapshot({ agentState: { requests: { question: { createdAt: 1 } } },
      agentStateCiphertext: 'existing-question-ciphertext' });
    const commit = vi.fn(async (patch: SessionMetadataTuplePatchV1) => ({
      result: 'success' as const,
      metadataVersion: 3,
      agentStateVersion: patch.mode === 'owner' && patch.agentState.ciphertext === 'existing-question-ciphertext' ? 4 : 5,
    }));

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot,
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'after', updatedAt: 2 },
        }),
      },
      crypto,
      commit,
    });

    expect(crypto.encodeOwnerMetadata).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      expectedOwnerMetadata: expect.objectContaining({ t: 'plain' }),
      ownerMetadata: expect.objectContaining({ t: 'plain' }),
      agentState: { expectedVersion: 4, ciphertext: 'existing-question-ciphertext' },
    }));
    expect(result).toMatchObject({
      mode: 'owner',
      agentStateVersion: 4,
      agentStateCiphertext: 'existing-question-ciphertext',
      ownerMetadataEnvelope: { t: 'plain' },
      value: {
        metadata: {
          path: '/workspace',
          host: 'local',
          summary: { text: 'after', updatedAt: 2 },
        },
      },
    });
    // Metadata-only traffic must not reseal requests or invalidate a fresh
    // Follow admission carrying their exact Agent-state version.
    expect(crypto.encryptPayload.mock.calls.map(([payload]) => payload)).not.toContainEqual(initialSnapshot.value.agentState);
  });

  it('rejoins a lost metadata-only response without requiring unchanged request state to advance', async () => {
    const initial = ownerSnapshot({ agentState: { requests: {} }, agentStateCiphertext: 'retained-requests' });
    const lostResponse = new Error('response lost after commit');
    let committed = initial;
    let writes = 0;
    const result = await updateSessionMetadataTupleWithRetry({ initialSnapshot: initial,
      mutation: { kind: 'metadata', update: metadata => ({ ...metadata, summary: { text: 'after', updatedAt: 2 } }) },
      crypto: cryptoAdapter(), commit: async patch => {
        if (patch.mode !== 'owner') throw new Error('Expected owner patch');
        writes++;
        committed = ownerSnapshot({ metadata: { ...initial.value.metadata, summary: { text: 'after', updatedAt: 2 } },
          metadataVersion: 3, sharedMetadataCiphertext: patch.sharedMetadata.ciphertext, ownerMetadataEnvelope: patch.ownerMetadata,
          agentState: initial.value.agentState, agentStateVersion: 4, agentStateCiphertext: patch.agentState.ciphertext });
        throw lostResponse;
      }, isAmbiguousCommitError: error => error === lostResponse, refreshAfterConflict: async () => committed,
    });
    expect(result).toMatchObject({ mode: 'owner', metadataVersion: 3, agentStateVersion: 4, agentStateCiphertext: 'retained-requests' });
    expect(writes).toBe(1);
  });

  it('does not promote synthesized compatibility defaults into unchanged owner metadata', async () => {
    const strictInitial = ownerSnapshot();
    if (strictInitial.mode !== 'owner') throw new Error('expected owner');
    const initial: SessionMetadataTupleMutationSnapshotV1<
      Metadata,
      AgentState
    > = {
      ...strictInitial,
      value: {
        ...strictInitial.value,
        metadata: {
          ...strictInitial.value.metadata,
          version: undefined,
          homeDir: '',
          happyHomeDir: '',
          happyLibDir: '',
          happyToolsDir: '',
        },
      },
    };
    const crypto = cryptoAdapter();
    const commit = vi.fn(async () => ({
      result: 'success' as const,
      metadataVersion: 3,
      agentStateVersion: 5,
    }));

    await updateSessionMetadataTupleWithRetry<Metadata, AgentState>({
      initialSnapshot: initial,
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'after', updatedAt: 2 },
        }),
      },
      crypto,
      commit,
    });

    expect(crypto.encodeOwnerMetadata).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      ownerMetadata: expect.objectContaining({ t: 'plain' }),
    }));
  });

  it('splits a private owner mutation and seals only the changed owner projection', async () => {
    const crypto = cryptoAdapter();
    const commit = vi.fn(async () => ({
      result: 'success' as const,
      metadataVersion: 3,
      agentStateVersion: 5,
    }));

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: ownerSnapshot(),
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          path: '/workspace/changed',
        }),
      },
      crypto,
      commit,
    });

    expect(crypto.encodeOwnerMetadata).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      expectedOwnerMetadata: expect.objectContaining({ t: 'plain' }),
      ownerMetadata: expect.objectContaining({
        t: 'plain',
        v: expect.objectContaining({
          workspace: expect.objectContaining({
            path: '/workspace/changed',
          }),
        }),
      }),
    }));
    expect(result).toMatchObject({
      mode: 'owner',
      value: {
        metadata: { path: '/workspace/changed' },
        ownerMetadata: {
          workspace: { path: '/workspace/changed' },
        },
      },
    });
  });

  it('returns the canonical owner compatibility projection instead of raw updater aliases', async () => {
    const crypto = cryptoAdapter();

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: ownerSnapshot(),
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              providerSessionId: 'native-1',
            },
          },
        }),
      },
      crypto,
      commit: async () => ({
        result: 'success',
        metadataVersion: 3,
        agentStateVersion: 5,
      }),
    });

    expect(result).toMatchObject({
      mode: 'owner',
      value: {
        metadata: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
          },
        },
      },
    });
    expect(
      (result.value.metadata as Metadata).agentRuntimeDescriptorV1,
    ).toEqual({
      v: 1,
      providerId: 'codex',
      provider: {
        backendMode: 'appServer',
        vendorSessionId: 'native-1',
      },
    });
  });

  it('accepts its projected host-session runtime descriptor on a second owner mutation', async () => {
    const first = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: ownerSnapshot(),
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'claude',
            agent: {
              backendMode: 'native',
              providerSessionId: 'claude-session-private',
              agentExtra: {
                owner: 'happier',
                schemaId: 'happier.hostSessionRuntimeIdentity',
                v: 1,
                runtimeHandle: {
                  backendId: 'claude',
                  agentId: 'claude',
                  provenance: 'first_party',
                },
              },
            },
          },
        }),
      },
      crypto: cryptoAdapter(),
      commit: async () => ({
        result: 'success',
        metadataVersion: 3,
        agentStateVersion: 5,
      }),
    });
    expect(first.mode).toBe('owner');
    if (first.mode !== 'owner') throw new Error('expected owner tuple');
    expect(first.value.metadata).toMatchObject({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'claude',
        agent: {
          backendMode: 'native',
          providerSessionId: 'claude-session-private',
        },
      },
    });
    const secondCommit = vi.fn(async () => ({
      result: 'success' as const,
      metadataVersion: 4,
      agentStateVersion: 6,
    }));

    const second = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: first,
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'second mutation', updatedAt: 3 },
        }),
      },
      crypto: cryptoAdapter(),
      commit: secondCommit,
    });

    expect(secondCommit).toHaveBeenCalledOnce();
    expect(second).toMatchObject({
      mode: 'owner',
      metadataVersion: 4,
      agentStateVersion: 6,
      value: {
        metadata: {
          summary: { text: 'second mutation', updatedAt: 3 },
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'claude',
            agent: {
              agentExtra: {
                runtimeHandle: {
                  backendId: 'claude',
                  provenance: 'first_party',
                },
              },
            },
          },
        },
      },
    });
  });

  it('commits nothing when a producer republishes an unchanged catalog without the view-only compatibility alias', async () => {
    // The returned compatibility view carries predecessor write aliases (`provider` on
    // `sessionModelsV1`). A producer that rebuilds its own field never writes that alias,
    // so its unchanged catalog differs from the view only by the alias.
    const catalog = {
      v: 1, agentId: 'claude', updatedAt: 1, currentModelId: 'opus',
      availableModels: [{ id: 'opus', name: 'Opus', description: 'Big', contextWindowTokens: 200_000 }],
    };
    const first = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: ownerSnapshot(),
      mutation: { kind: 'metadata', update: (metadata) => ({ ...metadata, sessionModelsV1: catalog }) },
      crypto: cryptoAdapter(),
      commit: async () => ({ result: 'success', metadataVersion: 3, agentStateVersion: 5 }),
    });
    expect((first.value.metadata as Metadata).sessionModelsV1).toMatchObject({ provider: 'claude' });
    const crypto = cryptoAdapter();
    const commit = vi.fn(async () => ({ result: 'success' as const, metadataVersion: 4, agentStateVersion: 6 }));
    let snapshot: SessionMetadataTupleMutationSnapshotV1<Metadata, AgentState> = first;
    for (let republish = 0; republish < 5; republish += 1) {
      snapshot = await updateSessionMetadataTupleWithRetry({
        initialSnapshot: snapshot,
        mutation: { kind: 'metadata', update: (metadata) => ({ ...metadata, sessionModelsV1: { ...catalog } }) },
        crypto,
        commit,
      });
    }

    expect({ commits: commit.mock.calls.length, ownerEncodes: crypto.encodeOwnerMetadata.mock.calls.length,
      sharedEncrypts: crypto.encryptPayload.mock.calls.length }).toEqual({ commits: 0, ownerEncodes: 0, sharedEncrypts: 0 });
    expect(snapshot).toBe(first);
  });

  it('reprojects shared metadata for an Agent-state-only mutation while preserving the owner envelope', async () => {
    const crypto = cryptoAdapter();
    const commit = vi.fn(async () => ({
      result: 'success' as const,
      metadataVersion: 3,
      agentStateVersion: 5,
    }));

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: ownerSnapshot({
        agentState: {
          requests: {
            r1: {
              tool: 'shell',
              createdAt: 1,
              completedAt: 2,
              status: 'completed',
            },
          },
        },
      }),
      mutation: {
        kind: 'agentState',
        update: (agentState) => ({
          ...agentState,
          controlledByUser: true,
        }),
      },
      crypto,
      commit,
    });

    expect(crypto.encodeOwnerMetadata).not.toHaveBeenCalled();
    expect(crypto.encryptPayload).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      mode: 'owner',
      ownerMetadataEnvelope: expect.objectContaining({ t: 'plain' }),
      value: {
        agentState: { controlledByUser: true },
      },
    });
  });

  it('reapplies the semantic mutation to the authoritative conflict snapshot', async () => {
    const crypto = cryptoAdapter();
    const authoritative = ownerSnapshot({
      metadata: {
        path: '/concurrent',
        host: 'local',
        name: 'preserve-me',
        summary: { text: 'concurrent', updatedAt: 3 },
      },
      metadataVersion: 3,
      ownerMetadataEnvelope: {
        t: 'encrypted',
        c: 'owner-authoritative',
      },
      agentStateVersion: 5,
    });
    const commit = vi.fn()
      .mockResolvedValueOnce({ result: 'conflict' })
      .mockResolvedValueOnce({
        result: 'success',
        metadataVersion: 4,
        agentStateVersion: 6,
      });
    const refreshAfterConflict = vi.fn(async () => authoritative);

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: ownerSnapshot(),
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'requested', updatedAt: 4 },
        }),
      },
      crypto,
      commit,
      refreshAfterConflict,
    });

    expect(commit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      expectedOwnerMetadata: {
        t: 'encrypted',
        c: 'owner-authoritative',
      },
    }));
    expect(result).toMatchObject({
      metadataVersion: 4,
      value: {
        metadata: {
          path: '/concurrent',
          name: 'preserve-me',
          summary: { text: 'requested', updatedAt: 4 },
        },
      },
    });
  });

  it('fails closed on unsupported owner fields before encryption or commit', async () => {
    const crypto = cryptoAdapter();
    const commit = vi.fn();

    await expect(updateSessionMetadataTupleWithRetry({
      initialSnapshot: ownerSnapshot(),
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          futurePrivateAuthority: 'must-not-drop',
        }),
      },
      crypto,
      commit,
    })).rejects.toMatchObject({
      code: 'metadata_privacy_upgrade_required',
      unsupportedFields: ['futurePrivateAuthority'],
      retryable: false,
    });

    expect(crypto.encryptPayload).not.toHaveBeenCalled();
    expect(crypto.encodeOwnerMetadata).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('uses the same strict semantic owner for a shared editor and rejects owner-only fields', async () => {
    const initialShared: SessionSharedMetadataV1 = {
      v: 1,
      summary: { text: 'before', updatedAt: 1 },
    };
    const initial: SessionMetadataTupleMutationSnapshotV1<
      SessionSharedMetadataV1,
      AgentState
    > = {
      mode: 'shared_editor',
      metadataLayoutVersion: 1,
      metadataVersion: 7,
      sharedMetadataCiphertext: 'shared-before',
      value: {
        metadata: initialShared,
        sharedMetadata: initialShared,
        ownerMetadata: null,
        agentState: null,
      },
    };
    const crypto = cryptoAdapter();
    const commit = vi.fn(async () => ({
      result: 'success' as const,
      metadataVersion: 8,
    }));

    const result = await updateSessionMetadataTupleWithRetry<
      SessionSharedMetadataV1,
      AgentState
    >({
      initialSnapshot: initial,
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'after', updatedAt: 2 },
        }),
      },
      crypto,
      commit,
    });

    expect(result).toMatchObject({
      mode: 'shared_editor',
      metadataVersion: 8,
      value: {
        metadata: {
          v: 1,
          summary: { text: 'after', updatedAt: 2 },
        },
      },
    });
    expect(commit).toHaveBeenCalledWith({
      mode: 'shared_editor',
      usageTimingV1: { v: 1, metadata: null, agentState: null },
      metadataLayoutVersion: 1,
      displayProjectionV1: null,
      sharedMetadata: {
        ciphertext: expect.stringContaining('"after"'),
        expectedVersion: 7,
      },
    });

    await expect(updateSessionMetadataTupleWithRetry<
      SessionSharedMetadataV1,
      AgentState
    >({
      initialSnapshot: initial,
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          path: '/owner-only',
        }),
      },
      crypto,
      commit,
    })).rejects.toMatchObject({
      code: 'metadata_privacy_upgrade_required',
      retryable: false,
    });
  });

  it.each(['owner', 'legacy_owner'] as const)('uses one structural no-op rule independent of object key order for %s', async mode => {
    const metadata = { host: 'local', path: '/workspace' };
    const initial = mode === 'owner' ? ownerSnapshot({ metadata })
      : legacyOwnerSnapshot({ metadata, metadataVersion: 2, metadataCiphertext: 'legacy-source', agentStateVersion: 4 });
    const crypto = cryptoAdapter();
    const commit = vi.fn();

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: initial,
      mutation: {
        kind: 'metadata',
        update: () => ({
          path: '/workspace',
          host: 'local',
        }),
      },
      crypto,
      commit,
      ownerMigrationCurrentness: { expectedAccountEncryptionMode: 'plain', expectedAccountContentPublicKeyFingerprint: null },
    });

    expect(result).toBe(initial);
    expect(crypto.encryptPayload).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('migrates original layout-0 values before applying reviewed metadata at the next revision', async () => {
    const initial = legacyOwnerSnapshot({
      metadata: {
        path: '/workspace',
        host: 'local',
        summary: { text: 'Before', updatedAt: 1 },
      },
      agentState: { controlledByUser: false },
      metadataVersion: 2,
      metadataCiphertext: 'metadata-exact-source',
      agentStateVersion: 4,
      agentStateCiphertext: 'agent-exact-source',
    });
    const crypto = cryptoAdapter();
    const commit = vi.fn(async (patch: SessionMetadataTuplePatchV1) => ({
      result: 'success' as const,
      metadataVersion: patch.mode === 'owner_migration' ? 3 : 4,
      agentStateVersion: 5,
    }));

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: initial,
      mutation: {
        kind: 'metadata',
        expectedMetadataRevision: 2,
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'After', updatedAt: 2 },
        }),
      },
      crypto,
      commit,
      ownerMigrationCurrentness: {
        expectedAccountEncryptionMode: 'plain',
        expectedAccountContentPublicKeyFingerprint: null,
      },
    });

    expect(commit).toHaveBeenCalledWith({
      mode: 'owner_migration',
      usageTimingV1: { v: 1, metadata: { v: 1, minMs: null, maxMs: null },
        agentState: { v: 1, minMs: null, maxMs: null } },
      expectedAccountEncryptionMode: 'plain',
      expectedAccountContentPublicKeyFingerprint: null,
      source: {
        metadataLayoutVersion: 0,
        metadata: {
          version: 2,
          ciphertext: 'metadata-exact-source',
        },
        ownerMetadata: null,
        agentState: {
          version: 4,
          ciphertext: 'agent-exact-source',
        },
      },
      target: {
        metadataLayoutVersion: 1,
        displayProjectionV1: null,
        sharedMetadata: {
          ciphertext: expect.stringContaining('"Before"'),
        },
        ownerMetadata: expect.objectContaining({ t: 'plain' }),
        agentState: {
          ciphertext: expect.stringContaining('"controlledByUser":false'),
        },
      },
    });
    expect(commit).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: 'owner',
      sharedMetadata: { expectedVersion: 3, ciphertext: expect.stringContaining('"After"') },
      agentState: { expectedVersion: 5, ciphertext: expect.stringContaining('"controlledByUser":false') },
    }));
    expect(result).toMatchObject({
      mode: 'owner',
      metadataLayoutVersion: 1,
      metadataVersion: 4,
      agentStateVersion: 5,
      value: {
        metadata: {
          summary: { text: 'After', updatedAt: 2 },
        },
        agentState: { controlledByUser: false },
      },
    });
  });

  it('migrates original layout-0 values before applying its Agent-state mutation', async () => {
    const initial = legacyOwnerSnapshot({
      metadata: {
        path: '/workspace',
        host: 'local',
      },
      agentState: { controlledByUser: false },
      metadataVersion: 2,
      metadataCiphertext: 'metadata-exact-source',
      agentStateVersion: 4,
      agentStateCiphertext: 'agent-exact-source',
    });
    const crypto = cryptoAdapter();
    const commit = vi.fn(async (patch: SessionMetadataTuplePatchV1) => ({
      result: 'success' as const,
      metadataVersion: patch.mode === 'owner_migration' ? 3 : 4,
      agentStateVersion: patch.mode === 'owner_migration' ? 5 : 6,
    }));

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: initial,
      mutation: {
        kind: 'agentState',
        update: (agentState) => ({
          ...agentState,
          controlledByUser: true,
        }),
      },
      crypto,
      commit,
      ownerMigrationCurrentness: {
        expectedAccountEncryptionMode: 'e2ee',
        expectedAccountContentPublicKeyFingerprint:
          `content-public-key-sha256:${'a'.repeat(64)}`,
      },
    });

    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'owner_migration',
      expectedAccountEncryptionMode: 'e2ee',
      expectedAccountContentPublicKeyFingerprint:
        `content-public-key-sha256:${'a'.repeat(64)}`,
      target: expect.objectContaining({
        agentState: {
          ciphertext: expect.stringContaining('"controlledByUser":false'),
        },
      }),
    }));
    expect(commit).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: 'owner', agentState: { expectedVersion: 5, ciphertext: expect.stringContaining('"controlledByUser":true') },
    }));
    expect(result).toMatchObject({
      mode: 'owner',
      metadataLayoutVersion: 1,
      value: {
        agentState: { controlledByUser: true },
      },
    });
  });

  it('migrates a dormant layout-0 owner on an explicit request without any value change', async () => {
    // A predecessor (0.2) owner tuple: one decrypted bag mixing recipient-safe
    // presentation with machine-local owner-private facts.
    const metadata = {
      path: '/Users/owner/private-repo',
      host: 'owner-laptop',
      summary: { text: 'Historical work', updatedAt: 1 },
    };
    const initial = legacyOwnerSnapshot({
      metadata,
      agentState: { controlledByUser: false },
      metadataVersion: 7,
      metadataCiphertext: 'metadata-0.2-source',
      agentStateVersion: 9,
      agentStateCiphertext: 'agent-0.2-source',
    });
    const crypto = cryptoAdapter();
    const commit = vi.fn(async (_patch: SessionMetadataTuplePatchV1) => ({
      result: 'success' as const,
      metadataVersion: 8,
      agentStateVersion: 10,
    }));
    const mutateLegacy = vi.fn();

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: initial,
      mutation: { kind: 'ownerMigration' },
      crypto,
      commit,
      mutateLegacy,
      ownerMigrationCurrentness: {
        expectedAccountEncryptionMode: 'plain',
        expectedAccountContentPublicKeyFingerprint: null,
      },
    });

    expect(mutateLegacy).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
    const patch = commit.mock.calls[0]![0];
    if (patch.mode !== 'owner_migration') throw new Error('expected owner_migration');
    expect(patch.source).toEqual({
      metadataLayoutVersion: 0,
      metadata: { version: 7, ciphertext: 'metadata-0.2-source' },
      ownerMetadata: null,
      agentState: { version: 9, ciphertext: 'agent-0.2-source' },
    });
    // Recipients get only the strict shared projection; owner-private facts
    // stay in the owner envelope.
    expect(patch.target.sharedMetadata.ciphertext).toContain('Historical work');
    expect(patch.target.sharedMetadata.ciphertext).not.toContain('/Users/owner/private-repo');
    expect(patch.target.sharedMetadata.ciphertext).not.toContain('owner-laptop');
    expect(JSON.stringify(patch.target.ownerMetadata)).toContain('/Users/owner/private-repo');
    expect(patch.target.agentState.ciphertext).toContain('"controlledByUser":false');
    // The owner's complete view is unchanged by the split.
    expect(result).toMatchObject({
      mode: 'owner',
      metadataLayoutVersion: 1,
      metadataVersion: 8,
      agentStateVersion: 10,
      value: {
        metadata: {
          path: '/Users/owner/private-repo',
          host: 'owner-laptop',
          summary: { text: 'Historical work', updatedAt: 1 },
        },
        agentState: { controlledByUser: false },
      },
    });
  });

  it('treats an explicit owner-migration request on a migrated tuple as already complete', async () => {
    const current = ownerSnapshot();
    const commit = vi.fn();

    await expect(updateSessionMetadataTupleWithRetry({
      initialSnapshot: current,
      mutation: { kind: 'ownerMigration' },
      crypto: cryptoAdapter(),
      commit,
    })).resolves.toBe(current);
    expect(commit).not.toHaveBeenCalled();
  });

  it('refuses an explicit owner migration typed when owner currentness is unavailable', async () => {
    const commit = vi.fn();
    const mutateLegacy = vi.fn();

    await expect(updateSessionMetadataTupleWithRetry({
      initialSnapshot: legacyOwnerSnapshot({
        metadata: { path: '/workspace', host: 'local' },
        metadataVersion: 2,
        metadataCiphertext: 'metadata-source',
        agentStateVersion: 1,
      }),
      mutation: { kind: 'ownerMigration' },
      crypto: cryptoAdapter(),
      commit,
      mutateLegacy,
    })).rejects.toMatchObject({ code: 'metadata_privacy_upgrade_required' });
    expect(commit).not.toHaveBeenCalled();
    expect(mutateLegacy).not.toHaveBeenCalled();
  });

  it('re-resolves owner-migration currentness after a conflict refresh', async () => {
    const initial = legacyOwnerSnapshot({
      metadata: { path: '/workspace', host: 'local' },
      agentState: null,
      metadataVersion: 2,
      metadataCiphertext: 'metadata-source-v2',
      agentStateVersion: 4,
      agentStateCiphertext: null,
    });
    const refreshed = legacyOwnerSnapshot({
      metadata: { path: '/workspace', host: 'local' },
      agentState: null,
      metadataVersion: 3,
      metadataCiphertext: 'metadata-source-v3',
      agentStateVersion: 4,
      agentStateCiphertext: null,
    });
    const resolveOwnerMigrationCurrentness = vi.fn()
      .mockResolvedValueOnce({
        expectedAccountEncryptionMode: 'plain' as const,
        expectedAccountContentPublicKeyFingerprint: null,
      })
      .mockResolvedValueOnce({
        expectedAccountEncryptionMode: 'e2ee' as const,
        expectedAccountContentPublicKeyFingerprint:
          `content-public-key-sha256:${'b'.repeat(64)}`,
      });
    const commit = vi.fn()
      .mockResolvedValueOnce({ result: 'conflict' as const })
      .mockResolvedValueOnce({
        result: 'success' as const,
        metadataVersion: 4,
        agentStateVersion: 5,
      })
      .mockResolvedValueOnce({
        result: 'success' as const,
        metadataVersion: 5,
        agentStateVersion: 5,
      });

    await updateSessionMetadataTupleWithRetry({
      initialSnapshot: initial,
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({ ...metadata, path: '/workspace/after' }),
      },
      crypto: cryptoAdapter(),
      commit,
      resolveOwnerMigrationCurrentness,
      refreshAfterConflict: async () => refreshed,
    });

    expect(resolveOwnerMigrationCurrentness).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls.filter(([request]) => request.mode === 'owner_migration').map(([request]) => ({
      mode: request.expectedAccountEncryptionMode,
      fingerprint: request.expectedAccountContentPublicKeyFingerprint,
      sourceVersion: request.source.metadata.version,
    }))).toEqual([
      { mode: 'plain', fingerprint: null, sourceVersion: 2 },
      {
        mode: 'e2ee',
        fingerprint: `content-public-key-sha256:${'b'.repeat(64)}`,
        sourceVersion: 3,
      },
    ]);
  });

  it('recognizes the exact migrated target after a lost owner-migration response', async () => {
    const ambiguous = Object.assign(new Error('timeout after write'), {
      code: 'transport_timeout',
    });
    const initial = legacyOwnerSnapshot({
      metadata: { path: '/workspace', host: 'local' },
      agentState: { controlledByUser: false },
      metadataVersion: 2,
      metadataCiphertext: 'metadata-exact-source',
      agentStateVersion: 4,
      agentStateCiphertext: 'agent-exact-source',
    });
    const crypto = cryptoAdapter();
    let migrated: SessionMetadataTupleMutationSnapshotV1<
      Metadata,
      AgentState
    > | null = null;
    const commit = vi.fn(async (patch: SessionMetadataTuplePatchV1) => {
      if (patch.mode !== 'owner_migration') {
        return { result: 'success' as const, metadataVersion: 4, agentStateVersion: 5 };
      }
      const createdOwner = createSessionOwnerMetadataV1({
        metadata: initial.value.metadata,
      });
      if (!createdOwner.ok) {
        throw new Error('invalid migrated owner fixture');
      }
      migrated = {
        mode: 'owner',
        metadataLayoutVersion: 1,
        metadataVersion: 3,
        sharedMetadataCiphertext: patch.target.sharedMetadata.ciphertext,
        ownerMetadataEnvelope: patch.target.ownerMetadata,
        agentStateVersion: 5,
        agentStateCiphertext: patch.target.agentState.ciphertext,
        value: {
          metadata: initial.value.metadata,
          sharedMetadata: projectSessionSharedMetadataV1({
            metadata: initial.value.metadata,
            agentState: initial.value.agentState,
          }),
          ownerMetadata: createdOwner.ownerMetadata,
          agentState: initial.value.agentState,
        },
      };
      throw ambiguous;
    });

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: initial,
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'After', updatedAt: 2 },
        }),
      },
      crypto,
      commit,
      ownerMigrationCurrentness: {
        expectedAccountEncryptionMode: 'plain',
        expectedAccountContentPublicKeyFingerprint: null,
      },
      refreshAfterConflict: async () => migrated ?? initial,
      isAmbiguousCommitError: (error) => error === ambiguous,
    });

    expect(result).toMatchObject({ metadataVersion: 4, value: { metadata: { summary: { text: 'After', updatedAt: 2 } } } });
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('keeps a reviewed edit conflicted when migration refreshes a changed competing tuple', async () => {
    const initialSnapshot = legacyOwnerSnapshot({ metadata: { path: '/workspace', host: 'local' },
      metadataVersion: 2, metadataCiphertext: 'legacy-source', agentStateVersion: 4 });
    const commit = vi.fn(async () => ({ result: 'conflict' as const,
      currentSnapshot: ownerSnapshot({ metadataVersion: 3, agentStateVersion: 5 }) }));
    await expect(updateSessionMetadataTupleWithRetry({ initialSnapshot,
      mutation: { kind: 'metadata', expectedMetadataRevision: 2,
        update: metadata => ({ ...metadata, summary: { text: 'Reviewed', updatedAt: 2 } }) },
      crypto: cryptoAdapter(), commit,
      ownerMigrationCurrentness: { expectedAccountEncryptionMode: 'plain', expectedAccountContentPublicKeyFingerprint: null },
    })).rejects.toMatchObject({ code: 'metadata_tuple_conflict' });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('replays after an ambiguous rejection only when the exact source is unchanged', async () => {
    const ambiguous = Object.assign(new Error('timeout after write'), {
      code: 'transport_timeout',
    });
    const initial = ownerSnapshot({
      sharedMetadataCiphertext: 'shared-source',
      ownerMetadataEnvelope: {
        t: 'encrypted',
        c: 'owner-source',
      },
      agentStateCiphertext: null,
    });
    const commit = vi.fn()
      .mockRejectedValueOnce(ambiguous)
      .mockResolvedValueOnce({
        result: 'success' as const,
        metadataVersion: 3,
        agentStateVersion: 5,
      });

    await updateSessionMetadataTupleWithRetry({
      initialSnapshot: initial,
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'after', updatedAt: 2 },
        }),
      },
      crypto: cryptoAdapter(),
      commit,
      refreshAfterConflict: async () => initial,
      isAmbiguousCommitError: (error) => error === ambiguous,
    });

    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('fails typed when an ambiguous rejection refreshes a changed non-target tuple', async () => {
    const ambiguous = Object.assign(new Error('timeout after write'), {
      code: 'transport_timeout',
    });
    const initial = ownerSnapshot({
      sharedMetadataCiphertext: 'shared-source',
      ownerMetadataEnvelope: {
        t: 'encrypted',
        c: 'owner-source',
      },
      agentStateCiphertext: null,
    });
    const commit = vi.fn(async () => {
      throw ambiguous;
    });

    await expect(updateSessionMetadataTupleWithRetry({
      initialSnapshot: initial,
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'after', updatedAt: 2 },
        }),
      },
      crypto: cryptoAdapter(),
      commit,
      refreshAfterConflict: async () => ownerSnapshot({
        metadataVersion: 3,
        sharedMetadataCiphertext: 'shared-different',
        ownerMetadataEnvelope: {
          t: 'encrypted',
          c: 'owner-different',
        },
        agentStateVersion: 5,
        agentStateCiphertext: 'agent-different',
      }),
      isAmbiguousCommitError: (error) => error === ambiguous,
    })).rejects.toMatchObject({
      code: 'metadata_tuple_ambiguous',
      retryable: false,
    });

    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('continues authoritative semantic rebases beyond the former retry ceiling', async () => {
    const previousCeiling = 10;
    let commits = 0;
    const result = await updateSessionMetadataTupleWithRetry<Metadata & Pick<SessionSharedMetadataV1, 'summary'>, AgentState>({
      initialSnapshot: ownerSnapshot(),
      mutation: { kind: 'metadata', update: metadata => ({ ...metadata, summary: { text: 'after', updatedAt: 2 } }) },
      crypto: cryptoAdapter(),
      commit: async () => {
        commits += 1;
        return commits <= previousCeiling + 1
          ? { result: 'conflict', currentSnapshot: ownerSnapshot({ metadataVersion: 2 + commits }) }
          : { result: 'success', metadataVersion: 2 + commits, agentStateVersion: 4 };
      },
    });
    expect(result.value.metadata.summary?.text).toBe('after');
    expect(commits).toBe(previousCeiling + 2);
  });

  it('stops a conflicted mutation when its containing operation is cancelled', async () => {
    const crypto = cryptoAdapter();
    const controller = new AbortController();
    const cancelled = new Error('containing operation cancelled');
    const refresh = vi.fn(async () => ownerSnapshot());
    const commit = vi.fn(async () => {
      controller.abort(cancelled);
      return { result: 'conflict' as const };
    });

    await expect(updateSessionMetadataTupleWithRetry({
      initialSnapshot: ownerSnapshot(),
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'after', updatedAt: 2 },
        }),
      },
      crypto,
      commit,
      refreshAfterConflict: refresh,
      assertCurrent: () => controller.signal.throwIfAborted(),
    })).rejects.toBe(cancelled);

    expect(commit).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
  });
});
