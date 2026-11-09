import { resolveCurrentSessionRecipientAccountIdsBySessionInTx } from '@/app/session/access/sessionRecipients';
import {
  getTransactionContext,
  inReadSnapshot,
  type Tx,
} from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { resolveDbSqlDialect } from '@/config/databaseProvider';
import { getSessionLifecycleAutomationPublicationAudienceInTx } from '@/app/workflows/workflowPublicationAudience';
import { hasSessionFollowSessionSource } from '@/app/session/follow/sessionFollowSourceIdentity';
import { acquireAccountChangePublicationLocksInTx } from '@/app/changes/markAccountChanged';
import type { AccountAdmissionIntent } from '@/app/encryption/accountSessionOwnerMetadataFence';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { readSessionProviderBrokerCustodianAccountIdsInTx } from '@/app/providers/brokerConsumerChanges';
import { readNativeCredentialPolicyPublicationAccountIdsInTx } from '@/app/teams/credentials/nativePolicyChanges';

export type SessionAccountCursorLockOptions = Readonly<{
  includeLifecyclePublications?: boolean;
  intent?: AccountAdmissionIntent;
  /** Prospective recipients/authority scopes supplied by the mutation owner.
   * Pure census only: the write's one census repeats this read on replay. */
  readAdditionalAccountIdsInTx?: (tx: Tx) => Promise<readonly string[]>;
  /** The caller adds no audience of its own, so this attempt's held admission of the
   * exact scope is enough; a grant committing later reaches the next write. A missing or
   * different scope still runs the full census and fence. */
  reuseHeldAudience?: boolean;
}>;

interface HeldSessionAudience {
  sessionIds: readonly string[];
  additionalAccountIds: readonly string[];
  intent: AccountAdmissionIntent;
  includeLifecyclePublications: boolean;
  readAdditionalAccountIdsInTx: SessionAccountCursorLockOptions['readAdditionalAccountIdsInTx'];
  projectionSessionIds: ReadonlySet<string>;
  accountIds: ReadonlySet<string>;
}

const heldSessionAudiences = Symbol('held-session-audiences');
type SessionAudienceContext = {
  [heldSessionAudiences]?: HeldSessionAudience[];
};

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

/** One census serves pre-attempt discovery and transactional currentness checks. */
export async function readSessionAccountCursorAudienceInTx(
  tx: Tx,
  sessionIds: readonly string[],
  additionalAccountIds: readonly string[],
  options?: SessionAccountCursorLockOptions,
) {
  const ids = [...new Set(sessionIds)].sort();
  const lifecycle = options?.includeLifecyclePublications
    ? await getSessionLifecycleAutomationPublicationAudienceInTx(tx, ids)
    : { sessionIds: [], accountIds: [] };
  const sourceSessionIds = [
    ...new Set([...ids, ...lifecycle.sessionIds]),
  ].sort();
  // Every outgoing relation publishes a destination cursor. Archive/rejoin
  // also invalidates incoming Manager children, so fence both endpoints there.
  const relationEdges: {
    sourceSessionId: string | null;
    destinationSessionId: string;
  }[] = [];
  // Each id binds in three OR arms; the relation literal and Prisma offset bind too.
  for (const chunk of portableQueryChunks({
    values: sourceSessionIds,
    bindingsPerValue: 3,
    fixedBindings: 2,
  })) {
    const rows = await tx.sessionFollowEdge.findMany({
      where: {
        OR: [
          { sourceSessionId: { in: [...chunk] } },
          { sourceExecutionRunSessionId: { in: [...chunk] } },
          { relation: 'manager', destinationSessionId: { in: [...chunk] } },
        ],
      },
      select: { sourceSessionId: true, destinationSessionId: true },
    });
    relationEdges.push(...rows);
  }
  const projectionSessionIds = [
    ...new Set([
      ...sourceSessionIds,
      ...relationEdges.map((edge) => edge.destinationSessionId),
      ...relationEdges
        .filter(hasSessionFollowSessionSource)
        .map((edge) => edge.sourceSessionId),
    ]),
  ].sort();
  const recipients =
    await resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, {
      sessionIds: projectionSessionIds,
      includeUnpublishedGrants: true,
      includeInactiveAccounts: true,
    });
  const additionalAudience =
    (await options?.readAdditionalAccountIdsInTx?.(tx)) ?? [];
  // Enclosing archive/erasure owners admit before the nested terminal writer.
  // Broker custody therefore belongs in this shared lifecycle census too.
  const brokerCustodians = options?.includeLifecyclePublications
    ? await readSessionProviderBrokerCustodianAccountIdsInTx(tx, ids)
    : [];
  const nativeControllers = options?.includeLifecyclePublications
    ? await readNativeCredentialPolicyPublicationAccountIdsInTx(tx, { sessionIds: ids }) : [];
  const accountIds = [
    ...new Set(
      [...recipients.values()]
        .flat()
        .concat([...additionalAccountIds], lifecycle.accountIds, [
          ...additionalAudience, ...brokerCustodians, ...nativeControllers,
        ]),
    ),
  ].sort();
  return { projectionSessionIds, accountIds };
}

