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

/** Drop a checkout stamp that names a checkout which left the census, so the resolver re-reads the placement. */
export function withoutRetiredSessionCheckout<T extends Record<string, unknown>>(metadata: T, retiredWorkspaceId: string | undefined): T {
  if (retiredWorkspaceId === undefined || metadata.workspaceId !== retiredWorkspaceId) return metadata;
  const { workspaceId: _workspaceId, projectId: _projectId, ...rest } = metadata;
  return rest as T;
}

/**
 * Publish that a Session is in no Project, so Project selections stop paging it as a candidate.
 * Only the canonical resolver's `none` over the observed census qualifies, and an existing
 * "no Project" fact is not rewritten. A published key is downgraded only when the checkout it was
 * stamped from (`retiredWorkspaceId`) is observed gone from the census; that stamp is dropped.
 * Returns whether this call wrote the owner tuple (including any supplied metadata update).
 */
export async function publishSessionWithoutProject(input: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  rawSession: RawSessionRecord;
  observedMetadata: unknown;
  serverId: string;
  workspaceRefs: readonly WorkspaceRefV1[];
  retiredWorkspaceId?: string;
  accountEncryptionCurrentness?: AccountEncryptionCurrentnessResponse;
  currentness?: SessionMetadataMutationCurrentness;
  updateMetadata?: Parameters<typeof updateSessionMetadataWithRetry>[0]['updater'];
}>): Promise<boolean> {
  const resolve = (metadata: unknown) => resolveSessionProjectKeyV1(metadata, input.serverId, input.workspaceRefs).kind;
  const retired = input.retiredWorkspaceId;
  const observed = input.observedMetadata && typeof input.observedMetadata === 'object' && !Array.isArray(input.observedMetadata)
    ? input.observedMetadata as Record<string, unknown> : null;
  if (input.rawSession.projectKey == null ? input.rawSession.projectKeyNone === true
    : retired === undefined || observed?.workspaceId !== retired || resolve({ workspaceId: retired }) === 'resolved') return false;
  if (resolve(observed ? withoutRetiredSessionCheckout(observed, retired) : input.observedMetadata) !== 'none') return false;
  await updateSessionMetadataWithRetry({
    token: input.credentials.token, credentials: input.credentials, sessionId: input.sessionId, rawSession: input.rawSession,
    ...(input.accountEncryptionCurrentness ? { accountEncryptionCurrentness: input.accountEncryptionCurrentness } : {}),
    projectKey: null,
    updater: async (current, context) => {
      const next = withoutRetiredSessionCheckout(input.updateMetadata ? await input.updateMetadata(current, context) : current, retired);
      // The classification is re-derived from the metadata this CAS actually writes.
      if (resolve(next) !== 'none') {
        throw Object.assign(new Error('Session checkout changed before Project classification'), {
          code: 'session_publisher_authority_lost' as const, retryable: false as const,
        });
      }
      return next;
    },
    ...(input.currentness ? { currentness: input.currentness } : {}),
  });
  return true;
}
