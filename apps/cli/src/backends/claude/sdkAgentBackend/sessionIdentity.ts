import type { AgentMessage, SessionId } from '@/agent/core/AgentBackend';
import type { ClaudeSdkLifecycleState } from './runtimeState';

export function noteClaudeSdkVendorSessionId(params: Readonly<{
  emit: (message: AgentMessage) => void;
  lifecycle: ClaudeSdkLifecycleState;
  sessionIdRaw: unknown;
}>): void {
  const sessionId = typeof params.sessionIdRaw === 'string' ? params.sessionIdRaw.trim() : '';
  if (!sessionId) return;
  const normalized = sessionId as SessionId;
  params.lifecycle.vendorSessionId = normalized;
  if (!params.lifecycle.acceptedSessionIds.has(normalized)) {
    params.lifecycle.acceptedSessionIds.add(normalized);
    params.emit({ type: 'event', name: 'vendor_session_id', payload: { sessionId: normalized } });
  }
  const resolve = params.lifecycle.resolveVendorSessionId;
  if (!resolve) return;
  params.lifecycle.resolveVendorSessionId = null;
  resolve(normalized);
}

export async function waitForClaudeSdkVendorSessionId(params: Readonly<{
  lifecycle: ClaudeSdkLifecycleState;
  timeoutMs: number;
}>): Promise<SessionId | null> {
  if (params.lifecycle.vendorSessionId) return params.lifecycle.vendorSessionId;
  const timeoutMs = Math.max(1, Math.floor(params.timeoutMs));
  try {
    const vendor = await Promise.race([
      params.lifecycle.vendorSessionIdPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return vendor;
  } catch {
    return null;
  }
}
