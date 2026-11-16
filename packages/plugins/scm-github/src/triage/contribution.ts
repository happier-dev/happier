import { githubDetailTabDeclaration } from '../ui/detail/tabDeclarations.js';
import { LOCAL_ACT_ACTION_IDS } from '../actions/local/contracts.js';
import {
  TriageSourceDescriptorV1Schema,
  type TriageSourceDescriptorV1,
} from '@happier-dev/triage-protocol/v1';

import { GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../observations/githubProviderContracts.js';

import { GITHUB_TRIAGE_KIND_IDS_V1, type GithubTriageKindIdV1 } from './types.js';

/**
 * The GitHub Triage source declaration.
 *
 * `kindId` is source-local and named in GitHub's own vocabulary: `pull-request`
 * and `issue`. It is never flattened into another forge's spelling, and the
 * schema-legal spelling is the hyphenated one — `pullRequest` is illegal under
 * `PluginContributionLocalIdSchema`.
 */

/** The contribution's local id inside `contributesTo['happier.triage'].sources`. */
export const GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 = 'github-forge';

/** The Action ids the contribution's operation roles bind to. */
export const GITHUB_TRIAGE_ACTION_IDS_V1 = Object.freeze({
  readAttention: 'triage/read-github-attention',
  create: 'github/issue/create',
  edit: 'github/issue/edit',
  transition: 'github/issue/transition',
  listInstances: 'triage/list-github-instances',
  listScopeUnits: 'triage/list-github-scope-units',
  listCreationPlaces: 'triage/list-github-creation-places',
  scan: 'triage/scan-github',
  get: 'triage/get-github-entry',
  resolveResource: 'triage/resolve-github-resource',
  linkSession: 'triage/link-github-session',
  readSessionLinks: 'triage/read-github-session-links',
  readPullRequestStatus: 'triage/read-github-pull-request-status',
  readFixPullRequests: 'triage/read-github-fix-pull-requests',
  prepareReviewWorkspace: 'triage/prepare-github-review-workspace',
  verifyReviewWorkspace: 'triage/verify-github-review-workspace',
});

/**
 * The source-native detail Action ids.
 *
 * They bind to no Triage operation role. A mounted Plugin UI surface holds
 * `PluginUiHostApi`, which has no storage member and no transport of its own, so
 * an Action is the ONLY way this source's detail body can reach GitHub at all.
 * They are declared separately from the role-bound Actions above precisely because
 * they are not roles: the aggregate never invokes them. UI and agent callers
 * reach the same configured-entry admission through these native Actions.
 */
export const GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 = Object.freeze({
  readIssueFacts: 'triage/read-github-issue-facts',
  readCapabilities: 'triage/read-github-capabilities',
  readOverview: 'triage/read-github-overview',
  readPreview: 'github/pull-request/preview',
  listTimeline: 'triage/list-github-timeline',
  listChangedFiles: 'triage/list-github-changed-files',
  readFeedback: 'triage/read-github-feedback',
  readChecks: 'triage/read-github-checks',
});

/**
 * The GitHub pull-request mutation Action ids, spelled exactly as SCM.md 3.8
 * names them.
 *
 * Create, edit and transition are source roles declared above; both native
 * callers and role callers execute those same Actions. These writes have no role.
 * They are declared separately from every read above because they are a
 * different kind of thing: each is ONE exact externally visible write with its
 * own strict input and its own confirmation presentation. UI and agent callers
 * use the shared host approval policy, which requires approval by default.
 * There is no generic `mutate({ operation, payload })` Action here.
 *
 * The two reviewer ids are a pair of exact DELTAS and never one "set reviewers"
 * id with a direction field. A single id would put the direction in the payload,
 * where the manifest cannot classify it, cannot confirm withdrawal differently
 * from a summons, and cannot state which of the two a user is about to do.
 *
 * The Reviews-owned dispatch claim is now the one barrier consumed by all four
 * publication Actions; none owns a source-local lease, receipt or correlation.
 */
export const GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 = Object.freeze({
  pullRequestPreviewStatus: 'github/pull-request/preview-status',
  closingReferenceAdd: 'github/issue/closing-reference-add',
  closingReferenceRemove: 'github/issue/closing-reference-remove',
  subIssueAdd: 'github/issue/sub-issue-add',
  subIssueRemove: 'github/issue/sub-issue-remove',
  subIssueReprioritize: 'github/issue/sub-issue-reprioritize',
  blockedByAdd: 'github/issue/blocked-by-add',
  blockedByRemove: 'github/issue/blocked-by-remove',
  blockingAdd: 'github/issue/blocking-add',
  blockingRemove: 'github/issue/blocking-remove',
  projectItemAdd: 'github/project/item-add',
  projectItemRemove: 'github/project/item-remove',
  projectFieldSet: 'github/project/field-set',
  projectFieldClear: 'github/project/field-clear',
  pullRequestEdit: 'github/pull-request/edit',
  pullRequestChangeBase: 'github/pull-request/change-base',
  pullRequestConvertToDraft: 'github/pull-request/convert-to-draft',
  entryMilestoneSet: 'github/entry/milestone-set',
  issueTypeSet: 'github/issue/type-set',
  entryLock: 'github/entry/lock',
  entryUnlock: 'github/entry/unlock',
  pendingReviewCreate: 'github/pull-request/pending-review-create',
  pendingReviewSubmit: 'github/pull-request/pending-review-submit',
  pendingReviewDelete: 'github/pull-request/pending-review-delete',
  reviewDismiss: 'github/pull-request/review-dismiss',
  issueTransfer: 'github/issue/transfer',
  issueDelete: 'github/issue/delete',
  issuePin: 'github/issue/pin',
  issueUnpin: 'github/issue/unpin',
  entrySubscribe: 'github/entry/subscribe',
  entryUnsubscribe: 'github/entry/unsubscribe',
  pullRequestRevert: 'github/pull-request/revert',
  pullRequestHeadBranchRestore: 'github/pull-request/head-branch-restore',
  pullRequestHeadBranchDelete: 'github/pull-request/head-branch-delete',
  pullRequestMerge: 'github/pull-request/merge',
  pullRequestEnqueue: 'github/pull-request/enqueue',
  pullRequestDequeue: 'github/pull-request/dequeue',
  pullRequestAutoMergeSet: 'github/pull-request/auto-merge-set',
  pullRequestSubmitReview: 'github/pull-request/submit-review',
  pullRequestReviewCommentCreate: 'github/pull-request/review-comment-create',
  pullRequestThreadReply: 'github/pull-request/thread-reply',
  pullRequestClose: 'github/pull-request/close',
  pullRequestReopen: 'github/pull-request/reopen',
  pullRequestMarkReady: 'github/pull-request/mark-ready',
  pullRequestUpdateBranch: 'github/pull-request/update-branch',
  pullRequestAddReviewers: 'github/pull-request/add-reviewers',
  pullRequestRemoveReviewers: 'github/pull-request/remove-reviewers',
  pullRequestThreadResolution: 'github/pull-request/thread-resolution',
  issueClose: 'github/issue/close',
  issueReopen: 'github/issue/reopen',
  issueComment: 'github/issue/comment',
  issueAssigneeAdd: 'github/issue/assignee-add',
  issueAssigneeRemove: 'github/issue/assignee-remove',
  issueLabelAdd: 'github/issue/label-add',
  issueLabelRemove: 'github/issue/label-remove',
  commentEdit: 'github/comment/edit',
  commentCreate: 'github/comment/create',
});

/**
 * The same-plugin renderer bound to the required source-owned detail role, and the UI
 * artifact it mounts.
 *
 * These are two different identities: `renderers[].id` is what the contribution's
 * `surfaces.detail` binds, while `renderers[].artifact` names the package's exact
 * `./happier-plugin-ui/<artifactId>` export, which the SDK UI build resolves.
 */
export const GITHUB_TRIAGE_DETAIL_RENDERER_ID_V1 = 'github-detail';
export const GITHUB_TRIAGE_DETAIL_ARTIFACT_ID_V1 = 'github-detail-native';

/**
 * The source-owned Settings page a person uses to put GitHub into PRs & Issues,
 * and the artifact that mounts it.
 *
 * It is a plain Settings contribution rather than anything Triage-specific: the
 * generic Settings catalog owns the group, route and availability decision, and
 * this source supplies one page and one renderer. The page is the only
 * production caller of the target-owned `happier.triage/sources/administer-v1`
 * Action for this source, and without it every configured-instance path in this
 * package is unreachable from the product.
 */
export const GITHUB_TRIAGE_SETTINGS_GROUP_ID_V1 = 'github-triage';
export const GITHUB_TRIAGE_SETTINGS_PAGE_ID_V1 = 'triage-sources';
export const GITHUB_TRIAGE_SETTINGS_RENDERER_ID_V1 = 'github-triage-sources';
export const GITHUB_TRIAGE_SETTINGS_ARTIFACT_ID_V1 = 'github-triage-sources-native';

/** The one declared kind vocabulary; every emitted local ref is validated against it. */
export { GITHUB_TRIAGE_KIND_IDS_V1 } from './types.js';

/**
 * Parsed through the published descriptor schema at module load, so a descriptor that
 * drifts from the contract fails at import rather than at host admission.
 */
export const GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1: TriageSourceDescriptorV1 =
  TriageSourceDescriptorV1Schema.parse({
  v: 1,
  // The declared Connected Account purpose is the source's only account authority
  // vocabulary: discovery, reauthorization and materialization all use this exact
  // string, and a candidate binding that named another purpose would be rejected.
  purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  sessionRelations: { kindIds: ['pull-request'] },
  // The page this source's own Settings contribution ships, so the PRs & Issues
  // surface can offer a working Configure action instead of naming Settings and
  // leaving the reader to find it. A BARE local id: the target qualifies it with
  // the contributor identity the host already admitted, so a descriptor can never
  // name another plugin's page.
  settingsPageId: GITHUB_TRIAGE_SETTINGS_PAGE_ID_V1,
  pullRequestLocalFormActionId: LOCAL_ACT_ACTION_IDS.form,
  displayName: 'GitHub',
  scopeUnit: { singularLabel: 'Repository', pluralLabel: 'Repositories' },
  kinds: Object.freeze([
    Object.freeze({
      id: 'pull-request',
      workflowSubject: 'pullRequest',
      displayName: 'Pull request',
      pluralDisplayName: 'Pull requests',
      // r0.42: the Triage detail frame draws these tabs and asks this source
      // for each as a panel; the writes render as the header `actions` panel.
      detailTabs: Object.freeze([
        Object.freeze({ kind: 'shared', id: 'overview', scrollOwner: githubDetailTabDeclaration('overview').scrollOwner }),
        Object.freeze({ kind: 'shared', id: 'activity', scrollOwner: githubDetailTabDeclaration('timeline').scrollOwner }),
        Object.freeze({ kind: 'shared', id: 'files', scrollOwner: githubDetailTabDeclaration('files').scrollOwner, summaryFact: 'github/changed-files' }),
        // The row's own checks rollup ("2 failing") is the Checks tab's summary.
        Object.freeze({ kind: 'shared', id: 'checks', scrollOwner: githubDetailTabDeclaration('checks').scrollOwner, summaryFact: 'github/checks' }),
      ]),
      detailActions: true,
    }),
    Object.freeze({
      id: 'issue',
      workflowSubject: 'issue',
      displayName: 'Issue',
      pluralDisplayName: 'Issues',
      task: true,
      taskCapabilities: {
        completedScan: true,
        createFields: ['title', 'body', 'assigneeIds', 'labelIds', 'scopeId'],
        editFields: ['title', 'body', 'assigneeIds', 'labelIds'],
        fieldChoices: true,
        transitions: [
          { id: 'open', label: 'Open', state: { presentation: 'active', nativeLabel: 'Open' } },
          { id: 'completed', label: 'Completed', state: { presentation: 'resolved', completionReason: 'completed', nativeLabel: 'Closed as completed' } },
          { id: 'not_planned', label: 'Not planned', state: { presentation: 'closed', completionReason: 'canceled', nativeLabel: 'Closed as not planned' } },
        ],
      },
      // An issue has no changes of its own: Triage sources its Files and
      // Checks from the linked fix PR.
      detailTabs: Object.freeze([
        Object.freeze({ kind: 'shared', id: 'overview', scrollOwner: githubDetailTabDeclaration('overview').scrollOwner }),
        Object.freeze({ kind: 'shared', id: 'activity', scrollOwner: githubDetailTabDeclaration('timeline').scrollOwner }),
      ]),
      detailActions: true,
    }),
    { id: 'dependabot-alert', workflowSubject: 'errorIssue', glyph: 'shield', displayName: 'Dependabot alert',
      pluralDisplayName: 'Dependabot alerts', detailTabs: [{ kind: 'shared', id: 'overview', scrollOwner: githubDetailTabDeclaration('overview').scrollOwner }], detailActions: true },
    { id: 'code-scanning-alert', workflowSubject: 'errorIssue', glyph: 'shield', displayName: 'Code scanning alert',
      pluralDisplayName: 'Code scanning alerts', detailTabs: [{ kind: 'shared', id: 'overview', scrollOwner: githubDetailTabDeclaration('overview').scrollOwner },
        { kind: 'source', id: 'locations', scrollOwner: githubDetailTabDeclaration('locations').scrollOwner, title: 'Locations' }], detailActions: true },
  ]),
  });

/** Narrows an inbound public local-ref kind to this source's declared vocabulary. */
export function readGithubTriageKindId(value: unknown): GithubTriageKindIdV1 | null {
  return GITHUB_TRIAGE_KIND_IDS_V1.find((kindId) => kindId === value) ?? null;
}
