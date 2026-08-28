import { z } from 'zod';

import { SessionIdSchema } from '../idsV1.js';
import { AgentExternalSessionTranscriptRawRecordSchema } from '../messages/agentExternalSessionTranscriptRawRecord.js';
import { LinkedExternalSessionQualifiedIdentityV1Schema } from './linkedSessionMetadata.js';
import {
  createExternalSessionTranscriptSourceItemV1Schema,
  ExternalSessionTranscriptItemIdV1Schema,
} from './sourceTranscriptItemV1.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

export const EXTERNAL_SESSION_TRANSCRIPT_INVALIDATION_EVENT_V1 =
  'external-session-transcript-invalidated' as const;

const ExternalSessionRefreshMachineIdV1Schema = z.string().trim().min(1).max(256);
const ExternalSessionRefreshGenerationV1Schema = z.string().trim().min(1).max(256);
const ExternalSessionRefreshRemoteSessionIdV1Schema = z.string().trim().min(1).max(2_000);
export const ExternalSessionRefreshCursorV1Schema = z.string()
  .trim()
  .min(1)
  .max(4_096)
  .regex(
    /^happier_external_cursor_v1:[A-Za-z0-9_-]+$/,
    'External-session refresh cursors must use the canonical host-qualified cursor carrier.',
  );
export type ExternalSessionRefreshCursorV1 = z.infer<
  typeof ExternalSessionRefreshCursorV1Schema
>;
export const ExternalSessionRefreshCursorIdentityV1Schema = z.string()
  .regex(
    /^external_session_cursor_binding_v1:[0-9a-f]{64}$/,
    'External-session refresh cursor identities must use the canonical non-reversible binding carrier.',
  );
export type ExternalSessionRefreshCursorIdentityV1 = z.infer<
  typeof ExternalSessionRefreshCursorIdentityV1Schema
>;
const ExternalSessionRefreshBoundaryV1Schema = z.string().trim().min(1).max(2_000);
const ExternalSessionRefreshReadDiagnosticV1Schema = z.object({
  code: z.string().trim().min(1).max(128),
  severity: z.enum(['benign', 'required']),
  count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  positions: z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).max(200),
}).strict().refine(
  (diagnostic) => diagnostic.count >= diagnostic.positions.length,
  'Diagnostic count must cover every reported position.',
);

/**
 * Opaque routing/currentness identity shared by the content-free invalidation
 * and the machine-encrypted authoritative read-after exchange.
 *
 * Source-native paths, cursors, linkData, and transcript content do not belong
 * here. The cursor identity is derived by the daemon through its purpose-bound
 * device-local secret owner from the complete host-qualified cursor and this
 * authority tuple.
 */
export const ExternalSessionTranscriptRefreshBindingV1Schema = z.object({
  v: z.literal(1),
  machineId: ExternalSessionRefreshMachineIdV1Schema,
  sessionId: asProtocolZod(SessionIdSchema),
  link: z.object({
    generation: ExternalSessionRefreshGenerationV1Schema,
    remoteSessionId: ExternalSessionRefreshRemoteSessionIdV1Schema,
  }).strict(),
  source: z.object({
    qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1Schema,
    generation: ExternalSessionRefreshGenerationV1Schema,
  }).strict(),
  contributionGeneration: ExternalSessionRefreshGenerationV1Schema,
  cursorIdentity: ExternalSessionRefreshCursorIdentityV1Schema,
}).strict();
export type ExternalSessionTranscriptRefreshBindingV1 = z.infer<
  typeof ExternalSessionTranscriptRefreshBindingV1Schema
>;

/**
 * Server-visible live hint. It deliberately carries no transcript item,
 * preview, title, raw source path, linkData, or source-native cursor.
 */
export const ExternalSessionTranscriptInvalidationV1Schema = z.object({
  v: z.literal(1),
  type: z.literal(EXTERNAL_SESSION_TRANSCRIPT_INVALIDATION_EVENT_V1),
  binding: ExternalSessionTranscriptRefreshBindingV1Schema,
}).strict();
export type ExternalSessionTranscriptInvalidationV1 = z.infer<
  typeof ExternalSessionTranscriptInvalidationV1Schema
