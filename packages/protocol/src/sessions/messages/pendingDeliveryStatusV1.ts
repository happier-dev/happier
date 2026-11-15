import { SPAWN_SESSION_ERROR_DETAIL_KINDS, type SpawnSessionErrorDetail, type SpawnSessionErrorDetailKind } from '../spawnSession.js';
import { SessionSpawnChildExitV1Schema, SessionSpawnLaunchErrorV1Schema } from '../creation/sessionSpawnLaunchErrorV1.js';
import { SessionRuntimeFailureCauseV1Schema } from '../control/runtimeIssueV1.js';
import { SpawnFailureV1Schema } from '../../machines/processes/spawnFailureV1.js';
import { ProviderErrorV1Schema } from '../../providers/errors.js';
import { ConnectedServiceUxDiagnosticCurrentV1Schema, type ConnectedServiceUxDiagnosticV1 } from '../../connect/connectedServiceUxDiagnostics.js';
import type { PendingDeliveryBlockedReason } from './pendingDeliveryBlockedReason.js';
import { normalizePendingDeliveryBlockedReason } from './pendingDeliveryBlockedReason.js';
import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

const K = SPAWN_SESSION_ERROR_DETAIL_KINDS;
const DETAILED_FAILURE_CAUSE_KINDS = [K.LAUNCH_ERROR, K.SPAWN_FAILURE, K.PROVIDER_ERROR,
  K.CONNECTED_SERVICE_RESUME_UNREACHABLE, K.CONNECTED_SERVICE_UX_DIAGNOSTIC] as const;
type KindOnlyFailureCauseKind = Exclude<SpawnSessionErrorDetailKind, (typeof DETAILED_FAILURE_CAUSE_KINDS)[number]>;
const KIND_ONLY_FAILURE_CAUSE_KINDS = Object.values(K).filter((kind): kind is KindOnlyFailureCauseKind =>
  !(DETAILED_FAILURE_CAUSE_KINDS as readonly string[]).includes(kind));

/** The UI-actionable part of a connected-service diagnostic; free-form `diagnostics` and ids stay local. */
const PendingDeliveryFailureUxDiagnosticV1Schema = lazyZodSchema(() => {
  const { code, failurePhase, source, retryable, suggestedActions } = ConnectedServiceUxDiagnosticCurrentV1Schema.shape;
  return z.strictObject({ code, failurePhase, source, retryable, suggestedActions });
});

/** Native provider codes are kept only when they are code-shaped, never prose. */
const PROVIDER_ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const PendingDeliveryFailureRuntimeCauseV1Schema = lazyZodSchema(() => {
  const { providerErrorMessage: _message, providerErrorCode: _code, ...typed } = SessionRuntimeFailureCauseV1Schema.shape;
  return z.strictObject({ ...typed,
    providerErrorCode: z.optional(z.union([z.string().check(z.regex(PROVIDER_ERROR_CODE_PATTERN)), z.number().check(z.int())])) });
});

/**
 * Content-free cause of a refused resume, stored in plaintext beside the Pending input.
 * The server never holds E2EE Session content: no message prose, child stderr, cwd,
 * profile ids or free-form diagnostics. The full spawn detail stays on the requesting CLI.
 */
