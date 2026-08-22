import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1,
  isExternalShareableTranscriptWirePayloadWithinLimitV1,
} from '@happier-dev/protocol';

import { projectExternalShareableTranscriptPage } from './projectExternalShareableTranscriptPage';

const authority = {
  v: 1 as const,
  producer: 'pluginSession' as const,
  caller: { kind: 'plugin' as const, pluginId: 'com.example.channel', contributionLocalId: 'channel' },
  sourceAuthority: {
    mediatorPluginId: 'com.example.channel',
    sourceRef: 'thread-7',
    sourceRevisionOrEpoch: '8',
    remoteApprovalMaxScope: 'off' as const,
  },
  permission: { requestedPermissionCeiling: 'read-only' as const, admittedPermissionCeiling: 'read-only' as const },
};

function row(seq: number, role: 'user' | 'agent', text: string, extras: Record<string, unknown> = {}) {
  return {
    id: `m${seq}`,
    seq,
    localId: `local-${seq}`,
    messageRole: role,
    sidechainId: null,
    createdAt: seq,
    content: { t: 'plain' as const, v: {
      role,
      content: { type: 'text', text },
      ...(role === 'user' ? { meta: { happierInputAuthorityV1: authority } } : {}),
    } },
    ...(role === 'user' ? { externalShareableActor: 'machine' as const } : {}),
    ...extras,
  };
}

const completedTurn = {
  turnId: 'turn-1',
  status: 'completed' as const,
  startedAt: 1,
  updatedAt: 3,
  transcriptAnchors: {
    startSeqInclusive: 1,
    endSeqInclusive: 3,
    userMessageSeqs: [1],
    finalAssistantMessageSeq: 3,
  },
};

