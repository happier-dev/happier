import type { HostCurrentSessionUiServices } from '@/agent/runtime/state/currentSessionUiTypes';

type Binding = Readonly<{
  token: symbol;
  service: HostCurrentSessionUiServices;
  signal: AbortSignal;
  isCurrent: () => boolean;
}>;

const bindings = new Map<string, Binding>();

export function registerCurrentSessionUiBinding(params: Readonly<{
  sessionId: string;
  service: HostCurrentSessionUiServices;
  signal: AbortSignal;
  isCurrent: () => boolean;
}>): () => void {
  const sessionId = params.sessionId.trim();
  const token = Symbol(sessionId);
  const binding = Object.freeze({
    token,
    service: params.service,
    signal: params.signal,
    isCurrent: params.isCurrent,
  });
  bindings.set(sessionId, binding);
  const dispose = () => {
    if (bindings.get(sessionId)?.token === token) bindings.delete(sessionId);
  };
  if (params.signal.aborted) dispose();
  else params.signal.addEventListener('abort', dispose, { once: true });
  return dispose;
}

export function resolveCurrentSessionUiBinding(
  sessionIdRaw: string,
): HostCurrentSessionUiServices | null {
  const sessionId = sessionIdRaw.trim();
  const binding = bindings.get(sessionId);
  if (!binding || binding.signal.aborted) return null;
  try {
    if (binding.isCurrent() !== true) return null;
  } catch {
    return null;
  }
  return binding.service;
}
