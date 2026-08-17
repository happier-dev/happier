import { describe, expect, it } from 'vitest';

import {
  deriveExternalShareableActorFromAdmissionReceiptV1,
  EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1,
  EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1,
  EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1,
  EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1,
  EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SNAPSHOT_TURNS_V1,
  ExternalShareableOriginV1Schema,
  ExternalShareableTranscriptPageV1Schema,
  ExternalShareableTranscriptSnapshotV1Schema,
  filterExternalShareableOriginForCallerV1,
  isExternalShareableTranscriptWirePayloadWithinLimitV1,
} from './sessionExternalShareableTranscriptV1.js';

function userItem(seq: number) {
  return {
    kind: 'userText' as const,
    sessionId: 'session-1',
    seq,
    itemId: `message-${seq}`,
    localId: `local-${seq}`,
    text: 'hello',
    origin: { v: 1 as const, producer: 'pluginSession' as const, actor: 'machine' as const },
  };
}

function assistantItem(seq: number, consumedInputCount: number) {
  return {
    kind: 'assistantText' as const,
    sessionId: 'session-1',
    seq,
    itemId: `assistant-${seq}`,
    turnId: `turn-${seq}`,
    final: 'completed' as const,
    text: 'final',
    consumedInputs: Array.from({ length: consumedInputCount }, (_, index) => ({
      localId: `local-${seq}-${index}`,
      origin: { v: 1 as const, producer: 'pluginSession' as const, actor: 'machine' as const },
    })),
  };
}

function snapshotTurn(index: number, extra: Record<string, unknown> = {}) {
  return {
    turnId: `turn-${index}`,
    status: 'completed' as const,
    startedAt: index,
    updatedAt: index,
    ...extra,
  };
}

function referencedUserRow(index: number) {
  return {
    id: `message-${index}`,
    seq: index,
    localId: `local-${index}`,
    messageRole: 'user' as const,
    content: {
      t: 'plain' as const,
      v: {
        role: 'user' as const,
        content: { type: 'text' as const, text: 'hello' },
        meta: {},
      },
    },
    createdAt: index,
    updatedAt: index,
    externalShareableActor: 'machine' as const,
  };
}

