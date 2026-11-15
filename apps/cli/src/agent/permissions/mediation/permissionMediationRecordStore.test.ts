import { describe, expect, it, vi } from 'vitest';

import {
  type SessionPermissionMediationRecordIdentityV1,
  type SessionPermissionMediationRecordStored,
  type SessionPermissionMediationRecordWriteRequest,
} from '@happier-dev/protocol';

import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type { SessionEncryptionContext } from '@/session/transport/encryption/sessionEncryptionContext';

import { createPermissionMediationRecordStore } from './permissionMediationRecordStore';

const firstIdentity = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  requestId: 'request-1',
} as const satisfies SessionPermissionMediationRecordIdentityV1;

function settlementRecord(
  identity: Pick<SessionPermissionMediationRecordIdentityV1, 'turnId' | 'requestId'> = firstIdentity,
  overrides: Record<string, unknown> = {},
) {
  return {
    version: 1 as const,
    settlementId: 'settlement-1',
    turnId: identity.turnId,
    requestId: identity.requestId,
    mediatorPluginId: 'happier.channels',
    idempotencyKey: 'retry-1',
    sourceAuthority: {
      kind: 'mediatedExternal' as const,
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default' as const,
      remoteApprovalMaxScope: 'request' as const,
    },
    actor: {
      kind: 'externalHuman' as const,
      assurance: 'pluginAsserted' as const,
      namespace: 'discord',
      principalId: 'person-1',
      assertedBy: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
    },
    decision: 'allow' as const,
    requestedScope: 'request' as const,
    effect: { kind: 'allowOnce' as const },
    createdAtMs: 1,
    ...overrides,
  };
}

function createPlainSession(overrides: Partial<SessionClientPort> = {}): SessionClientPort {
  const session: SessionClientPort = {
    sessionId: 'session-1',
    rpcHandlerManager: {
      registerHandler: vi.fn(),
      invokeLocal: vi.fn(async () => undefined),
    },
    updateMetadata: vi.fn(),
    updateAgentState: vi.fn(),
    updateAgentStateRequestSettlement: vi.fn(async () => undefined),
    keepAlive: vi.fn(),
    getMetadataSnapshot: () => null,
    hasUserMessageLocalConsumption: () => false,
    waitForMetadataUpdate: async () => false,
    popPendingMessage: async () => false,
    shouldAttemptPendingMaterialization: () => false,
    peekPendingMessageQueueV2Count: async () => 0,
    discardPendingMessageQueueV2All: async () => 0,
    discardCommittedMessageLocalIds: async () => 0,
    flush: async () => undefined,
    close: async () => undefined,
    getStoredContentEncryptionContext: () => ({ mode: 'plain' as const }),
    readPermissionMediationRecord: vi.fn(),
    writePermissionMediationRecord: vi.fn(),
    listPermissionMediationRecords: vi.fn(),
    prunePermissionMediationRecord: vi.fn(),
  };
  return Object.assign(session, overrides);
}

function createE2eeSession(
  ctx: SessionEncryptionContext,
  overrides: Partial<SessionClientPort> = {},
): SessionClientPort {
  return createPlainSession({
    getStoredContentEncryptionContext: () => ({ mode: 'e2ee' as const, ctx }),
    ...overrides,
  });
}

function identityKey(identity: SessionPermissionMediationRecordIdentityV1): string {
  return JSON.stringify([identity.sessionId, identity.turnId, identity.requestId]);
}

