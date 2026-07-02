import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY } from '@happier-dev/protocol';
import { applyRegisteredSessionStateFieldMutationToMetadata } from '@/api/session/client/transport/mutations/applyRegisteredSessionStateFieldMutation';
import { createSessionClientDurableMutationOutbox } from '@/api/session/client/transport/mutations/createSessionClientDurableMutationOutbox';
import type { Metadata } from '@/api/types';
import { splitDurableRegisteredSessionStateMetadata } from '@/agent/runtime/registry/pluginMetadataDurability';
import type { Credentials } from '@/persistence';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

export async function persistUsageLimitRecoveryFieldDurably(params: Readonly<{
  token: string;
  credentials: Credentials;
  sessionId: string;
  rawSession: RawSessionRecord;
  currentMetadata: Record<string, unknown>;
  nextMetadata: Record<string, unknown>;
}>): Promise<Record<string, unknown>> {
  const candidateForSplit = (
    Object.prototype.hasOwnProperty.call(params.currentMetadata, SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY)
    && !Object.prototype.hasOwnProperty.call(params.nextMetadata, SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY)
  )
    ? {
        ...params.nextMetadata,
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: null,
      }
    : params.nextMetadata;
  const split = splitDurableRegisteredSessionStateMetadata({
    sessionId: params.sessionId,
    current: params.currentMetadata,
    candidate: candidateForSplit,
    source: 'daemon',
  });
  if (split.mutations.length === 0) {
    return params.nextMetadata;
  }

  const outbox = createSessionClientDurableMutationOutbox({
    token: params.token,
    sessionId: params.sessionId,
    getSocket: () => null,
    requestReconnect: () => undefined,
    deliverRegisteredSessionStateFieldMutation: async (mutation) => {
      await updateSessionMetadataWithRetry({
        token: params.token,
        credentials: params.credentials,
        sessionId: params.sessionId,
        rawSession: params.rawSession,
        updater: (metadata) => applyRegisteredSessionStateFieldMutationToMetadata(
          metadata as Metadata,
          mutation,
        ),
      });
      return true;
    },
  });

  try {
    for (const mutation of split.mutations) {
      await outbox.enqueueRegisteredSessionStateFieldMutation(mutation);
    }
  } finally {
    await outbox.close();
  }

  return params.nextMetadata;
}
