import type { ConnectedServiceId } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';
import type { ConnectedServiceRuntimeRegistry, ConnectedServiceRuntimeTarget } from '../runtimeRegistry/registry';
import {
  resolveConnectedServiceGroupMemberByProviderAccountId,
  type ConnectedServiceGroupMemberProviderAccountIdentity,
} from '../shared/resolveConnectedServiceGroupMemberByProviderAccountId';

export async function reconcileProviderObservedSessionAccount(input: Readonly<{
  runtimeRegistry: ConnectedServiceRuntimeRegistry;
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  providerOrganizationId: string | null;
  observedAtMs: number;
  sourceSessionId: string;
  getCurrentProviderSessionId: () => string | null;
  getGroup: () => Promise<Readonly<{
    generation: number;
    members: ReadonlyArray<Readonly<{ profileId: string }>>;
  }> | null>;
  resolveProviderAccountIdentity: (profileId: string) => Promise<ConnectedServiceGroupMemberProviderAccountIdentity | null>;
}>): Promise<Readonly<{ target: ConnectedServiceRuntimeTarget; generationBehind: boolean }> | null> {
  if (input.getCurrentProviderSessionId() !== input.sourceSessionId) return null;
  const before = input.runtimeRegistry.getBySessionId(input.sessionId);
  const binding = before?.activeBindings.find((candidate) => (
    candidate.serviceId === input.serviceId && candidate.groupId === input.groupId
  ));
  if (!before || !binding) return null;
  const group = await input.getGroup();
  if (!group) return null;
  const profileId = await resolveConnectedServiceGroupMemberByProviderAccountId({
    providerOrganizationId: input.providerOrganizationId,
    members: group.members,
    resolveProviderAccountIdentity: input.resolveProviderAccountIdentity,
  });
  if (!profileId) {
    logger.warn('[ConnectedServices] Provider session account observation is unproven', {
      sessionId: input.sessionId, serviceId: input.serviceId, groupId: input.groupId,
      errorCode: 'provider_session_account_observation_unproven',
    });
    return null;
  }
  // A replacement/application during identity resolution owns the newer state. The provider
  // timestamp is checked by the registry too, covering reordered observations of one registration.
  if (input.runtimeRegistry.getBySessionId(input.sessionId) !== before
    || input.getCurrentProviderSessionId() !== input.sourceSessionId) return null;
  const target = input.runtimeRegistry.adoptProviderObservedGroupAccountForSession({
    sessionId: input.sessionId, serviceId: input.serviceId, groupId: input.groupId,
    profileId, observedAtMs: input.observedAtMs,
  });
  if (!target) return null;
  return { target, generationBehind: binding.generation !== null && binding.generation < group.generation };
}

/** Keep account publication and generation catch-up on the same observed-account path. */
export async function handleProviderObservedSessionAccount(input: Parameters<typeof reconcileProviderObservedSessionAccount>[0] & Readonly<{
  publishAccount: (target: ConnectedServiceRuntimeTarget) => Promise<void>;
  reconcileGeneration: (target: ConnectedServiceRuntimeTarget) => Promise<void>;
}>): Promise<void> {
  const observed = await reconcileProviderObservedSessionAccount(input);
  if (!observed) return;
  if (observed.generationBehind) await input.reconcileGeneration(observed.target);
  await input.publishAccount(observed.target);
}
