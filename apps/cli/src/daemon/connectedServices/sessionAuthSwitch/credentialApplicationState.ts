import { ConnectedServiceBindingsV2IngressSchema, readBuiltInLegacyConnectedAccountServiceKeyIngress } from '@happier-dev/protocol/connect/connected-service-bindings';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { ConnectedAccountServiceKey, ConnectedServiceBindingsV2 } from '@happier-dev/protocol';

import { readConnectedServiceChildSelectionsFromEnv, type ConnectedServiceChildSelection } from '../connectedServiceChildEnvironment';
import type { TrackedSession } from '@/daemon/types';
import { resolveTrackedConnectedServiceBindingsRaw } from '../trackedSessionConnectedServiceBindings';
import type { ConnectedServiceSessionAuthSwitchCore } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';

export function readConnectedServiceBindingsOrEmpty(raw: unknown): ConnectedServiceBindingsV2 {
  const parsed = createStoredReadSchema(ConnectedServiceBindingsV2IngressSchema).safeParse(raw);
  return parsed.success ? parsed.data : { v: 2, bindingsByServiceId: {} };
}

export function readConnectedServiceCredentialApplicationState(input: Readonly<{
  serviceId: ConnectedAccountServiceKey;
  connectedServicesBindingsRaw: unknown;
  connectedServiceSelectionsEnv?: NodeJS.ProcessEnv;
}>): Readonly<{
  serviceId: ConnectedAccountServiceKey;
  bindings: ConnectedServiceBindingsV2;
  binding: ConnectedServiceBindingsV2['bindingsByServiceId'][string] | undefined;
  childSelection: ConnectedServiceChildSelection | null;
}> | null {
  const serviceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(input.serviceId);
  if (!serviceId) return null;
  const bindings = readConnectedServiceBindingsOrEmpty(input.connectedServicesBindingsRaw);
  return {
    serviceId,
    bindings,
    binding: bindings.bindingsByServiceId[serviceId],
    childSelection: readConnectedServiceChildSelectionsFromEnv(input.connectedServiceSelectionsEnv ?? {})?.get(serviceId) ?? null,
  };
}

type CredentialUpdateResult = Readonly<{ status: 'unchanged' | 'hot_applied' | 'restart_requested' }>
  | Readonly<{ status: 'failed'; errorCode: string }>;

/** Notification admission and application share the existing Session transition custody. */
export async function applyConnectedServiceCredentialUpdate(input: Readonly<{
  signal?: AbortSignal;
  sessionId: string;
  serviceId: ConnectedAccountServiceKey;
  profileId: string;
  core: ConnectedServiceSessionAuthSwitchCore;
  getTrackedSession(sessionId: string): TrackedSession | null;
  applyGeneration(request: Readonly<{
    sessionId: string;
    serviceId: ConnectedAccountServiceKey;
    groupId: string | null;
    activeProfileId: string;
    generation: number | null;
  }>): Promise<Readonly<{ ok: true; action?: string }> | Readonly<{ ok: false; errorCode: string }>>;
}>): Promise<CredentialUpdateResult> {
  input.signal?.throwIfAborted();
  const sessionId = input.sessionId.trim();
  if (!sessionId) return { status: 'failed', errorCode: 'session_not_found' };
  return await input.core.run<CredentialUpdateResult>({ sessionId, reason: 'automatic_runtime_failure', execute: async () => {
    // A preceding application may replace the runner or roll back its staged
    // selection. Re-read both only after that transition has settled.
    const tracked = input.getTrackedSession(sessionId);
    if (!tracked) return { status: 'failed', errorCode: 'session_not_found' };
    const state = readConnectedServiceCredentialApplicationState({ serviceId: input.serviceId,
      connectedServicesBindingsRaw: resolveTrackedConnectedServiceBindingsRaw(tracked),
      connectedServiceSelectionsEnv: tracked.spawnOptions?.environmentVariables });
    if (!state) return { status: 'failed', errorCode: 'unsupported_service' };
    const selection = state.childSelection;
    if (state.binding?.source !== 'connected'
      || (selection?.kind === 'group' ? selection.activeProfileId
        : selection?.profileId ?? state.binding.profileId) !== input.profileId) {
      return { status: 'unchanged' };
    }
    const result = await input.applyGeneration({ sessionId, serviceId: state.serviceId,
      groupId: selection?.kind === 'group' ? selection.groupId : null,
      activeProfileId: input.profileId,
      generation: selection?.kind === 'group' ? selection.generation : null });
    if (!result.ok) return { status: 'failed', errorCode: result.errorCode };
    return { status: result.action === 'hot_applied' || result.action === 'restart_requested'
      ? result.action : 'unchanged' };
  } });
}