describe('permissionMediationRecordStore', () => {
  it('retains distinct staged native settlements and restores their logical identities from the host transport', async () => {
    const rows = new Map<string, SessionPermissionMediationRecordStored>();
    const session = createPlainSession({
      readPermissionMediationRecord: async ({ identity }) => rows.get(identityKey(identity)) ?? null,
      writePermissionMediationRecord: async ({ identity, request }) => {
        const row = { ...identity, kind: request.kind, content: request.content,
          revision: 'ssr1.AAAACnJlY29yZC1vbmUAAAAB' };
        rows.set(identityKey(identity), row);
        return row;
      },
      listPermissionMediationRecords: async () => ({ records: [...rows.values()], nextCursor: null, hasNext: false }),
      prunePermissionMediationRecord: async ({ identity }) => { rows.delete(identityKey(identity)); },
    });
    const store = createPermissionMediationRecordStore(session);
    if (!store) throw new Error('expected typed mediation store');
    for (const sourceIndex of [0, 1]) {
      const identity = { ...firstIdentity, responseKey: `human-command-${sourceIndex}` };
      const record = settlementRecord(firstIdentity, { idempotencyKey: identity.responseKey,
        nativeChoice: { requirementId: JSON.stringify({ approvalId: 'native-staged', sourceIndex }), choiceId: 'allow_once' } });
      await expect(store.createExpectedAbsent({ identity, kind: 'remote_settlement.v1', record }))
        .resolves.toMatchObject({ status: 'created', stored: { identity, record } });
      await expect(store.read({ identity })).resolves.toMatchObject({ status: 'found', stored: { identity, record } });
    }
    expect(rows.size).toBe(2);
    const page = await store.list({});
    expect(page).toMatchObject({ status: 'ready', records: [
      { identity: { ...firstIdentity, responseKey: 'human-command-0' } },
      { identity: { ...firstIdentity, responseKey: 'human-command-1' } },
    ] });
    const identity = { ...firstIdentity, responseKey: 'human-command-0' };
    const stored = await store.read({ identity });
    if (stored.status !== 'found') throw new Error('expected first-stage audit');
    await expect(store.pruneInactive({ identity, expectedRevision: stored.stored.revision })).resolves.toMatchObject({ status: 'pruned' });
    await expect(store.read({ identity })).resolves.toEqual({ status: 'absent' });
    expect(rows.size).toBe(1);
  });

  it.each(['remote_settlement.v1', 'remote_grant.v1'] as const)('projects retained extra fields while reading %s and keeps write admission strict', async (kind) => {
    const base = settlementRecord();
    const record = kind === 'remote_grant.v1' ? {
      ...base,
      sourceAuthority: { ...base.sourceAuthority, remoteApprovalMaxScope: 'session' as const },
      requestedScope: 'session' as const,
      effect: { kind: 'sessionGrant' as const, grantId: 'grant-1', rule: { kind: 'exactTool' as const, identifier: 'Bash:git status' } },
    } : base;
    const retained = {
      ...record,
      retired: true,
      sourceAuthority: { ...record.sourceAuthority, retired: true },
      actor: { ...record.actor, retired: true, assertedBy: { ...record.actor.assertedBy, retired: true } },
      effect: { ...record.effect, retired: true },
    };
    const revision = 'ssr1.AAAACnJlY29yZC1vbmUAAAAB';
    const row = { ...firstIdentity, kind, content: { t: 'plain' as const, v: retained, retired: true }, revision, retired: true };
    const write = vi.fn();
    const store = createPermissionMediationRecordStore(createPlainSession({
      readPermissionMediationRecord: vi.fn(async () => row),
      listPermissionMediationRecords: vi.fn(async () => ({ records: [row], nextCursor: null, hasNext: false })),
      writePermissionMediationRecord: write,
    }));
    if (!store) throw new Error('expected typed mediation store');
    const stored = { identity: firstIdentity, kind, record, revision };
    await expect(store.read({ identity: firstIdentity })).resolves.toEqual({ status: 'found', stored });
    await expect(store.list({})).resolves.toEqual({ status: 'ready', records: [stored], nextCursor: null, hasNext: false });
    // New authority remains closed, even when its known fields are valid.
    const freshRecord = { ...base, retired: true };
    await expect(store.createExpectedAbsent({ identity: firstIdentity, kind: 'remote_settlement.v1', record: freshRecord })).resolves.toEqual({ status: 'unavailable' });
    expect(write).not.toHaveBeenCalled();
    row.content.v = { ...retained, actor: { ...retained.actor, assertedBy: { ...retained.actor.assertedBy, pluginId: 'other.plugin' } } };
    await expect(store.read({ identity: firstIdentity })).resolves.toEqual({ status: 'unavailable' });
  });

  it('uses only the fixed typed host route and rejects an envelope whose mode conflicts with the session', async () => {
    const record = settlementRecord();
    const revision = 'ssr1.AAAACnJlY29yZC1vbmUAAAAB';
    const write = vi.fn(async (params: Readonly<{
      identity: SessionPermissionMediationRecordIdentityV1;
      request: SessionPermissionMediationRecordWriteRequest;
    }>) => ({
      ...params.identity,
      kind: params.request.kind,
      content: params.request.content,
      revision,
    }));
    const read = vi.fn(async () => ({
      ...firstIdentity,
      kind: 'remote_settlement.v1' as const,
      // A plaintext Session must not reinterpret an encrypted row as data.
      content: { t: 'encrypted' as const, c: 'wrong-mode' },
      revision,
    }));
    const session = createPlainSession({
      writePermissionMediationRecord: write,
      readPermissionMediationRecord: read,
      listPermissionMediationRecords: vi.fn(async () => ({ records: [], nextCursor: null, hasNext: false })),
    });
    const store = createPermissionMediationRecordStore(session);
    expect(store).not.toBeNull();
    if (!store) throw new Error('expected typed mediation store');

    await expect(store.createExpectedAbsent({
      identity: firstIdentity,
      kind: 'remote_settlement.v1',
      record,
    })).resolves.toEqual({
      status: 'created',
      stored: {
        identity: firstIdentity,
        kind: 'remote_settlement.v1',
        record,
        revision,
      },
    });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      identity: firstIdentity,
      request: {
        kind: 'remote_settlement.v1',
        content: { t: 'plain', v: record },
        expectedRevision: null,
      },
    }));

    await expect(store.read({ identity: firstIdentity })).resolves.toEqual({ status: 'unavailable' });
  });

  it('seals an E2EE row, round trips it, and never reads a plain or undecryptable row as data', async () => {
    const ctx: SessionEncryptionContext = {
      encryptionKey: new Uint8Array(32).fill(7),
      encryptionVariant: 'dataKey',
    };
    const record = settlementRecord();
    const revision = 'ssr1.AAAACnJlY29yZC1vbmUAAAAB';
    const write = vi.fn(async (params: Readonly<{
      identity: SessionPermissionMediationRecordIdentityV1;
      request: SessionPermissionMediationRecordWriteRequest;
    }>) => ({ ...params.identity, kind: params.request.kind, content: params.request.content, revision }));
    let readContent: SessionPermissionMediationRecordStored['content'] | null = null;
    const read = vi.fn(async () => (readContent
      ? { ...firstIdentity, kind: 'remote_settlement.v1' as const, content: readContent, revision }
      : null));
    const store = createPermissionMediationRecordStore(createE2eeSession(ctx, {
      writePermissionMediationRecord: write,
      readPermissionMediationRecord: read,
    }));
    expect(store).not.toBeNull();
    if (!store) throw new Error('expected typed mediation store');

    await expect(store.createExpectedAbsent({
      identity: firstIdentity,
      kind: 'remote_settlement.v1',
      record,
    })).resolves.toEqual({
      status: 'created',
      stored: { identity: firstIdentity, kind: 'remote_settlement.v1', record, revision },
    });
    // The transport only ever observes the sealed envelope for an E2EE
    // Session: read back exactly what the host handed it.
    const sealed = write.mock.calls[0]?.[0].request.content;
    if (sealed?.t !== 'encrypted') throw new Error('expected a sealed E2EE envelope');
    expect(typeof sealed.c).toBe('string');
    // No actor or source field may survive in the transported bytes.
    expect(JSON.stringify(sealed)).not.toContain('person-1');
    expect(JSON.stringify(sealed)).not.toContain('happier.channels');

    readContent = sealed;
    await expect(store.read({ identity: firstIdentity })).resolves.toEqual({
      status: 'found',
      stored: { identity: firstIdentity, kind: 'remote_settlement.v1', record, revision },
    });

    // An E2EE Session must never reinterpret a plain row as data.
    readContent = { t: 'plain', v: record };
    await expect(store.read({ identity: firstIdentity })).resolves.toEqual({ status: 'unavailable' });

    // A row this Session cannot open is unavailable, never partially applied.
    readContent = { t: 'encrypted', c: 'bm90LWEtdmFsaWQtY2lwaGVydGV4dA==' };
    await expect(store.read({ identity: firstIdentity })).resolves.toEqual({ status: 'unavailable' });
  });

  it('fails a host ledger list closed when its transport is unavailable', async () => {
    const listPermissionMediationRecords = vi.fn(async () => {
      throw new Error('Session System Records are unavailable');
    });
    const store = createPermissionMediationRecordStore(createPlainSession({
      listPermissionMediationRecords,
    }));
    expect(store).not.toBeNull();
    if (!store) throw new Error('expected typed mediation store');

    await expect(store.list({ limit: 500 })).resolves.toEqual({ status: 'unavailable' });
    expect(listPermissionMediationRecords).toHaveBeenCalledWith({ query: { limit: 500 } });
  });

  it('prunes only through the fixed typed retention operation and preserves CAS conflicts', async () => {
    const prune = vi.fn(async () => undefined);
    const store = createPermissionMediationRecordStore(createPlainSession({
      prunePermissionMediationRecord: prune,
    }));
    expect(store).not.toBeNull();
    if (!store) throw new Error('expected typed mediation store');

    await expect(store.pruneInactive({
      identity: firstIdentity,
      expectedRevision: 'ssr1.AAAACnJlY29yZC1vbmUAAAAB',
    })).resolves.toEqual({ status: 'pruned' });
    expect(prune).toHaveBeenCalledWith({
      identity: firstIdentity,
      request: { expectedRevision: 'ssr1.AAAACnJlY29yZC1vbmUAAAAB' },
    });

    prune.mockRejectedValueOnce(Object.assign(new Error('conflict'), {
      code: 'permission_mediation_record_conflict',
    }));
    await expect(store.pruneInactive({
      identity: firstIdentity,
      expectedRevision: 'ssr1.AAAACnJlY29yZC1vbmUAAAAB',
    })).resolves.toEqual({ status: 'conflict' });
  });

  it('keeps same-request records in different turns independent through list, restart, and CAS', async () => {
    const secondIdentity = {
      ...firstIdentity,
      turnId: 'turn-2',
    } satisfies SessionPermissionMediationRecordIdentityV1;
    const rows = new Map<string, SessionPermissionMediationRecordStored>();
    const revisions = [
      'ssr1.AAAACnJlY29yZC1vbmUAAAAB',
      'ssr1.AAAACnJlY29yZC1vbmUAAAAC',
      'ssr1.AAAACnJlY29yZC1vbmUAAAAD',
    ];
    let nextVersion = 0;
    const session = createPlainSession({
      readPermissionMediationRecord: vi.fn(async ({ identity }) => rows.get(identityKey(identity)) ?? null),
      writePermissionMediationRecord: vi.fn(async ({ identity, request }) => {
        const key = identityKey(identity);
        const current = rows.get(key);
        if (request.expectedRevision === null && current) {
          throw Object.assign(new Error('conflict'), { code: 'permission_mediation_record_conflict' });
        }
        if (request.expectedRevision !== null && current?.revision !== request.expectedRevision) {
          throw Object.assign(new Error('conflict'), { code: 'permission_mediation_record_conflict' });
        }
        const stored: SessionPermissionMediationRecordStored = {
          ...identity,
          kind: request.kind,
          content: request.content,
          revision: revisions[nextVersion++]!,
        };
        rows.set(key, stored);
        return stored;
      }),
      listPermissionMediationRecords: vi.fn(async () => ({
        records: [...rows.values()],
        nextCursor: null,
        hasNext: false,
      })),
    });
    const store = createPermissionMediationRecordStore(session);
    expect(store).not.toBeNull();
    if (!store) throw new Error('expected typed mediation store');

    const first = settlementRecord(firstIdentity);
    const second = settlementRecord(secondIdentity, { settlementId: 'settlement-2' });
    const createdFirst = await store.createExpectedAbsent({
      identity: firstIdentity,
      kind: 'remote_settlement.v1',
      record: first,
    });
    const createdSecond = await store.createExpectedAbsent({
      identity: secondIdentity,
      kind: 'remote_settlement.v1',
      record: second,
    });
    expect(createdFirst.status).toBe('created');
    expect(createdSecond.status).toBe('created');
    if (createdFirst.status !== 'created') throw new Error('expected first record');

    await expect(store.list({})).resolves.toEqual(expect.objectContaining({
      status: 'ready',
      records: expect.arrayContaining([
        expect.objectContaining({ identity: firstIdentity, record: first }),
        expect.objectContaining({ identity: secondIdentity, record: second }),
      ]),
    }));

    const reloadedStore = createPermissionMediationRecordStore(session);
    expect(reloadedStore).not.toBeNull();
    if (!reloadedStore) throw new Error('expected restarted typed mediation store');
    await expect(reloadedStore.read({ identity: secondIdentity })).resolves.toEqual(expect.objectContaining({
      status: 'found',
      stored: expect.objectContaining({ identity: secondIdentity, record: second }),
    }));

    const firstAfterCas = { ...first, createdAtMs: 2 };
    await expect(store.compareAndSet({
      identity: firstIdentity,
      kind: 'remote_settlement.v1',
      record: firstAfterCas,
      expectedRevision: createdFirst.stored.revision,
    })).resolves.toEqual(expect.objectContaining({
      status: 'updated',
      stored: expect.objectContaining({ identity: firstIdentity, record: firstAfterCas }),
    }));
    await expect(reloadedStore.read({ identity: secondIdentity })).resolves.toEqual(expect.objectContaining({
      status: 'found',
      stored: expect.objectContaining({ identity: secondIdentity, record: second }),
    }));
  });

  it('fails closed when a direct or listed record separates its payload tuple from its exact stored identity', async () => {
    const record = settlementRecord();
    const secondIdentity = { ...firstIdentity, turnId: 'turn-2' };
    const directMismatchedPayload = {
      ...firstIdentity,
      kind: 'remote_settlement.v1' as const,
      content: { t: 'plain' as const, v: settlementRecord(secondIdentity) },
      revision: 'ssr1.AAAACnJlY29yZC1vbmUAAAAB',
    };
    const session = createPlainSession({
      readPermissionMediationRecord: vi.fn(async () => directMismatchedPayload),
      listPermissionMediationRecords: vi.fn(async () => ({
        records: [{
          ...secondIdentity,
          kind: 'remote_settlement.v1' as const,
          content: { t: 'plain' as const, v: record },
          revision: 'ssr1.AAAACnJlY29yZC1vbmUAAAAB',
        }],
        nextCursor: null,
        hasNext: false,
      })),
    });
    const store = createPermissionMediationRecordStore(session);
    expect(store).not.toBeNull();
    if (!store) throw new Error('expected typed mediation store');

    await expect(store.read({ identity: firstIdentity })).resolves.toEqual({ status: 'unavailable' });
    await expect(store.list({})).resolves.toEqual({ status: 'unavailable' });
  });
});
