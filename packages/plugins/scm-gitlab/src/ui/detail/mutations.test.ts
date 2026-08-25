/**
 * The three decisions the GitLab detail surface makes around its declared
 * writes, checked without mounting a device.
 *
 * Each case here is chosen because a plausible wrong implementation passes the
 * others: offering writes off the display label, building an input the Action
 * would reject, reading one write's success arm off another write's dispatch,
 * and — the expensive one — reporting a scheduled, unconfirmed or refused write
 * as a completed one.
 */

import { describe, expect, it } from 'vitest';
import {
  TriageDetailSurfaceInputV1Schema,
  type TriageDetailSurfaceInputV1,
} from '@happier-dev/triage-protocol/v1';
import type { PluginActionExecution } from '@happier-dev/plugin-ui';

import { GITLAB_CONNECTED_ACCOUNT_PURPOSE } from '../../triage/contribution.js';
import {
  GITLAB_CURRENT_INTENT_REJECTED_CODE,
  buildGitlabMergeRequestCloseInputV1,
  buildGitlabMergeRequestMarkReadyInputV1,
  buildGitlabMergeRequestMergeInputV1,
  buildGitlabMergeRequestReopenInputV1,
  buildGitlabReviewerChangeInputV1,
  buildGitlabDiscussionResolutionInputV1,
  buildGitlabIssueCloseInputV1,
  buildGitlabIssueReopenInputV1,
  buildGitlabIssueAssignInputV1,
  buildGitlabIssueLabelInputV1,
  gitlabOfferedMergeRequestWritesV1,
  projectGitlabWriteOutcomeV1,
} from './mutations.js';

const SOURCE_CONTRIBUTION = Object.freeze({ pluginId: 'happier.gitlab', localId: 'gitlab-forge' });
const CONFIGURED_INSTANCE = Object.freeze({
  v: 1,
  instance: Object.freeze({
    source: SOURCE_CONTRIBUTION,
    sourceInstanceId: '9d2a6b1e-6c1a-4b7d-9f31-1d4a6c8b2e70',
  }),
  binding: Object.freeze({
    purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
    account: Object.freeze({
      service: Object.freeze({ pluginId: 'happier.gitlab', localId: 'gitlab-account' }),
      accountId: 'account-1',
    }),
  }),
  localInstanceKey: 'gitlab-com',
  configuration: Object.freeze({ v: 1, token: 'gitlab-configuration-token-v1' }),
});

describe('the remaining registered write inputs', () => {
  it('builds each MR input from the mounted entry and its observed head', () => {
    const input = detailInput();
    expect(buildGitlabMergeRequestReopenInputV1(input)).toMatchObject({ localRef: { kindId: 'merge-request' } });
    expect(buildGitlabReviewerChangeInputV1(input, 'add', ['alice'])).toMatchObject({ operation: 'add', reviewerUsernames: ['alice'], observedHeadSha: OBSERVED_HEAD });
    expect(buildGitlabDiscussionResolutionInputV1(input, 'discussion-1', true)).toMatchObject({ discussionId: 'discussion-1', resolved: true, observedHeadSha: OBSERVED_HEAD });
  });

  it('builds each issue input without replacing the user-entered member names', () => {
    const input = detailInput({ kindId: 'issue', nativeRevision: '2026-08-12T09:00:00.000Z' });
    expect(buildGitlabIssueCloseInputV1(input)).toMatchObject({ observedRevision: '2026-08-12T09:00:00.000Z' });
    expect(buildGitlabIssueReopenInputV1(input)).toMatchObject({ observedRevision: '2026-08-12T09:00:00.000Z' });
    expect(buildGitlabIssueAssignInputV1(input, 'remove', ['alice'])).toMatchObject({ operation: 'remove', assigneeUsernames: ['alice'] });
    expect(buildGitlabIssueLabelInputV1(input, 'add', ['needs-review'])).toMatchObject({ operation: 'add', labelNames: ['needs-review'] });
  });
});

/** GitLab's own `sha` for this merge request, exactly as the read observed it. */
const OBSERVED_HEAD = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

