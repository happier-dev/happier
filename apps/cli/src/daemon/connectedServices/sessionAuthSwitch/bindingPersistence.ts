import { projectProviderObservedAccountMetadata } from './providerObservedAccountMetadata';
import { readConnectedServiceMaterializationIdentityV1FromMetadata, writeConnectedServiceMaterializationIdentityV1ToMetadata } from '@happier-dev/protocol/sessions/metadata/connectedServiceMaterializationIdentityV1';
import type { ConnectedServiceBindingsV2, ConnectedServiceMaterializationIdentityV1 } from '@happier-dev/protocol';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import type { CatalogAgentId } from '@/agent/catalog/types';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { generateConnectedServiceMaterializationIdentityV1 } from "@/daemon/connectedServices/materialization/identity";

export async function persistSessionConnectedServiceBindings(
  input: Readonly<{
    token: string;
    credentials: Parameters<
      typeof updateSessionMetadataWithRetry
    >[0]['credentials'];
    sessionId: string;
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
    teamCredentialBindings?: import('@happier-dev/protocol/teams').SessionTeamCredentialBindingIntentListV1;
    teamVisibilityGrantConsent?: Readonly<{ teamId: string }>;
  }> & (Readonly<{ normalizedBindings: ConnectedServiceBindingsV2; providerObservedAccount?: never; isCurrent?: never }>
    | Readonly<{ normalizedBindings?: never; providerObservedAccount: Readonly<{ serviceId: import('@happier-dev/protocol').ConnectedAccountServiceKey; groupId: string; profileId: string }>; isCurrent: () => boolean | Promise<boolean> }>),
): Promise<void> {
  const rawSession = await fetchSessionByIdCompat({ reason: 'session-control',
    token: input.token,
    sessionId: input.sessionId,
  });
  if (!rawSession) {
    throw new Error('session_not_found');
  }
  await updateSessionMetadataWithRetry({
    token: input.token,
    credentials: input.credentials,
    sessionId: input.sessionId,
    rawSession,
    ...(input.providerObservedAccount ? { currentness: { verifyCurrent: async () => input.isCurrent() } } : {}),
    ...(input.teamCredentialBindings
      ? {
          teamCredentialBindings: input.teamCredentialBindings,
          teamCredentialBindingOperation:
            'session.connected_service.switch' as const,
        }
      : {}),
    ...(input.teamVisibilityGrantConsent
      ? { teamVisibilityGrantConsent: input.teamVisibilityGrantConsent }
      : {}),
    updater: async (metadata) => {
      if (input.providerObservedAccount && !await input.isCurrent()) return metadata;
      const projected = input.providerObservedAccount
        ? projectProviderObservedAccountMetadata(metadata, input.providerObservedAccount)
        : { ...metadata, connectedServices: input.normalizedBindings };
      if (projected === metadata) return metadata;
      const existingUpdatedAt =
        typeof metadata.connectedServicesUpdatedAt === 'number' &&
        Number.isFinite(metadata.connectedServicesUpdatedAt)
          ? metadata.connectedServicesUpdatedAt
          : 0;
      const materializationIdentity =
        input.connectedServiceMaterializationIdentityV1 ??
        readConnectedServiceMaterializationIdentityV1FromMetadata(metadata);
      const nextMetadata = {
        ...projected,
        connectedServicesUpdatedAt: Math.max(Date.now(), existingUpdatedAt + 1),
      };
      return materializationIdentity
        ? writeConnectedServiceMaterializationIdentityV1ToMetadata(
            nextMetadata,
            materializationIdentity,
          )
        : nextMetadata;
    },
  });
}

export function selectConnectedServiceCredentialBindingIntentsForPersist(
  input: Readonly<{
    normalizedBindings: ConnectedServiceBindingsV2;
    next?: import('@happier-dev/protocol/teams').SessionTeamCredentialBindingIntentListV1;
    previous?: import('@happier-dev/protocol/teams').SessionTeamCredentialBindingIntentListV1;
  }>,
): Readonly<{
  intents?: import('@happier-dev/protocol/teams').SessionTeamCredentialBindingIntentListV1;
  isNext: boolean;
}> {
  const selectedResourceIds = new Set(
    Object.values(input.normalizedBindings.bindingsByServiceId).flatMap(
      (binding) =>
        binding.source === 'team_resource' ? [binding.resourceId] : [],
    ),
  );
  const containsSelectedResource = (
    intents:
      | import('@happier-dev/protocol/teams').SessionTeamCredentialBindingIntentListV1
      | undefined,
  ) =>
    intents?.some(
      (intent) =>
        intent.resourceId !== null &&
        selectedResourceIds.has(intent.resourceId),
    ) === true;
  if (containsSelectedResource(input.next))
    return { intents: input.next, isNext: true };
  if (containsSelectedResource(input.previous))
    return { intents: input.previous, isNext: false };
  if (
    selectedResourceIds.size === 0 &&
    input.next?.every((intent) => intent.resourceId === null)
  ) {
    return { intents: input.next, isNext: true };
  }
  return { isNext: false };
}

export async function repairMissingConnectedServiceMaterializationIdentityForSpawn(
  input: Readonly<{
    token: string;
    credentials: Parameters<
      typeof updateSessionMetadataWithRetry
    >[0]['credentials'];
    sessionId: string;
    agentId: CatalogAgentId;
    connectedServices: ConnectedServiceBindingsV2;
    vendorResumeId: string | null;
  }>,
): Promise<Readonly<{
  identity: ConnectedServiceMaterializationIdentityV1;
  persistAfterMaterialization: () => Promise<void>;
}> | null> {
  const vendorResumeId = readNonBlankOpaqueIdentifier(input.vendorResumeId);
  if (!vendorResumeId) return null;

  const hasConnectedBinding = Object.values(
    input.connectedServices.bindingsByServiceId,
  ).some((binding) => binding.source === 'connected');
  if (!hasConnectedBinding) return null;

  const connectedServiceMaterializationIdentityV1 =
    generateConnectedServiceMaterializationIdentityV1();
  return {
    identity: connectedServiceMaterializationIdentityV1,
    persistAfterMaterialization: async () => {
      await persistSessionConnectedServiceBindings({
        token: input.token,
        credentials: input.credentials,
        sessionId: input.sessionId,
        normalizedBindings: input.connectedServices,
        connectedServiceMaterializationIdentityV1,
      });
    },
  };
}