export const PendingDeliveryFailureCauseV1Schema = lazyZodSchema(() => {
  const launch = SessionSpawnLaunchErrorV1Schema.shape;
  const childExit = SessionSpawnChildExitV1Schema.shape;
  const spawnFailure = SpawnFailureV1Schema.shape;
  const typedSpawnFailure = z.strictObject({ reason: spawnFailure.reason, errno: spawnFailure.errno });
  return z.union([
    z.strictObject({
      kind: z.literal(K.LAUNCH_ERROR), code: launch.code, subtype: launch.subtype, rpcErrorCode: launch.rpcErrorCode,
      connectionPhase: launch.connectionPhase, currentnessFailure: launch.currentnessFailure,
      childExit: z.optional(z.strictObject({ code: childExit.code, signal: childExit.signal })),
      spawnFailure: z.optional(typedSpawnFailure),
      failureCause: z.optional(PendingDeliveryFailureRuntimeCauseV1Schema),
      uxDiagnostic: z.optional(PendingDeliveryFailureUxDiagnosticV1Schema),
    }),
    z.strictObject({ kind: z.literal(K.SPAWN_FAILURE), reason: spawnFailure.reason, errno: spawnFailure.errno }),
    z.strictObject({ kind: z.literal(K.PROVIDER_ERROR), providerError: ProviderErrorV1Schema }),
    z.strictObject({
      kind: z.enum([K.CONNECTED_SERVICE_RESUME_UNREACHABLE, K.CONNECTED_SERVICE_UX_DIAGNOSTIC]),
      uxDiagnostic: PendingDeliveryFailureUxDiagnosticV1Schema,
    }),
    z.strictObject({ kind: z.enum(KIND_ONLY_FAILURE_CAUSE_KINDS as [KindOnlyFailureCauseKind, ...KindOnlyFailureCauseKind[]]) }),
  ]);
});
export type PendingDeliveryFailureCauseV1 = z.infer<typeof PendingDeliveryFailureCauseV1Schema>;

function projectUxDiagnostic(diagnostic: ConnectedServiceUxDiagnosticV1): z.infer<typeof PendingDeliveryFailureUxDiagnosticV1Schema> {
  const { code, failurePhase, source, retryable, suggestedActions } = diagnostic;
  return { code, failurePhase, source, retryable, suggestedActions };
}

/** The one projection from a local spawn detail into the server-stored cause. */
export function projectPendingDeliveryFailureCauseV1(detail: SpawnSessionErrorDetail): PendingDeliveryFailureCauseV1 {
  switch (detail.kind) {
    case K.LAUNCH_ERROR: {
      const failureCause = detail.failureCause;
      const providerErrorCode = failureCause?.providerErrorCode;
      const { providerErrorMessage: _message, providerErrorCode: _code, ...typedFailureCause } = failureCause ?? {};
      return {
        kind: detail.kind, code: detail.code,
        ...(detail.subtype ? { subtype: detail.subtype } : {}),
        ...(detail.rpcErrorCode ? { rpcErrorCode: detail.rpcErrorCode } : {}),
        ...(detail.connectionPhase ? { connectionPhase: detail.connectionPhase } : {}),
        ...(detail.currentnessFailure ? { currentnessFailure: detail.currentnessFailure } : {}),
        ...(detail.childExit ? { childExit: { code: detail.childExit.code, signal: detail.childExit.signal } } : {}),
        ...(detail.spawnFailure ? { spawnFailure: { reason: detail.spawnFailure.reason,
          ...(detail.spawnFailure.errno ? { errno: detail.spawnFailure.errno } : {}) } } : {}),
        ...(failureCause ? { failureCause: { ...typedFailureCause, phase: failureCause.phase, failureReason: failureCause.failureReason,
          ...(typeof providerErrorCode === 'number' || (typeof providerErrorCode === 'string' && PROVIDER_ERROR_CODE_PATTERN.test(providerErrorCode))
            ? { providerErrorCode } : {}) } } : {}),
        ...(detail.uxDiagnostic ? { uxDiagnostic: projectUxDiagnostic(detail.uxDiagnostic) } : {}),
      };
    }
    case K.SPAWN_FAILURE:
      return { kind: detail.kind, reason: detail.reason, ...(detail.errno ? { errno: detail.errno } : {}) };
    case K.PROVIDER_ERROR:
      return { kind: detail.kind, providerError: detail.providerError };
    case K.CONNECTED_SERVICE_RESUME_UNREACHABLE:
    case K.CONNECTED_SERVICE_UX_DIAGNOSTIC:
      return { kind: detail.kind, uxDiagnostic: projectUxDiagnostic(detail.uxDiagnostic) };
    default:
      return { kind: detail.kind };
  }
}

