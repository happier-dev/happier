import {
  TriageDetailSurfaceInputV1Schema,
  type TriageDetailSurfaceInputV1,
  type TriageSourceObservationV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../../observations/githubProviderContracts.js';

import {
  GITHUB_ISSUE_CLOSE_REASONS_V1,
  GITHUB_MERGE_METHODS_V1,
  buildGithubIssueAssigneesInputV1,
  buildGithubIssueCloseInputV1,
  buildGithubIssueLabelsInputV1,
  buildGithubIssueReopenInputV1,
  buildGithubPullRequestMarkReadyInputV1,
  buildGithubPullRequestMergeInputV1,
  buildGithubPullRequestReviewersInputV1,
  buildGithubPullRequestTargetInputV1,
  buildGithubPullRequestThreadResolutionInputV1,
  buildGithubPullRequestUpdateBranchInputV1,
  githubMutationMayHaveChangedProviderStateV1,
  githubOfferedMutationsV1,
  projectGithubMutationOutcomeV1,
  readGithubLabelsV1,
  readGithubNamesV1,
} from './mutations.js';

const SOURCE_CONTRIBUTION = Object.freeze({
  pluginId: 'happier.scm.forge.github',
  localId: 'github-forge',
});
const CONFIGURED_INSTANCE = Object.freeze({
  v: 1,
  instance: Object.freeze({
    source: SOURCE_CONTRIBUTION,
    sourceInstanceId: '9d2a6b1e-6c1a-4b7d-9f31-1d4a6c8b2e70',
  }),
  binding: Object.freeze({
    purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
    account: Object.freeze({
      service: Object.freeze({
        pluginId: 'happier.scm.forge.github',
        localId: 'github-account',
      }),
      accountId: 'account-1',
    }),
  }),
  localInstanceKey: 'github.com',
  configuration: Object.freeze({ v: 1, token: 'github-configuration-token-v1' }),
});

const OBSERVED_HEAD = 'b3f1c0a9d2e4f60718293a4b5c6d7e8f90a1b2c3';

function detailInput(
  overrides: Readonly<{
    kindId?: string;
    presentation?: string;
    nativeLabel?: string;
    routingToken?: string | null;
    nativeRevision?: string | null;
  }> = {},
): TriageDetailSurfaceInputV1 {
  const routingToken = overrides.routingToken === undefined
    ? 'octo-org/example-app'
    : overrides.routingToken;
  const nativeRevision = overrides.nativeRevision === undefined
    ? OBSERVED_HEAD
    : overrides.nativeRevision;
  return TriageDetailSurfaceInputV1Schema.parse({
    v: 1,
    instance: CONFIGURED_INSTANCE,
    observation: {
      entryRef: {
        source: SOURCE_CONTRIBUTION,
        kindId: overrides.kindId ?? 'pull-request',
        collisionScope: 'github:1296269',
        entryId: '1284',
      },
      observedAtMs: 1_760_000_700_000,
      locator: {
        v: 1,
        webUrl: 'https://github.com/octo-org/example-app/pull/1284',
        displayPath: 'octo-org/example-app#1284',
        ...(routingToken === null ? {} : { routingToken }),
      },
      snapshot: {
        v: 1,
        title: 'Consolidate the duplicated normalizer',
        scopeLabel: 'octo-org/example-app',
        state: {
          presentation: overrides.presentation ?? 'active',
          nativeLabel: overrides.nativeLabel ?? 'Open',
        },
        facts: [],
      },
      viewer: { involvement: ['reviewRequested'] },
      ...(nativeRevision === null ? {} : { nativeRevision }),
    },
    linkedSessions: [],
  });
}

// Typed against the published observation union so a drifted arm, state, or
// locator shape fails the program instead of only the assertion that reads it.
const APPLIED_OBSERVATION: TriageSourceObservationV1 = {
  kind: 'present',
  localRef: {
    kindId: 'pull-request',
    collisionScope: 'github:1296269',
    entryId: '1284',
  },
  locator: {
    v: 1,
    webUrl: 'https://github.com/octo-org/example-app/pull/1284',
    displayPath: 'octo-org/example-app#1284',
    routingToken: 'octo-org/example-app',
  },
  snapshot: {
    v: 1,
    title: 'Consolidate the duplicated normalizer',
    scopeLabel: 'octo-org/example-app',
    state: { presentation: 'closed', nativeLabel: 'Merged' },
    facts: [],
  },
  viewer: { involvement: ['reviewRequested'] },
};

describe('githubOfferedMutationsV1', () => {
  it('offers merge and close on an open pull request, and reopen once it is closed', () => {
    // Which writes exist is a function of the APPLIED observation's state, not of a
    // provider read: a surface that offered all three always would put "Merge" on a
    // closed pull request and make the refusal the user's first feedback.
    expect(githubOfferedMutationsV1({
      kindId: 'pull-request',
      state: detailInput().observation.snapshot.state,
    })).toEqual(['merge', 'close']);

    expect(githubOfferedMutationsV1({
      kindId: 'pull-request',
      state: detailInput({ presentation: 'closed', nativeLabel: 'Closed' })
        .observation.snapshot.state,
    })).toEqual(['reopen']);
  });

  it('offers an issue its own two transitions, and never merge', () => {
    // An issue has both state Actions registered, and a surface that offered it
    // nothing left six registered writes unreachable from the product. It has no
    // merge: that control's every press would be refused.
    expect(githubOfferedMutationsV1({
      kindId: 'issue',
      state: detailInput({ kindId: 'issue' }).observation.snapshot.state,
    })).toEqual(['close']);

    expect(githubOfferedMutationsV1({
      kindId: 'issue',
      state: detailInput({ kindId: 'issue', presentation: 'closed', nativeLabel: 'Closed as completed' })
        .observation.snapshot.state,
    })).toEqual(['reopen']);
  });

  it('offers nothing for a state this build cannot read, on either kind', () => {
    for (const kindId of ['pull-request', 'issue'] as const) {
      expect(githubOfferedMutationsV1({
        kindId,
        state: detailInput({ kindId, presentation: 'unknown', nativeLabel: 'unknown' })
          .observation.snapshot.state,
      }), kindId).toEqual([]);
    }
  });
});

describe('the issue write inputs', () => {
  it('carries the reason the reader chose and never a default one', () => {
    const built = buildGithubIssueCloseInputV1(detailInput({ kindId: 'issue' }), 'not_planned');
    expect(built).toMatchObject({
      v: 1,
      localRef: { kindId: 'issue', collisionScope: 'github:1296269', entryId: '1284' },
      routingToken: 'octo-org/example-app',
      stateReason: 'not_planned',
    });
    // Every reason the contract declares is offered, in GitHub's own vocabulary.
    expect(GITHUB_ISSUE_CLOSE_REASONS_V1).toEqual(['completed', 'not_planned', 'duplicate']);
  });

  it('builds nothing for either issue write when the observation carries no route', () => {
    const routeless = detailInput({ kindId: 'issue', routingToken: null });
    expect(buildGithubIssueCloseInputV1(routeless, 'completed')).toBeNull();
    expect(buildGithubIssueReopenInputV1(routeless)).toBeNull();
  });
});

describe('the remaining exact mutation inputs', () => {
  it('pins mark-ready and update-branch to the head the reader saw', () => {
    for (const built of [
      buildGithubPullRequestMarkReadyInputV1(detailInput()),
      buildGithubPullRequestUpdateBranchInputV1(detailInput()),
    ]) {
      expect(built).toMatchObject({
        localRef: { kindId: 'pull-request', collisionScope: 'github:1296269', entryId: '1284' },
        routingToken: 'octo-org/example-app',
        headRevision: OBSERVED_HEAD,
      });
    }
    expect(buildGithubPullRequestMarkReadyInputV1(detailInput({ nativeRevision: null }))).toBeNull();
    expect(buildGithubPullRequestUpdateBranchInputV1(detailInput({ nativeRevision: null }))).toBeNull();
  });

  it('builds exact reviewer deltas and never sends an empty one', () => {
    expect(readGithubNamesV1(' octocat, hubot\noctocat ')).toEqual(['octocat', 'hubot']);
    expect(buildGithubPullRequestReviewersInputV1(
      detailInput(),
      ['octocat'],
      ['maintainers'],
      'add',
    )).toMatchObject({ users: ['octocat'], teams: ['maintainers'] });
    expect(buildGithubPullRequestReviewersInputV1(detailInput(), [], [], 'remove')).toBeNull();
  });

  it('builds issue member deltas without turning one direction into a runtime flag', () => {
    const issue = detailInput({ kindId: 'issue' });
    expect(buildGithubIssueAssigneesInputV1(issue, ['octocat', 'hubot'], 'add'))
      .toMatchObject({ usernames: ['octocat', 'hubot'] });
    expect(buildGithubIssueAssigneesInputV1(issue, [], 'remove')).toBeNull();

    expect(readGithubLabelsV1('needs triage\nrelease, blocker\nneeds triage'))
      .toEqual(['needs triage', 'release, blocker']);
    expect(buildGithubIssueLabelsInputV1(issue, ['needs triage', 'release, blocker'], 'add'))
      .toMatchObject({ labels: ['needs triage', 'release, blocker'] });
    expect(buildGithubIssueLabelsInputV1(issue, ['needs triage'], 'remove'))
      .toMatchObject({ label: 'needs triage' });
    expect(buildGithubIssueLabelsInputV1(issue, ['one', 'two'], 'remove')).toBeNull();
  });

  it('names one opaque review thread and one requested resolution state', () => {
    expect(buildGithubPullRequestThreadResolutionInputV1(detailInput(), ' PRRT_kwDOA ', false))
      .toMatchObject({ threadId: 'PRRT_kwDOA', resolved: false });
  });
});

describe('buildGithubPullRequestMergeInputV1', () => {
  it('names the observed head and the chosen method, and defaults neither', () => {
    const built = buildGithubPullRequestMergeInputV1(detailInput(), 'squash');
    expect(built).toEqual({
      v: 1,
      instance: CONFIGURED_INSTANCE,
      localRef: {
        kindId: 'pull-request',
        collisionScope: 'github:1296269',
        entryId: '1284',
      },
      routingToken: 'octo-org/example-app',
      headRevision: OBSERVED_HEAD,
      mergeMethod: 'squash',
    });
  });

  it('refuses to build when the observation carries no head revision', () => {
    // The merge precondition's whole value is that the SHA comes from the read the user
    // acted on. A build that substituted anything else would send a precondition the
    // user never saw.
    expect(buildGithubPullRequestMergeInputV1(
      detailInput({ nativeRevision: null }),
      'merge',
    )).toBeNull();
  });

  it('refuses to build when the observation carries no route', () => {
    expect(buildGithubPullRequestMergeInputV1(
      detailInput({ routingToken: null }),
      'merge',
    )).toBeNull();
  });

  it('refuses a head revision the write contract will not accept', () => {
    // A provider identifier that is not a commit object cannot be a merge precondition.
    // Catching it here keeps the control from dispatching a write that can only fail.
    expect(buildGithubPullRequestMergeInputV1(
      detailInput({ nativeRevision: 'not-a-sha' }),
      'merge',
    )).toBeNull();
  });

  it('offers exactly GitHub\'s own merge-method vocabulary', () => {
    expect(GITHUB_MERGE_METHODS_V1).toEqual(['merge', 'squash', 'rebase']);
  });
});

describe('buildGithubPullRequestTargetInputV1', () => {
  it('builds the head-independent target close and reopen share', () => {
    expect(buildGithubPullRequestTargetInputV1(detailInput())).toEqual({
      v: 1,
      instance: CONFIGURED_INSTANCE,
      localRef: {
        kindId: 'pull-request',
        collisionScope: 'github:1296269',
        entryId: '1284',
      },
      routingToken: 'octo-org/example-app',
    });
  });

  it('still builds when no head revision was observed', () => {
    // Close and reopen are head-independent by contract; pinning them would add a
    // failure mode protecting no invariant.
    expect(buildGithubPullRequestTargetInputV1(detailInput({ nativeRevision: null })))
      .not.toBeNull();
  });

  it('refuses to build when the observation carries no route', () => {
    expect(buildGithubPullRequestTargetInputV1(detailInput({ routingToken: null })))
      .toBeNull();
  });
});

describe('projectGithubMutationOutcomeV1', () => {
  it('settles nothing while the control is at rest or in flight', () => {
    expect(projectGithubMutationOutcomeV1({ status: 'idle' }, null)).toBeNull();
    expect(projectGithubMutationOutcomeV1({ status: 'pending' }, null)).toBeNull();
  });

  it('separates a state that changed from one GitHub already held', () => {
    // `alreadySatisfied` states that NO request was sent. Rendering it as a plain
    // success tells the user they changed something they did not.
    expect(projectGithubMutationOutcomeV1(
      { status: 'success', result: null },
      { kind: 'applied', effect: 'changed', observation: APPLIED_OBSERVATION },
    )).toEqual({ kind: 'applied', effect: 'changed' });

    expect(projectGithubMutationOutcomeV1(
      { status: 'success', result: null },
      { kind: 'applied', effect: 'alreadySatisfied', observation: APPLIED_OBSERVATION },
    )).toEqual({ kind: 'applied', effect: 'alreadySatisfied' });
  });

  it('carries each refusal reason through instead of collapsing them to one word', () => {
    // The four merge refusals are four different things for the user to do next. A
    // projection that flattened them would tell someone whose head advanced the same
    // sentence as someone whose repository forbids squash merges.
    for (const reason of [
      'head_advanced',
      'state_changed',
      'not_mergeable',
      'merge_method_not_allowed',
    ] as const) {
      expect(projectGithubMutationOutcomeV1(
        { status: 'success', result: null },
        { kind: 'refused', reason },
      )).toEqual({ kind: 'refused', reason });
    }
  });

  it('keeps an accepted-but-unconfirmed write distinct from a success and from a failure', () => {
    // §2 forbids retrying an unknown outcome blindly, and this is the projection the
    // control's copy hangs off. Folding it into either neighbour is how a duplicate
    // merge ships.
    expect(projectGithubMutationOutcomeV1(
      { status: 'success', result: null },
      { kind: 'uncertain' },
    )).toEqual({ kind: 'uncertain', failure: null });

    const failure = { class: 'transient', code: 'github_confirm_read_failed' } as const;
    expect(projectGithubMutationOutcomeV1(
      { status: 'success', result: null },
      { kind: 'uncertain', failure },
    )).toEqual({ kind: 'uncertain', failure });
  });

  it('keeps GitHub\'s accepted branch update distinct from applied and uncertain', () => {
    expect(projectGithubMutationOutcomeV1(
      { status: 'success', result: null },
      { kind: 'pending', observation: APPLIED_OBSERVATION },
    )).toEqual({ kind: 'pending' });
  });

  it('keeps a stated provider failure as a failure', () => {
    const failure = { class: 'permission', code: 'github_write_forbidden' } as const;
    expect(projectGithubMutationOutcomeV1(
      { status: 'success', result: null },
      { kind: 'failed', failure },
    )).toEqual({ kind: 'failed', failure });
  });

  it('does not read an unparseable result as an applied write', () => {
    // The action settled successfully at the transport, but this build could not
    // understand what it settled AS. Claiming the write landed would be an invention.
    expect(projectGithubMutationOutcomeV1({ status: 'success', result: null }, null))
      .toEqual({ kind: 'unreadable' });
  });

  it('reports a declined or failed dispatch as rejected, carrying its code', () => {
    expect(projectGithubMutationOutcomeV1({
      status: 'error',
      code: 'plugin_action_current_intent_rejected',
      message: 'The confirmation was declined.',
      retryable: false,
    }, null)).toEqual({
      kind: 'rejected',
      code: 'plugin_action_current_intent_rejected',
      message: 'The confirmation was declined.',
    });
  });

  it('reports an unknown dispatch outcome as uncertain, never as a rejection', () => {
    // A timed-out or aborted dispatch may already have merged. Presenting it as a
    // refusal invites the retry that duplicates the mutation.
    expect(projectGithubMutationOutcomeV1({
      status: 'outcomeUnknown',
      code: 'timeout',
      message: 'The action did not complete.',
    }, null)).toEqual({ kind: 'uncertain', failure: null });
  });
});

describe('GitHub post-mutation provider semantics', () => {
  it('reconciles only the published outcomes which can follow a provider write', () => {
    expect(githubMutationMayHaveChangedProviderStateV1({ kind: 'applied', effect: 'changed' }))
      .toBe(true);
    expect(githubMutationMayHaveChangedProviderStateV1({ kind: 'pending' })).toBe(true);
    expect(githubMutationMayHaveChangedProviderStateV1({ kind: 'uncertain', failure: null }))
      .toBe(true);
    expect(githubMutationMayHaveChangedProviderStateV1({ kind: 'unreadable' })).toBe(true);
    expect(githubMutationMayHaveChangedProviderStateV1({
      kind: 'applied',
      effect: 'alreadySatisfied',
    })).toBe(false);
    expect(githubMutationMayHaveChangedProviderStateV1({ kind: 'refused', reason: 'state_changed' }))
      .toBe(false);
    expect(githubMutationMayHaveChangedProviderStateV1({
      kind: 'failed',
      failure: { class: 'permission', code: 'github-write-forbidden' },
    })).toBe(false);
    expect(githubMutationMayHaveChangedProviderStateV1({
      kind: 'rejected',
      code: 'plugin_action_current_intent_rejected',
      message: 'The confirmation was declined.',
    })).toBe(false);
  });
});
