import {
  EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1,
  EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1,
  EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1,
  ExternalShareableTranscriptPageV1Schema,
  ExternalShareableActorV1Schema,
  filterExternalShareableOriginForCallerV1,
  isExternalShareableTranscriptWirePayloadWithinLimitV1,
  readSessionInputAuthorityV1,
  readSessionMessageProvenanceV1,
  type ExternalShareableOriginV1,
  type ExternalShareableTranscriptPageV1,
  type ExternalShareableTranscriptItemV1,
  type SessionTurnV1,
} from '@happier-dev/protocol';

import type { RawTranscriptRow } from '@/session/replay/fetchEncryptedTranscriptMessages';

import { tryResolveDecryptedTranscriptPayload } from './transcriptHistoryRows';
import { decodeTranscriptBody } from './transcriptBodyDecoder';

const MAX_TEXT_CODE_POINTS = 50_000;

type ProjectableTranscriptRow = RawTranscriptRow & Readonly<{
  id?: unknown;
  seq?: unknown;
  localId?: unknown;
  messageRole?: unknown;
  sidechainId?: unknown;
  createdAt?: unknown;
  externalShareableActor?: unknown;
}>;

type EncryptionContext = Readonly<{
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
}> | null;

function readSafeSeq(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function containsAtMostCodePoints(value: string, maximum: number): boolean {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count > maximum) return false;
  }
  return true;
}

function findOwningTurn(turns: readonly SessionTurnV1[], seq: number): SessionTurnV1 | null {
  const explicit = turns.find((turn) =>
    turn.transcriptAnchors?.userMessageSeqs?.includes(seq) === true
    || turn.transcriptAnchors?.finalAssistantMessageSeq === seq);
  if (explicit) return explicit;
  return turns.find((turn) => {
    const start = readSafeSeq(turn.transcriptAnchors?.startSeqInclusive);
    if (start === null || seq < start) return false;
    const end = readSafeSeq(turn.transcriptAnchors?.endSeqInclusive);
    return end !== null ? seq <= end : turn.status === 'in_progress';
  }) ?? null;
}

function isRolledBack(turn: SessionTurnV1): boolean {
  return turn.rollback?.state === 'rolled_back';
}

function deriveExternalOrigin(params: Readonly<{
  authority: NonNullable<ReturnType<typeof readSessionInputAuthorityV1>>;
  provenance: ReturnType<typeof readSessionMessageProvenanceV1>;
  externalShareableActor: unknown;
  callerPluginId?: string | null;
}>): ExternalShareableOriginV1 | null {
  const actor = ExternalShareableActorV1Schema.safeParse(params.externalShareableActor);
  if (!actor.success) return null;
  const externalDescriptor = params.authority.producer === 'pluginSession'
    && params.provenance?.kind === 'pluginSession'
    && params.provenance.externalActor !== undefined
    && params.provenance.contentProvenance !== undefined
    ? {
        externalActor: params.provenance.externalActor,
        contentProvenance: params.provenance.contentProvenance,
      }
    : {};
  return filterExternalShareableOriginForCallerV1({
    origin: {
      v: 1,
      producer: params.authority.producer,
      actor: actor.data,
      ...externalDescriptor,
      ...(params.authority.sourceAuthority
        ? {
            sourceAuthority: {
              mediatorPluginId: params.authority.sourceAuthority.mediatorPluginId,
              sourceRef: params.authority.sourceAuthority.sourceRef,
              sourceRevisionOrEpoch: params.authority.sourceAuthority.sourceRevisionOrEpoch,
            },
          }
        : {}),
    },
    callerPluginId: params.callerPluginId,
  });
}

function deriveExternalHistoryOrigin(params: Readonly<{
  meta: unknown;
  externalShareableActor: unknown;
  callerPluginId?: string | null;
}>): ExternalShareableOriginV1 | null {
  const provenance = readSessionMessageProvenanceV1(params.meta);
  if (
    provenance?.kind !== 'host'
    || provenance.producer !== 'externalSessionHistory'
  ) {
    return null;
  }
  const actor = ExternalShareableActorV1Schema.safeParse(params.externalShareableActor);
  if (!actor.success || actor.data !== 'machine') return null;
  return filterExternalShareableOriginForCallerV1({
    origin: {
      v: 1,
      producer: 'externalSessionHistory',
      actor: actor.data,
    },
    callerPluginId: params.callerPluginId,
  });
}

