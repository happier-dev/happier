import { resolveSessionProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import type { StoredCredentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { hasSameSessionCheckout } from './sessionCheckoutIdentity';
import { updateSessionMetadataWithRetry, type SessionMetadataMutationCurrentness } from './updateSessionMetadataWithRetry';

/** Publish an already accepted checkout through the owner tuple's existing CAS. */
export async function publishAcceptedSessionProject(input: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  rawSession: RawSessionRecord;
  observedMetadata: Partial<Metadata>;
  serverId: string;
  workspaceRefs: readonly WorkspaceRefV1[];
  workspaceId: string;
  accountEncryptionCurrentness?: AccountEncryptionCurrentnessResponse;
  currentness?: SessionMetadataMutationCurrentness;
  updateMetadata?: Parameters<typeof updateSessionMetadataWithRetry>[0]['updater'];
}>): Promise<void> {
  const accepted = resolveSessionProjectKeyV1({ workspaceId: input.workspaceId }, input.serverId, input.workspaceRefs);
  if (accepted.kind !== 'resolved' || !accepted.ref) return;
  const projectKey = accepted.projectKey.projectKey;
  const keyChanged = input.rawSession.projectKey !== projectKey;
  if (!input.updateMetadata && !keyChanged && input.observedMetadata.workspaceId === accepted.ref.id && input.observedMetadata.projectId === projectKey) return;
  const workspaceId = accepted.ref.id;
  await updateSessionMetadataWithRetry({
    token: input.credentials.token, credentials: input.credentials, sessionId: input.sessionId, rawSession: input.rawSession,
    ...(input.accountEncryptionCurrentness ? { accountEncryptionCurrentness: input.accountEncryptionCurrentness } : {}),
    ...(keyChanged ? { projectKey } : {}),
    updater: async (current, context) => {
      const next = input.updateMetadata ? await input.updateMetadata(current, context) : current;
      const currentAssociation = next.workspaceId != null
        ? resolveSessionProjectKeyV1(next, input.serverId, input.workspaceRefs) : null;
      const stillAccepted = next.workspaceId != null
        ? currentAssociation?.kind === 'resolved' && currentAssociation.ref?.id === workspaceId
        : hasSameSessionCheckout(next, input.observedMetadata);
      if (!stillAccepted) {
        throw Object.assign(new Error('Session checkout changed before Project publication'), {
          code: 'session_publisher_authority_lost' as const, retryable: false as const,
        });
      }
      return { ...next, workspaceId, projectId: projectKey };
    },
    ...(input.currentness ? { currentness: input.currentness } : {}),
  });
}