/** Discover outside the mutation snapshot; each attempt locks that one census. */
export async function prepareSessionAccountCursorLocks(
  sessionIds: readonly string[],
  additionalAccountIds: readonly string[] = [],
  options?: SessionAccountCursorLockOptions,
): Promise<(tx: Tx) => Promise<void>> {
  if (getDbProviderFromEnv(process.env, 'postgres') === 'sqlite')
    return async () => {};
  const audience = await inReadSnapshot((tx) =>
    readSessionAccountCursorAudienceInTx(
      tx,
      sessionIds,
      additionalAccountIds,
      options,
    ),
  );
  return async (tx) => {
    await fenceSessionAccountCursorAudienceInTx(
      tx,
      audience,
      sessionIds,
      additionalAccountIds,
      options,
    );
  };
}

/**
 * Admit the complete Account audience before locking the Session resources.
 * PostgreSQL ordinary admission is compatible with unrelated cursor writers;
 * exclusive admission is selected at entry by transition/lifecycle owners.
 * Account cursor locks are acquired only by terminal publication. MySQL retains
 * exclusive entry admission, and SQLite retains its single-writer lifecycle.
 */
export async function acquireSessionAccountCursorLocksInTx(
  tx: Tx,
  sessionIds: readonly string[],
  additionalAccountIds: readonly string[] = [],
  options?: SessionAccountCursorLockOptions,
): Promise<readonly string[]> {
  const provider = getDbProviderFromEnv(process.env, 'postgres');
  // SQLite has one database writer rather than independently lockable rows.
  if (provider === 'sqlite') return [];
  const requestedSessionIds = [...new Set(sessionIds)].sort();
  const requestedAccountIds = [...new Set(additionalAccountIds)].sort();
  const matchHeldScopes = (context: SessionAudienceContext | undefined) =>
    context?.[heldSessionAudiences]?.filter(
      (scope) =>
        sameIds(scope.sessionIds, requestedSessionIds) &&
        sameIds(scope.additionalAccountIds, requestedAccountIds) &&
        scope.intent === (options?.intent ?? 'content') &&
        scope.includeLifecyclePublications ===
          (options?.includeLifecyclePublications === true) &&
        scope.readAdditionalAccountIdsInTx ===
          options?.readAdditionalAccountIdsInTx,
    );
  if (options?.reuseHeldAudience) {
    const reusable = matchHeldScopes(
      getTransactionContext(tx, { optional: true }) as SessionAudienceContext | undefined,
    )?.[0];
    if (reusable) return [...reusable.accountIds];
  }
  const audience = await readSessionAccountCursorAudienceInTx(
    tx,
    sessionIds,
    additionalAccountIds,
    options,
  );
  const held = matchHeldScopes(
    getTransactionContext(tx) as SessionAudienceContext,
  )?.find(
    (scope) =>
      audience.accountIds.every((id) => scope.accountIds.has(id)) &&
      audience.projectionSessionIds.every((id) =>
        scope.projectionSessionIds.has(id),
      ),
  );
  if (held) {
    // Reentry rereads currentness, but a completed same-attempt admission
    // already holds the resources and owns their terminal validation.
    return audience.accountIds;
  }
  // A changed scope still goes through canonical admission. In particular,
  // the transaction may itself add a Follow resource for an already-admitted
  // Account; replaying that write would never make its new resource preexist.
  return fenceSessionAccountCursorAudienceInTx(
    tx,
    audience,
    sessionIds,
    additionalAccountIds,
    options,
  );
}

/**
 * Lock one captured audience, Accounts before Sessions. A grant that commits after
 * the census is not re-read here: this write's change row may miss the newcomer, who
 * learns of it from their next change or open, and content stays authorized at each
 * read (owner, 2026-10-31). A fan-out that does discover a new Account replays
 * through the Account admission owner, which never extends its sorted lock set.
 */
export async function fenceSessionAccountCursorAudienceInTx(
  tx: Tx,
  {
    projectionSessionIds,
    accountIds,
  }: Readonly<{
    projectionSessionIds: readonly string[];
    accountIds: readonly string[];
  }>,
  sessionIds: readonly string[],
  additionalAccountIds: readonly string[],
  options?: SessionAccountCursorLockOptions,
): Promise<readonly string[]> {
  if (projectionSessionIds.length === 0 && accountIds.length === 0) return [];
  await acquireAccountChangePublicationLocksInTx(tx, accountIds, {
    includeSingleAccount: true,
    intent: options?.intent ?? 'content',
  });
  const dialect = resolveDbSqlDialect(
    getDbProviderFromEnv(process.env, 'postgres'),
  );
  // Direct captured-audience callers still reserve SQLite's single writer,
  // without querying independently lockable resource scopes it does not have.
  if (dialect === 'sqlite') return accountIds;
  if (projectionSessionIds.length > 0) {
    if (dialect === 'postgres') {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Session" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR NO KEY UPDATE',
        projectionSessionIds,
      );
    } else if (dialect === 'mysql') {
      await tx.$queryRawUnsafe(
        `SELECT \`id\` FROM \`Session\` WHERE \`id\` IN (${projectionSessionIds.map(() => '?').join(', ')}) ORDER BY \`id\` FOR UPDATE`,
        ...projectionSessionIds,
      );
    }
  }
  const context = getTransactionContext(tx) as SessionAudienceContext;
  (context[heldSessionAudiences] ??= []).push({
    sessionIds: [...new Set(sessionIds)].sort(),
    additionalAccountIds: [...new Set(additionalAccountIds)].sort(),
    intent: options?.intent ?? 'content',
    includeLifecyclePublications:
      options?.includeLifecyclePublications === true,
    readAdditionalAccountIdsInTx: options?.readAdditionalAccountIdsInTx,
    projectionSessionIds: new Set(projectionSessionIds),
    accountIds: new Set(accountIds),
  });
  return accountIds;
}