function deriveUserFact(params: Readonly<{
  sessionId: string;
  row: ProjectableTranscriptRow;
  ctx: EncryptionContext;
  callerPluginId?: string | null;
}>): Extract<ExternalShareableTranscriptItemV1, { kind: 'userText' }> | null {
  const seq = readSafeSeq(params.row.seq);
  const itemId = typeof params.row.id === 'string' && params.row.id.length > 0 ? params.row.id : null;
  const localId = typeof params.row.localId === 'string' && params.row.localId.length > 0 ? params.row.localId : null;
  if (seq === null || !itemId || !localId || params.row.sidechainId != null) return null;
  const decrypted = tryResolveDecryptedTranscriptPayload({ content: params.row.content, ctx: params.ctx });
  const record = asRecord(decrypted);
  const decoded = decodeTranscriptBody(decrypted);
  if (!record || decoded?.semanticRole !== 'user' || !decoded.text || !containsAtMostCodePoints(decoded.text, MAX_TEXT_CODE_POINTS)) {
    return null;
  }
  const historicalOrigin = deriveExternalHistoryOrigin({
    meta: record.meta,
    externalShareableActor: params.row.externalShareableActor,
    callerPluginId: params.callerPluginId,
  });
  const authority = historicalOrigin ? null : readSessionInputAuthorityV1(record.meta);
  const provenance = historicalOrigin ? null : readSessionMessageProvenanceV1(record.meta);
  const origin = historicalOrigin ?? (authority
    ? deriveExternalOrigin({
      authority,
      provenance,
      externalShareableActor: params.row.externalShareableActor,
      callerPluginId: params.callerPluginId,
    })
    : null);
  if (!origin) return null;
  return {
    kind: 'userText',
    sessionId: params.sessionId,
    seq,
    itemId,
    localId,
    text: decoded.text,
    origin,
  };
}

function deriveAssistantText(params: Readonly<{
  row: ProjectableTranscriptRow;
  ctx: EncryptionContext;
}>): Readonly<{ seq: number; itemId: string; text: string }> | null {
  const seq = readSafeSeq(params.row.seq);
  const itemId = typeof params.row.id === 'string' && params.row.id.length > 0 ? params.row.id : null;
  if (seq === null || !itemId || params.row.sidechainId != null) return null;
  const decrypted = tryResolveDecryptedTranscriptPayload({ content: params.row.content, ctx: params.ctx });
  const decoded = decodeTranscriptBody(decrypted);
  if (decoded?.semanticRole !== 'assistant' || !decoded.text || !containsAtMostCodePoints(decoded.text, MAX_TEXT_CODE_POINTS)) {
    return null;
  }
  return { seq, itemId, text: decoded.text };
}