>;

/**
 * Plaintext contract before the existing machine-RPC owner encrypts it.
 */
export const ExternalSessionTranscriptRefreshReadAfterRequestV1Schema = z.object({
  v: z.literal(1),
  binding: ExternalSessionTranscriptRefreshBindingV1Schema,
  cursor: ExternalSessionRefreshCursorV1Schema,
}).strict();
export type ExternalSessionTranscriptRefreshReadAfterRequestV1 = z.infer<
  typeof ExternalSessionTranscriptRefreshReadAfterRequestV1Schema
>;

export const ExternalSessionTranscriptRefreshItemV1Schema =
  createExternalSessionTranscriptSourceItemV1Schema({
    identifier: ExternalSessionTranscriptItemIdV1Schema,
    raw: AgentExternalSessionTranscriptRawRecordSchema,
  }).strict();
export type ExternalSessionTranscriptRefreshItemV1 = z.infer<
  typeof ExternalSessionTranscriptRefreshItemV1Schema
>;

const ExternalSessionTranscriptAlreadyCurrentV1Schema = z.object({
  outcome: z.literal('already_current'),
}).strict();

const ExternalSessionTranscriptAdvancedV1Schema = z.object({
  outcome: z.literal('advanced'),
  items: z.array(ExternalSessionTranscriptRefreshItemV1Schema).max(200),
  nextCursor: ExternalSessionRefreshCursorV1Schema,
  boundary: ExternalSessionRefreshBoundaryV1Schema,
  hasMore: z.boolean(),
  diagnostics: z.array(ExternalSessionRefreshReadDiagnosticV1Schema).min(1).max(32).optional(),
}).strict().refine(
  (result) => result.items.length > 0 || (result.diagnostics?.length ?? 0) > 0,
  'An empty advanced result requires bounded structured diagnostics.',
);

const ExternalSessionTranscriptGapOrCursorExpiredV1Schema = z.object({
  outcome: z.literal('gap_or_cursor_expired'),
}).strict();

const ExternalSessionTranscriptSourceReplacedV1Schema = z.object({
  outcome: z.literal('source_replaced'),
}).strict();

const ExternalSessionTranscriptSourceUnavailableV1Schema = z.object({
  outcome: z.literal('source_unavailable'),
}).strict();

const ExternalSessionTranscriptReadFailedV1Schema = z.object({
  outcome: z.literal('read_failed'),
}).strict();

export const ExternalSessionTranscriptRefreshReadAfterResultV1Schema = z.discriminatedUnion(
  'outcome',
  [
    ExternalSessionTranscriptAlreadyCurrentV1Schema,
    ExternalSessionTranscriptAdvancedV1Schema,
    ExternalSessionTranscriptGapOrCursorExpiredV1Schema,
    ExternalSessionTranscriptSourceReplacedV1Schema,
    ExternalSessionTranscriptSourceUnavailableV1Schema,
    ExternalSessionTranscriptReadFailedV1Schema,
  ],
);
export type ExternalSessionTranscriptRefreshReadAfterResultV1 = z.infer<
  typeof ExternalSessionTranscriptRefreshReadAfterResultV1Schema
>;

/**
 * Plaintext contract after the existing machine-RPC owner decrypts it.
 * Transcript items are protected once as part of that whole RPC payload; this
 * schema intentionally defines no per-item encryption envelope.
 */
export const ExternalSessionTranscriptRefreshReadAfterResponseV1Schema = z.object({
  v: z.literal(1),
  binding: ExternalSessionTranscriptRefreshBindingV1Schema,
  result: ExternalSessionTranscriptRefreshReadAfterResultV1Schema,
}).strict();
export type ExternalSessionTranscriptRefreshReadAfterResponseV1 = z.infer<
  typeof ExternalSessionTranscriptRefreshReadAfterResponseV1Schema
>;

