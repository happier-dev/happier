import { TriageSourcesContributionProtocolV1, TriageSourceConnectedAccountInputsV1 } from '@happier-dev/triage-protocol/v1';
import { AZURE_DEVOPS_TRIAGE_ACTION_IDS, getAzureDevOpsSourceEntryAction, listAzureDevOpsInstancesAction, scanAzureDevOpsSourceAction } from './triage/actions.js';
import { AzureCommitsInputV1Schema, AzureCommitsResultV1Schema, AzureIterationChangesInputV1Schema, AzureIterationChangesResultV1Schema, AzureIterationsInputV1Schema, AzureIterationsResultV1Schema, AzurePoliciesInputV1Schema, AzurePoliciesResultV1Schema, AzureThreadsInputV1Schema, AzureThreadsResultV1Schema } from './triage/detail/contracts.js';
import { AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS, listAzureDevOpsCommits, listAzureDevOpsIterationChanges, readAzureDevOpsIterations, readAzureDevOpsPolicies, readAzureDevOpsThreads } from './triage/detailActions.js';
import { AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS, abandonAzureDevOpsPullRequest, completeAzureDevOpsPullRequest, reactivateAzureDevOpsPullRequest, requestAzureDevOpsPullRequestReview, setAzureDevOpsPullRequestThreadStatus } from './triage/mutationActions.js';
import { createAzureDevOpsPullRequestThreadComment, replyAzureDevOpsPullRequestThread, submitAzureDevOpsPullRequestReview } from './triage/reviewPublication.js';
import { AzureAbandonInputV1Schema, AzureCompleteInputV1Schema, AzureMutationResultV1Schema, AzureReactivateInputV1Schema, AzureReviewPublicationResultV1Schema, AzureRequestReviewInputV1Schema, AzureSubmitReviewInputV1Schema, AzureThreadCommentCreateInputV1Schema, AzureThreadReplyInputV1Schema, AzureThreadStatusInputV1Schema, AzureThreadStatusResultV1Schema } from './triage/mutations/contracts.js';
import { AZURE_DEVOPS_ACCOUNT_NETWORK_HOST_ACCESS_ID, AZURE_DEVOPS_TRIAGE_PURPOSE } from './triage/descriptor.js';

export const sources = TriageSourcesContributionProtocolV1;

export const READ_HOST_ACCESS = [
  AZURE_DEVOPS_ACCOUNT_NETWORK_HOST_ACCESS_ID,
  AZURE_DEVOPS_TRIAGE_PURPOSE,
];

export const INSTANCE_ACCOUNT_BINDINGS = [{
  path: 'instance.binding.account',
  purpose: AZURE_DEVOPS_TRIAGE_PURPOSE,
}];

const ACCOUNT_EXECUTION = { target: 'account', account: { artifactId: 'azure-devops-account-runtime', exportName: 'activate' } } as const;

const azureEntryReviewFields = [
  { path: 'routingToken', title: 'Repository' },
  { path: 'instance.locator.displayLabel', title: 'Source' },
  { path: 'localRef.entryId', title: 'Item' },
] as const;