describe('projectExternalShareableTranscriptPage', () => {
  it('returns completed exact user/final-assistant facts and filters source detail by caller', async () => {
    const rows = [
      row(1, 'user', 'hello', {
        content: {
          t: 'plain' as const,
          v: {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'hello' },
            meta: {
              happierInputAuthorityV1: authority,
              happierProvenanceV1: {
                v: 1 as const,
                kind: 'pluginSession' as const,
                pluginId: 'com.example.channel',
                contributionLocalId: 'channel',
                surface: 'background' as const,
                externalActor: { kind: 'human' as const, displayNameSnapshot: 'Ada' },
                contentProvenance: 'forwarded' as const,
              },
            },
          },
        },
      }),
      row(2, 'agent', 'draft'),
      row(3, 'agent', 'final'),
    ];
    const page = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1', rows, turns: [completedTurn], ctx: null, callerPluginId: 'com.example.channel',
      cursorSeq: 0, limit: 20, upstreamHasMore: false, publicationBlocked: false,
    });

    expect(page.items).toEqual([
      expect.objectContaining({ kind: 'userText', seq: 1, origin: expect.objectContaining({
        sourceAuthority: expect.objectContaining({ sourceRef: 'thread-7' }),
        externalActor: { kind: 'human', displayNameSnapshot: 'Ada' },
        contentProvenance: 'forwarded',
      }) }),
      expect.objectContaining({
        kind: 'assistantText',
        seq: 3,
        consumedInputs: [expect.objectContaining({
          localId: 'local-1',
          origin: expect.objectContaining({
            externalActor: { kind: 'human', displayNameSnapshot: 'Ada' },
            contentProvenance: 'forwarded',
          }),
        })],
      }),
    ]);
    expect(page).toMatchObject({ scannedThroughSeq: 3, nextCursor: '3', hasMore: false });

    const otherCaller = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1', rows: [rows[0]!], turns: [completedTurn], ctx: null, callerPluginId: 'other.plugin',
      cursorSeq: 0, limit: 20, upstreamHasMore: false, publicationBlocked: false,
    });
    expect(otherCaller.items[0]?.kind === 'userText' && otherCaller.items[0].origin).not.toHaveProperty('sourceAuthority');
  });

  it('projects only bounded generic external descriptors while withholding authority and raw metadata', async () => {
    const externalInputs = [
      {
        seq: 1,
        externalActor: { kind: 'human' as const, displayNameSnapshot: 'Ada' },
        contentProvenance: 'original' as const,
      },
      {
        seq: 2,
        externalActor: { kind: 'human' as const, displayNameSnapshot: 'Forwarder' },
        contentProvenance: 'forwarded' as const,
      },
      {
        seq: 3,
        externalActor: { kind: 'bot' as const, displayNameSnapshot: 'Relay' },
        contentProvenance: 'viaBot' as const,
      },
    ];
    const principalId = 'provider-principal-private';
    const rawProviderPayload = 'provider-payload-private';
    const rows = externalInputs.map((input) => row(input.seq, 'user', `message-${input.seq}`, {
      content: {
        t: 'plain' as const,
        v: {
          role: 'user' as const,
          content: { type: 'text' as const, text: `message-${input.seq}` },
          meta: {
            happierInputAuthorityV1: authority,
            happierProvenanceV1: {
              v: 1 as const,
              kind: 'pluginSession' as const,
              pluginId: 'com.example.channel',
              contributionLocalId: 'channel',
              surface: 'background' as const,
              sourceRef: 'thread-7',
              sourceRevisionOrEpoch: '8',
              externalActor: input.externalActor,
              contentProvenance: input.contentProvenance,
            },
            principalId,
            rawProviderPayload,
          },
        },
      },
    }));
    const turns = externalInputs.map((input) => ({
      ...completedTurn,
      turnId: `turn-${input.seq}`,
      transcriptAnchors: {
        startSeqInclusive: input.seq,
        endSeqInclusive: input.seq,
        userMessageSeqs: [input.seq],
        finalAssistantMessageSeq: null,
      },
    }));

    const page = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1',
      rows,
      turns,
      ctx: null,
      callerPluginId: 'other.plugin',
      cursorSeq: 0,
      limit: 20,
      upstreamHasMore: false,
      publicationBlocked: false,
    });

    expect(page.items).toMatchObject(externalInputs.map((input) => ({
      kind: 'userText',
      seq: input.seq,
      origin: {
        v: 1,
        producer: 'pluginSession',
        actor: 'machine',
        externalActor: input.externalActor,
        contentProvenance: input.contentProvenance,
      },
    })));
    for (const item of page.items) {
      expect(item.kind).toBe('userText');
      if (item.kind === 'userText') expect(item.origin).not.toHaveProperty('sourceAuthority');
    }
    expect(JSON.stringify(page)).not.toContain(principalId);
    expect(JSON.stringify(page)).not.toContain(rawProviderPayload);
  });

  it('keeps an eligible item visible from the server-derived actor while never projecting a raw admission receipt', async () => {
    const actorAccountId = 'account-private-actor-id';
    const source = row(1, 'user', 'hello', {
      inputAdmissionReceipt: {
        v: 1,
        issuer: 'authenticatedAccount',
        actorAccountId,
        sessionRelationship: 'sharedEditor',
      },
      externalShareableActor: 'collaborator',
    });
    const page = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1', rows: [source], turns: [completedTurn], ctx: null,
      cursorSeq: 0, limit: 20, upstreamHasMore: false, publicationBlocked: false,
    });

    expect(page.items).toEqual([
      expect.objectContaining({
        kind: 'userText',
        origin: expect.objectContaining({ actor: 'collaborator' }),
      }),
    ]);
    expect(JSON.stringify(page)).not.toContain(actorAccountId);
    expect(JSON.stringify(page)).not.toContain('sharedEditor');
  });

  it('does not infer an external actor from a raw receipt when the Server did not admit one', async () => {
    const source = row(1, 'user', 'hello', {
      externalShareableActor: undefined,
      inputAdmissionReceipt: {
        v: 1,
        issuer: 'authenticatedAccount',
        actorAccountId: 'account-private-actor-id',
        sessionRelationship: 'owner',
      },
    });
    const page = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1', rows: [source], turns: [completedTurn], ctx: null,
      cursorSeq: 0, limit: 20, upstreamHasMore: false, publicationBlocked: false,
    });

    expect(page.items).toEqual([]);
  });

  it('projects only host-stamped external history without treating imported user rows as admitted input', async () => {
    const sourceFact = row(1, 'user', 'historical user fact', {
      content: {
        t: 'plain' as const,
        v: {
          role: 'user',
          content: { type: 'text', text: 'historical user fact' },
          meta: {
            happierProvenanceV1: {
              v: 1,
              kind: 'host',
              producer: 'externalSessionHistory',
            },
          },
        },
      },
      externalShareableActor: 'machine',
    });
    const ordinaryImportedUser = row(2, 'user', 'ordinary imported user row', {
      content: {
        t: 'plain' as const,
        v: {
          role: 'user',
          content: { type: 'text', text: 'ordinary imported user row' },
          meta: {},
        },
      },
      externalShareableActor: 'machine',
    });
    const final = row(3, 'agent', 'final');
    const turn = {
      ...completedTurn,
      transcriptAnchors: {
        ...completedTurn.transcriptAnchors,
        userMessageSeqs: [1, 2],
      },
    };
    const page = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1', rows: [sourceFact, ordinaryImportedUser, final], turns: [turn], ctx: null,
      cursorSeq: 0, limit: 20, upstreamHasMore: false, publicationBlocked: false,
    });

    expect(page.items).toEqual([
      expect.objectContaining({
        kind: 'userText',
        seq: 1,
        origin: {
          v: 1,
          producer: 'externalSessionHistory',
          actor: 'machine',
        },
      }),
    ]);
    expect(JSON.stringify(page)).not.toContain('happierInputAuthorityV1');
    expect(JSON.stringify(page)).not.toContain('ordinary imported user row');
  });

  it('projects a turnless host-stamped external history fact while keeping a generic imported user row hidden', async () => {
    const sourceFact = row(1, 'user', 'historical user fact', {
      content: {
        t: 'plain' as const,
        v: {
          role: 'user',
          content: { type: 'text', text: 'historical user fact' },
          meta: {
            happierProvenanceV1: {
              v: 1,
              kind: 'host',
              producer: 'externalSessionHistory',
            },
          },
        },
      },
      externalShareableActor: 'machine',
    });
    const ordinaryImportedUser = row(2, 'user', 'ordinary imported user row', {
      content: {
        t: 'plain' as const,
        v: {
          role: 'user',
          content: { type: 'text', text: 'ordinary imported user row' },
          meta: {},
        },
      },
      externalShareableActor: 'machine',
    });

    const page = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1',
      rows: [sourceFact, ordinaryImportedUser],
      turns: [],
      ctx: null,
      cursorSeq: 0,
      limit: 20,
      upstreamHasMore: false,
      publicationBlocked: false,
    });

    expect(page).toEqual({
      items: [expect.objectContaining({
        kind: 'userText',
        seq: 1,
        origin: {
          v: 1,
          producer: 'externalSessionHistory',
          actor: 'machine',
        },
      })],
      nextCursor: '2',
      scannedThroughSeq: 2,
      hasMore: false,
    });
  });

  it('does not advance through a server-authoritative hidden-turn barrier', async () => {
    const pendingRow = row(7, 'user', 'pending');
    const snapshotPageRequest = {
      sessionId: 'session-1',
      rows: [pendingRow],
      turns: [],
      ctx: null,
      cursorSeq: 0,
      limit: 20,
      upstreamHasMore: true,
      publicationBlocked: true,
      publicationBlockedFromSeq: 7,
    };
    const page = await projectExternalShareableTranscriptPage(snapshotPageRequest);

    expect(page).toEqual({ items: [], scannedThroughSeq: 0, hasMore: true });
  });

  it('keeps hasMore true for publication and settlement barriers beyond the returned rows', async () => {
    const publicationBlocked = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1',
      rows: [],
      turns: [],
      ctx: null,
      cursorSeq: 0,
      limit: 20,
      upstreamHasMore: false,
      publicationBlocked: false,
      publicationBlockedFromSeq: 7,
    });
    expect(publicationBlocked).toEqual({ items: [], scannedThroughSeq: 0, hasMore: true });

    const settlementBlocked = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1',
      rows: [row(1, 'user', 'unsettled later barrier')],
      turns: [],
      ctx: null,
      cursorSeq: 0,
      limit: 20,
      upstreamHasMore: false,
      publicationBlocked: false,
      turnSettlementBlockedFromSeq: 7,
    });
    expect(settlementBlocked).toEqual({ items: [], nextCursor: '1', scannedThroughSeq: 1, hasMore: true });
  });

  it('uses the server settlement barrier rather than reconstructing transient turn state', async () => {
    const active = { ...completedTurn, status: 'in_progress' as const, transcriptAnchors: { ...completedTurn.transcriptAnchors, finalAssistantMessageSeq: undefined } };
    const blocked = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1', rows: [row(1, 'user', 'hello')], turns: [active], ctx: null, cursorSeq: 0,
      limit: 20, upstreamHasMore: true, publicationBlocked: false, turnSettlementBlockedFromSeq: 1,
    });
    expect(blocked).toEqual({ items: [], scannedThroughSeq: 0, hasMore: true });

    const rolledBack = { ...completedTurn, rollback: { state: 'rolled_back' as const, updatedAt: 4 } };
    const crossed = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1', rows: [row(1, 'user', 'hello'), row(3, 'agent', 'final')], turns: [rolledBack], ctx: null,
      cursorSeq: 0, limit: 20, upstreamHasMore: false, publicationBlocked: false,
    });
    expect(crossed).toEqual({ items: [], nextCursor: '3', scannedThroughSeq: 3, hasMore: false });

    const retriedAfterDelivery = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1', rows: [row(1, 'user', 'hello'), row(3, 'agent', 'final')], turns: [rolledBack], ctx: null,
      cursorSeq: 3, limit: 20, upstreamHasMore: false, publicationBlocked: false,
    });
    expect(retriedAfterDelivery).toEqual({ items: [], scannedThroughSeq: 3, hasMore: false });
  });

  it('uses same-snapshot exact consumed input anchors after crossing more than 100 semantic rows', async () => {
    const input = row(1, 'user', 'hello');
    const final = row(102, 'agent', 'final');
    const page = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1', rows: [row(101, 'agent', 'draft'), final], ctx: null,
      turns: [{ ...completedTurn, transcriptAnchors: { ...completedTurn.transcriptAnchors, endSeqInclusive: 102, finalAssistantMessageSeq: 102 } }],
      cursorSeq: 100, limit: 20, upstreamHasMore: false, publicationBlocked: false,
      referencedUserRows: [input],
    });
    expect(page.items).toEqual([expect.objectContaining({ kind: 'assistantText', seq: 102 })]);
    expect(page.scannedThroughSeq).toBe(102);
  });

  it('crosses a terminal-unshareable final when no server settlement barrier exists', async () => {
    const final = row(4, 'agent', 'final');
    const page = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1',
      rows: [final],
      ctx: null,
      turns: [{
        ...completedTurn,
        transcriptAnchors: {
          startSeqInclusive: 1,
          endSeqInclusive: 4,
          userMessageSeqs: [1],
          finalAssistantMessageSeq: 4,
        },
      }],
      cursorSeq: 0,
      limit: 20,
      upstreamHasMore: false,
      publicationBlocked: false,
    });

    expect(page).toEqual({ items: [], nextCursor: '4', scannedThroughSeq: 4, hasMore: false });
  });

  it('holds a final with unresolved exact inputs only when the server witness marks settlement pending', async () => {
    const final = row(4, 'agent', 'final');
    const page = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1',
      rows: [final],
      ctx: null,
      turns: [{
        ...completedTurn,
        transcriptAnchors: {
          startSeqInclusive: 1,
          endSeqInclusive: 4,
          userMessageSeqs: [1],
          finalAssistantMessageSeq: 4,
        },
      }],
      cursorSeq: 0,
      limit: 20,
      upstreamHasMore: false,
      publicationBlocked: false,
      turnSettlementBlockedFromSeq: 4,
    });

    expect(page).toEqual({ items: [], scannedThroughSeq: 0, hasMore: true });
  });

  it('joins every exact consumed input in anchor order and never guesses a null final assistant', async () => {
    const rows = [
      row(1, 'user', 'first'),
      row(2, 'user', 'second'),
      row(3, 'agent', 'draft'),
      row(4, 'agent', 'final'),
    ];
    const turn = {
      ...completedTurn,
      transcriptAnchors: {
        startSeqInclusive: 1,
        endSeqInclusive: 4,
        userMessageSeqs: [2, 1],
        finalAssistantMessageSeq: 4,
      },
    };
    const page = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1', rows, turns: [turn], ctx: null, cursorSeq: 0,
      limit: 20, upstreamHasMore: false, publicationBlocked: false,
    });
    expect(page.items.at(-1)).toMatchObject({
      kind: 'assistantText',
      seq: 4,
      consumedInputs: [{ localId: 'local-2' }, { localId: 'local-1' }],
    });

    const nullFinal = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1', rows, turns: [{
        ...turn,
      transcriptAnchors: { ...turn.transcriptAnchors, finalAssistantMessageSeq: null },
      }], ctx: null, cursorSeq: 0, limit: 20, upstreamHasMore: false, publicationBlocked: false,
    });
    expect(nullFinal.items).toEqual([
      expect.objectContaining({ kind: 'userText', seq: 1 }),
      expect.objectContaining({ kind: 'userText', seq: 2 }),
    ]);
    expect(nullFinal).toMatchObject({ nextCursor: '4', scannedThroughSeq: 4, hasMore: false });
  });

  it('keeps a fitting prefix when aggregate candidates would exceed the serialized page ceiling', async () => {
    const userSeqs = Array.from({ length: 50 }, (_, index) => index + 1);
    const rows = userSeqs.map((seq) => row(seq, 'user', 'x'.repeat(50_000)));
    rows[0] = row(1, 'user', 'x'.repeat(50_001));
    const page = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1', rows, turns: [{
        ...completedTurn,
        transcriptAnchors: {
          startSeqInclusive: 1,
          endSeqInclusive: 50,
          userMessageSeqs: userSeqs,
          finalAssistantMessageSeq: null,
        },
      }], ctx: null, cursorSeq: 0, limit: 100, upstreamHasMore: false, publicationBlocked: false,
    });
    expect(page.items.some((item) => item.seq === 1)).toBe(false);
    expect(page.items.map((item) => item.seq)).toEqual(Array.from({ length: 41 }, (_, index) => index + 2));
    expect(isExternalShareableTranscriptWirePayloadWithinLimitV1(page)).toBe(true);
    expect(page).toMatchObject({ nextCursor: '42', scannedThroughSeq: 42, hasMore: true });
  });

  it('returns the last fitting cursor checkpoint when an unshareable tail expands the final envelope', async () => {
    const trailingSeq = Number.MAX_SAFE_INTEGER;
    const emittedSeqs = Array.from({ length: 42 }, (_, index) => index + 1);
    const projectedItemsWithEmptyTail = emittedSeqs.map((seq, index) => ({
      kind: 'userText' as const,
      sessionId: 'session-1',
      seq,
      itemId: `m${seq}`,
      localId: `local-${seq}`,
      text: index === emittedSeqs.length - 1 ? '' : 'x'.repeat(50_000),
      origin: { v: 1 as const, producer: 'pluginSession' as const, actor: 'machine' as const },
    }));
    const provisionalEnvelope = {
      items: projectedItemsWithEmptyTail,
      nextCursor: String(emittedSeqs.at(-1)),
      scannedThroughSeq: emittedSeqs.at(-1),
      hasMore: true,
    };
    const provisionalBytes = new TextEncoder().encode(JSON.stringify(provisionalEnvelope)).byteLength;
    const finalTailTextLength = EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1 - provisionalBytes;
    expect(finalTailTextLength).toBeGreaterThan(0);
    expect(finalTailTextLength).toBeLessThanOrEqual(50_000);

    const rows = [
      ...emittedSeqs.map((seq, index) => row(
        seq,
        'user',
        index === emittedSeqs.length - 1 ? 'x'.repeat(finalTailTextLength) : 'x'.repeat(50_000),
      )),
      row(trailingSeq, 'agent', 'terminally unshareable trailing row'),
    ];
    const provisionalWithLastCandidate = {
      ...provisionalEnvelope,
      items: [
        ...projectedItemsWithEmptyTail.slice(0, -1),
        { ...projectedItemsWithEmptyTail.at(-1)!, text: 'x'.repeat(finalTailTextLength) },
      ],
    };
    const actualEnvelope = {
      ...provisionalWithLastCandidate,
      nextCursor: String(trailingSeq),
      scannedThroughSeq: trailingSeq,
      hasMore: false,
    };
    expect(isExternalShareableTranscriptWirePayloadWithinLimitV1(provisionalWithLastCandidate)).toBe(true);
    expect(isExternalShareableTranscriptWirePayloadWithinLimitV1(actualEnvelope)).toBe(false);

    const page = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1',
      rows,
      turns: [{
        ...completedTurn,
        transcriptAnchors: {
          startSeqInclusive: 1,
          endSeqInclusive: emittedSeqs.at(-1),
          userMessageSeqs: emittedSeqs,
          finalAssistantMessageSeq: null,
        },
      }],
      ctx: null,
      cursorSeq: 0,
      limit: 100,
      upstreamHasMore: false,
      publicationBlocked: false,
    });

    expect(page.items.map((item) => item.seq)).toEqual(emittedSeqs);
    expect(page).toMatchObject({
      nextCursor: String(emittedSeqs.at(-1)),
      scannedThroughSeq: emittedSeqs.at(-1),
      hasMore: true,
    });
    expect(isExternalShareableTranscriptWirePayloadWithinLimitV1(page)).toBe(true);
  });

  it('does not cross a fitting prefix when the next candidate exceeds the final wire envelope', async () => {
    const emittedSeqs = Array.from({ length: 42 }, (_, index) => index + 1);
    const prefixSeqs = emittedSeqs.slice(0, -1);
    const projectedPrefix = prefixSeqs.map((seq) => ({
      kind: 'userText' as const,
      sessionId: 'session-1',
      seq,
      itemId: `m${seq}`,
      localId: `local-${seq}`,
      text: 'x'.repeat(50_000),
      origin: { v: 1 as const, producer: 'pluginSession' as const, actor: 'machine' as const },
    }));
    const tailTemplate = {
      kind: 'userText' as const,
      sessionId: 'session-1',
      seq: emittedSeqs.at(-1)!,
      itemId: `m${emittedSeqs.at(-1)!}`,
      localId: `local-${emittedSeqs.at(-1)!}`,
      text: '',
      origin: { v: 1 as const, producer: 'pluginSession' as const, actor: 'machine' as const },
    };
    const candidateWithEmptyTail = {
      items: [...projectedPrefix, tailTemplate],
      nextCursor: String(emittedSeqs.at(-1)),
      scannedThroughSeq: emittedSeqs.at(-1),
      hasMore: false,
    };
    const tailTextLength = EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1
      - new TextEncoder().encode(JSON.stringify(candidateWithEmptyTail)).byteLength
      + 1;
    expect(tailTextLength).toBeGreaterThan(0);
    expect(tailTextLength).toBeLessThanOrEqual(50_000);
    const checkpointEnvelope = {
      items: projectedPrefix,
      nextCursor: String(prefixSeqs.at(-1)),
      scannedThroughSeq: prefixSeqs.at(-1),
      hasMore: true,
    };
    const overflowingEnvelope = {
      ...candidateWithEmptyTail,
      items: [...projectedPrefix, { ...tailTemplate, text: 'x'.repeat(tailTextLength) }],
    };
    expect(isExternalShareableTranscriptWirePayloadWithinLimitV1(checkpointEnvelope)).toBe(true);
    expect(isExternalShareableTranscriptWirePayloadWithinLimitV1(overflowingEnvelope)).toBe(false);

    const page = await projectExternalShareableTranscriptPage({
      sessionId: 'session-1',
      rows: [
        ...prefixSeqs.map((seq) => row(seq, 'user', 'x'.repeat(50_000))),
        row(emittedSeqs.at(-1)!, 'user', 'x'.repeat(tailTextLength)),
      ],
      turns: [{
        ...completedTurn,
        transcriptAnchors: {
          startSeqInclusive: 1,
          endSeqInclusive: emittedSeqs.at(-1),
          userMessageSeqs: emittedSeqs,
          finalAssistantMessageSeq: null,
        },
      }],
      ctx: null,
      cursorSeq: 0,
      limit: 100,
      upstreamHasMore: false,
      publicationBlocked: false,
    });

    expect(page.items.map((item) => item.seq)).toEqual(prefixSeqs);
    expect(page).toMatchObject({
      nextCursor: String(prefixSeqs.at(-1)),
      scannedThroughSeq: prefixSeqs.at(-1),
      hasMore: true,
    });
    expect(isExternalShareableTranscriptWirePayloadWithinLimitV1(page)).toBe(true);
  });
});