export type ExternalSessionTranscriptRefreshApplicationDecisionV1 =
  | Readonly<{
    kind: 'apply';
    items: readonly ExternalSessionTranscriptRefreshItemV1[];
    nextCursor: string;
    boundary: string;
  }>
  | Readonly<{
    kind: 'no_apply';
    reason:
      | 'stale_or_mismatched'
      | 'already_current'
      | 'resync_required'
      | 'source_replaced'
      | 'source_unavailable'
      | 'read_failed';
    items: readonly [];
  }>;

const EMPTY_REFRESH_ITEMS = Object.freeze([]) as readonly [];

export function externalSessionTranscriptRefreshBindingsEqualV1(
  left: ExternalSessionTranscriptRefreshBindingV1,
  right: ExternalSessionTranscriptRefreshBindingV1,
): boolean {
  return left.machineId === right.machineId
    && left.sessionId === right.sessionId
    && left.link.generation === right.link.generation
    && left.link.remoteSessionId === right.link.remoteSessionId
    && left.source.qualifiedIdentity.agent.pluginId
      === right.source.qualifiedIdentity.agent.pluginId
    && left.source.qualifiedIdentity.agent.localId
      === right.source.qualifiedIdentity.agent.localId
    && left.source.qualifiedIdentity.source.kind
      === right.source.qualifiedIdentity.source.kind
    && left.source.qualifiedIdentity.source.contractVersion
      === right.source.qualifiedIdentity.source.contractVersion
    && left.source.generation === right.source.generation
    && left.contributionGeneration === right.contributionGeneration
    && left.cursorIdentity === right.cursorIdentity;
}

/**
 * Pure admission decision for the later transcript-source selector. Only an
 * exact-current `advanced` response can release items to the canonical apply
 * path. Every stale, gapped, replaced, unavailable, or failed response carries
 * zero applicable items.
 */
export function decideExternalSessionTranscriptRefreshApplicationV1(
  expectedBindingInput: ExternalSessionTranscriptRefreshBindingV1,
  requestCursorInput: ExternalSessionRefreshCursorV1,
  responseInput: ExternalSessionTranscriptRefreshReadAfterResponseV1,
): ExternalSessionTranscriptRefreshApplicationDecisionV1 {
  const expectedBinding = ExternalSessionTranscriptRefreshBindingV1Schema.parse(expectedBindingInput);
  const requestCursor = ExternalSessionRefreshCursorV1Schema.parse(requestCursorInput);
  const response = ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse(responseInput);

  if (!externalSessionTranscriptRefreshBindingsEqualV1(expectedBinding, response.binding)) {
    return Object.freeze({
      kind: 'no_apply',
      reason: 'stale_or_mismatched',
      items: EMPTY_REFRESH_ITEMS,
    });
  }

  switch (response.result.outcome) {
    case 'advanced':
      if (
        response.result.nextCursor === requestCursor
        || response.result.hasMore
        || response.result.diagnostics?.some(
          (diagnostic) => diagnostic.severity === 'required',
        )
      ) {
        return Object.freeze({
          kind: 'no_apply',
          reason: 'resync_required',
          items: EMPTY_REFRESH_ITEMS,
        });
      }
      return Object.freeze({
        kind: 'apply',
        items: Object.freeze([...response.result.items]),
        nextCursor: response.result.nextCursor,
        boundary: response.result.boundary,
      });
    case 'already_current':
      return Object.freeze({
        kind: 'no_apply',
        reason: 'already_current',
        items: EMPTY_REFRESH_ITEMS,
      });
    case 'gap_or_cursor_expired':
      return Object.freeze({
        kind: 'no_apply',
        reason: 'resync_required',
        items: EMPTY_REFRESH_ITEMS,
      });
    case 'source_replaced':
      return Object.freeze({
        kind: 'no_apply',
        reason: 'source_replaced',
        items: EMPTY_REFRESH_ITEMS,
      });
    case 'source_unavailable':
      return Object.freeze({
        kind: 'no_apply',
        reason: 'source_unavailable',
        items: EMPTY_REFRESH_ITEMS,
      });
    case 'read_failed':
      return Object.freeze({
        kind: 'no_apply',
        reason: 'read_failed',
        items: EMPTY_REFRESH_ITEMS,
      });
  }
}