export const AZURE_DEVOPS_ACCOUNT_ACTIONS = {
    [AZURE_DEVOPS_TRIAGE_ACTION_IDS.listInstances]: {
      title: 'Discover Azure DevOps organizations',
      description: 'Lists the Azure DevOps deployments each connected account can reach.',
      surfaces: sources.operations.listInstances.declaration.surfaces,
      placementBindings: [],
      dangerLevel: sources.operations.listInstances.declaration.dangerLevel,
      inputSchema: sources.operations.listInstances.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.listInstances.declaration.resultSchema.jsonSchema,
      hostAccess: [AZURE_DEVOPS_TRIAGE_PURPOSE],
      run: listAzureDevOpsInstancesAction,
      execution: ACCOUNT_EXECUTION,
    },
    [AZURE_DEVOPS_TRIAGE_ACTION_IDS.scan]: {
      title: 'Scan Azure DevOps pull requests',
      description: 'Reads one bounded page of the configured Azure DevOps pull-request walk.',
      surfaces: sources.operations.scan.declaration.surfaces,
      dangerLevel: sources.operations.scan.declaration.dangerLevel,
      inputSchema: TriageSourceConnectedAccountInputsV1.scan.jsonSchema,
      resultSchema: sources.operations.scan.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: scanAzureDevOpsSourceAction,
      execution: ACCOUNT_EXECUTION,
    },
    [AZURE_DEVOPS_TRIAGE_ACTION_IDS.get]: {
      title: 'Read an Azure DevOps pull request',
      description: 'Reads one pull request authoritatively through its configured deployment.',
      surfaces: sources.operations.get.declaration.surfaces,
      placementBindings: [],
      dangerLevel: sources.operations.get.declaration.dangerLevel,
      inputSchema: TriageSourceConnectedAccountInputsV1.get.jsonSchema,
      resultSchema: sources.operations.get.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: getAzureDevOpsSourceEntryAction,
      execution: ACCOUNT_EXECUTION,
    },
    [AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.readIterations]: {
      title: 'Read the Azure DevOps iterations of a pull request',
      description: 'Reads the pull request\u2019s iteration list once, and names the real'
        + ' current iteration the Files and Activity tabs both compare against.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: [],
      inputSchema: AzureIterationsInputV1Schema.jsonSchema,
      resultSchema: AzureIterationsResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: readAzureDevOpsIterations,
      execution: ACCOUNT_EXECUTION,
    },
    [AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.listCommits]: {
      title: 'Read an Azure DevOps commit page',
      description: 'Reads one bounded page of the commits of one pull request, positioned only'
        + ' by the continuation token Azure DevOps issued.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: [],
      inputSchema: AzureCommitsInputV1Schema.jsonSchema,
      resultSchema: AzureCommitsResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: listAzureDevOpsCommits,
      execution: ACCOUNT_EXECUTION,
    },
    [AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.listIterationChanges]: {
      title: 'Read an Azure DevOps iteration change page',
      description: 'Reads one bounded page of the files one pull-request iteration changes,'
        + ' advancing only through the skip and top Azure DevOps issued.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: [],
      inputSchema: AzureIterationChangesInputV1Schema.jsonSchema,
      resultSchema: AzureIterationChangesResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: listAzureDevOpsIterationChanges,
      execution: ACCOUNT_EXECUTION,
    },
    [AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.readPolicies]: {
      title: 'Read the Azure DevOps policies of a pull request',
      description: 'Reads the statuses and policy evaluations of one pull request, with'
        + ' enforcement taken only from a returned evaluation.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: [],
      inputSchema: AzurePoliciesInputV1Schema.jsonSchema,
      resultSchema: AzurePoliciesResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: readAzureDevOpsPolicies,
      execution: ACCOUNT_EXECUTION,
    },
    [AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.readThreads]: {
      title: 'Read the Azure DevOps threads of a pull request',
      description: 'Reads every review thread of one pull request in the one response the'
        + ' documented endpoint returns.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: [],
      inputSchema: AzureThreadsInputV1Schema.jsonSchema,
      resultSchema: AzureThreadsResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: readAzureDevOpsThreads,
      execution: ACCOUNT_EXECUTION,
    },
    [AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.complete]: {
      title: 'Complete an Azure DevOps pull request',
      description: 'Completes one active pull request with the branch decision the user chose,'
        + ' only while its merge source is still the commit they saw, and reports the polled'
        + ' terminal state rather than the accepted request.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'destructive',
      secretInputPaths: ['instance.configuration.token'],
      confirmation: {
        title: { key: 'plugins.azureDevops.actions.complete.confirm.title', fallback: 'Complete this pull request?' },
        body: {
          key: 'plugins.azureDevops.actions.complete.confirm.body',
          fallback: 'Completing is permanent in Azure DevOps. Work items are not transitioned and branch'
            + ' policy is not bypassed. The source branch is deleted only if you chose that, and'
            + ' completion runs against the merge source shown here — if new commits arrive first,'
            + ' nothing is completed and you are asked again.',
        },
        confirmLabel: { key: 'plugins.azureDevops.actions.complete.confirm.label', fallback: 'Complete' },
        inputFields: [
          ...azureEntryReviewFields,
          { path: 'observedSourceCommitId', title: 'Reviewed source commit' },
          { path: 'deleteSourceBranch', title: 'Delete source branch' },
        ],
      },
      inputSchema: AzureCompleteInputV1Schema.jsonSchema,
      resultSchema: AzureMutationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: completeAzureDevOpsPullRequest,
      execution: ACCOUNT_EXECUTION,
    },
    [AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.abandon]: {
      title: 'Abandon an Azure DevOps pull request',
      description: 'Abandons one active pull request. Azure can reactivate an abandoned pull'
        + ' request later.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      secretInputPaths: ['instance.configuration.token'],
      confirmation: {
        title: { key: 'plugins.azureDevops.actions.abandon.confirm.title', fallback: 'Abandon this pull request?' },
        body: {
          key: 'plugins.azureDevops.actions.abandon.confirm.body',
          fallback: 'The pull request stops being active and its reviewers stop being asked. Azure can'
            + ' reactivate it later, so this is not permanent.',
        },
        confirmLabel: { key: 'plugins.azureDevops.actions.abandon.confirm.label', fallback: 'Abandon' },
        inputFields: [
          ...azureEntryReviewFields,
        ],
      },
      inputSchema: AzureAbandonInputV1Schema.jsonSchema,
      resultSchema: AzureMutationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: abandonAzureDevOpsPullRequest,
      execution: ACCOUNT_EXECUTION,
    },
    [AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.reactivate]: {
      title: 'Reactivate an Azure DevOps pull request',
      description: 'Reactivates one abandoned pull request, which is Azure’s reopen. A'
        + ' completed pull request is refused rather than reactivated.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      secretInputPaths: ['instance.configuration.token'],
      confirmation: {
        title: { key: 'plugins.azureDevops.actions.reactivate.confirm.title', fallback: 'Reactivate this pull request?' },
        body: {
          key: 'plugins.azureDevops.actions.reactivate.confirm.body',
          fallback: 'The pull request becomes active again and its reviewers are asked to look at it'
            + ' again. You can abandon it once more afterwards.',
        },
        confirmLabel: { key: 'plugins.azureDevops.actions.reactivate.confirm.label', fallback: 'Reactivate' },
        inputFields: [
          ...azureEntryReviewFields,
        ],
      },
      inputSchema: AzureReactivateInputV1Schema.jsonSchema,
      resultSchema: AzureMutationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: reactivateAzureDevOpsPullRequest,
      execution: ACCOUNT_EXECUTION,
    },
    [AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.requestReview]: {
      title: 'Request review on an Azure DevOps pull request',
      description: 'Adds the selected identities as reviewers of one active pull request through'
        + ' one additive request, leaving every existing reviewer and vote untouched.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      secretInputPaths: ['instance.configuration.token'],
      confirmation: {
        title: { key: 'plugins.azureDevops.actions.requestReview.confirm.title', fallback: 'Request review from these people?' },
        body: {
          key: 'plugins.azureDevops.actions.requestReview.confirm.body',
          fallback: 'They are added as reviewers and notified. Nobody currently reviewing is removed and'
            + ' no existing vote is changed.',
        },
        confirmLabel: { key: 'plugins.azureDevops.actions.requestReview.confirm.label', fallback: 'Request review' },
        inputFields: [
          ...azureEntryReviewFields,
          { path: 'observedSourceCommitId', title: 'Reviewed source commit' },
          { path: 'reviewerIds', title: 'Reviewers' },
        ],
      },
      inputSchema: AzureRequestReviewInputV1Schema.jsonSchema,
      resultSchema: AzureMutationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: requestAzureDevOpsPullRequestReview,
      execution: ACCOUNT_EXECUTION,
    },
    [AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.threadStatus]: {
      title: 'Set the status of an Azure DevOps review thread',
      description: 'Sets one review thread’s status and confirms it from the thread itself.'
        + ' The conversation in the thread is never rewritten.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      secretInputPaths: ['instance.configuration.token'],
      confirmation: {
        title: { key: 'plugins.azureDevops.actions.threadStatus.confirm.title', fallback: 'Change this thread’s status?' },
        body: {
          key: 'plugins.azureDevops.actions.threadStatus.confirm.body',
          fallback: 'Everyone on the pull request sees the new status. Nothing in the conversation is'
            + ' changed, and you can set the status again afterwards.',
        },
        confirmLabel: { key: 'plugins.azureDevops.actions.threadStatus.confirm.label', fallback: 'Set status' },
        inputFields: [
          ...azureEntryReviewFields,
          { path: 'threadId', title: 'Thread' },
          { path: 'status', title: 'Status' },
        ],
      },
      inputSchema: AzureThreadStatusInputV1Schema.jsonSchema,
      resultSchema: AzureThreadStatusResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: setAzureDevOpsPullRequestThreadStatus,
      execution: ACCOUNT_EXECUTION,
    },
    [AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.submitReview]: {
      title: 'Submit an Azure DevOps pull request review',
      description: 'Publishes the selected canonical review comments in order and submits the'
        + ' viewer verdict last, only while the exact base and head remain current.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'externalSideEffect',
      secretInputPaths: ['instance.configuration.token'],
      confirmation: {
        title: { key: 'plugins.azureDevops.actions.submitReview.confirm.title', fallback: 'Submit this review?' },
        body: { key: 'plugins.azureDevops.actions.submitReview.confirm.body', fallback: 'Selected comments are published in order, then the verdict is submitted. If the pull request comparison moved, nothing is written.' },
        confirmLabel: { key: 'plugins.azureDevops.actions.submitReview.confirm.label', fallback: 'Submit review' },
        inputFields: [
          ...azureEntryReviewFields,
          { path: 'publicationPlan.headRevision', title: 'Reviewed head' },
          { path: 'publicationPlan.entries.[].body', title: 'Comments' },
          { path: 'publicationPlan.verdict.kind', title: 'Verdict' },
          { path: 'publicationPlan.verdict.body', title: 'Review summary' },
        ],
      },
      inputSchema: AzureSubmitReviewInputV1Schema.jsonSchema,
      resultSchema: AzureReviewPublicationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: submitAzureDevOpsPullRequestReview,
      execution: ACCOUNT_EXECUTION,
    },
    [AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.threadCommentCreate]: {
      title: 'Publish an Azure DevOps pull request review comment',
      description: 'Publishes one canonical Happier proposal as a new review thread at its exact'
        + ' preflighted Azure DevOps anchor.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'externalSideEffect',
      secretInputPaths: ['instance.configuration.token'],
      confirmation: {
        title: { key: 'plugins.azureDevops.actions.threadCommentCreate.confirm.title', fallback: 'Publish this review comment?' },
        body: { key: 'plugins.azureDevops.actions.threadCommentCreate.confirm.body', fallback: 'This comment becomes visible as a new Azure DevOps review thread at the comparison you reviewed.' },
        confirmLabel: { key: 'plugins.azureDevops.actions.threadCommentCreate.confirm.label', fallback: 'Publish comment' },
        inputFields: [
          ...azureEntryReviewFields,
          { path: 'publicationPlan.headRevision', title: 'Reviewed head' },
          { path: 'publicationPlan.entries.[].body', title: 'Comments' },
        ],
      },
      inputSchema: AzureThreadCommentCreateInputV1Schema.jsonSchema,
      resultSchema: AzureReviewPublicationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: createAzureDevOpsPullRequestThreadComment,
      execution: ACCOUNT_EXECUTION,
    },
    [AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.threadReply]: {
      title: 'Reply to an Azure DevOps pull request review thread',
      description: 'Publishes one canonical Happier proposal as a reply to the exact Azure DevOps'
        + ' thread and parent comment selected by the reader.',
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      secretInputPaths: ['instance.configuration.token'],
      confirmation: {
        title: { key: 'plugins.azureDevops.actions.threadReply.confirm.title', fallback: 'Post this thread reply?' },
        body: { key: 'plugins.azureDevops.actions.threadReply.confirm.body', fallback: 'This reply becomes visible in the selected Azure DevOps review conversation.' },
        confirmLabel: { key: 'plugins.azureDevops.actions.threadReply.confirm.label', fallback: 'Post reply' },
        inputFields: [
          ...azureEntryReviewFields,
          { path: 'publicationPlan.headRevision', title: 'Reviewed head' },
          { path: 'publicationPlan.entries.[].body', title: 'Comments' },
          { path: 'threadId', title: 'Thread' },
          { path: 'parentCommentId', title: 'Parent comment' },
        ],
      },
      inputSchema: AzureThreadReplyInputV1Schema.jsonSchema,
      resultSchema: AzureReviewPublicationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: replyAzureDevOpsPullRequestThread,
      execution: ACCOUNT_EXECUTION,
    }
} as const;
