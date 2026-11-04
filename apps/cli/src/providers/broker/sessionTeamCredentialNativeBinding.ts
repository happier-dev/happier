import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { ProviderBrokerConsumerV1, ProviderCredentialTransportV1 } from '@happier-dev/protocol';
import type { SessionTeamCredentialBindingIntentV1, TeamCredentialProviderModelCatalogEntryV1 } from '@happier-dev/protocol/teams';

import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { materializeLeasedAgentProviderBinding, prepareLeasedAgentProviderBinding } from '@/plugins/runtime/providerBindings/adapter';
import { composeProviderBindingMaterialization } from '@/providers/spawn/compose';
import { SessionTeamCredentialLaunchUnavailableError } from '@/session/services/sessionTeamCredentialLaunchError';
import type { SessionTeamCredentialProviderBinding } from './sessionTeamCredentialProviderBinding';

type NativeEndpoint = Parameters<typeof materializeLeasedAgentProviderBinding>[0]['binding']['endpoint'];

export type SessionTeamCredentialInstalledModelRead = (input: Readonly<{
  sessionId: string;
  agentTargetKey: string;
  modelId: string;
  binding: Exclude<SessionTeamCredentialBindingIntentV1, { resourceId: null }>;
  signal?: AbortSignal;
}>) => Promise<TeamCredentialProviderModelCatalogEntryV1>;

/** Compare the private installed row with the accepted Session witness, never
 * with an installer echo or a new caller-selected source. */
export function assertSessionTeamCredentialNativeModel(input: Readonly<{
  row: TeamCredentialProviderModelCatalogEntryV1;
  binding: Exclude<SessionTeamCredentialBindingIntentV1, { resourceId: null }>;
  agentTargetKey: string;
  modelId: string;
}>): void {
  const { row, binding } = input;
  const native = binding.nativeDelivery;
  if (binding.slot.kind !== 'provider_model' || binding.deliveryMode !== 'vendor-native' || !native
    || row.selection.resourceId !== binding.resourceId || row.selection.expectedResourceRevision !== binding.expectedResourceRevision
    || row.selection.deliveryMode !== 'vendor-native' || row.selection.agentTargetKey !== input.agentTargetKey
    || row.selection.modelId !== input.modelId || (binding.teamId && row.selection.teamId !== binding.teamId)
    || row.availability !== 'available' || native.sourceRevision !== row.sourceRevision
    || native.providerTicket !== row.nativeSource?.providerTicket
    || (row.selection.nativeDelivery && !isDeepStrictEqual(native, row.selection.nativeDelivery))
    || (binding.providerModelSelection && (binding.providerModelSelection.agentTargetKey !== input.agentTargetKey
      || binding.providerModelSelection.modelId !== input.modelId
      || (binding.providerModelSelection.application && !isDeepStrictEqual(binding.providerModelSelection.application, row.application))))) {
    throw new SessionTeamCredentialLaunchUnavailableError();
  }
}

/** The pinned daemon opens the accepted binding. A borrow releases only its
 * local launch materialization; owning Session end retires the installed rule. */
export type SessionTeamCredentialNativeOpen = (input: Readonly<{
  consumer: ProviderBrokerConsumerV1;
  sessionId?: string;
  agentTargetKey: string;
  modelId: string;
  binding: Exclude<SessionTeamCredentialBindingIntentV1, { resourceId: null }>;
  signal: AbortSignal;
}>) => Promise<Readonly<{
  model: TeamCredentialProviderModelCatalogEntryV1;
  endpoint: NativeEndpoint;
  credentialTransport: ProviderCredentialTransportV1;
  placeholder: string;
  cleanup(): Promise<void>;
}>>;

/** Company plaintext never reaches this owner: the ordinary Agent adapter
 * receives only the exact binding's client-compatible placeholder. */
