import type {
  TerminalNativeCopyEvent,
  TerminalNativeBellEvent,
  TerminalNativeLinkEvent,
  TerminalNativeRendererCrashEvent,
  TerminalNativeSelectionEvent,
  TerminalNativeTitleEvent,
  TerminalNativeUnavailableReason,
  TerminalNativeWriteAckEvent,
  TerminalNativeWriteRejectionReason,
} from './HappierTerminalNative.types';

export type TerminalNativeWriteBytesInput = Readonly<{
  surfaceId: string;
  bytes: Uint8Array;
  byteOffset: number;
}>;

export type TerminalNativeWriteResult =
  | Readonly<{ accepted: true; byteOffset: number }>
  | Readonly<{ accepted: false; reason: TerminalNativeWriteRejectionReason; detail?: string }>;

export type TerminalNativeSurfaceMetrics = Readonly<{
  cols: number;
  rows: number;
}>;

export type TerminalNativeSurfaceHandle = Readonly<{
  writeBytes: (input: TerminalNativeWriteBytesInput) => TerminalNativeWriteResult | Promise<TerminalNativeWriteResult>;
  clear: () => void;
  focus: () => void;
  dispose?: () => void;
}>;

export type TerminalNativeSurfaceProps = Readonly<{
  surfaceId: string;
  fontSize: number;
  lineHeightPx: number;
  onInput: (data: string) => void;
  onReady: (cols: number, rows: number) => void;
  onResize: (cols: number, rows: number) => void;
  onWriteAck?: (event: TerminalNativeWriteAckEvent) => void;
  onLink?: (event: TerminalNativeLinkEvent) => void;
  onSelection?: (event: TerminalNativeSelectionEvent) => void;
  onCopy?: (event: TerminalNativeCopyEvent) => void;
  onTitle?: (event: TerminalNativeTitleEvent) => void;
  onBell?: (event: TerminalNativeBellEvent) => void;
  onRendererCrash?: (event: TerminalNativeRendererCrashEvent) => void;
  onUnavailable?: (reason: TerminalNativeUnavailableReason) => void;
}>;

const WRITE_REJECTION_REASONS = new Set<TerminalNativeWriteRejectionReason>([
  'surface-not-ready',
  'renderer-unavailable',
  'queue-full',
  'invalid-ack',
]);

export function normalizeTerminalNativeWriteResult(
  value: unknown,
  minimumAcceptedByteOffset: number,
): TerminalNativeWriteResult {
  if (!isRecord(value)) {
    return invalidWriteAck();
  }

  if (value.accepted === true) {
    const byteOffset = readNonNegativeInteger(value.byteOffset);
    if (byteOffset !== null && byteOffset >= minimumAcceptedByteOffset) {
      return { accepted: true, byteOffset };
    }
    return invalidWriteAck();
  }

  if (value.accepted === false) {
    const reason = typeof value.reason === 'string' && WRITE_REJECTION_REASONS.has(value.reason as TerminalNativeWriteRejectionReason)
      ? value.reason as TerminalNativeWriteRejectionReason
      : null;
    if (reason) {
      return typeof value.detail === 'string'
        ? { accepted: false, reason, detail: value.detail }
        : { accepted: false, reason };
    }
  }

  return invalidWriteAck();
}

export function normalizeTerminalNativeSurfaceMetrics(value: unknown): TerminalNativeSurfaceMetrics | null {
  if (!isRecord(value)) return null;
  const cols = readPositiveInteger(value.cols);
  const rows = readPositiveInteger(value.rows);
  return cols !== null && rows !== null ? { cols, rows } : null;
}

function invalidWriteAck(): TerminalNativeWriteResult {
  return {
    accepted: false,
    reason: 'invalid-ack',
    detail: 'Native terminal write acknowledgement was missing or regressed.',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