describe('ExternalShareableTranscriptPageV1Schema', () => {
  it('derives only a coarse actor from the server-local admission receipt', () => {
    expect(deriveExternalShareableActorFromAdmissionReceiptV1({
      v: 1,
      issuer: 'authenticatedAccount',
      actorAccountId: 'account-private',
      sessionRelationship: 'sharedAdmin',
    })).toBe('collaborator');
    expect(deriveExternalShareableActorFromAdmissionReceiptV1({
      v: 1,
      issuer: 'authenticatedMachine',
    })).toBe('machine');
    expect(deriveExternalShareableActorFromAdmissionReceiptV1({
      v: 1,
      issuer: 'authenticatedAccount',
      actorAccountId: 'account-private',
      sessionRelationship: 'owner',
    })).toBe('owner');
  });

  it('accepts the closed least-disclosure transcript projection', () => {
    expect(ExternalShareableTranscriptPageV1Schema.parse({
      items: [
        {
          kind: 'userText',
          sessionId: 'session-1',
          seq: 4,
          itemId: 'message-4',
          localId: 'local-4',
          text: 'hello',
          origin: {
            v: 1,
            producer: 'pluginSession',
            actor: 'machine',
            sourceAuthority: {
              mediatorPluginId: 'com.example.channel',
              sourceRef: 'thread-7',
              sourceRevisionOrEpoch: '8',
            },
          },
        },
        {
          kind: 'assistantText',
          sessionId: 'session-1',
          seq: 7,
          itemId: 'message-7',
          turnId: 'turn-1',
          final: 'completed',
          text: 'world',
          consumedInputs: [{
            localId: 'local-4',
            origin: { v: 1, producer: 'pluginSession', actor: 'machine' },
          }],
        },
      ],
      nextCursor: '7',
      scannedThroughSeq: 7,
      hasMore: true,
    })).toMatchObject({ scannedThroughSeq: 7, hasMore: true });
  });

  it('keeps bounded external actor and content provenance while filtering only source authority', () => {
    const origin = {
      v: 1 as const,
      producer: 'pluginSession' as const,
      actor: 'machine' as const,
      externalActor: { kind: 'bot' as const, displayNameSnapshot: 'Relay' },
      contentProvenance: 'viaBot' as const,
      sourceAuthority: {
        mediatorPluginId: 'com.example.channel',
        sourceRef: 'thread-7',
        sourceRevisionOrEpoch: '8',
      },
    };

    expect(ExternalShareableOriginV1Schema.parse(origin)).toEqual(origin);
    expect(ExternalShareableOriginV1Schema.parse({
      ...origin,
      externalActor: { kind: 'human', displayNameSnapshot: 'Ada' },
      contentProvenance: 'original',
    })).toMatchObject({
      externalActor: { kind: 'human', displayNameSnapshot: 'Ada' },
      contentProvenance: 'original',
    });
    expect(filterExternalShareableOriginForCallerV1({
      origin,
      callerPluginId: 'other.plugin',
    })).toEqual({
      v: 1,
      producer: 'pluginSession',
      actor: 'machine',
      externalActor: { kind: 'bot', displayNameSnapshot: 'Relay' },
      contentProvenance: 'viaBot',
    });

    const { contentProvenance: _contentProvenance, ...withoutContentProvenance } = origin;
    const { externalActor: _externalActor, ...withoutExternalActor } = origin;
    expect(ExternalShareableOriginV1Schema.safeParse(withoutContentProvenance).success).toBe(false);
    expect(ExternalShareableOriginV1Schema.safeParse(withoutExternalActor).success).toBe(false);
    expect(ExternalShareableOriginV1Schema.safeParse({
      ...origin,
      externalActor: { kind: 'integration' },
    }).success).toBe(false);
    expect(ExternalShareableOriginV1Schema.safeParse({
      ...origin,
      externalActor: { kind: 'unknown' },
    }).success).toBe(false);
    expect(ExternalShareableOriginV1Schema.safeParse({
      ...origin,
      externalActor: { kind: 'forwarded' },
    }).success).toBe(false);
    expect(ExternalShareableOriginV1Schema.safeParse({
      ...origin,
      externalActor: { kind: 'human', principalId: 'provider-principal-private' },
    }).success).toBe(false);
    expect(ExternalShareableOriginV1Schema.safeParse({
      ...origin,
      externalActor: { kind: 'human', displayNameSnapshot: 'x'.repeat(129) },
    }).success).toBe(false);
    expect(ExternalShareableOriginV1Schema.safeParse({
      ...origin,
      externalActor: { kind: 'human', displayNameSnapshot: 'e\u0301' },
    }).success).toBe(false);
    expect(ExternalShareableOriginV1Schema.safeParse({
      ...origin,
      providerPayload: { token: 'provider-payload-private' },
    }).success).toBe(false);
  });

  it('rejects permission, account, and raw metadata disclosure', () => {
    const base = {
      items: [],
      scannedThroughSeq: 0,
      hasMore: false,
    };
    expect(ExternalShareableTranscriptPageV1Schema.safeParse({
      ...base,
      admittedPermissionCeiling: 'yolo',
    }).success).toBe(false);
    expect(ExternalShareableTranscriptPageV1Schema.safeParse({
      ...base,
      items: [{
        kind: 'userText', sessionId: 's', seq: 1, itemId: 'm', localId: 'l', text: 'x',
        origin: { v: 1, producer: 'happierApp', actor: 'owner', actorAccountId: 'secret' },
      }],
    }).success).toBe(false);
  });

  it('enforces the 50,000-code-point item bound', () => {
    expect(ExternalShareableTranscriptPageV1Schema.safeParse({
      items: [{
        kind: 'userText', sessionId: 's', seq: 1, itemId: 'm', localId: 'l',
        text: '🧠'.repeat(50_001),
        origin: { v: 1, producer: 'happierApp', actor: 'owner' },
      }],
      scannedThroughSeq: 1,
      hasMore: false,
    }).success).toBe(false);
  });

  it('accepts only server-derived settlement and exact referenced-user snapshot witnesses', () => {
    const snapshot = ExternalShareableTranscriptSnapshotV1Schema.parse({
      turns: [],
      turnSettlementBlockedFromSeq: 7,
      referencedUserRows: [{
        id: 'message-1',
        seq: 1,
        localId: 'local-1',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: {},
          },
        },
        createdAt: 1,
        updatedAt: 1,
        externalShareableActor: 'machine',
      }],
    });

    expect(snapshot).toMatchObject({
      turnSettlementBlockedFromSeq: 7,
      referencedUserRows: [{ seq: 1, localId: 'local-1' }],
    });
    expect(ExternalShareableTranscriptSnapshotV1Schema.safeParse({
      ...snapshot,
      referencedUserRows: [{
        ...snapshot.referencedUserRows[0],
        inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
      }],
    }).success).toBe(false);
  });

  it('enforces the approved 100/101 witness ceilings and total consumed-input budget', () => {
    const pageBase = { scannedThroughSeq: 0, hasMore: false };
    expect(ExternalShareableTranscriptPageV1Schema.safeParse({
      ...pageBase,
      items: Array.from(
        { length: EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1 },
        (_, index) => userItem(index + 1),
      ),
    }).success).toBe(true);
    expect(ExternalShareableTranscriptPageV1Schema.safeParse({
      ...pageBase,
      items: Array.from(
        { length: EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1 + 1 },
        (_, index) => userItem(index + 1),
      ),
    }).success).toBe(false);

    expect(ExternalShareableTranscriptSnapshotV1Schema.safeParse({
      turns: Array.from(
        { length: EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SNAPSHOT_TURNS_V1 },
        (_, index) => snapshotTurn(index + 1),
      ),
      referencedUserRows: Array.from(
        { length: EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1 },
        (_, index) => referencedUserRow(index + 1),
      ),
    }).success).toBe(true);
    expect(ExternalShareableTranscriptSnapshotV1Schema.safeParse({
      turns: Array.from(
        { length: EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SNAPSHOT_TURNS_V1 + 1 },
        (_, index) => snapshotTurn(index + 1),
      ),
    }).success).toBe(false);
    expect(ExternalShareableTranscriptSnapshotV1Schema.safeParse({
      turns: [],
      referencedUserRows: Array.from(
        { length: EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1 + 1 },
        (_, index) => referencedUserRow(index + 1),
      ),
    }).success).toBe(false);

    expect(ExternalShareableTranscriptPageV1Schema.safeParse({
      ...pageBase,
      items: [
        assistantItem(1, EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1 / 2),
        assistantItem(2, EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1 / 2),
      ],
    }).success).toBe(true);
    expect(ExternalShareableTranscriptPageV1Schema.safeParse({
      ...pageBase,
      items: [
        assistantItem(1, EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1 / 2),
        assistantItem(2, (EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1 / 2) + 1),
      ],
    }).success).toBe(false);
  });

  it('uses the one 2 MiB response ceiling for snapshots and their enclosing wire payload', () => {
    const encodedEmpty = new TextEncoder().encode(JSON.stringify({ data: '' })).byteLength;
    const exactLimitPayload = { data: 'x'.repeat(EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1 - encodedEmpty) };
    expect(isExternalShareableTranscriptWirePayloadWithinLimitV1(exactLimitPayload)).toBe(true);
    expect(isExternalShareableTranscriptWirePayloadWithinLimitV1({
      data: `${exactLimitPayload.data}x`,
    })).toBe(false);

    const oversizedSnapshot = {
      turns: [snapshotTurn(1, { witness: 'x'.repeat(EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1) })],
    };
    expect(ExternalShareableTranscriptSnapshotV1Schema.safeParse(oversizedSnapshot).success).toBe(false);
    expect(isExternalShareableTranscriptWirePayloadWithinLimitV1({
      messages: [],
      externalShareableSnapshot: oversizedSnapshot,
    })).toBe(false);
  });
});
