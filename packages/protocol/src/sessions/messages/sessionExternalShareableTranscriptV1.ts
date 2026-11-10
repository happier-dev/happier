import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PluginIdSchema } from '../../plugins/pluginId.js';
import { SessionTurnV1Schema, type SessionTurnV1 } from '../turns/sessionTurnV1.js';
import { projectTranscriptBodySemanticContent } from './transcriptBodySemanticProjection.js';
import {
  ContentProvenanceV1Schema,
  readSessionInputAuthorityV1,
  readSessionMessageProvenanceV1,
  ExternalActorV1Schema,
  SessionInputAdmissionReceiptV1Schema,
  SessionInputSourceAuthorityV1Schema,
  SessionRoleUserProducerKindV1Schema,
} from './sessionInputAdmission.js';
import { SessionStoredMessageContentSchema } from './sessionStoredMessageContent.js';

const MAX_EXTERNAL_TRANSCRIPT_TEXT_CODE_POINTS = 50_000;

/** The approved semantic-page budget; the server reads one extra row as lookahead. */
export const EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1 = 100;
export const EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SNAPSHOT_TURNS_V1 =
  EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1 + 1;
export const EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1 =
  EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1;
export const EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1 =
  EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1;
export const EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1 = 2 * 1024 * 1024;

/**
 * The same 2 MiB budget applies to the whole route response, including its
 * transaction witness. Server selection uses this helper on its response
 * envelope; Protocol schemas use it on the projection and witness shapes.
 */
export function isExternalShareableTranscriptWirePayloadWithinLimitV1(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string'
      && new TextEncoder().encode(serialized).byteLength <= EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1;
  } catch {
    return false;
  }
}

const ExternalShareableTextV1Schema = lazyZodSchema(() => z.string().check(z.refine((value) => Array.from(value).length <= MAX_EXTERNAL_TRANSCRIPT_TEXT_CODE_POINTS, `External transcript text must contain at most ${MAX_EXTERNAL_TRANSCRIPT_TEXT_CODE_POINTS} Unicode code points`)));

const ExternalShareableSourceAuthorityV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.pick(SessionInputSourceAuthorityV1Schema, {
  mediatorPluginId: true,
  sourceRef: true,
  sourceRevisionOrEpoch: true,
})));

export const ExternalShareableActorV1Schema = lazyZodSchema(() => z.enum(['owner', 'collaborator', 'machine']));
export type ExternalShareableActorV1 = z.infer<typeof ExternalShareableActorV1Schema>;

/**
 * Maps the server-only admission receipt to the one coarse fact that may
 * cross the external transcript boundary. Account identity and the exact
 * shared role remain receipt-local.
 */
export function deriveExternalShareableActorFromAdmissionReceiptV1(
  inputAdmissionReceipt: unknown,
  mode: 'input' | 'stored' = 'input',
): ExternalShareableActorV1 | null {
  const receipt = (mode === 'stored' ? createStoredReadSchema(SessionInputAdmissionReceiptV1Schema)
    : SessionInputAdmissionReceiptV1Schema).safeParse(inputAdmissionReceipt);
  if (!receipt.success) return null;
  if (receipt.data.issuer === 'authenticatedMachine') return 'machine';
  return receipt.data.sessionRelationship === 'owner' ? 'owner' : 'collaborator';
}

export const ExternalShareableOriginV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  producer: SessionRoleUserProducerKindV1Schema,
  actor: ExternalShareableActorV1Schema,
  sourceAuthority: z.optional(ExternalShareableSourceAuthorityV1Schema),
  externalActor: z.optional(ExternalActorV1Schema),
  contentProvenance: z.optional(ContentProvenanceV1Schema),
}).check(z.superRefine((value, context) => {
  if ((value.externalActor === undefined) === (value.contentProvenance === undefined)) return;
  context.addIssue({
    code: "custom",
    path: value.externalActor === undefined ? ['externalActor'] : ['contentProvenance'],
    message: 'External actor and content provenance must be supplied together',
  });
})));
export type ExternalShareableOriginV1 = z.infer<typeof ExternalShareableOriginV1Schema>;