/** Definite pre-runner refusal retained with the original Pending input. */
export const PendingDeliveryFailureV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.literal('resume_failed'),
  errorDetail: z.optional(PendingDeliveryFailureCauseV1Schema),
}));
export type PendingDeliveryFailureV1 = z.infer<typeof PendingDeliveryFailureV1Schema>;

/** Read-only custody eligibility; recovery mutations still check current server state. */
export const PendingDeliveryRecoveryV1Schema = lazyZodSchema(() => z.strictObject({
  canSendAsNew: z.boolean(),
}));
export type PendingDeliveryRecoveryV1 = z.infer<typeof PendingDeliveryRecoveryV1Schema>;

export type PendingDeliveryDetailV1 = 'custody_observed' | 'awaiting_acceptance';

export type PendingDeliveryStatusV1 =
  | Readonly<{ status: 'queued' }>
  | Readonly<{ status: 'delivering'; detail?: PendingDeliveryDetailV1 }>
  | Readonly<{ status: 'external_handoff' }>
  | Readonly<{ status: 'blocked'; reason: PendingDeliveryBlockedReason }>
  | Readonly<{ status: 'discarded'; reason: string | null }>;

export type PendingDeliveryResolvedReasonV1 = 'provider_accepted' | 'materialized' | 'manual_handled';
export type PendingDeliveryArchivedUncertaintyReasonV1 = 'dismissed_uncertain' | 'resent_as_new';

export const PENDING_DELIVERY_HIDDEN_DISCARDED_REASONS_V1 = ['resent_as_new', 'session_input_muted'] as const;
const pendingDeliveryHiddenDiscardedReasonsV1 = new Set<string>(PENDING_DELIVERY_HIDDEN_DISCARDED_REASONS_V1);

export type PendingDeliveryStatusTransitionTargetV1 =
  | PendingDeliveryStatusV1
  | Readonly<{
      status: 'resolved';
      reason: 'provider_accepted';
    }>
  | Readonly<{
      status: 'resolved';
      reason: Exclude<PendingDeliveryResolvedReasonV1, 'provider_accepted'>;
    }>;

export type PendingDeliveryStatusPersistedFieldsV1 = Readonly<{
  status?: unknown;
  deliveryState?: unknown;
  deliveryBlockedReason?: unknown;
  discardedReason?: unknown;
}>;

export type PendingDeliveryStatusPersistedProjectionV1 = Readonly<{
  status: 'queued' | 'discarded';
  deliveryState: 'delivering' | 'external_handoff' | 'blocked' | null;
  deliveryBlockedReason: PendingDeliveryBlockedReason | null;
  discardedReason: string | null;
}>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readPendingDeliveryDetailV1(value: unknown): PendingDeliveryDetailV1 | null {
  return value === 'custody_observed' || value === 'awaiting_acceptance' ? value : null;
}

export function normalizePendingDeliveryStatusV1(fields: PendingDeliveryStatusPersistedFieldsV1): PendingDeliveryStatusV1 {
  if (fields.status === 'discarded') {
    return { status: 'discarded', reason: readNonEmptyString(fields.discardedReason) };
  }

  if (fields.status !== 'queued') {
    return { status: 'queued' };
  }

  if (fields.deliveryState === 'delivering') {
    return { status: 'delivering', detail: 'awaiting_acceptance' };
  }
  if (fields.deliveryState === 'external_handoff') {
    return { status: 'external_handoff' };
  }

  if (fields.deliveryState === 'blocked') {
    return {
      status: 'blocked',
      reason: normalizePendingDeliveryBlockedReason(fields.deliveryBlockedReason) ?? 'unknown',
    };
  }

  return { status: 'queued' };
}

