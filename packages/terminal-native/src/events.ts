import type {
  TerminalNativeEventName,
  TerminalNativeEventPayload,
  TerminalNativeEventPayloadMap,
  TerminalNativeCopyEvent,
  TerminalNativeInputEvent,
  TerminalNativeLinkEvent,
  TerminalNativeBellEvent,
  TerminalNativeRendererCrashEvent,
  TerminalNativeResizeEvent,
  TerminalNativeSelectionEvent,
  TerminalNativeSelectionState,
  TerminalNativeSurfaceReadyEvent,
  TerminalNativeTitleEvent,
  TerminalNativeWriteAckEvent,
} from './HappierTerminalNative.types';

export type {
  TerminalNativeLinkEvent,
  TerminalNativeCopyEvent,
  TerminalNativeInputEvent,
  TerminalNativeRendererCrashEvent,
  TerminalNativeResizeEvent,
  TerminalNativeSelectionEvent,
  TerminalNativeSelectionState,
  TerminalNativeSurfaceReadyEvent,
  TerminalNativeTitleEvent,
  TerminalNativeBellEvent,
  TerminalNativeWriteAckEvent,
} from './HappierTerminalNative.types';

export const TERMINAL_NATIVE_EVENT_NAMES: readonly TerminalNativeEventName[] = [
  'rendererCrash',
  'surfaceReady',
  'writeAck',
  'input',
  'resize',
  'link',
  'selection',
  'copy',
  'title',
  'bell',
];

const SELECTION_STATES = new Set<TerminalNativeSelectionState>([
  'started',
  'changed',
  'ended',
  'cleared',
  'copied',
]);

export function normalizeTerminalNativeEvent<TName extends TerminalNativeEventName>(
  eventName: TName,
  payload: unknown,
): TerminalNativeEventPayload<TName> | null {
  switch (eventName) {
    case 'rendererCrash':
      return normalizeRendererCrashEvent(payload) as TerminalNativeEventPayload<TName> | null;
    case 'surfaceReady':
      return normalizeSurfaceReadyEvent(payload) as TerminalNativeEventPayload<TName> | null;
    case 'writeAck':
      return normalizeWriteAckEvent(payload) as TerminalNativeEventPayload<TName> | null;
    case 'input':
      return normalizeInputEvent(payload) as TerminalNativeEventPayload<TName> | null;
    case 'resize':
      return normalizeResizeEvent(payload) as TerminalNativeEventPayload<TName> | null;
    case 'link':
      return normalizeLinkEvent(payload) as TerminalNativeEventPayload<TName> | null;
    case 'selection':
      return normalizeSelectionEvent(payload) as TerminalNativeEventPayload<TName> | null;
    case 'copy':
      return normalizeCopyEvent(payload) as TerminalNativeEventPayload<TName> | null;
    case 'title':
      return normalizeTitleEvent(payload) as TerminalNativeEventPayload<TName> | null;
    case 'bell':
      return normalizeBellEvent(payload) as TerminalNativeEventPayload<TName> | null;
  }
}

export function normalizeTerminalNativeEventMap(
  eventName: TerminalNativeEventName,
  payload: unknown,
): TerminalNativeEventPayloadMap[TerminalNativeEventName] | null {
  return normalizeTerminalNativeEvent(eventName, payload);
}

function normalizeRendererCrashEvent(payload: unknown): TerminalNativeRendererCrashEvent | null {
  if (!isRecord(payload)) return null;
  const surfaceId = readNonEmptyString(payload.surfaceId);
  const reason = readNonEmptyString(payload.reason);
  return surfaceId && reason && payload.fatal === true ? { surfaceId, reason, fatal: true } : null;
}

function normalizeSurfaceReadyEvent(payload: unknown): TerminalNativeSurfaceReadyEvent | null {
  if (!isRecord(payload)) return null;
  const surfaceId = readNonEmptyString(payload.surfaceId);
  const cols = readPositiveInteger(payload.cols);
  const rows = readPositiveInteger(payload.rows);
  return surfaceId && cols !== null && rows !== null ? { surfaceId, cols, rows } : null;
}

function normalizeWriteAckEvent(payload: unknown): TerminalNativeWriteAckEvent | null {
  if (!isRecord(payload)) return null;
  const surfaceId = readNonEmptyString(payload.surfaceId);
  const byteOffset = readNonNegativeInteger(payload.byteOffset);
  return surfaceId && byteOffset !== null ? { surfaceId, byteOffset } : null;
}

function normalizeInputEvent(payload: unknown): TerminalNativeInputEvent | null {
  if (!isRecord(payload)) return null;
  const surfaceId = readNonEmptyString(payload.surfaceId);
  const data = readNonEmptyString(payload.data);
  return surfaceId && data ? { surfaceId, data } : null;
}

function normalizeResizeEvent(payload: unknown): TerminalNativeResizeEvent | null {
  if (!isRecord(payload)) return null;
  const surfaceId = readNonEmptyString(payload.surfaceId);
  const cols = readPositiveInteger(payload.cols);
  const rows = readPositiveInteger(payload.rows);
  return surfaceId && cols !== null && rows !== null ? { surfaceId, cols, rows } : null;
}

function normalizeLinkEvent(payload: unknown): TerminalNativeLinkEvent | null {
  if (!isRecord(payload)) return null;
  const surfaceId = readNonEmptyString(payload.surfaceId);
  const url = readNonEmptyString(payload.url);
  if (!surfaceId || !url) return null;
  if (payload.text !== undefined) {
    const text = readNonEmptyString(payload.text);
    return text ? { surfaceId, url, text } : null;
  }
  return { surfaceId, url };
}

function normalizeSelectionEvent(payload: unknown): TerminalNativeSelectionEvent | null {
  if (!isRecord(payload)) return null;
  const surfaceId = readNonEmptyString(payload.surfaceId);
  const state = typeof payload.state === 'string' && SELECTION_STATES.has(payload.state as TerminalNativeSelectionState)
    ? payload.state as TerminalNativeSelectionState
    : null;
  if (!surfaceId || !state) return null;
  if (payload.text !== undefined) {
    const text = readNonEmptyString(payload.text);
    return text ? { surfaceId, state, text } : null;
  }
  return { surfaceId, state };
}

function normalizeCopyEvent(payload: unknown): TerminalNativeCopyEvent | null {
  if (!isRecord(payload)) return null;
  const surfaceId = readNonEmptyString(payload.surfaceId);
  const text = readNonEmptyString(payload.text);
  return surfaceId && text ? { surfaceId, text } : null;
}

function normalizeTitleEvent(payload: unknown): TerminalNativeTitleEvent | null {
  if (!isRecord(payload)) return null;
  const surfaceId = readNonEmptyString(payload.surfaceId);
  const title = readNonEmptyString(payload.title);
  return surfaceId && title ? { surfaceId, title } : null;
}

function normalizeBellEvent(payload: unknown): TerminalNativeBellEvent | null {
  if (!isRecord(payload)) return null;
  const surfaceId = readNonEmptyString(payload.surfaceId);
  if (!surfaceId) return null;
  if (payload.label !== undefined) {
    const label = readNonEmptyString(payload.label);
    return label ? { surfaceId, label } : null;
  }
  return { surfaceId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
