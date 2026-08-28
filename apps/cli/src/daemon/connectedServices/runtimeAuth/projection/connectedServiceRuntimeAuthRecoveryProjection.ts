import { createHash } from 'node:crypto';

import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  readBuiltInLegacyConnectedAccountServiceKeyIngress,
  TranscriptRawAgentEventV1Schema,
  buildAgentEventLocalId,
  normalizeConnectedServiceUxDiagnosticV1,
  type ConnectedServiceUxDiagnosticV1,
  type TranscriptRawAgentEventV1,
} from '@happier-dev/protocol';

import { buildConnectedServiceUxDiagnostic } from '../../diagnostics/connectedServiceUxDiagnostics';
import type { ConnectedServiceRuntimeFailureClassification } from '../types';
import type { ConnectedServiceRuntimeAuthFailureStatusNote } from '../resolveConnectedServiceRuntimeAuthFailureStatusMessage';

export type ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1 = Extract<
  TranscriptRawAgentEventV1,
  { type: 'connected-service-runtime-auth-recovery' }
>;

export type ConnectedServiceRuntimeAuthRecoveryProjection = Readonly<{
  handled: boolean;
  statusCode: string | null;
  statusMessage: string | null;
  uxDiagnostic?: ConnectedServiceUxDiagnosticV1;
  transcriptEvent?: ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1;
  nextRetryAtMs?: number | null;
  terminal?: boolean;
}>;

