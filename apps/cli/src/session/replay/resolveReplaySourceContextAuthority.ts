import type { StoredCredentials } from '@/persistence';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { SessionCreationCorrespondenceV1ReadSchema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

/**
 * The source-context creation flow is Account-owned, unlike ordinary Replay
 * readers (which intentionally allow an authorized shared participant to read
 * a Session). Current effective access is authoritative; the canonical access
 * projection reader retains only the released owner/direct compatibility
 * interpretation when that current projection is absent.
 */
export type ReplaySourceContextAuthority =
  | Readonly<{ status: 'owned'; sourceMachineId: string | null; managedSource?: true; managedDirectorySeed?: SpawnSessionOptions['managedDirectorySeed'] }>
  | Readonly<{ status: 'not_owned' }>
  | Readonly<{ status: 'unavailable' }>;

function readNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolves the source-context flow's one extra authority fact without changing
 * generic shared-Session Replay, fork, or continue-with-Replay semantics.
 *
 * A source machine is useful only as a positive locality proof for media
 * continuity. The server projection and decrypted metadata must agree when
 * both name one; disagreement or absence degrades to `null`, which causes the
 * caller to omit source-local paths rather than inventing an ownership or
 * replacement-machine relation.
 */
export async function resolveReplaySourceContextAuthority(params: Readonly<{
  credentials: StoredCredentials;
  sourceSessionId: string;
}>): Promise<ReplaySourceContextAuthority> {
  const rawSession = await fetchSessionByIdCompat({
    token: params.credentials.token,
    sessionId: params.sourceSessionId,
  });
  if (!rawSession) return { status: 'unavailable' };
  const accessRole = readSessionAccessProjectionRoleV1(rawSession);
  if (accessRole === 'unavailable') return { status: 'unavailable' };
  if (accessRole !== 'owner') return { status: 'not_owned' };

  const rawMachineId = readNonBlankString(rawSession.machineId);
  const metadata = tryDecryptSessionMetadata({
    credentials: params.credentials,
    rawSession,
  });
  const metadataMachineId = readNonBlankString(metadata?.machineId);
  const sourceMachineId = rawMachineId && metadataMachineId && rawMachineId !== metadataMachineId
    ? null
    : rawMachineId ?? metadataMachineId;

  const sourcePath = readNonBlankString(metadata?.path);
  const correspondence = SessionCreationCorrespondenceV1ReadSchema.safeParse(metadata?.sessionCreationCorrespondenceV1);
  const sourceSessionCreationTag = correspondence.success ? correspondence.data.sessionCreationTag : undefined;
  const managedSource = readSessionDirectoryKind(metadata) === 'managed';
  return {
    status: 'owned', sourceMachineId,
    ...(managedSource ? { managedSource: true as const } : {}),
    ...(sourceMachineId && sourcePath && managedSource ? {
      managedDirectorySeed: {
        sourceSessionId: params.sourceSessionId,
        sourcePath,
        ...(sourceSessionCreationTag ? { sourceSessionCreationTag } : {}),
      },
    } : {}),
  };
}
