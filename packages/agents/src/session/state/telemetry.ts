import type { SessionStateTelemetryEvent } from './_types.js';

export function sanitizeSessionStateErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as Readonly<{ code?: unknown }>).code;
  if (typeof code !== 'string') return undefined;
  const normalized = code.trim().toLowerCase().replaceAll('-', '_');
  return /^[a-z0-9][a-z0-9_:.]{0,63}$/.test(normalized) ? normalized : undefined;
}

export function emitSessionStateTelemetry(
  emit: ((event: SessionStateTelemetryEvent) => void) | null | undefined,
  event: SessionStateTelemetryEvent,
): void {
  emit?.(event);
}
