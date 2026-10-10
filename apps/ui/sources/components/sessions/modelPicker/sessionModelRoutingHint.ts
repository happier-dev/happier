import type { ConnectedServicePoolSelectionGetResponseV1 } from '@happier-dev/protocol/connect/connectedServicePoolSelection';

type ServiceRef = Readonly<{ pluginId: string; localId: string }>;

/** The selected Agent's default sign-in targets, as the one purpose-default owner resolves them. */
export type SessionModelRoutingHintTarget =
  | Readonly<{ kind: 'group'; service: ServiceRef; groupId: string }>
  | Readonly<{
      kind: 'account';
      account: Readonly<{ service: ServiceRef; accountId: string }>;
    }>;

export type SessionModelRoutingHintCandidate = Readonly<{
  accountId: string;
  remainingPercent: number | null;
}>;

export type SessionModelRoutingHintPool = Readonly<{
  key: string;
  group: Extract<SessionModelRoutingHintTarget, { kind: 'group' }>;
  state: 'loading' | 'unavailable' | 'ready';
  /** The account the daemon selector uses now; `sticky` when it stays on it past a preferred one. */
  selected:
    | (SessionModelRoutingHintCandidate & Readonly<{ sticky: boolean }>)
    | null;
  /** The rest of the selector's own preference order within this pool. */
  next: readonly SessionModelRoutingHintCandidate[];
  excluded: readonly Readonly<{
    accountId: string;
    reason: string;
    retryAtMs: number | null;
  }>[];
}>;

export type SessionModelRoutingHint = Readonly<{
  pools: readonly SessionModelRoutingHintPool[];
}>;

export function sessionModelRoutingHintPoolKey(
  target: Extract<SessionModelRoutingHintTarget, { kind: 'group' }>,
): string {
  return `${target.service.pluginId}/${target.service.localId}:${target.groupId}`;
}

/**
 * The picker's routing hint: for the selected Agent's own pools only, which account the selector uses
 * and the order it would move through. It never compares another Agent's headroom, never ranks across
 * pools, and never changes which account runs. Off means absent.
 */
export function buildSessionModelRoutingHint(
  input: Readonly<{
    enabled: boolean;
    targets: readonly SessionModelRoutingHintTarget[];
    selections: ReadonlyMap<
      string,
      ConnectedServicePoolSelectionGetResponseV1 | 'loading' | 'failed'
    >;
  }>,
): SessionModelRoutingHint | null {
  if (!input.enabled) return null;
  const pools: SessionModelRoutingHintPool[] = [];
  for (const target of input.targets) {
    if (target.kind !== 'group') continue;
    const key = sessionModelRoutingHintPoolKey(target);
    if (pools.some((pool) => pool.key === key)) continue;
    const response = input.selections.get(key) ?? 'loading';
    if (
      response === 'loading' ||
      response === 'failed' ||
      'status' in response
    ) {
      pools.push({
        key,
        group: target,
        state: response === 'loading' ? 'loading' : 'unavailable',
        selected: null,
        next: [],
        excluded: [],
      });
      continue;
    }
    const { selection } = response;
    const evidence = new Map(
      selection.decisionTrace.candidates.map((entry) => [
        entry.profileId,
        entry.quotaEvidence.status === 'fresh'
          ? (entry.quotaEvidence.remainingPercent ?? null)
          : null,
      ]),
    );
    const remaining = (accountId: string) => evidence.get(accountId) ?? null;
    const selectedId = selection.selected?.profileId ?? null;
    pools.push({
      key,
      group: target,
      state: 'ready',
      selected: selectedId
        ? {
            accountId: selectedId,
            remainingPercent: remaining(selectedId),
            sticky: selection.decisionTrace.sticky,
          }
        : null,
      next: selection.decisionTrace.orderedEligibleCandidates
        .filter((entry) => entry.profileId !== selectedId)
        .map((entry) => ({
          accountId: entry.profileId,
          remainingPercent: remaining(entry.profileId),
        })),
      excluded: selection.excluded.map((entry) => ({
        accountId: entry.profileId,
        reason: entry.reason,
        retryAtMs: entry.retryAtMs ?? null,
      })),
    });
  }
  return pools.length ? { pools } : null;
}