function detailInput(
  overrides: Readonly<{
    kindId?: string;
    state?: Readonly<Record<string, unknown>>;
    nativeRevision?: string | undefined;
  }> = {},
): TriageDetailSurfaceInputV1 {
  const revision = 'nativeRevision' in overrides ? overrides.nativeRevision : OBSERVED_HEAD;
  return TriageDetailSurfaceInputV1Schema.parse({
    v: 1,
    instance: CONFIGURED_INSTANCE,
    observation: {
      entryRef: {
        source: SOURCE_CONTRIBUTION,
        kindId: overrides.kindId ?? 'merge-request',
        collisionScope: 'gitlab.com:group/project',
        entryId: '412',
      },
      observedAtMs: 1_760_000_700_000,
      locator: {
        v: 1,
        webUrl: 'https://gitlab.com/group/project/-/merge_requests/412',
        displayPath: 'group/project !412',
        routingToken: 'group/project',
      },
      snapshot: {
        v: 1,
        title: 'Consolidate the duplicated normalizer',
        scopeLabel: 'group/project',
        state: overrides.state ?? { presentation: 'active', nativeLabel: 'Opened' },
        facts: [],
      },
      viewer: { involvement: ['reviewRequested'] },
      ...(revision === undefined ? {} : { nativeRevision: revision }),
    },
    linkedSessions: [],
  });
}

const STATE_ROW = Object.freeze({
  projectId: 3,
  iid: '412',
  state: 'merged',
  draft: false,
  autoMergeScheduled: false,
});

function success(result: unknown): PluginActionExecution<unknown> {
  return { status: 'success', result };
}

describe('gitlabOfferedMergeRequestWritesV1', () => {
  it('offers every registered open merge-request write', () => {
    expect(gitlabOfferedMergeRequestWritesV1({
      kindId: 'merge-request',
      state: { presentation: 'active', nativeLabel: 'Opened' },
    })).toEqual(['merge', 'markReady', 'close', 'reviewerChange']);
  });

  it('offers nothing on an issue, because all three Actions are merge-request writes', () => {
    expect(gitlabOfferedMergeRequestWritesV1({
      kindId: 'issue',
      state: { presentation: 'active', nativeLabel: 'Open' },
    })).toEqual([]);
  });

  it('offers the declared reopen on a closed merge request', () => {
    expect(gitlabOfferedMergeRequestWritesV1({
      kindId: 'merge-request',
      state: { presentation: 'closed', nativeLabel: 'Merged' },
    })).toEqual(['mergeRequestReopen']);
  });

  it('branches on the projected state and never on GitLab’s display word', () => {
    // One deployment's relabelled or translated state word must not change what a
    // user may write. Same presentation, different native label, same offer.
    const relabelled = gitlabOfferedMergeRequestWritesV1({
      kindId: 'merge-request',
      state: { presentation: 'active', nativeLabel: 'En cours' },
    });
    const closedLookingLabel = gitlabOfferedMergeRequestWritesV1({
      kindId: 'merge-request',
      state: { presentation: 'active', nativeLabel: 'Merged' },
    });

    expect(relabelled).toEqual(['merge', 'markReady', 'close', 'reviewerChange']);
    expect(closedLookingLabel).toEqual(['merge', 'markReady', 'close', 'reviewerChange']);
  });
});

describe('buildGitlabMergeRequestCloseInputV1', () => {
  it('addresses the exact entry through the close contract’s own schema', () => {
    const built = buildGitlabMergeRequestCloseInputV1(detailInput());

    expect(built).not.toBeNull();
    expect(built?.localRef).toEqual({
      kindId: 'merge-request',
      collisionScope: 'gitlab.com:group/project',
      entryId: '412',
    });
  });

  it('carries no pin at all, and nothing that decides how GitLab closes', () => {
    // §2.6: close is head-independent, so a pin here would add a failure mode
    // protecting no invariant. The exact key set is asserted rather than a
    // per-field absence, so a member added later — a pin, or a
    // `should_remove_source_branch` that deletes a collaborator's branch — fails
    // this case instead of shipping as an invisible default.
    const built = buildGitlabMergeRequestCloseInputV1(detailInput());

    expect(Object.keys(built ?? {}).sort()).toEqual(['instance', 'localRef', 'v']);
  });

  it('still builds when the observation carries no revision', () => {
    // Close needs no observed commit, so an unpinnable merge request is still
    // closable. Withholding the control here would remove a working capability.
    expect(buildGitlabMergeRequestCloseInputV1(detailInput({ nativeRevision: undefined })))
      .not.toBeNull();
  });
});