const ExternalShareableConsumedInputV1Schema = lazyZodSchema(() => z.strictObject({
  localId: z.string().check(z.minLength(1)),
  origin: ExternalShareableOriginV1Schema,
}));

export const ExternalShareableTranscriptItemV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('userText'),
    sessionId: z.string().check(z.minLength(1)),
    seq: z.number().check(z.int(), z.nonnegative()),
    itemId: z.string().check(z.minLength(1)),
    localId: z.string().check(z.minLength(1)),
    text: ExternalShareableTextV1Schema,
    origin: ExternalShareableOriginV1Schema,
  }),
  z.strictObject({
    kind: z.literal('assistantText'),
    sessionId: z.string().check(z.minLength(1)),
    seq: z.number().check(z.int(), z.nonnegative()),
    itemId: z.string().check(z.minLength(1)),
    turnId: z.string().check(z.minLength(1)),
    final: z.literal('completed'),
    text: ExternalShareableTextV1Schema,
    consumedInputs: z.readonly(z.array(ExternalShareableConsumedInputV1Schema).check(z.maxLength(EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1))),
  }),
]));
export type ExternalShareableTranscriptItemV1 = z.infer<typeof ExternalShareableTranscriptItemV1Schema>;

export const ExternalShareableTranscriptPageV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.readonly(z.array(ExternalShareableTranscriptItemV1Schema).check(z.maxLength(EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1))),
  nextCursor: z.optional(z.string().check(z.minLength(1))),
  scannedThroughSeq: z.number().check(z.int(), z.nonnegative()),
  hasMore: z.boolean(),
}).check(z.superRefine((page, context) => {
  const consumedInputCount = page.items.reduce(
    (total, item) => total + (item.kind === 'assistantText' ? item.consumedInputs.length : 0),
    0,
  );
  if (consumedInputCount > EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1) {
    context.addIssue({
      code: "custom",
      message: `External transcript page contains more than ${EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1} consumed inputs`,
    });
  }
  if (!isExternalShareableTranscriptWirePayloadWithinLimitV1(page)) {
    context.addIssue({
      code: "custom",
      message: `External transcript page exceeds ${EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1} serialized bytes`,
    });
  }
})));
export type ExternalShareableTranscriptPageV1 = z.infer<typeof ExternalShareableTranscriptPageV1Schema>;

const ExternalShareableReferencedUserRowV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)),
  seq: z.number().check(z.int(), z.nonnegative()),
  localId: z.string().check(z.minLength(1)),
  messageRole: z.literal('user'),
  content: SessionStoredMessageContentSchema,
  createdAt: z.number().check(z.int(), z.nonnegative()),
  updatedAt: z.number().check(z.int(), z.nonnegative()),
  externalShareableActor: z.optional(ExternalShareableActorV1Schema),
}));

/**
 * One database-transaction witness for an external transcript page. Its turns
 * are already publication-visible; the optional barriers mark the earliest
 * row that must not advance a cursor until publication or turn settlement is
 * visible. Referenced user rows are the exact, least-disclosure inputs needed
 * to project a final assistant row from the same transaction.
 */
export const ExternalShareableTranscriptSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  turns: z.readonly(z.array(SessionTurnV1Schema).check(z.maxLength(EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SNAPSHOT_TURNS_V1))),
  publicationBlockedFromSeq: z.optional(z.number().check(z.int(), z.nonnegative())),
  turnSettlementBlockedFromSeq: z.optional(z.number().check(z.int(), z.nonnegative())),
  referencedUserRows: z.optional(z.readonly(z.array(ExternalShareableReferencedUserRowV1Schema).check(z.maxLength(EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1)))),
}).check(z.superRefine((snapshot, context) => {
  if (!isExternalShareableTranscriptWirePayloadWithinLimitV1(snapshot)) {
    context.addIssue({
      code: "custom",
      message: `External transcript snapshot exceeds ${EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1} serialized bytes`,
    });
  }
})));
export type ExternalShareableTranscriptSnapshotV1 = z.infer<
  typeof ExternalShareableTranscriptSnapshotV1Schema
