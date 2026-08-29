import {
  ConnectedServiceCredentialRecordV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
  readBuiltInLegacyConnectedAccountServiceKeyIngress,
} from '@happier-dev/protocol';

import type { ConnectedServiceRuntimeAuthTargetInput } from './types';

type RuntimeAuthNativeHome = NonNullable<ConnectedServiceRuntimeAuthTargetInput['nativeHome']>;
type RuntimeAuthSelection = ConnectedServiceRuntimeAuthTargetInput['selection'];

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readApplyReason(value: unknown):
  | 'usage_limit'
  | 'same_provider_account_exhausted'
  | 'soft_threshold'
  | 'manual'
  | 'diagnostic'
  | null {
  return value === 'usage_limit'
    || value === 'same_provider_account_exhausted'
    || value === 'soft_threshold'
    || value === 'manual'
    || value === 'diagnostic'
    ? value
    : null;
}

export function projectConnectedServiceRuntimeAuthSelection(
  value: Readonly<Record<string, unknown>>,
): RuntimeAuthSelection {
  const serviceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(value.serviceId);
  const profileId = readString(value.profileId);
  const activeProfileId = readString(value.activeProfileId);
  const fallbackProfileId = readString(value.fallbackProfileId);
  const groupId = readString(value.groupId);
  const applyReason = readString(value.applyReason);
  const sourceProviderAccountId = readString(value.sourceProviderAccountId);
  const sourceAccountLabel = readString(value.sourceAccountLabel);
  const kind = value.kind === 'profile' || value.kind === 'group' ? value.kind : null;
  const generation = typeof value.generation === 'number' && Number.isSafeInteger(value.generation) && value.generation >= 0
    ? value.generation
    : null;
  const groupGeneration = typeof value.groupGeneration === 'number'
    && Number.isSafeInteger(value.groupGeneration)
    && value.groupGeneration >= 0
    ? value.groupGeneration
    : null;
  const credentialRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(value.credentialRevision);
  return Object.freeze({
    ...(serviceId ? { serviceId } : {}),
    ...(profileId ? { profileId } : {}),
    ...(activeProfileId ? { activeProfileId } : {}),
    ...(fallbackProfileId ? { fallbackProfileId } : {}),
    ...(groupId ? { groupId } : {}),
    ...(applyReason ? { applyReason } : {}),
    ...(sourceProviderAccountId ? { sourceProviderAccountId } : {}),
    ...(sourceAccountLabel ? { sourceAccountLabel } : {}),
    ...(kind ? { kind } : {}),
    ...(generation === null ? {} : { generation }),
    ...(groupGeneration === null ? {} : { groupGeneration }),
    ...(value.requireDirectLiveHotApply === true ? { requireDirectLiveHotApply: true } : {}),
    ...(credentialRevision.success ? { credentialRevision: credentialRevision.data } : {}),
  });
}

export function projectConnectedServiceRuntimeAuthTargetInput(input: Readonly<{
  agentId: string;
  materializedSelection: unknown;
  fallbackSelection: Readonly<Record<string, unknown>>;
  validateCurrentBeforeMutation?: ConnectedServiceRuntimeAuthTargetInput['validateCurrentBeforeMutation'];
}>): ConnectedServiceRuntimeAuthTargetInput {
  const materialized = readRecord(input.materializedSelection);
  const credential = ConnectedServiceCredentialRecordV1Schema.safeParse(
    materialized?.credential,
  );
  const nativeHomeRecord = readRecord(materialized?.nativeHome);
  const nativeHome = nativeHomeRecord
    && typeof nativeHomeRecord.readFiles === 'function'
    && typeof nativeHomeRecord.replaceFiles === 'function'
    ? {
        readFiles: nativeHomeRecord.readFiles as RuntimeAuthNativeHome['readFiles'],
        replaceFiles: nativeHomeRecord.replaceFiles as RuntimeAuthNativeHome['replaceFiles'],
      }
    : null;
  const sourceSelection = materialized ?? input.fallbackSelection;
  const selection = projectConnectedServiceRuntimeAuthSelection({
    ...sourceSelection,
    ...(credential.success && credential.data.kind === 'oauth'
      ? {
          sourceProviderAccountId: credential.data.oauth.providerAccountId,
          sourceAccountLabel: credential.data.oauth.providerEmail,
        }
      : {}),
  });
  const applyAuthGenerationSource = sourceSelection.applyConnectedServiceAuthGeneration;
  const applyReason = readApplyReason(selection.applyReason);
  const selectedServiceId = selection.serviceId
    ?? (credential.success
      ? readBuiltInLegacyConnectedAccountServiceKeyIngress(credential.data.serviceId)
      : null);
  const applySelectedAuthGeneration = typeof applyAuthGenerationSource === 'function'
    && credential.success
    && selectedServiceId
    ? async () => await applyAuthGenerationSource({
        serviceId: selectedServiceId,
        ...(applyReason ? { reason: applyReason } : {}),
        ...(selection.requireDirectLiveHotApply ? { requireDirectLiveHotApply: true } : {}),
        expected: {
          ...(selection.activeProfileId ?? selection.profileId
            ? { profileId: selection.activeProfileId ?? selection.profileId }
            : {}),
          ...(selection.groupId ? { groupId: selection.groupId } : {}),
          ...(selection.generation === undefined ? {} : { generation: selection.generation }),
          ...(selection.credentialRevision ? { credentialRevision: selection.credentialRevision } : {}),
        },
        authGeneration: {
          credential: credential.data,
          ...(selection.credentialRevision ? { credentialRevision: selection.credentialRevision } : {}),
          selection,
        },
      })
    : undefined;
  const client = readRecord(sourceSelection.client);
  const requestProviderSource = client?.request;
  const readProviderAccount = typeof requestProviderSource === 'function'
    ? async () => await requestProviderSource.call(client, 'account/read')
    : undefined;
  const readProviderUsage = typeof requestProviderSource === 'function'
    ? async (params?: unknown) => await requestProviderSource.call(client, 'account/rateLimits/read', params)
    : undefined;
  return {
    target: { agentId: input.agentId },
    selection,
    ...(applySelectedAuthGeneration ? { applySelectedAuthGeneration } : {}),
    ...(readProviderAccount ? { readProviderAccount } : {}),
    ...(readProviderUsage ? { readProviderUsage } : {}),
    ...(credential.success ? { credential: credential.data } : {}),
    ...(nativeHome ? { nativeHome } : {}),
    ...(input.validateCurrentBeforeMutation
      ? { validateCurrentBeforeMutation: input.validateCurrentBeforeMutation }
      : {}),
  };
}
