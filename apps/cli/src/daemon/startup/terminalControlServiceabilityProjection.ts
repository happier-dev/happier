import type { Metadata } from '@/api/types';
import type { TerminalMode } from '@/terminal/runtime/terminalConfig';

type TerminalControlServiceability =
  | Readonly<{ state: 'servable' }>
  | Readonly<{ state: 'recoverable_unservable' | 'unknown'; reason: string }>;

export type TerminalControlServiceabilityEvidence = Readonly<{
  attachmentId: string;
  state: TerminalControlServiceability['state'];
  observedAt: number;
  reason?: string;
}>;

export function shouldPublishReportedTerminalControlServiceability(params: Readonly<{
  terminal: Metadata['terminal'] | null | undefined;
  attachmentId: string | null | undefined;
  publishedAttachmentId: string | null | undefined;
}>): boolean {
  const attachmentId = typeof params.attachmentId === 'string' ? params.attachmentId.trim() : '';
  if (!attachmentId || !params.terminal || params.terminal.mode === 'plain') return false;
  const existing = params.terminal.controlServiceabilityV1;
  if (
    existing?.v === 1
    && existing.retired !== true
    && existing.attachmentId === attachmentId
  ) {
    return false;
  }
  return params.publishedAttachmentId !== attachmentId;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function resolveRunnerTerminalControlServiceabilityEvidence(params: Readonly<{
  serviceability: TerminalControlServiceability;
  attachmentId: string;
  observedAt: number;
}>): TerminalControlServiceabilityEvidence {
  return {
    attachmentId: params.attachmentId,
    state: params.serviceability.state,
    observedAt: params.observedAt,
    ...('reason' in params.serviceability ? { reason: params.serviceability.reason } : {}),
  };
}

export function applyTerminalControlServiceabilityProjection(params: Readonly<{
  metadata: Record<string, unknown>;
  evidence: TerminalControlServiceabilityEvidence;
}>): Record<string, unknown> {
  const terminal = asRecord(params.metadata.terminal);
  if (!terminal) return params.metadata;
  const existing = asRecord(terminal.controlServiceabilityV1);
  const existingObservedAt = typeof existing?.observedAt === 'number' && Number.isFinite(existing.observedAt)
    ? existing.observedAt
    : Number.NEGATIVE_INFINITY;
  if (existing?.retired === true) {
    if (existing.attachmentId === params.evidence.attachmentId) return params.metadata;
    if (existingObservedAt > params.evidence.observedAt) return params.metadata;
  } else if (existingObservedAt >= params.evidence.observedAt) {
    return params.metadata;
  }
  return {
    ...params.metadata,
    terminal: {
      ...terminal,
      controlServiceabilityV1: {
        v: 1,
        ...params.evidence,
      },
    },
  };
}

export function clearTerminalControlServiceabilityProjection(params: Readonly<{
  metadata: Record<string, unknown>;
  retiredAttachmentId: string;
  retiredAt: number;
  terminalMode: TerminalMode;
}>): Record<string, unknown> {
  const terminal = asRecord(params.metadata.terminal) ?? {};
  const existing = asRecord(terminal.controlServiceabilityV1);
  if (existing && existing.attachmentId !== params.retiredAttachmentId) return params.metadata;
  const existingObservedAt = typeof existing?.observedAt === 'number' && Number.isFinite(existing.observedAt)
    ? existing.observedAt
    : Number.NEGATIVE_INFINITY;
  return {
    ...params.metadata,
    terminal: {
      ...terminal,
      mode: typeof terminal.mode === 'string' ? terminal.mode : params.terminalMode,
      controlServiceabilityV1: {
        v: 1,
        attachmentId: params.retiredAttachmentId,
        state: 'unknown',
        observedAt: Math.max(params.retiredAt, existingObservedAt),
        reason: 'attachment_retired',
        retired: true,
      },
    },
  };
}