>;

export function filterExternalShareableOriginForCallerV1(params: Readonly<{
  origin: ExternalShareableOriginV1;
  callerPluginId?: string | null;
}>): ExternalShareableOriginV1 {
  const origin = ExternalShareableOriginV1Schema.parse(params.origin);
  if (
    !origin.sourceAuthority
    || !params.callerPluginId
    || !PluginIdSchema.safeParse(params.callerPluginId).success
    || origin.sourceAuthority.mediatorPluginId !== params.callerPluginId
  ) {
    const { sourceAuthority: _sourceAuthority, ...leastDisclosure } = origin;
    return leastDisclosure;
  }
  return origin;
}

/** The single semantic admission owner, after the platform opens mode-checked content. */
type ProjectableTranscriptRow = Readonly<{
  content: unknown;
  id?: unknown;
  seq?: unknown;
  localId?: unknown;
  messageRole?: unknown;
  sidechainId?: unknown;
  createdAt?: unknown;
  externalShareableActor?: unknown;
}>;

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
  const provenance = readSessionMessageProvenanceV1(params.meta, 'stored');
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
  callerPluginId?: string | null;
}>): Extract<ExternalShareableTranscriptItemV1, { kind: 'userText' }> | null {
  const seq = readSafeSeq(params.row.seq);
  const itemId = typeof params.row.id === 'string' && params.row.id.length > 0 ? params.row.id : null;
  const localId = typeof params.row.localId === 'string' && params.row.localId.length > 0 ? params.row.localId : null;
  if (seq === null || !itemId || !localId || params.row.sidechainId != null) return null;
  const decrypted = params.row.content;
  const record = asRecord(decrypted);
  const decoded = projectTranscriptBodySemanticContent(decrypted);
  if (!record || decoded?.semanticRole !== 'user' || !decoded.text || !containsAtMostCodePoints(decoded.text, MAX_EXTERNAL_TRANSCRIPT_TEXT_CODE_POINTS)) {
    return null;
  }
  const historicalOrigin = deriveExternalHistoryOrigin({
    meta: record.meta,
    externalShareableActor: params.row.externalShareableActor,
    callerPluginId: params.callerPluginId,
  });
  const authority = historicalOrigin ? null : readSessionInputAuthorityV1(record.meta, 'stored');
  const provenance = historicalOrigin ? null : readSessionMessageProvenanceV1(record.meta, 'stored');
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
}>): Readonly<{ seq: number; itemId: string; text: string }> | null {
  const seq = readSafeSeq(params.row.seq);
  const itemId = typeof params.row.id === 'string' && params.row.id.length > 0 ? params.row.id : null;
  if (seq === null || !itemId || params.row.sidechainId != null) return null;
  const decrypted = params.row.content;
  const decoded = projectTranscriptBodySemanticContent(decrypted);
  if (decoded?.semanticRole !== 'assistant' || !decoded.text || !containsAtMostCodePoints(decoded.text, MAX_EXTERNAL_TRANSCRIPT_TEXT_CODE_POINTS)) {
    return null;
  }
  return { seq, itemId, text: decoded.text };
}

export async function projectOpenedExternalShareableTranscriptPageV1(params: Readonly<{
  sessionId: string;
  rows: readonly ProjectableTranscriptRow[];
  turns: readonly SessionTurnV1[];
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
          const assistant = deriveAssistantText({ row });
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
    if (emittedConsumedInputCount + nextConsumedInputCount > EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1) {
      return ExternalShareableTranscriptPageV1Schema.parse({
        ...lastFittingPage,
        hasMore: true,
      });
    }
    const nextCandidate = candidate !== null
      && items.length < limit
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
