import {
  loadSessionApprovalConsentsV1,
  type BoundSessionApprovalConsentsV1,
  type SessionApprovalConsentsStoreV1,
} from '@happier-dev/protocol/actions/sessionApprovalConsentsV1';
import type { StoredCredentials } from '@/persistence';

/**
 * The bound Session's own "allow for this Session" rows, held for its host process. Admission
 * reads the held rows (no network); a consent Artifact change on the Session's Account feed
 * refreshes them, and an admission during that refresh waits for it, so a removed row stops
 * applying on the next call. A read that fails holds nothing and applies no rows: the Ask returns.
 */
type Held = Readonly<{
  token: string;
  sessionId: string;
  value: Promise<BoundSessionApprovalConsentsV1 | null>;
}>;
const held = new Map<string, Held>();
const keyOf = (token: string, sessionId: string) =>
  JSON.stringify([token, sessionId]);

function load(
  input: Readonly<{
    token: string;
    sessionId: string;
    store: Pick<SessionApprovalConsentsStoreV1, 'list'>;
  }>,
  key: string,
): Promise<BoundSessionApprovalConsentsV1 | null> {
  const value: Promise<BoundSessionApprovalConsentsV1 | null> =
    loadSessionApprovalConsentsV1(input.store, input.sessionId).then(
      (record) => ({ sessionId: input.sessionId, rows: record?.rows ?? [] }),
      () => {
        if (held.get(key)?.value === value) held.delete(key);
        return null;
      },
    );
  held.set(key, { token: input.token, sessionId: input.sessionId, value });
  return value;
}

export async function readHeldSessionApprovalConsents(
  input: Readonly<{
    token: string;
    sessionId: string;
    store: () => Pick<SessionApprovalConsentsStoreV1, 'list'>;
  }>,
): Promise<BoundSessionApprovalConsentsV1 | null> {
  const key = keyOf(input.token, input.sessionId);
  const current = held.get(key);
  return await (current
    ? current.value
    : load(
        {
          token: input.token,
          sessionId: input.sessionId,
          store: input.store(),
        },
        key,
      ));
}

/** The Session's Account observer refreshes only rows already demanded under this credential. */
export async function refreshDemandedSessionApprovalConsents(
  input: Readonly<{ credentials: StoredCredentials }>,
): Promise<void> {
  const token = input.credentials.token;
  const demanded = [...held.entries()].filter(
    ([, entry]) => entry.token === token,
  );
  if (demanded.length === 0) return;
  const { createCredentialedAccountArtifactStore } =
    await import('@/api/artifacts/accountArtifactStore');
  const store = createCredentialedAccountArtifactStore(input.credentials);
  await Promise.all(
    demanded.map(([key, entry]) =>
      load({ token, sessionId: entry.sessionId, store }, key),
    ),
  );
}
