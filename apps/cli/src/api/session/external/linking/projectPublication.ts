import { $ZodError } from 'zod/v4/core';
import { resolveSessionProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { fetchServerFeaturesSnapshot, readServerIdentityIdFromFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { publishAcceptedSessionProject, publishSessionWithoutProject } from '@/session/metadata/publishAcceptedSessionProject';
import { readProjectAccountRowsObservation } from '@/workspaces/projectAccountRows';

/** Only a current creation or real metadata write may publish a native link's accepted Project. */
export async function publishLinkedSessionProject(input: Readonly<{
  credentials: StoredCredentials;
  accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
  rawSession: RawSessionRecord;
  metadata: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
  assertCurrent(): void;
  updateMetadata?: NonNullable<Parameters<typeof publishAcceptedSessionProject>[0]['updateMetadata']>;
}>): Promise<boolean> {
  if (input.rawSession.projectKey != null || typeof input.metadata.path !== 'string' || !input.metadata.path.trim()) return false;
  input.signal?.throwIfAborted();
  input.assertCurrent();
  const features = await fetchServerFeaturesSnapshot({ serverUrl: resolveServerHttpBaseUrl(), signal: input.signal });
  const serverId = readServerIdentityIdFromFeaturesSnapshot(features);
  if (!serverId) return false;
  const observation = await readProjectAccountRowsObservation({ credentials: input.credentials, serverId,
    selection: { kinds: ['workspace-ref'], serverId }, signal: input.signal,
  }).catch((error: unknown) => {
    // Older Homes lack this operation; malformed coverage cannot prove association.
    if (error instanceof $ZodError || error instanceof Error && 'code' in error
      && error.code === 'project_account_rows_unsupported') return null;
    throw error;
  });
  input.signal?.throwIfAborted();
  input.assertCurrent();
  if (!observation) return false;
  const accepted = resolveSessionProjectKeyV1(input.metadata, serverId, observation.snapshot.workspaceRefs);
  const currentness = { signal: input.signal, verifyCurrent: async () => {
    input.assertCurrent();
    return observation.isCurrent();
  } };
  if (accepted.kind === 'none') {
    return await publishSessionWithoutProject({ credentials: input.credentials, sessionId: input.rawSession.id,
      rawSession: input.rawSession, observedMetadata: input.metadata, serverId,
      workspaceRefs: observation.snapshot.workspaceRefs, accountEncryptionCurrentness: input.accountEncryptionCurrentness,
      ...(input.updateMetadata ? { updateMetadata: input.updateMetadata } : {}), currentness });
  }
  if (accepted.kind !== 'resolved' || !accepted.ref) return false;
  await publishAcceptedSessionProject({ credentials: input.credentials, sessionId: input.rawSession.id,
    rawSession: input.rawSession, observedMetadata: input.metadata, serverId,
    workspaceRefs: observation.snapshot.workspaceRefs, workspaceId: accepted.ref.id,
    accountEncryptionCurrentness: input.accountEncryptionCurrentness,
    ...(input.updateMetadata ? { updateMetadata: input.updateMetadata } : {}),
    currentness,
  });
  return true;
}