describe('buildGitlabMergeRequestMergeInputV1', () => {
  it('pins the merge to the head commit the mounted observation carries', () => {
    const built = buildGitlabMergeRequestMergeInputV1(detailInput());

    expect(built?.observedHeadSha).toBe(OBSERVED_HEAD);
  });

  it('builds nothing without a head commit, rather than merging whatever the head becomes', () => {
    // GitLab consumes this pin as its own `sha` precondition. A merge dispatched
    // without it is unconditional, which is the exact race the pin closes.
    expect(buildGitlabMergeRequestMergeInputV1(detailInput({ nativeRevision: undefined })))
      .toBeNull();
  });

  it('rejects a revision that is not a commit object', () => {
    // A timestamp and a branch name are both revisions of a sort, and neither is
    // a head pin. The contract's pattern refuses them here, so neither can ever
    // reach GitLab as a `sha` — which GitLab would answer `400` or, worse, merge.
    expect(buildGitlabMergeRequestMergeInputV1(
      detailInput({ nativeRevision: '2026-08-01T10:00:00.123Z' }),
    )).toBeNull();
    expect(buildGitlabMergeRequestMergeInputV1(
      detailInput({ nativeRevision: 'refs/heads/main' }),
    )).toBeNull();
  });

  it('carries no option that rewrites history or deletes a branch', () => {
    // GitLab exposes `squash`, `squash_commit_message` and
    // `should_remove_source_branch` on this endpoint and this Action offers none
    // of them: the project's own configured defaults decide. The exact key set is
    // the gate, so one added later cannot arrive silently switched on — or off.
    const built = buildGitlabMergeRequestMergeInputV1(detailInput());

    expect(Object.keys(built ?? {}).sort())
      .toEqual(['instance', 'localRef', 'observedHeadSha', 'v']);
  });
});

describe('buildGitlabMergeRequestMarkReadyInputV1', () => {
  it('requires the head pin, because the reviewer notification is the write', () => {
    expect(buildGitlabMergeRequestMarkReadyInputV1(detailInput({ nativeRevision: undefined })))
      .toBeNull();
    expect(buildGitlabMergeRequestMarkReadyInputV1(detailInput())?.observedHeadSha)
      .toBe(OBSERVED_HEAD);
  });
});