export function buildRuntimeAuthRecoveryAttemptTransitionLocalId(input: Readonly<{
  attemptId: string;
  transition: string;
}>): string {
  const attemptDigest = createHash('sha256').update(input.attemptId).digest('base64url');
  return buildAgentEventLocalId('connected-service-runtime-auth-recovery', [attemptDigest, input.transition]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function readPositiveNumber(value: unknown): number | null {
  const number = readNumber(value);
  return number !== null && number > 0 ? number : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  const number = readNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function normalizeTranscriptServiceId(
  value: string,
): ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1['serviceId'] | null {
  // Transcript events are written with canonical qualified service keys;
  // released bundled scalars normalize through the sole legacy ingress.
  return readBuiltInLegacyConnectedAccountServiceKeyIngress(value);
}

function normalizeRuntimeAuthRecoveryTranscriptEvent(
  value: unknown,
): ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1 | null {
  const parsed = TranscriptRawAgentEventV1Schema.safeParse(value);
  if (!parsed.success || parsed.data.type !== 'connected-service-runtime-auth-recovery') {
    return null;
  }
  return parsed.data;
}

function readOuterResult(report: unknown): Readonly<Record<string, unknown>> | null {
  const envelope = readRecord(report);
  if (!envelope || envelope.ok !== true) return null;
  return readRecord(envelope.result);
}

function readRecovery(reportResult: Readonly<Record<string, unknown>> | null): Readonly<Record<string, unknown>> | null {
  return readRecord(reportResult?.recovery);
}

function readNextRetryAtMs(input: Readonly<{
  recovery: Readonly<Record<string, unknown>> | null;
  uxDiagnostic: ConnectedServiceUxDiagnosticV1 | null;
}>): number | null {
  const fromRecovery = readNonNegativeNumber(input.recovery?.nextRetryAtMs);
  if (fromRecovery !== null) return fromRecovery;
  const diagnostics = readRecord(input.uxDiagnostic?.diagnostics);
  return readNonNegativeNumber(diagnostics?.nextRetryAtMs);
}

function readTerminalStatus(result: Readonly<Record<string, unknown>> | null): boolean | undefined {
  if (!result) return undefined;
  if (result.status === 'recovery_retry_scheduled') return false;
  if (result.status === 'recovery_handler_failed') return true;
  const recovery = readRecovery(result);
  if (recovery?.status === 'exhausted' || recovery?.status === 'terminal') return true;
  if (recovery?.status === 'scheduled') return false;
  return undefined;
}

export function buildRuntimeAuthRecoveryScheduledUxDiagnostic(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  nextRetryAtMs?: number | null;
  reason?: string | null;
}>): ConnectedServiceUxDiagnosticV1 {
  return buildConnectedServiceUxDiagnostic({
    code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryRetryScheduled,
    failurePhase: 'runtime_auth_recovery',
    source: 'runtime_auth_recovery',
    serviceId: input.classification.serviceId,
    profileId: input.classification.profileId,
    groupId: input.classification.groupId,
    retryable: true,
    diagnostics: {
      runtimeFailureKind: input.classification.kind,
      classificationSource: input.classification.source,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(typeof input.nextRetryAtMs === 'number' && Number.isFinite(input.nextRetryAtMs)
        ? { nextRetryAtMs: Math.max(0, Math.trunc(input.nextRetryAtMs)) }
        : {}),
    },
  });
}

export function buildRuntimeAuthRecoveryTranscriptEvent(input: Readonly<{
  status: ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1['status'];
  classification: ConnectedServiceRuntimeFailureClassification;
  uxDiagnostic?: ConnectedServiceUxDiagnosticV1;
  attempt?: number | null;
  nextRetryAtMs?: number | null;
  terminal?: boolean;
  reason?: string | null;
}>): ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1 | null {
  const serviceId = normalizeTranscriptServiceId(input.classification.serviceId);
  if (!serviceId) return null;
  return {
    type: 'connected-service-runtime-auth-recovery',
    status: input.status,
    serviceId,
    ...(input.classification.profileId ? { profileId: input.classification.profileId } : {}),
    ...(input.classification.groupId ? { groupId: input.classification.groupId } : {}),
    ...(input.attempt ? { attempt: input.attempt } : {}),
    ...(input.nextRetryAtMs === undefined ? {} : { nextRetryAtMs: input.nextRetryAtMs }),
    ...(input.terminal === undefined ? {} : { terminal: input.terminal }),
    ...(input.uxDiagnostic ? { diagnostic: input.uxDiagnostic } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

export function buildRuntimeAuthRecoveryScheduledResult(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  recovery: unknown;
  originalResult?: unknown;
}>): Readonly<{
  status: 'recovery_retry_scheduled';
  recovery: unknown;
  originalResult?: unknown;
  uxDiagnostic: ConnectedServiceUxDiagnosticV1;
  transcriptEvent?: ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1;
}> {
  const recovery = readRecord(input.recovery);
  const nextRetryAtMs = readNonNegativeNumber(recovery?.nextRetryAtMs);
  const attempt = readPositiveNumber(recovery?.attemptCount);
  const uxDiagnostic = buildRuntimeAuthRecoveryScheduledUxDiagnostic({
    classification: input.classification,
    nextRetryAtMs,
  });
  const transcriptEvent = buildRuntimeAuthRecoveryTranscriptEvent({
    status: 'retry_scheduled',
    classification: input.classification,
    uxDiagnostic,
    attempt,
    nextRetryAtMs,
    terminal: false,
  });
  return {
    status: 'recovery_retry_scheduled',
    recovery: input.recovery,
    ...(input.originalResult === undefined ? {} : { originalResult: input.originalResult }),
    uxDiagnostic,
    ...(transcriptEvent ? { transcriptEvent } : {}),
  };
}

export function normalizeConnectedServiceRuntimeAuthRecoveryProjection(input: Readonly<{
  report: unknown;
  statusNote: ConnectedServiceRuntimeAuthFailureStatusNote | null;
}>): ConnectedServiceRuntimeAuthRecoveryProjection {
  const result = readOuterResult(input.report);
  const recovery = readRecovery(result);
  const uxDiagnostic = normalizeConnectedServiceUxDiagnosticV1(result?.uxDiagnostic);
  const nextRetryAtMs = readNextRetryAtMs({ recovery, uxDiagnostic });
  const transcriptEvent = normalizeRuntimeAuthRecoveryTranscriptEvent(result?.transcriptEvent);
  const terminal = readTerminalStatus(result);
  return {
    handled: Boolean(input.statusNote || uxDiagnostic || transcriptEvent),
    statusCode: input.statusNote?.code ?? null,
    statusMessage: input.statusNote?.message ?? null,
    ...(uxDiagnostic ? { uxDiagnostic } : {}),
    ...(transcriptEvent ? { transcriptEvent } : {}),
    ...(nextRetryAtMs === null ? {} : { nextRetryAtMs }),
    ...(terminal === undefined ? {} : { terminal }),
  };
}