export async function materializeSessionTeamCredentialNativeBinding(input: Readonly<{
  consumer: ProviderBrokerConsumerV1;
  row: TeamCredentialProviderModelCatalogEntryV1;
  binding: Exclude<SessionTeamCredentialBindingIntentV1, { resourceId: null }>;
  agentId: string;
  lease: PluginRuntimeRegistryLease;
  materializationBaseDir: string;
  signal: AbortSignal;
  opened: Awaited<ReturnType<SessionTeamCredentialNativeOpen>>;
}>): Promise<SessionTeamCredentialProviderBinding> {
  const opened = input.opened;
  let composed: Awaited<ReturnType<typeof composeProviderBindingMaterialization>> | null = null;
  try {
    input.signal.throwIfAborted();
    assertSessionTeamCredentialNativeModel({ row: input.row, binding: input.binding,
      agentTargetKey: input.row.selection.agentTargetKey, modelId: input.row.selection.modelId });
    const nativeDelivery = input.binding.nativeDelivery!;
    const endpoint = opened.endpoint;
    const transport = opened.credentialTransport;
    const sourceTransport = input.row.sourceFacts?.credential?.transports.find(candidate =>
      candidate.uses.includes('runtime') && candidate.protocols.includes(input.row.application.protocol)
      && isDeepStrictEqual(candidate, transport));
    if (new URL(endpoint.normalizedUrl).protocol !== 'https:' || !opened.placeholder
      || endpoint.endpointTemplateId !== input.row.application.endpointTemplateId
      || endpoint.protocol !== input.row.application.protocol || !sourceTransport
      || transport.destination.kind !== 'httpHeader' || transport.additionalCredentials?.length) {
      throw new SessionTeamCredentialLaunchUnavailableError('provider_credential_transport_unavailable');
    }
    input.signal.throwIfAborted();
    const bindingKey = nativeDelivery.bindingKey;
    const prepared = prepareLeasedAgentProviderBinding({ lease: input.lease, agentId: input.agentId,
      input: { v: 1, agentTargetKey: input.row.selection.agentTargetKey, bindingKey } });
    const materialization = await materializeLeasedAgentProviderBinding({ lease: input.lease, agentId: input.agentId,
      binding: { v: 1, agentTargetKey: input.row.selection.agentTargetKey,
        selection: { bindingKey, model: input.row.descriptor }, contributionKey: null,
        endpoint, runtimeCredentialTransport: transport, compatibilityFingerprint: input.row.sourceRevision },
      prepared, credential: { kind: 'apiKey', transport, value: opened.placeholder } });
    composed = await composeProviderBindingMaterialization({ materialization,
      materializationBaseDir: join(input.materializationBaseDir, 'team-native'),
      sessionId: input.consumer.kind === 'session' ? input.consumer.sessionId : input.consumer.executionRunId });
    input.signal.throwIfAborted();
    const releaseMaterialization = composed.takeCleanupOwnership();
    let materializationReleased = false;
    let closed = false;
    let cleanupInFlight: Promise<void> | null = null;
    return Object.freeze({
      providerBinding: { source: { kind: 'team_resource', resourceId: input.row.selection.resourceId,
        resourceRevision: input.row.selection.expectedResourceRevision }, model: input.row.descriptor,
        upstream: { protocol: endpoint.protocol, normalizedUrl: endpoint.normalizedUrl, credential: 'apiKey' },
        materialization: composed.launchMaterialization },
      environmentOverlay: composed.providerEnvironmentOverlay,
      additionalRedactionValues: Object.freeze([opened.placeholder, ...composed.additionalRedactionValues]),
      cleanup() {
        if (closed) return Promise.resolve();
        cleanupInFlight ??= (async () => {
          try {
            if (!materializationReleased) { releaseMaterialization?.(); materializationReleased = true; }
          } finally { await opened.cleanup(); }
        })().then(() => { closed = true; cleanupInFlight = null; }, (error: unknown) => {
          cleanupInFlight = null;
          throw error;
        });
        return cleanupInFlight;
      },
    });
  } catch (error) {
    try { composed?.cleanup?.(); } finally { await opened.cleanup(); }
    throw error;
  }
}