export async function projectExternalShareableTranscriptPage(params: Readonly<{
  sessionId: string;
  rows: readonly ProjectableTranscriptRow[];
  turns: readonly SessionTurnV1[];
  ctx: EncryptionContext;
  callerPluginId?: string | null;
  cursorSeq: number;
  limit: number;
  upstreamHasMore: boolean;
  publicationBlocked: boolean;
  publicationBlockedFromSeq?: number;
  turnSettlementBlockedFromSeq?: number;
  referencedUserRows?: readonly ProjectableTranscriptRow[];
}>): Promise<ExternalShareableTranscriptPageV1> {
  const rows = [...params.rows]
    .filter((row) => (readSafeSeq(row.seq) ?? -1) > params.cursorSeq)
    .sort((left, right) => (readSafeSeq(left.seq) ?? 0) - (readSafeSeq(right.seq) ?? 0));
  const boundedRows = rows.slice(0, EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1);
  const limit = Math.max(
    1,
    Math.min(EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1, Math.floor(params.limit)),
  );
  const items: ExternalShareableTranscriptItemV1[] = [];
  const rowBySeq = new Map<number, ProjectableTranscriptRow>();
  for (const row of (params.referencedUserRows ?? []).slice(
    0,
    EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1,
  )) {
    const seq = readSafeSeq(row.seq);
    if (seq !== null) rowBySeq.set(seq, row);
  }
  for (const row of rows) {
    const seq = readSafeSeq(row.seq);
    if (seq !== null) rowBySeq.set(seq, row);
  }
  const publicationBlockedFromSeq = readSafeSeq(params.publicationBlockedFromSeq);
  const turnSettlementBlockedFromSeq = readSafeSeq(params.turnSettlementBlockedFromSeq);
  const hasMoreOutsideBoundedRows = publicationBlockedFromSeq !== null
    || turnSettlementBlockedFromSeq !== null
    || params.publicationBlocked
    || params.upstreamHasMore
    || rows.length > boundedRows.length;
  const buildPage = (state: Readonly<{
    items: readonly ExternalShareableTranscriptItemV1[];
    scannedThroughSeq: number;
    hasMore: boolean;
  }>) => ({
    items: [...state.items],
    ...(state.scannedThroughSeq > params.cursorSeq ? { nextCursor: String(state.scannedThroughSeq) } : {}),
    scannedThroughSeq: state.scannedThroughSeq,
    hasMore: state.hasMore,
  });
  let lastFittingPage = buildPage({
    items,
    scannedThroughSeq: params.cursorSeq,
    hasMore: hasMoreOutsideBoundedRows || boundedRows.length > 0,
  });

  const resolveUserFact = (seq: number) => {
    const row = rowBySeq.get(seq);
    return row ? deriveUserFact({
      sessionId: params.sessionId,
      row,
      ctx: params.ctx,
      callerPluginId: params.callerPluginId,
    }) : null;
  };

  for (let rowIndex = 0; rowIndex < boundedRows.length; rowIndex += 1) {
    const row = boundedRows[rowIndex]!;
    const seq = readSafeSeq(row.seq);
    if (seq === null) continue;
    if (publicationBlockedFromSeq !== null && seq >= publicationBlockedFromSeq) {
      break;
    }
    if (turnSettlementBlockedFromSeq !== null && seq >= turnSettlementBlockedFromSeq) {
      break;
    }
    const turn = findOwningTurn(params.turns, seq);

    let candidate: ExternalShareableTranscriptItemV1 | null = null;
    // Historical source facts intentionally have no turn or Pending admission. They are visible
    // only when the host provenance and Server-derived machine actor both prove that exact origin.
    const standaloneHistoricalFact = !turn ? await resolveUserFact(seq) : null;
    if (standaloneHistoricalFact?.origin.producer === 'externalSessionHistory') {
      candidate = standaloneHistoricalFact;
    } else {
      const finalAnchorWasSettled = turn?.transcriptAnchors
        ? Object.prototype.hasOwnProperty.call(turn.transcriptAnchors, 'finalAssistantMessageSeq')
        : false;
      if (turn?.status === 'completed' && finalAnchorWasSettled && !isRolledBack(turn)) {
        if (turn.transcriptAnchors?.userMessageSeqs?.includes(seq)) {
          candidate = await resolveUserFact(seq);
        } else if (turn.transcriptAnchors?.finalAssistantMessageSeq === seq) {
          const assistant = deriveAssistantText({ row, ctx: params.ctx });
          const userSeqs = turn.transcriptAnchors.userMessageSeqs;
          if (assistant && userSeqs && userSeqs.length <= EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1) {
            const consumedInputs = userSeqs.map((userSeq) => resolveUserFact(userSeq));
            if (consumedInputs.every((fact) => fact !== null)) {
              candidate = {
                kind: 'assistantText',
                sessionId: params.sessionId,
                seq: assistant.seq,
                itemId: assistant.itemId,
                turnId: turn.turnId,
                final: 'completed',
                text: assistant.text,
                consumedInputs: consumedInputs.map((fact) => ({
                  localId: fact!.localId,
                  origin: fact!.origin,
                })),
              };
            }
          }
        }
      }
    }

    const nextConsumedInputCount = candidate?.kind === 'assistantText'
      ? candidate.consumedInputs.length
      : 0;
    const emittedConsumedInputCount = items.reduce(
      (total, item) => total + (item.kind === 'assistantText' ? item.consumedInputs.length : 0),
      0,
    );
    const nextCandidate = candidate !== null
      && items.length < limit
      && emittedConsumedInputCount + nextConsumedInputCount <= EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1
      ? candidate
      : null;
    const nextItems = nextCandidate ? [...items, nextCandidate] : items;
    const nextPage = buildPage({
      items: nextItems,
      scannedThroughSeq: seq,
      hasMore: hasMoreOutsideBoundedRows || rowIndex < boundedRows.length - 1,
    });
    if (!isExternalShareableTranscriptWirePayloadWithinLimitV1(nextPage)) {
      return ExternalShareableTranscriptPageV1Schema.parse({
        ...lastFittingPage,
        hasMore: true,
      });
    }
    if (nextCandidate) items.push(nextCandidate);
    lastFittingPage = nextPage;
    if (items.length >= limit) {
      break;
    }
  }

  return ExternalShareableTranscriptPageV1Schema.parse(lastFittingPage);
}
