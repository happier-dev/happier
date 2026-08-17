import { basename } from 'node:path';

import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { resolveConnectedServiceCredentials } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import type { ConnectedServiceRuntimeAuthSelectionMaterializer } from '@/daemon/connectedServices/sessionAuthSwitch/runtimeAuthSelectionMaterializerTypes';
import { logger } from '@/ui/logger';

import type { OpenCodeConnectedServiceId } from './openCodeConnectedServicePrecedence';
import { readOpenCodeConnectedServiceId } from './openCodeConnectedServicePrecedence';
import { materializeOpenCodeConnectedServiceAuth } from './materializeOpenCodeConnectedServiceAuth';
import { readTrackedSessionBrokerSelectionIdentity } from '@/daemon/connectedServices/broker/trackedSessionBrokerSelectionIdentity';
import {
  readSharedManagedOpenCodeServerStateByLaunchFingerprintBestEffort,
  resolveSharedManagedOpenCodeServerStatePathForEnv,
} from '@/backends/opencode/server/sharedManagedServer';

function buildOpenCodeMaterializationInput(
  serviceId: OpenCodeConnectedServiceId,
  record: ConnectedServiceCredentialRecordV1,
): Readonly<{
  openaiCodex: ConnectedServiceCredentialRecordV1 | null;
  openai: ConnectedServiceCredentialRecordV1 | null;
  claudeSubscription: ConnectedServiceCredentialRecordV1 | null;
  anthropic: ConnectedServiceCredentialRecordV1 | null;
}> {
  return {
    openaiCodex: serviceId === 'openai-codex' ? record : null,
    openai: serviceId === 'openai' ? record : null,
    claudeSubscription: serviceId === 'claude-subscription' ? record : null,
    anthropic: serviceId === 'anthropic' ? record : null,
  };
}

async function resolvePreviousLaunchFingerprintContext(params: Readonly<{
  serviceId: OpenCodeConnectedServiceId;
  previousProfileId: string | null;
  credentials: Parameters<typeof resolveConnectedServiceCredentials>[0]['credentials'];
  api: Parameters<typeof resolveConnectedServiceCredentials>[0]['api'];
  processEnv: NodeJS.ProcessEnv;
}>): Promise<Readonly<{ previousLaunchFingerprint: string; previousOwnerToken: string | null }> | null> {
  const previousProfileId = typeof params.previousProfileId === 'string' ? params.previousProfileId.trim() : '';
  if (!previousProfileId) return null;

  const records = await resolveConnectedServiceCredentials({
    credentials: params.credentials,
    api: params.api,
    bindings: [{ serviceId: params.serviceId, profileId: previousProfileId }],
  });
  const previousRecord = records.get(params.serviceId);
  if (!previousRecord) return null;

  const materializedPrevious = await materializeOpenCodeConnectedServiceAuth({
    rootDir: '',
    ...buildOpenCodeMaterializationInput(params.serviceId, previousRecord),
  });
  const previousStatePath = resolveSharedManagedOpenCodeServerStatePathForEnv({
    ...params.processEnv,
    ...materializedPrevious.env,
  });
  const previousLaunchFingerprint = basename(previousStatePath, '.json').trim();
  if (!previousLaunchFingerprint) return null;

  const previousState = await readSharedManagedOpenCodeServerStateByLaunchFingerprintBestEffort(previousLaunchFingerprint);
  const previousOwnerToken = typeof previousState?.ownerToken === 'string' && previousState.ownerToken.trim().length > 0
    ? previousState.ownerToken.trim()
    : null;
  return {
    previousLaunchFingerprint,
    previousOwnerToken,
  };
}

export const materializeOpenCodeConnectedServiceRuntimeAuthSelection: ConnectedServiceRuntimeAuthSelectionMaterializer = async (
  params,
) => {
  const serviceId = readOpenCodeConnectedServiceId(params.input.serviceId);
  if (!serviceId) return params.baseSelection;

  const previousBinding = params.input.previous;
  const previousProfileId = previousBinding?.source === 'connected' ? previousBinding.profileId : null;
  const context = await resolvePreviousLaunchFingerprintContext({
    serviceId,
    previousProfileId,
    credentials: params.credentials,
    api: params.api,
    processEnv: params.processEnv ?? process.env,
  }).catch((error) => {
    // Best-effort: a missing prior fingerprint only skips detaching the previous managed server.
    logger.debug('[opencode] Failed to resolve previous launch fingerprint context for auth switch (non-fatal)', error);
    return null;
  });

  const brokerSelectionIdentity = readTrackedSessionBrokerSelectionIdentity(params.input.tracked);
  return {
    ...params.baseSelection,
    ...(brokerSelectionIdentity ? { brokerSelectionIdentity } : {}),
    ...(context?.previousLaunchFingerprint ? { previousLaunchFingerprint: context.previousLaunchFingerprint } : {}),
    ...(context?.previousOwnerToken ? { previousOwnerToken: context.previousOwnerToken } : {}),
    restartAndResume: async () => undefined,
  };
};
