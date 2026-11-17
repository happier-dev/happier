import {
  SessionCreationCorrespondenceV1ReadSchema,
  type SessionCreationCorrespondenceV1,
  type SessionProjectFilesOriginV1,
} from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import type { StoredCredentials } from '@/persistence';
import { readSessionMetadataTupleWriterSnapshot, updateSessionMetadataEnvelopeTupleWithRetry,
  type SessionMetadataWriterSnapshot } from '@/session/metadata/updateSessionMetadataWithRetry';
import { resolveSessionEncryptionContextFromCredentials, resolveSessionStoredContentEncryptionMode } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';

export function withSessionProjectFilesOrigin(correspondence: SessionCreationCorrespondenceV1,
  origin: SessionProjectFilesOriginV1): SessionCreationCorrespondenceV1 {
  if (correspondence.recipe.projectFilesOrigin) return correspondence;
  const retained = origin.targetWorkspace.kind === 'managed'
    ? { sourceWorkspace: origin.sourceWorkspace, targetWorkspace: origin.targetWorkspace,
      ...(origin.contentPolicyDigest ? { contentPolicyDigest: origin.contentPolicyDigest } : {}) } : origin;
  return { ...correspondence, recipe: { ...correspondence.recipe, projectFilesOrigin: retained } };
}

/** The existing private birth recipe retains endpoints; the native READY fact owns the copied base. */
export async function persistSessionProjectFilesOrigin(input: Readonly<{
  credentials: StoredCredentials; sessionId: string; origin: SessionProjectFilesOriginV1;
}>): Promise<Readonly<{ origin: SessionProjectFilesOriginV1; snapshot: SessionMetadataWriterSnapshot }>> {
  const rawSession = await fetchSessionByIdCompat({ reason: 'session-control', token: input.credentials.token, sessionId: input.sessionId });
  if (!rawSession) throw Object.assign(new Error('Session origin is unavailable'), { code: 'project_files_origin_unavailable' });
  const accountEncryptionCurrentness = await fetchAccountEncryptionCurrentness({ token: input.credentials.token });
  const initialSnapshot = readSessionMetadataTupleWriterSnapshot({ credentials: input.credentials, rawSession, accountEncryptionCurrentness });
  const mode = resolveSessionStoredContentEncryptionMode(rawSession);
  const ctx = mode === 'e2ee' ? resolveSessionEncryptionContextFromCredentials(input.credentials, rawSession) : null;
  if (mode === 'e2ee' && !ctx) throw Object.assign(new Error('Session encryption is unavailable'), { code: 'metadata_privacy_upgrade_required' });
  const crypto = ctx ? { mode: 'e2ee' as const, ctx } : { mode: 'plain' as const, ctx: null };
  const snapshot = await updateSessionMetadataEnvelopeTupleWithRetry({ token: input.credentials.token, sessionId: input.sessionId,
    authority: { kind: 'owner', credentials: input.credentials, accountEncryptionCurrentness }, initialSnapshot, ...crypto,
    mutation: { kind: 'metadata', update: metadata => ({ ...metadata,
      sessionCreationCorrespondenceV1: withSessionProjectFilesOrigin(
        SessionCreationCorrespondenceV1ReadSchema.parse(metadata.sessionCreationCorrespondenceV1), input.origin) }) } });
  const correspondence = SessionCreationCorrespondenceV1ReadSchema.parse(snapshot.value.metadata.sessionCreationCorrespondenceV1);
  return { origin: correspondence.recipe.projectFilesOrigin!, snapshot };
}
