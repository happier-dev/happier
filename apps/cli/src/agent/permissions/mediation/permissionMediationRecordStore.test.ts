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
