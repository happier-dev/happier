import type { StoredCredentials } from '@/persistence';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';

/**
 * The source-context creation flow is Account-owned, unlike ordinary Replay
 * readers (which intentionally allow an authorized shared participant to read
 * a Session). `share: null` is the V2 session projection's owner proof; any
 * other value, including an absent legacy projection, is deliberately not
 * enough to clone replay context into a new Account-owned child.
 */
export type ReplaySourceContextAuthority =
  | Readonly<{ status: 'owned'; sourceMachineId: string | null }>
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
  if (rawSession.share !== null) return { status: 'not_owned' };

  const rawMachineId = readNonBlankString(rawSession.machineId);
  const metadata = tryDecryptSessionMetadata({
    credentials: params.credentials,
    rawSession,
  });
  const metadataMachineId = readNonBlankString(metadata?.machineId);
  const sourceMachineId = rawMachineId && metadataMachineId && rawMachineId !== metadataMachineId
    ? null
    : rawMachineId ?? metadataMachineId;

  return { status: 'owned', sourceMachineId };
}