export function parsePendingDeliveryStatusV1(value: unknown): PendingDeliveryStatusV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.status === 'queued') {
    return { status: 'queued' };
  }
  if (record.status === 'delivering') {
    const detail = readPendingDeliveryDetailV1(record.detail);
    return detail ? { status: 'delivering', detail } : { status: 'delivering' };
  }
  if (record.status === 'external_handoff') {
    return { status: 'external_handoff' };
  }
  if (record.status === 'blocked') {
    return {
      status: 'blocked',
      reason: normalizePendingDeliveryBlockedReason(record.reason) ?? 'unknown',
    };
  }
  if (record.status === 'discarded') {
    return { status: 'discarded', reason: readNonEmptyString(record.reason) };
  }
  return null;
}

export function pendingDeliveryStatusV1ToPersistedFields(
  status: PendingDeliveryStatusV1,
): PendingDeliveryStatusPersistedProjectionV1 {
  switch (status.status) {
    case 'queued':
      return { status: 'queued', deliveryState: null, deliveryBlockedReason: null, discardedReason: null };
    case 'delivering':
      return { status: 'queued', deliveryState: 'delivering', deliveryBlockedReason: null, discardedReason: null };
    case 'external_handoff':
      return { status: 'queued', deliveryState: 'external_handoff', deliveryBlockedReason: null, discardedReason: null };
    case 'blocked':
      return {
        status: 'queued',
        deliveryState: 'blocked',
        deliveryBlockedReason: status.reason,
        discardedReason: null,
      };
    case 'discarded':
      return { status: 'discarded', deliveryState: null, deliveryBlockedReason: null, discardedReason: status.reason };
  }
}

export function isPendingDeliveryProviderEffectPossibleV1(status: PendingDeliveryStatusV1): boolean {
  if (status.status === 'delivering' || status.status === 'external_handoff') return true;
  if (status.status !== 'blocked') return false;
  return status.reason === 'ambiguous_terminal_delivery'
    || status.reason === 'delivery_outcome_uncertain'
    || status.reason === 'team_access_removed'
    || status.reason === 'unknown';
}

export function isPendingDeliveryArchivedUncertaintyReasonV1(
  value: unknown,
): value is PendingDeliveryArchivedUncertaintyReasonV1 {
  return value === 'dismissed_uncertain' || value === 'resent_as_new';
}

export function shouldExposePendingDeliveryInDiscardedHistoryV1(status: PendingDeliveryStatusV1): boolean {
  return status.status === 'discarded'
    && !pendingDeliveryHiddenDiscardedReasonsV1.has(status.reason ?? '');
}

export function isPendingDeliveryStatusTransitionAllowedV1(
  from: PendingDeliveryStatusV1,
  to: PendingDeliveryStatusTransitionTargetV1,
): boolean {
  if (to.status === 'resolved') {
    if (to.reason === 'provider_accepted') {
      return from.status === 'delivering'
        || from.status === 'external_handoff'
        || from.status === 'blocked'
        || (from.status === 'discarded' && isPendingDeliveryArchivedUncertaintyReasonV1(from.reason));
    }
    if (to.reason === 'manual_handled') {
      return from.status === 'delivering' || from.status === 'external_handoff' || from.status === 'blocked';
    }
    return from.status === 'queued';
  }

  if (from.status === to.status) {
    return true;
  }

  if (from.status === 'queued') {
    return to.status === 'delivering' || to.status === 'blocked' || to.status === 'discarded';
  }

  if (from.status === 'delivering') {
    return to.status === 'blocked' || to.status === 'discarded';
  }
  if (from.status === 'external_handoff') {
    return to.status === 'blocked' || to.status === 'discarded';
  }

  if (from.status === 'blocked') {
    return to.status === 'queued' || to.status === 'discarded';
  }

  if (from.status === 'discarded' && isPendingDeliveryArchivedUncertaintyReasonV1(from.reason)) {
    return false;
  }
  return to.status === 'queued';
}

/** A durable Pending row keeps its committed transcript twin provisional until delivery starts. */
export function doesPendingDeliveryOwnTranscriptV1(status: Pick<PendingDeliveryStatusV1, 'status'>): boolean {
    return status.status !== 'delivering' && status.status !== 'external_handoff';
}
