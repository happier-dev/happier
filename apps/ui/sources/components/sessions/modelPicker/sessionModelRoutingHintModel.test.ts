import { describe, expect, it } from 'vitest';
import {
  ConnectedServicePoolSelectionGetResponseV1Schema,
  type ConnectedServicePoolSelectionGetResponseV1,
} from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import {
  buildSessionModelRoutingHint,
  sessionModelRoutingHintPoolKey,
  type SessionModelRoutingHintTarget,
} from './sessionModelRoutingHintModel';

const service = {
  pluginId: 'happier.agent.claude',
  localId: 'claude-subscription',
};
const pool: SessionModelRoutingHintTarget = {
  kind: 'group',
  service,
  groupId: 'claude-pool',
};
const candidate = (profileId: string, priority: number) => ({
  profileId,
  priority,
  createdAtMs: 1,
  enabled: true,
  leastLimitedScore: null,
});

/** The daemon selector's own read projection (U3), schema-validated as the Action returns it. */
function selection(
  input: Readonly<{
    selected: string;
    sticky: boolean;
    ordered: readonly string[];
    evidence: Readonly<Record<string, number | null>>;
    excluded?: string;
  }>,
): ConnectedServicePoolSelectionGetResponseV1 {
  return ConnectedServicePoolSelectionGetResponseV1Schema.parse({
    group: { service, groupId: 'claude-pool' },
    observedAtMs: 1,
    selection: {
      selected: candidate(input.selected, 1),
      reason: 'selected',
      excluded: input.excluded
        ? [
            {
              profileId: input.excluded,
              reason: 'quota_exhausted',
              retryAtMs: 5_000,
            },
          ]
        : [],
      decisionTrace: {
        activeProfileId: input.selected,
        reason: 'selected',
        strategy: 'priority',
        selectionBasis: input.sticky ? 'active_stickiness' : 'preference',
        sticky: input.sticky,
        orderedEligibleCandidates: input.ordered.map((id, index) =>
          candidate(id, index + 1),
        ),
        candidates: Object.entries(input.evidence).map(
          ([profileId, remainingPercent]) => ({
            profileId,
            decision:
              profileId === input.selected
                ? 'selected'
                : profileId === input.excluded
                  ? 'excluded'
                  : 'eligible',
            quotaEvidence:
              remainingPercent === null
                ? { status: 'stale_or_missing' }
                : { status: 'fresh', remainingPercent },
          }),
        ),
      },
    },
  });
}

describe('Routing hint in the agent/model picker', () => {
  const ready = selection({
    selected: 'max',
    sticky: true,
    ordered: ['pro', 'max', 'team'],
    evidence: { pro: 74, max: 18, team: null },
    excluded: 'plus',
  });
  const selections = new Map([[sessionModelRoutingHintPoolKey(pool), ready]]);

  it('says nothing when the setting is off, whatever the selector knows', () => {
    expect(
      buildSessionModelRoutingHint({
        enabled: false,
        targets: [pool],
        selections,
      }),
    ).toBeNull();
  });

  it('says nothing for an Agent signed in with one account: there is no pool to route through', () => {
    const account: SessionModelRoutingHintTarget = {
      kind: 'account',
      account: { service, accountId: 'pro' },
    };
    expect(
      buildSessionModelRoutingHint({
        enabled: true,
        targets: [account],
        selections,
      }),
    ).toBeNull();
  });

  it('shows the account the selector actually uses, then its own preference order, with only fresh evidence', () => {
    const hint = buildSessionModelRoutingHint({
      enabled: true,
      targets: [pool],
      selections,
    });
    const row = hint!.pools[0]!;
    expect(row.state).toBe('ready');
    expect(row.selected).toEqual({
      accountId: 'max',
      remainingPercent: 18,
      sticky: true,
    });
    expect(
      row.next.map((entry) => [entry.accountId, entry.remainingPercent]),
    ).toEqual([
      ['pro', 74],
      ['team', null],
    ]);
    expect(row.excluded).toEqual([
      { accountId: 'plus', reason: 'quota_exhausted', retryAtMs: 5_000 },
    ]);
  });

  it.each([
    ['pending', undefined, 'loading'],
    ['failed', 'failed' as const, 'failed'],
    ['owner unavailable', ConnectedServicePoolSelectionGetResponseV1Schema.parse({
      status: 'unavailable', code: 'connected_account_daemon_owner_unavailable',
    }), 'failed'],
    ['runtime unavailable', ConnectedServicePoolSelectionGetResponseV1Schema.parse({
      status: 'unavailable', code: 'connected_account_daemon_runtime_unavailable',
    }), 'failed'],
    ['invalid response', ConnectedServicePoolSelectionGetResponseV1Schema.parse({
      status: 'unavailable', code: 'connected_account_daemon_response_invalid',
    }), 'failed'],
    ['unsupported read', ConnectedServicePoolSelectionGetResponseV1Schema.parse({
      status: 'unavailable', code: 'unsupported',
    }), 'failed'],
  ] as const)('keeps a %s selector read distinct without guessing an order', (_kind, response, state) => {
    const hint = buildSessionModelRoutingHint({
      enabled: true,
      targets: [pool],
      selections: response ? new Map([[sessionModelRoutingHintPoolKey(pool), response]]) : new Map(),
    });
    expect(hint!.pools[0]).toMatchObject({
      state,
      selected: null,
      next: [],
    });
  });

  it('preserves an answered pool with no eligible account as a settled selector result', () => {
    if (!('selection' in ready)) throw new Error('Expected selector evidence');
    const response = ConnectedServicePoolSelectionGetResponseV1Schema.parse({
      ...ready,
      selection: { ...ready.selection, selected: null, reason: 'no_eligible_members',
        decisionTrace: { ...ready.selection.decisionTrace, activeProfileId: null,
          reason: 'no_eligible_members', selectionBasis: 'no_eligible_members', sticky: false,
          orderedEligibleCandidates: [], candidates: [] } },
    });
    expect(buildSessionModelRoutingHint({ enabled: true, targets: [pool],
      selections: new Map([[sessionModelRoutingHintPoolKey(pool), response]]),
    })!.pools[0]).toMatchObject({ state: 'ready', selected: null, next: [] });
  });
});
