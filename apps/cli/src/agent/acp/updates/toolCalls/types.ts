export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export function isAcpToolCallTerminalStatus(status: unknown): status is 'completed' | 'failed' | 'cancelled' {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export type AcpToolCallSnapshot = Readonly<{
  toolCallId: string;
  title?: string | null;
  kind?: string | null;
  status?: AcpToolCallStatus | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown[] | null;
  locations?: unknown[] | null;
  _meta?: Record<string, unknown> | null;
  [key: string]: unknown;
}>;

export type AcpToolCallPublication = Readonly<{
  callId: string;
  toolName: string;
  snapshot: AcpToolCallSnapshot;
  revision: number;
  startedAt: number;
  updatedAt: number;
}>;

export type AcpToolResultPublication = Readonly<{
  callId: string;
  toolName: string;
  snapshot: AcpToolCallSnapshot;
  value: unknown;
  isError?: boolean;
}>;

/**
 * Provider-neutral semantic enrichment for a tool call already known (or expected shortly) by
 * ACP lifecycle correlation. It deliberately cannot change lifecycle status or result payloads.
 */
export type AcpToolCallEnrichment = Readonly<{
  toolName?: string;
  title?: string | null;
  rawInput?: unknown;
  metadata?: Record<string, unknown> | null;
}>;

export type AcpToolCallEnrichmentDisposition = 'applied' | 'queued' | 'duplicate' | 'ignored';

export type AcpToolCallCloseReason = 'terminal' | 'timeout' | 'cancelled' | 'abandoned';
