import { GITLAB_ACCOUNT_EXECUTION, GITLAB_TRIAGE_ACTION_DECLARATIONS, GITLAB_TRIAGE_ACTION_IDS, GITLAB_TRIAGE_DETAIL_ACTION_DECLARATIONS, GITLAB_TRIAGE_DETAIL_ACTION_IDS, GITLAB_TRIAGE_MUTATION_ACTION_DECLARATIONS, GITLAB_TRIAGE_MUTATION_ACTION_IDS } from './triage/contribution.js';
import { listGitlabScopeUnitsAction } from './triage/sourceScopeUnits.js';
import { listGitlabActivityEvents, listGitlabChanges, listGitlabDiscussions, listGitlabNotes, listGitlabPipelines, readGitlabRawDiff, readGitlabApprovals, readGitlabOverview, readGitlabPullRequestStatus } from './triage/detailOperations.js';
import { getGitlabSourceEntryAction, listGitlabInstancesAction, scanGitlabSourceAction } from './triage/operations.js';
import { assignGitlabIssue, changeGitlabIssueLabels, changeGitlabMergeRequestReviewers, closeGitlabIssue, closeGitlabMergeRequest, markGitlabMergeRequestReady, mergeGitlabMergeRequest, publishGitlabIssueComment, publishGitlabMergeRequestReview, publishGitlabMergeRequestReviewComment, publishGitlabMergeRequestThreadReply, reopenGitlabIssue, reopenGitlabMergeRequest, resolveGitlabMergeRequestDiscussion } from './triage/mutations/operations.js';

export const GITLAB_ACTION_DECLARATIONS = [
  ...GITLAB_TRIAGE_ACTION_DECLARATIONS,
  ...GITLAB_TRIAGE_DETAIL_ACTION_DECLARATIONS,
  ...GITLAB_TRIAGE_MUTATION_ACTION_DECLARATIONS,
];

export function readGitlabActionDeclaration(id: string) {
  const declaration = GITLAB_ACTION_DECLARATIONS.find((candidate) => candidate.id === id);
  if (declaration === undefined) {
    throw new TypeError(`gitlab_action_declaration_missing:${id}`);
  }
  return declaration;
}

/** The full declaration catalog also contains native workspace roles. */
function readGitlabAccountActionDeclaration(id:
  | Exclude<typeof GITLAB_TRIAGE_ACTION_IDS[keyof typeof GITLAB_TRIAGE_ACTION_IDS],
    typeof GITLAB_TRIAGE_ACTION_IDS.prepareReviewWorkspace | typeof GITLAB_TRIAGE_ACTION_IDS.verifyReviewWorkspace>
  | typeof GITLAB_TRIAGE_DETAIL_ACTION_IDS[keyof typeof GITLAB_TRIAGE_DETAIL_ACTION_IDS]
  | typeof GITLAB_TRIAGE_MUTATION_ACTION_IDS[keyof typeof GITLAB_TRIAGE_MUTATION_ACTION_IDS]
): Omit<ReturnType<typeof readGitlabActionDeclaration>, 'operation' | 'execution'> & Readonly<{
  execution: typeof GITLAB_ACCOUNT_EXECUTION;
}> {
  return { ...readGitlabActionDeclaration(id), execution: GITLAB_ACCOUNT_EXECUTION };
}

export const GITLAB_ACCOUNT_ACTIONS = {
    [GITLAB_TRIAGE_ACTION_IDS.listScopeUnits]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_ACTION_IDS.listScopeUnits),
      run: listGitlabScopeUnitsAction,
    },
    [GITLAB_TRIAGE_ACTION_IDS.listInstances]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_ACTION_IDS.listInstances),
      run: listGitlabInstancesAction,
    },
    [GITLAB_TRIAGE_ACTION_IDS.scan]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_ACTION_IDS.scan),
      run: scanGitlabSourceAction,
    },
    [GITLAB_TRIAGE_ACTION_IDS.get]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_ACTION_IDS.get),
      run: getGitlabSourceEntryAction,
    },
    [GITLAB_TRIAGE_ACTION_IDS.readPullRequestStatus]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_ACTION_IDS.readPullRequestStatus),
      run: readGitlabPullRequestStatus,
    },
    [GITLAB_TRIAGE_DETAIL_ACTION_IDS.listNotes]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_DETAIL_ACTION_IDS.listNotes),
      run: listGitlabNotes,
    },
    [GITLAB_TRIAGE_DETAIL_ACTION_IDS.readOverview]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_DETAIL_ACTION_IDS.readOverview),
      run: readGitlabOverview,
    },
    [GITLAB_TRIAGE_DETAIL_ACTION_IDS.listActivityEvents]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_DETAIL_ACTION_IDS.listActivityEvents),
      run: listGitlabActivityEvents,
    },
    [GITLAB_TRIAGE_DETAIL_ACTION_IDS.listDiscussions]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_DETAIL_ACTION_IDS.listDiscussions),
      run: listGitlabDiscussions,
    },
    [GITLAB_TRIAGE_DETAIL_ACTION_IDS.readApprovals]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_DETAIL_ACTION_IDS.readApprovals),
      run: readGitlabApprovals,
    },
    [GITLAB_TRIAGE_DETAIL_ACTION_IDS.listPipelines]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_DETAIL_ACTION_IDS.listPipelines),
      run: listGitlabPipelines,
    },
    [GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges),
      run: listGitlabChanges,
    },
    [GITLAB_TRIAGE_DETAIL_ACTION_IDS.readRawDiff]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_DETAIL_ACTION_IDS.readRawDiff),
      run: readGitlabRawDiff,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMerge]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMerge),
      run: mergeGitlabMergeRequest,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMarkReady]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMarkReady),
      run: markGitlabMergeRequestReady,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestClose]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestClose),
      run: closeGitlabMergeRequest,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReopen]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReopen),
      run: reopenGitlabMergeRequest,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueClose]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueClose),
      run: closeGitlabIssue,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueReopen]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueReopen),
      run: reopenGitlabIssue,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReviewerChange]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReviewerChange),
      run: changeGitlabMergeRequestReviewers,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestDiscussionResolution]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestDiscussionResolution),
      run: resolveGitlabMergeRequestDiscussion,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueAssign]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueAssign),
      run: assignGitlabIssue,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueLabel]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueLabel),
      run: changeGitlabIssueLabels,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestSubmitReview]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestSubmitReview),
      run: publishGitlabMergeRequestReview,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReviewCommentCreate]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReviewCommentCreate),
      run: publishGitlabMergeRequestReviewComment,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestThreadReply]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestThreadReply),
      run: publishGitlabMergeRequestThreadReply,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueComment]: {
      ...readGitlabAccountActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueComment),
      run: publishGitlabIssueComment,
    }
} as const;
