import { TriageSourcesContributionProtocolV1, TriageSourceConnectedAccountInputsV1 } from '@happier-dev/triage-protocol/v1';
import { BITBUCKET_CONNECTED_ACCOUNT_PURPOSE } from './triage/source/descriptor.js';
import { BITBUCKET_TRIAGE_ACTION_IDS, getBitbucketSourceEntryAction, listBitbucketInstancesAction, scanBitbucketSourceAction } from './triage/source/actions.js';
import { BITBUCKET_TRIAGE_DETAIL_ACTION_IDS, listBitbucketActivity, listBitbucketBuilds, listBitbucketComments, readBitbucketDiff, readBitbucketOverview } from './triage/source/detailActions.js';
import { BitbucketActivityInputV1Schema, BitbucketActivityResultV1Schema, BitbucketBuildsInputV1Schema, BitbucketBuildsResultV1Schema, BitbucketCommentsInputV1Schema, BitbucketCommentsResultV1Schema, BitbucketDiffInputV1Schema, BitbucketDiffResultV1Schema, BitbucketOverviewInputV1Schema, BitbucketOverviewResultV1Schema } from './triage/source/detailContracts.js';
import { BITBUCKET_TRIAGE_MUTATION_ACTION_IDS, createBitbucketPullRequestReviewCommentAction, declineBitbucketPullRequestAction, mergeBitbucketPullRequestAction, resolveBitbucketCommentAction, publishBitbucketPullRequestReviewAction, replyToBitbucketPullRequestReviewCommentAction, unresolveBitbucketCommentAction } from './triage/source/mutationActions.js';
import { BitbucketCommentResolutionInputV1Schema, BitbucketCommentResolutionResultV1Schema, BitbucketDeclineInputV1Schema, BitbucketMergeInputV1Schema, BitbucketMutationResultV1Schema, BitbucketReviewPublicationInputV1Schema, BitbucketReviewPublicationResultV1Schema, BitbucketReviewCommentCreateInputV1Schema, BitbucketReviewCommentReplyInputV1Schema } from './triage/source/mutationContracts.js';

export const BITBUCKET_NETWORK_HOST_ACCESS_ID = 'bitbucket-api';

export const sources = TriageSourcesContributionProtocolV1;

export const READ_HOST_ACCESS = [BITBUCKET_NETWORK_HOST_ACCESS_ID, BITBUCKET_CONNECTED_ACCOUNT_PURPOSE];

export const INSTANCE_ACCOUNT_BINDINGS = [{
  path: 'instance.binding.account',
  purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
}];

export const BITBUCKET_ACCOUNT_EXECUTION = { target: 'account', account: { artifactId: 'bitbucket-account-runtime', exportName: 'activate' } } as const;

const bitbucketEntryReviewFields = [
  { path: 'lastKnownLocator.routingToken', title: 'Repository' },
  { path: 'instance.locator.displayLabel', title: 'Source' },
  { path: 'localRef.entryId', title: 'Item' },
] as const;