describe('projectGitlabWriteOutcomeV1', () => {
  it('reports nothing while the control is at rest or in flight', () => {
    expect(projectGitlabWriteOutcomeV1('close', { status: 'idle' })).toBeNull();
    expect(projectGitlabWriteOutcomeV1('close', { status: 'pending' })).toBeNull();
  });

  it('keeps a scheduled merge apart from a merged one', () => {
    // GitLab answers 200 on a merge it only queued behind a train or a pipeline.
    // A person waiting on a release acts differently on these two facts.
    const merged = projectGitlabWriteOutcomeV1('merge', success({ kind: 'merged', item: STATE_ROW }));
    const scheduled = projectGitlabWriteOutcomeV1(
      'merge',
      success({ kind: 'scheduled', item: { ...STATE_ROW, state: 'opened', autoMergeScheduled: true } }),
    );

    expect(merged).toMatchObject({ kind: 'applied', effect: 'merged' });
    expect(scheduled).toMatchObject({ kind: 'applied', effect: 'scheduled' });
  });

  it('projects each write’s own success arm', () => {
    expect(projectGitlabWriteOutcomeV1('close', success({
      kind: 'closed',
      item: { ...STATE_ROW, state: 'closed' },
    }))).toMatchObject({ kind: 'applied', effect: 'closed' });
    expect(projectGitlabWriteOutcomeV1('markReady', success({
      kind: 'ready',
      item: { ...STATE_ROW, state: 'opened' },
    }))).toMatchObject({ kind: 'applied', effect: 'ready' });
  });

  it('refuses to read one write’s success arm off another write’s dispatch', () => {
    // `closed` is not a member of the merge result union. Reading it as applied
    // would tell a user their merge landed because a close answered.
    expect(projectGitlabWriteOutcomeV1('merge', success({
      kind: 'closed',
      item: { ...STATE_ROW, state: 'closed' },
    }))).toEqual({ kind: 'unreadable' });
  });

  it('reports a stale-read refusal as having written nothing', () => {
    const outcome = projectGitlabWriteOutcomeV1('close', success({
      kind: 'reconfirmationRequired',
      observed: { ...STATE_ROW, state: 'opened' },
    }));

    expect(outcome).toMatchObject({ kind: 'reconfirmationRequired' });
  });

  it('keeps a refusal’s reason and whether it ever left this process', () => {
    // `dispatched: false` is a preflight refusal — nothing reached GitLab. The
    // two are different advice to the user, so neither is collapsed away.
    expect(projectGitlabWriteOutcomeV1('merge', success({
      kind: 'refused',
      reason: 'headAdvanced',
      dispatched: true,
      observed: { ...STATE_ROW, state: 'opened' },
    }))).toMatchObject({ kind: 'refused', reason: 'headAdvanced', dispatched: true });
    expect(projectGitlabWriteOutcomeV1('close', success({
      kind: 'refused',
      reason: 'notOpen',
      dispatched: false,
      observed: STATE_ROW,
    }))).toMatchObject({ kind: 'refused', reason: 'notOpen', dispatched: false });
  });

  it('never reports an unconfirmed write as a failure', () => {
    // The request reached GitLab and the confirming read could not settle. It may
    // have merged. "Failed" would misinform someone about production.
    const outcome = projectGitlabWriteOutcomeV1('merge', success({
      kind: 'unconfirmed',
      failure: { class: 'transient', code: 'transport-failed' },
    }));

    expect(outcome).toMatchObject({ kind: 'unconfirmed' });
    expect(outcome).not.toMatchObject({ kind: 'unavailable' });
  });

  it('keeps a never-attempted write apart from an unconfirmed one', () => {
    expect(projectGitlabWriteOutcomeV1('close', success({
      kind: 'unavailable',
      failure: { class: 'permission', code: 'item-unreadable' },
    }))).toMatchObject({ kind: 'unavailable' });
  });

  it('reports a declined confirmation as nothing written', () => {
    // This host code settles BEFORE the handler is entered, so it is the one
    // rejection this surface may describe as having written nothing.
    expect(projectGitlabWriteOutcomeV1('merge', {
      status: 'error',
      code: GITLAB_CURRENT_INTENT_REJECTED_CODE,
      message: 'declined',
      retryable: false,
    })).toEqual({ kind: 'declined' });
  });

  it('does not claim any other host error wrote nothing', () => {
    const outcome = projectGitlabWriteOutcomeV1('merge', {
      status: 'error',
      code: 'plugin_action_surface_unavailable',
      message: 'refused',
      retryable: false,
    });

    expect(outcome).toMatchObject({ kind: 'rejected', code: 'plugin_action_surface_unavailable' });
  });

  it('reports an unsettled transport as uncertain, never as idle or failed', () => {
    expect(projectGitlabWriteOutcomeV1('merge', {
      status: 'outcomeUnknown',
      code: 'timeout',
      message: 'timed out',
    })).toEqual({ kind: 'uncertain' });
  });

  it('does not read an unparseable success as an applied write', () => {
    expect(projectGitlabWriteOutcomeV1('merge', success({ kind: 'merged' })))
      .toEqual({ kind: 'unreadable' });
    expect(projectGitlabWriteOutcomeV1('close', success(null)))
      .toEqual({ kind: 'unreadable' });
  });
});
