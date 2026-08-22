import type { HostCurrentSessionUiServices } from '@/agent/runtime/state/currentSessionUiTypes';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type { SessionMediaService } from '@happier-dev/plugin-sdk/sessions';

export type CurrentSessionCapabilityBinding = Readonly<{
  scopeId: symbol;
  permissionHandler?: Pick<
    ProviderEnforcedPermissionHandler,
    | 'handleToolCall'
    | 'listMediatedPendingRequests'
    | 'respondToMediatedPendingPermission'
    | 'listMediatedPermissionGrants'
    | 'revokeMediatedPermissionGrant'
  >;
  readPermissionMode: () => string;
  createMediaService?(
    authorizeSourceRoot: (canonicalRoot: string) => boolean | Promise<boolean>,
  ): SessionMediaService;
  signal: AbortSignal;
  isCurrent: () => boolean;
}>;

type Binding = Readonly<{
  token: symbol;
  service: HostCurrentSessionUiServices;
  signal: AbortSignal;
  isCurrent: () => boolean;
  capabilities?: Omit<CurrentSessionCapabilityBinding, 'scopeId' | 'signal' | 'isCurrent'>;
}>;

const bindings = new Map<string, Binding>();

export function registerCurrentSessionUiBinding(params: Readonly<{
  sessionId: string;
  service: HostCurrentSessionUiServices;
  signal: AbortSignal;
  isCurrent: () => boolean;
  capabilities?: Omit<CurrentSessionCapabilityBinding, 'scopeId' | 'signal' | 'isCurrent'>;
}>): () => void {
  const sessionId = params.sessionId.trim();
  const token = Symbol(sessionId);
  const binding = Object.freeze({
    token,
    service: params.service,
    signal: params.signal,
    isCurrent: params.isCurrent,
    ...(params.capabilities ? { capabilities: params.capabilities } : {}),
  });
  bindings.set(sessionId, binding);
  const dispose = () => {
    if (bindings.get(sessionId)?.token === token) bindings.delete(sessionId);
  };
  if (params.signal.aborted) dispose();
  else params.signal.addEventListener('abort', dispose, { once: true });
  return dispose;
}

export function resolveCurrentSessionCapabilityBinding(
  sessionIdRaw: string,
): CurrentSessionCapabilityBinding | null {
  const sessionId = sessionIdRaw.trim();
  const binding = bindings.get(sessionId);
  if (!binding?.capabilities || binding.signal.aborted) return null;
  try {
    if (binding.isCurrent() !== true) return null;
  } catch {
    return null;
  }
  return Object.freeze({
    scopeId: binding.token,
    ...binding.capabilities,
    signal: binding.signal,
    isCurrent: binding.isCurrent,
  });
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