export const BITBUCKET_ACCOUNT_ACTIONS = {
    [BITBUCKET_TRIAGE_ACTION_IDS.listInstances]: {
      title: 'Discover Bitbucket Cloud workspaces',
      description: 'Enumerates the workspaces reachable by each authorized Bitbucket Cloud account.',
      surfaces: sources.operations.listInstances.declaration.surfaces,
      placementBindings: [],
      dangerLevel: sources.operations.listInstances.declaration.dangerLevel,
      inputSchema: sources.operations.listInstances.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.listInstances.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      run: listBitbucketInstancesAction,
      execution: BITBUCKET_ACCOUNT_EXECUTION,
    },
    [BITBUCKET_TRIAGE_ACTION_IDS.scan]: {
      title: 'Scan Bitbucket Cloud pull requests',
      description: 'Reads one bounded page of pull requests for one configured Bitbucket Cloud workspace.',
      surfaces: sources.operations.scan.declaration.surfaces,
      dangerLevel: sources.operations.scan.declaration.dangerLevel,
      inputSchema: TriageSourceConnectedAccountInputsV1.scan.jsonSchema,
      resultSchema: sources.operations.scan.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: scanBitbucketSourceAction,
      execution: BITBUCKET_ACCOUNT_EXECUTION,
    },
    [BITBUCKET_TRIAGE_ACTION_IDS.get]: {
      title: 'Read one Bitbucket Cloud pull request',
      description: 'Reads one pull request authoritatively through one exact configured Bitbucket Cloud instance.',
      surfaces: sources.operations.get.declaration.surfaces,
      placementBindings: [],
      dangerLevel: sources.operations.get.declaration.dangerLevel,
      inputSchema: TriageSourceConnectedAccountInputsV1.get.jsonSchema,
      resultSchema: sources.operations.get.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: getBitbucketSourceEntryAction,
      execution: BITBUCKET_ACCOUNT_EXECUTION,
    },
    [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listActivity]: {
      title: 'Read a Bitbucket activity page',
      description: 'Reads one bounded page of the combined approval, update and comment activity'
        + ' of one pull request.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: [],
      inputSchema: BitbucketActivityInputV1Schema.jsonSchema,
      resultSchema: BitbucketActivityResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: listBitbucketActivity,
      execution: BITBUCKET_ACCOUNT_EXECUTION,
    },
    [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readOverview]: {
      title: 'Refresh a Bitbucket pull-request overview',
      description: 'Reads the pull request authoritatively from Bitbucket for the mounted Overview.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: [],
      inputSchema: BitbucketOverviewInputV1Schema.jsonSchema,
      resultSchema: BitbucketOverviewResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: readBitbucketOverview,
      execution: BITBUCKET_ACCOUNT_EXECUTION,
    },
    [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readDiff]: {
      title: 'Read a Bitbucket pull-request diff',
      description: 'Reads the raw diff and its bounded diffstat projection without dropping the pull request.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: [],
      inputSchema: BitbucketDiffInputV1Schema.jsonSchema,
      resultSchema: BitbucketDiffResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: readBitbucketDiff,
      execution: BITBUCKET_ACCOUNT_EXECUTION,
    },
    [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listBuilds]: {
      title: 'Read a Bitbucket build-status page',
      description: 'Reads one bounded page of the build statuses reported against one pull'
        + ' request, with a rollup only when that page is the whole collection.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: [],
      inputSchema: BitbucketBuildsInputV1Schema.jsonSchema,
      resultSchema: BitbucketBuildsResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: listBitbucketBuilds,
      execution: BITBUCKET_ACCOUNT_EXECUTION,
    },
    [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listComments]: {
      title: 'Read a Bitbucket comment page',
      description: 'Reads one bounded page of the comments on one pull request, in provider'
        + ' order, with their real resolution tri-state.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: [],
      inputSchema: BitbucketCommentsInputV1Schema.jsonSchema,
      resultSchema: BitbucketCommentsResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: listBitbucketComments,
      execution: BITBUCKET_ACCOUNT_EXECUTION,
    },
    [BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.merge]: {
      title: 'Merge a Bitbucket pull request',
      description: 'Merges one pull request with the exact strategy and source-branch decision the'
        + ' user chose, only while its head is still the commit they saw.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'destructive',
      secretInputPaths: ['instance.configuration.token'],
      confirmation: {
        title: {
          key: 'plugins.bitbucket.ui.mutations.merge.button',
          fallback: 'Merge this pull request?',
        },
        body: {
          key: 'plugins.bitbucket.ui.mutations.merge.strategyRequired',
          fallback: 'Merging permanently writes the selected strategy into this repository.'
            + ' If new commits arrive first, nothing is merged.',
        },
        confirmLabel: {
          key: 'plugins.bitbucket.ui.mutations.merge.button',
          fallback: 'Merge',
        },
        inputFields: [
          ...bitbucketEntryReviewFields,
          { path: 'observedHeadCommit', title: 'Reviewed head' },
          { path: 'closeSourceBranch', title: 'Close source branch' },
          { path: 'mergeStrategy', title: 'Merge strategy' },
          { path: 'message', title: 'Message' },
        ],
      },
      inputSchema: BitbucketMergeInputV1Schema.jsonSchema,
      resultSchema: BitbucketMutationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: mergeBitbucketPullRequestAction,
      execution: BITBUCKET_ACCOUNT_EXECUTION,
    },
    [BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.decline]: {
      title: 'Decline a Bitbucket pull request',
      description: 'Declines one open pull request. Bitbucket has no reopen, so this cannot be'
        + ' undone through its API.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      secretInputPaths: ['instance.configuration.token'],
      confirmation: {
        title: {
          key: 'plugins.bitbucket.ui.mutations.decline.button',
          fallback: 'Decline this pull request?',
        },
        body: {
          key: 'plugins.bitbucket.ui.mutations.decline.description',
          fallback: 'Bitbucket cannot reopen a declined pull request through its API.',
        },
        confirmLabel: {
          key: 'plugins.bitbucket.ui.mutations.decline.button',
          fallback: 'Decline',
        },
        inputFields: [
          ...bitbucketEntryReviewFields,
        ],
      },
      inputSchema: BitbucketDeclineInputV1Schema.jsonSchema,
      resultSchema: BitbucketMutationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: declineBitbucketPullRequestAction,
      execution: BITBUCKET_ACCOUNT_EXECUTION,
    },
    [BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.resolveComment]: {
      title: 'Resolve a Bitbucket comment thread',
      description: 'Marks one comment thread on this pull request resolved, and confirms it from'
        + ' the comment itself.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      secretInputPaths: ['instance.configuration.token'],
      confirmation: {
        title: {
          key: 'plugins.bitbucket.ui.mutations.comment.resolve',
          fallback: 'Resolve this comment thread?',
        },
        body: {
          key: 'plugins.bitbucket.ui.mutations.comment.resolveConfirmation',
          fallback: 'Everyone on the pull request will see this thread as resolved. It can be reopened.',
        },
        confirmLabel: {
          key: 'plugins.bitbucket.ui.mutations.comment.resolve',
          fallback: 'Resolve',
        },
        inputFields: [
          ...bitbucketEntryReviewFields,
          { path: 'commentId', title: 'Comment' },
        ],
      },
      inputSchema: BitbucketCommentResolutionInputV1Schema.jsonSchema,
      resultSchema: BitbucketCommentResolutionResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: resolveBitbucketCommentAction,
      execution: BITBUCKET_ACCOUNT_EXECUTION,
    },
    [BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.unresolveComment]: {
      title: 'Reopen a Bitbucket comment thread',
      description: 'Reopens one resolved comment thread on this pull request, and confirms it from'
        + ' the comment itself.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      secretInputPaths: ['instance.configuration.token'],
      confirmation: {
        title: {
          key: 'plugins.bitbucket.ui.mutations.comment.reopen',
          fallback: 'Reopen this comment thread?',
        },
        body: {
          key: 'plugins.bitbucket.ui.mutations.comment.reopenConfirmation',
          fallback: 'Everyone on the pull request will see this thread as open again. It can be resolved again.',
        },
        confirmLabel: {
          key: 'plugins.bitbucket.ui.mutations.comment.reopen',
          fallback: 'Reopen',
        },
        inputFields: [
          ...bitbucketEntryReviewFields,
          { path: 'commentId', title: 'Comment' },
        ],
      },
      inputSchema: BitbucketCommentResolutionInputV1Schema.jsonSchema,
      resultSchema: BitbucketCommentResolutionResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: unresolveBitbucketCommentAction,
      execution: BITBUCKET_ACCOUNT_EXECUTION,
    },
    [BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.submitReview]: {
      title: 'Submit this Bitbucket pull-request review',
      description: 'Publishes the selected canonical Happier review comments in order, then applies the requested Bitbucket verdict against the exact base and head revisions shown.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'externalSideEffect',
      secretInputPaths: ['instance.configuration.token'],
      confirmation: {
        title: {
          key: 'plugins.bitbucket.ui.mutations.review.confirmation.title',
          fallback: 'Submit this review?',
        },
        body: {
          key: 'plugins.bitbucket.ui.mutations.review.confirmation.body',
          fallback: 'This publishes the selected comments and then your verdict on Bitbucket. If the pull request comparison moved, nothing is written.',
        },
        confirmLabel: {
          key: 'plugins.bitbucket.ui.mutations.review.submit',
          fallback: 'Submit review',
        },
        inputFields: [
          ...bitbucketEntryReviewFields,
          { path: 'publicationPlan.headRevision', title: 'Reviewed head' },
          { path: 'publicationPlan.entries.[].body', title: 'Comments' },
          { path: 'publicationPlan.verdict.kind', title: 'Verdict' },
          { path: 'publicationPlan.verdict.body', title: 'Review summary' },
        ],
      },
      inputSchema: BitbucketReviewPublicationInputV1Schema.jsonSchema,
      resultSchema: BitbucketReviewPublicationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: publishBitbucketPullRequestReviewAction,
      execution: BITBUCKET_ACCOUNT_EXECUTION,
    },
    [BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.createReviewComment]: {
      title: 'Publish this Bitbucket review comment',
      description: 'Publishes one canonical Happier proposal at its exact pinned Bitbucket diff anchor.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'externalSideEffect',
      secretInputPaths: ['instance.configuration.token'],
      confirmation: {
        title: { key: 'plugins.bitbucket.ui.mutations.reviewComment.confirmation.title', fallback: 'Publish this review comment?' },
        body: { key: 'plugins.bitbucket.ui.mutations.reviewComment.confirmation.body', fallback: 'This posts the selected comment on Bitbucket at the exact pull request comparison you reviewed.' },
        confirmLabel: { key: 'plugins.bitbucket.ui.mutations.reviewComment.publish', fallback: 'Publish comment' },
        inputFields: [
          ...bitbucketEntryReviewFields,
          { path: 'publicationPlan.headRevision', title: 'Reviewed head' },
          { path: 'publicationPlan.entries.[].body', title: 'Comments' },
        ],
      },
      inputSchema: BitbucketReviewCommentCreateInputV1Schema.jsonSchema,
      resultSchema: BitbucketReviewPublicationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: createBitbucketPullRequestReviewCommentAction,
      execution: BITBUCKET_ACCOUNT_EXECUTION,
    },
    [BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.replyToReviewComment]: {
      title: 'Reply to this Bitbucket review comment',
      description: 'Publishes one canonical Happier proposal beneath one exact Bitbucket pull-request comment.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      secretInputPaths: ['instance.configuration.token'],
      confirmation: {
        title: { key: 'plugins.bitbucket.ui.mutations.reviewReply.confirmation.title', fallback: 'Post this reply?' },
        body: { key: 'plugins.bitbucket.ui.mutations.reviewReply.confirmation.body', fallback: 'This reply becomes visible beneath the selected Bitbucket pull-request comment.' },
        confirmLabel: { key: 'plugins.bitbucket.ui.mutations.reviewReply.publish', fallback: 'Post reply' },
        inputFields: [
          ...bitbucketEntryReviewFields,
          { path: 'publicationPlan.headRevision', title: 'Reviewed head' },
          { path: 'publicationPlan.entries.[].body', title: 'Comments' },
          { path: 'parentCommentId', title: 'Parent comment' },
        ],
      },
      inputSchema: BitbucketReviewCommentReplyInputV1Schema.jsonSchema,
      resultSchema: BitbucketReviewPublicationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: replyToBitbucketPullRequestReviewCommentAction,
      execution: BITBUCKET_ACCOUNT_EXECUTION,
    }
} as const;
