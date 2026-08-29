/**
 * The one Triage boundary for this provider.
 *
 * Everything the aggregate ever learns about GitLab crosses here: the declared
 * source descriptor, the three read operations bound to this plugin's own
 * Actions, and the source-owned detail surface. Nothing below this file imports
 * a Triage schema, and nothing above it sees a GitLab route, lane id, or native
 * item shape.
 *
 * The Action input/result JSON Schemas are read from the published protocol
 * declarations rather than restated. A hand-copied schema is the split brain
 * this vertical exists to avoid: the manifest would then claim a contract the
 * package no longer publishes, and the host would admit it.
 */

import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import type { PluginActionInvocationSurfaceV2 } from '@happier-dev/plugin-sdk/actions';
import {
  TriageSourceDescriptorV1Schema,
  TriageSourcesContributionProtocolV1,
  type TriageSourceDescriptorV1,
} from '@happier-dev/triage-protocol/v1';

import {
  GitlabIssueCloseInputV1Schema,
  GitlabIssueCloseResultV1Schema,
  GitlabIssueAssignInputV1Schema,
  GitlabIssueAssignResultV1Schema,
  GitlabIssueLabelInputV1Schema,
  GitlabIssueLabelResultV1Schema,
  GitlabIssueCommentInputV1Schema,
  GitlabIssueReopenInputV1Schema,
  GitlabIssueReopenResultV1Schema,
  GitlabMergeRequestCloseInputV1Schema,
  GitlabMergeRequestCloseResultV1Schema,
  GitlabMergeRequestMarkReadyInputV1Schema,
  GitlabMergeRequestMarkReadyResultV1Schema,
  GitlabMergeRequestMergeInputV1Schema,
  GitlabMergeRequestMergeResultV1Schema,
  GitlabMergeRequestReopenInputV1Schema,
  GitlabMergeRequestReopenResultV1Schema,
  GitlabMergeRequestReviewerChangeInputV1Schema,
  GitlabMergeRequestReviewerChangeResultV1Schema,
  GitlabMergeRequestDiscussionResolutionInputV1Schema,
  GitlabMergeRequestDiscussionResolutionResultV1Schema,
  GitlabMergeRequestReviewCommentCreateInputV1Schema,
  GitlabMergeRequestReviewPublicationInputV1Schema,
  GitlabMergeRequestThreadReplyInputV1Schema,
  GitlabReviewPublicationResultV1Schema,
} from './mutations/contracts.js';
import {
  GitlabActivityEventsInputV1Schema,
  GitlabActivityEventsResultV1Schema,
  GitlabApprovalsInputV1Schema,
  GitlabApprovalsResultV1Schema,
  GitlabChangesInputV1Schema,
  GitlabChangesResultV1Schema,
  GitlabDiscussionsInputV1Schema,
  GitlabDiscussionsResultV1Schema,
  GitlabNotesInputV1Schema,
  GitlabNotesResultV1Schema,
  GitlabPipelinesInputV1Schema,
  GitlabPipelinesResultV1Schema,
  GitlabRawDiffInputV1Schema,
  GitlabRawDiffResultV1Schema,
} from './detail/contracts.js';
import type { GitlabKindId } from './types.js';

/** The Connected Account descriptor this source authorizes against. */
export const GITLAB_CONNECTED_ACCOUNT_ID = 'gitlab-account';
/** The declared host-access purpose used to list and materialize that account. */
export const GITLAB_CONNECTED_ACCOUNT_PURPOSE = 'gitlab-connected-account';
/** Public GitLab.com stays public-only; configured self-hosted origins may be private. */
export const GITLAB_CLOUD_NETWORK_HOST_ACCESS_ID = 'gitlab-cloud-api';
export const GITLAB_ACCOUNT_NETWORK_HOST_ACCESS_ID = 'gitlab-account-api';
export const GITLAB_NETWORK_HOST_ACCESS_IDS = Object.freeze([
  GITLAB_CLOUD_NETWORK_HOST_ACCESS_ID,
  GITLAB_ACCOUNT_NETWORK_HOST_ACCESS_ID,
]);

/** `pullRequest` is schema-illegal as a local id; `merge-request` is GitLab's word anyway. */
export const GITLAB_TRIAGE_CONTRIBUTION_LOCAL_ID = 'gitlab-forge';

export const GITLAB_TRIAGE_ACTION_IDS = Object.freeze({
  listInstances: 'triage/list-gitlab-instances',
  scan: 'triage/scan-gitlab',
  get: 'triage/get-gitlab-entry',
  prepareReviewWorkspace: 'triage/prepare-gitlab-review-workspace',
  verifyReviewWorkspace: 'triage/verify-gitlab-review-workspace',
});

/**
 * The source-native detail planes.
 *
 * They carry no Triage role: a note, a resource event, a discussion, an approval
 * state, a pipeline and a changed file are GitLab-native content this source's
 * own mounted detail body reads. Their published surface is `ui`: the mounted
 * dispatcher supplies present-user authority, while direct plugin/backend code
 * is refused because the declarations omit `plugin`.
 */
export const GITLAB_TRIAGE_DETAIL_ACTION_IDS = Object.freeze({
  listNotes: 'triage/list-gitlab-notes',
  listActivityEvents: 'triage/list-gitlab-activity-events',
  listDiscussions: 'triage/list-gitlab-discussions',
  readApprovals: 'triage/read-gitlab-approvals',
  listPipelines: 'triage/list-gitlab-pipelines',
  listChanges: 'triage/list-gitlab-changes',
  readRawDiff: 'triage/read-gitlab-raw-diff',
});

/**
 * The exact GitLab mutation Actions.
 *
 * `sources/SCM.md` §3.8: every externally visible write is its own named Action.
 * There is no generic `mutate({ operation, payload })` and there will not be
 * one, so each id below names one effect a person asked for and the host admits
 * exactly that.
 *
 * The ids are the contract's own spelling rather than this package's
 * `triage/…` read prefix, because a write is not a Triage role: `scan` and `get`
 * implement a shared operation the aggregate binds, while these are GitLab's own
 * verbs invoked from GitLab's own detail surface.
 *
 * `gitlab/issue/{close,reopen}` are the first writes this source declares for a
 * kind other than `merge-request`, and they are separate ids rather than a kind
 * parameter on the merge-request pair for the reason §4.7 states: an issue and a
 * merge request can share a project and an IID, so one id addressing both would
 * be one Action that can transition either of two different items.
 */
export const GITLAB_TRIAGE_MUTATION_ACTION_IDS = Object.freeze({
  mergeRequestMerge: 'gitlab/merge-request/merge',
  mergeRequestMarkReady: 'gitlab/merge-request/mark-ready',
  mergeRequestClose: 'gitlab/merge-request/close',
  mergeRequestReopen: 'gitlab/merge-request/reopen',
  mergeRequestReviewerChange: 'gitlab/merge-request/reviewer-change',
  mergeRequestDiscussionResolution: 'gitlab/merge-request/discussion-resolution',
  issueClose: 'gitlab/issue/close',
  issueReopen: 'gitlab/issue/reopen',
  issueAssign: 'gitlab/issue/assign',
  issueLabel: 'gitlab/issue/label',
  mergeRequestSubmitReview: 'gitlab/merge-request/submit-review',
  mergeRequestReviewCommentCreate: 'gitlab/merge-request/review-comment-create',
  mergeRequestThreadReply: 'gitlab/merge-request/thread-reply',
  issueComment: 'gitlab/issue/comment',
});

/**
 * The same-plugin renderer bound to the required source-owned detail role, and
 * the UI artifact it mounts. The GitLab detail body itself — the merge-request
 * and issue tab verticals of `SCM.md` §4.6 — is its own unit and produces that
 * artifact; the binding is declared here because the role is required and its
 * identity must not move once sources are admitted.
 */
export const GITLAB_TRIAGE_DETAIL_RENDERER_ID = 'gitlab-detail';
export const GITLAB_TRIAGE_DETAIL_ARTIFACT_ID = 'gitlab-detail-native';

/** This plugin's own id, named once so the mounted surface and the manifest agree. */
export const GITLAB_PLUGIN_ID = 'happier.scm.forge.gitlab';

/**
 * The source-owned Settings page a person uses to put GitLab into PRs & Issues,
 * and the artifact that mounts it.
 *
 * It is a plain Settings contribution: the generic Settings catalog owns the
 * group, route and availability decision, and this source supplies one page and
 * one renderer. The page is the only production caller of the target-owned
 * `happier.triage/sources/administer-v1` Action for this source, and without it
 * every configured-instance path in this package is unreachable from the
 * product.
 */
export const GITLAB_TRIAGE_SETTINGS_GROUP_ID = 'gitlab-triage';
export const GITLAB_TRIAGE_SETTINGS_PAGE_ID = 'triage-sources';
export const GITLAB_TRIAGE_SETTINGS_RENDERER_ID = 'gitlab-triage-sources';
export const GITLAB_TRIAGE_SETTINGS_ARTIFACT_ID = 'gitlab-triage-sources-native';

const KIND_DISPLAY: Readonly<Record<GitlabKindId, Readonly<{
  workflowSubject: 'pullRequest' | 'issue';
  displayName: string;
  pluralDisplayName: string;
}>>> = Object.freeze({
  'merge-request': Object.freeze({
    workflowSubject: 'pullRequest',
    displayName: 'Merge request',
    pluralDisplayName: 'Merge requests',
  }),
  issue: Object.freeze({
    workflowSubject: 'issue',
    displayName: 'Issue',
    pluralDisplayName: 'Issues',
  }),
});

/**
 * Parsed through the published descriptor schema at module load, so a descriptor
 * that drifts from the contract fails at import rather than at host admission.
 */
export const GITLAB_TRIAGE_SOURCE_DESCRIPTOR_V1: TriageSourceDescriptorV1 =
  TriageSourceDescriptorV1Schema.parse({
    v: 1,
    purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
    // The page this source's own Settings contribution ships, so the PRs & Issues
    // surface can offer a working Configure action instead of naming Settings and
    // leaving the reader to find it. A BARE local id: the target qualifies it with
    // the contributor identity the host already admitted, so a descriptor can never
    // name another plugin's page.
    settingsPageId: GITLAB_TRIAGE_SETTINGS_PAGE_ID,
    displayName: 'GitLab',
    kinds: [
      { id: 'merge-request', ...KIND_DISPLAY['merge-request'] },
      { id: 'issue', ...KIND_DISPLAY.issue },
    ],
  });

/** The declared source-local kinds, in the order the descriptor lists them. */
export const GITLAB_TRIAGE_KIND_IDS: readonly GitlabKindId[] = Object.freeze([
  'merge-request',
  'issue',
] as const);

/**
 * The one place a caller-supplied kind string becomes a declared kind.
 *
 * `null` rather than a throw or a default: a kind this source never declared
 * cannot select a route or a tab composition, and guessing one would read a
 * merge-request endpoint for an entry that is not one.
 */
export function readGitlabTriageKindId(value: string): GitlabKindId | null {
  return (GITLAB_TRIAGE_KIND_IDS as readonly string[]).includes(value)
    ? value as GitlabKindId
    : null;
}

const sourceOperations = TriageSourcesContributionProtocolV1.operations;

/**
 * Every read that carries a configured instance declares the exact account path
 * that instance holds, so the host binds and revalidates that one leaf.
 *
 * `scan` publishes a two-arm union — the deliberate shape that makes a mid-scan
 * limit change unrepresentable — and both arms carry the same configured
 * instance, so the leaf is proven for every representable input. `listInstances`
 * carries no account at all: producing account references is what it performs,
 * and its published input has no position a binding could name.
 */
const INSTANCE_ACCOUNT_BINDINGS = Object.freeze([Object.freeze({
  path: 'instance.binding.account',
  purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
})]);

type TriageActionDeclaration = Readonly<{
  id: string;
  title: string;
  description: string;
  scopes: readonly ['settings'] | readonly ['global'];
  surfaces: readonly [
    PluginActionInvocationSurfaceV2,
    ...PluginActionInvocationSurfaceV2[],
  ];
  execution: Readonly<{ target: 'daemon' }>;
  dangerLevel: 'safe' | 'writesLocal';
  inputSchema: PluginJsonSchema;
  resultSchema: PluginJsonSchema;
  hostAccess: readonly string[];
  connectedAccountPurposeBindings?: readonly Readonly<{ path: string; purpose: string }>[];
}>;

/**
 * A mutation Action declaration. It is deliberately NOT the read declaration
 * type widened: a read has no danger level to choose, no confirmation to author
 * and no placement to bind, and one shared shape with four optional members
 * would let a write be declared as though it were a read.
 */
type GitlabMutationActionDeclaration = Readonly<{
  id: string;
  title: string;
  description: string;
  scopes: readonly ['global'];
  surfaces: readonly ['ui'];
  placementBindings: readonly ['detailsPanel'];
  execution: Readonly<{ target: 'daemon' }>;
  dangerLevel: 'destructive' | 'externalSideEffect' | 'writesRemote';
  confirmation: Readonly<{
    title: Readonly<{ key: string; fallback: string }>;
    body: Readonly<{ key: string; fallback: string }>;
    confirmLabel: Readonly<{ key: string; fallback: string }>;
  }>;
  inputSchema: PluginJsonSchema;
  resultSchema: PluginJsonSchema;
  hostAccess: readonly string[];
  connectedAccountPurposeBindings: readonly Readonly<{ path: string; purpose: string }>[];
}>;

function declareOperationAction(input: Readonly<{
  id: string;
  title: string;
  description: string;
  scopes: readonly ['settings'] | readonly ['global'];
  role: 'listInstances' | 'scan' | 'get' | 'prepareReviewWorkspace' | 'verifyReviewWorkspace';
  connectedAccountPurposeBindings?: readonly Readonly<{ path: string; purpose: string }>[];
}>): TriageActionDeclaration {
  const declaration = sourceOperations[input.role].declaration;
  if (declaration.input.kind !== 'protocolDefined') {
    // Every V1 source role is protocol-defined. A contributor-defined input
    // would mean this manifest may publish its own schema, which it may not.
    throw new TypeError(`gitlab_triage_role_input_not_protocol_defined:${input.role}`);
  }
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    scopes: input.scopes,
    surfaces: declaration.surfaces,
    execution: { target: 'daemon' },
    dangerLevel: declaration.dangerLevel as 'safe' | 'writesLocal',
    inputSchema: declaration.input.schema.jsonSchema,
    resultSchema: declaration.resultSchema.jsonSchema,
    hostAccess: [...GITLAB_NETWORK_HOST_ACCESS_IDS, GITLAB_CONNECTED_ACCOUNT_PURPOSE],
    ...(input.connectedAccountPurposeBindings === undefined
      ? {}
      : { connectedAccountPurposeBindings: input.connectedAccountPurposeBindings }),
  };
}

/** The five Action declarations the contribution's operation roles bind to. */
export const GITLAB_TRIAGE_ACTION_DECLARATIONS: readonly TriageActionDeclaration[] = Object.freeze([
  declareOperationAction({
    id: GITLAB_TRIAGE_ACTION_IDS.listInstances,
    title: 'List GitLab deployments',
    description: 'Discovers the GitLab deployments each authorized account can reach.',
    scopes: ['settings'],
    role: 'listInstances',
  }),
  declareOperationAction({
    id: GITLAB_TRIAGE_ACTION_IDS.scan,
    title: 'Scan GitLab merge requests and issues',
    description: 'Reads one bounded page of GitLab merge requests and issues for a configured deployment.',
    scopes: ['global'],
    role: 'scan',
    connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
  }),
  declareOperationAction({
    id: GITLAB_TRIAGE_ACTION_IDS.verifyReviewWorkspace,
    title: 'Verify a GitLab merge-request review workspace',
    description: 'Reauthorizes and rereads one GitLab merge request, then verifies the prepared'
      + ' local checkout at its provider-authoritative head.',
    scopes: ['global'],
    role: 'verifyReviewWorkspace',
    connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
  }),
  declareOperationAction({
    id: GITLAB_TRIAGE_ACTION_IDS.get,
    title: 'Read one GitLab merge request or issue',
    description: 'Authoritatively reads one GitLab merge request or issue for a configured deployment.',
    scopes: ['global'],
    role: 'get',
    connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
  }),
  declareOperationAction({
    id: GITLAB_TRIAGE_ACTION_IDS.prepareReviewWorkspace,
    title: 'Prepare a GitLab merge-request review workspace',
    description: 'Reauthorizes and rereads one GitLab merge request before preparing its selected'
      + ' local workspace.',
    scopes: ['global'],
    role: 'prepareReviewWorkspace',
    connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
  }),
]);

/**
 * The source-native detail plane declarations.
 *
 * Unlike the three operation roles above, these publish this source's OWN
 * schemas: there is no protocol-defined role for "one page of GitLab
 * discussions", and inventing one would put GitLab vocabulary into the shared
 * contract. Only this source's own mounted detail body invokes them, through
 * the mounted Plugin UI host — present-user authority — so they are `ui`-
 * surfaced and account-bound: the same exact configured account gates them as
 * gates `scan` and `get`.
 */
export const GITLAB_TRIAGE_DETAIL_ACTION_DECLARATIONS: readonly TriageActionDeclaration[] =
  Object.freeze([
    {
      id: GITLAB_TRIAGE_DETAIL_ACTION_IDS.listNotes,
      title: 'Read a GitLab note page',
      description: 'Reads one bounded page of the notes of one merge request or issue.',
      inputSchema: GitlabNotesInputV1Schema.jsonSchema,
      resultSchema: GitlabNotesResultV1Schema.jsonSchema,
    },
    {
      id: GITLAB_TRIAGE_DETAIL_ACTION_IDS.listActivityEvents,
      title: 'Read a GitLab activity event page',
      description: 'Reads one bounded page of one resource event source of one merge request'
        + ' or issue.',
      inputSchema: GitlabActivityEventsInputV1Schema.jsonSchema,
      resultSchema: GitlabActivityEventsResultV1Schema.jsonSchema,
    },
    {
      id: GITLAB_TRIAGE_DETAIL_ACTION_IDS.listDiscussions,
      title: 'Read a GitLab discussion page',
      description: 'Reads one bounded page of the discussion threads of one merge request.',
      inputSchema: GitlabDiscussionsInputV1Schema.jsonSchema,
      resultSchema: GitlabDiscussionsResultV1Schema.jsonSchema,
    },
    {
      id: GITLAB_TRIAGE_DETAIL_ACTION_IDS.readApprovals,
      title: 'Read the GitLab approvals of a merge request',
      description: 'Reads the approval state of one merge request, and its approval rules when'
        + ' the deployment tier supplies them.',
      inputSchema: GitlabApprovalsInputV1Schema.jsonSchema,
      resultSchema: GitlabApprovalsResultV1Schema.jsonSchema,
    },
    {
      id: GITLAB_TRIAGE_DETAIL_ACTION_IDS.listPipelines,
      title: 'Read a GitLab pipeline page',
      description: 'Reads one bounded page of the pipelines of one merge request, with the'
        + ' newest pipeline’s per-job rollup when GitLab supplies one.',
      inputSchema: GitlabPipelinesInputV1Schema.jsonSchema,
      resultSchema: GitlabPipelinesResultV1Schema.jsonSchema,
    },
    {
      id: GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges,
      title: 'Read a GitLab changed-file page',
      description: 'Reads one bounded page of the files one merge request changes, with GitLab'
        + '’s own per-file truncation evidence.',
      inputSchema: GitlabChangesInputV1Schema.jsonSchema,
      resultSchema: GitlabChangesResultV1Schema.jsonSchema,
    },
    {
      id: GITLAB_TRIAGE_DETAIL_ACTION_IDS.readRawDiff,
      title: 'Read a GitLab raw diff',
      description: 'Reads the raw-text diff evidence of one merge request on explicit request.',
      inputSchema: GitlabRawDiffInputV1Schema.jsonSchema,
      resultSchema: GitlabRawDiffResultV1Schema.jsonSchema,
    },
  ].map((declaration) => Object.freeze({
    ...declaration,
    scopes: ['global'] as const,
    surfaces: ['ui'] as const,
    execution: { target: 'daemon' as const },
    dangerLevel: 'safe' as const,
    hostAccess: [...GITLAB_NETWORK_HOST_ACCESS_IDS, GITLAB_CONNECTED_ACCOUNT_PURPOSE],
    connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
  })));

/**
 * The mutation Action declarations.
 *
 * Four properties of these declarations are load-bearing rather than
 * decorative, and each is a rule from `sources/SCM.md` §3.8:
 *
 * - **`surfaces: ['ui']`, and the OMISSIONS are the gate.** The human
 *   gate is *reachability*, not a prompt: with no `agent` and no `mcp` surface no
 *   agent can reach these Actions at all — no tool, no prompt, no exposure —
 *   where a danger level plus `agent: true` would only *floor* them to an
 *   approval prompt, which is not the required guarantee.
 *
 *   `ui` is the write's whole product reach. The daemon derives the invoking
 *   surface from the authenticated mounted-UI provenance, so this source's own
 *   mounted detail artifact reaches each write as present-user authority while
 *   direct plugin code — ActionsService — checks only the `plugin` surface and
 *   is refused here.
 * - **The declared danger level is the contract's, row for row.** `merge` is
 *   `destructive` because it is irreversible on the forge; `mark-ready` is
 *   `externalSideEffect` because its reviewer notification fan-out *is* the
 *   write; `close` is `writesRemote`.
 * - **Confirmation metadata is required by the manifest grammar** for a non-safe
 *   Action on a human surface, and it is authored per Action: "GitLab notifies
 *   every reviewer" is the fact that makes mark-ready worth confirming, and a
 *   shared string could not say it.
 * - **Both resources are declared.** A write Action that names neither the
 *   network grant nor the connected-account purpose is a manifest defect, not a
 *   runtime one — the host revalidates the exact origin *and method* at dispatch.
 */
export const GITLAB_TRIAGE_MUTATION_ACTION_DECLARATIONS:
  readonly GitlabMutationActionDeclaration[] = Object.freeze([
    {
      id: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMerge,
      title: 'Merge a GitLab merge request',
      description: 'Merges one merge request at the exact commit the user observed, and reports'
        + ' whether GitLab merged it or scheduled it.',
      dangerLevel: 'destructive' as const,
      confirmation: {
        title: {
          key: 'plugins.gitlab.actions.mergeRequestMerge.confirm.title',
          fallback: 'Merge this merge request?',
        },
        body: {
          key: 'plugins.gitlab.actions.mergeRequestMerge.confirm.body',
          fallback: 'GitLab merges it into the target branch. Happier cannot undo that.',
        },
        confirmLabel: {
          key: 'plugins.gitlab.actions.mergeRequestMerge.confirm.label',
          fallback: 'Merge',
        },
      },
      inputSchema: GitlabMergeRequestMergeInputV1Schema.jsonSchema,
      resultSchema: GitlabMergeRequestMergeResultV1Schema.jsonSchema,
    },
    {
      id: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMarkReady,
      title: 'Mark a GitLab merge request ready for review',
      description: 'Clears the draft flag of one merge request through GitLab’s own draft'
        + ' transition, which notifies every named reviewer.',
      dangerLevel: 'externalSideEffect' as const,
      confirmation: {
        title: {
          key: 'plugins.gitlab.actions.mergeRequestMarkReady.confirm.title',
          fallback: 'Mark as ready for review?',
        },
        body: {
          key: 'plugins.gitlab.actions.mergeRequestMarkReady.confirm.body',
          fallback: 'GitLab notifies every reviewer of this merge request.',
        },
        confirmLabel: {
          key: 'plugins.gitlab.actions.mergeRequestMarkReady.confirm.label',
          fallback: 'Mark ready',
        },
      },
      inputSchema: GitlabMergeRequestMarkReadyInputV1Schema.jsonSchema,
      resultSchema: GitlabMergeRequestMarkReadyResultV1Schema.jsonSchema,
    },
    {
      id: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestClose,
      title: 'Close a GitLab merge request',
      description: 'Closes one open merge request through GitLab’s own state transition and'
        + ' proves the new state with a fresh read.',
      dangerLevel: 'writesRemote' as const,
      confirmation: {
        title: {
          key: 'plugins.gitlab.actions.mergeRequestClose.confirm.title',
          fallback: 'Close this merge request?',
        },
        body: {
          key: 'plugins.gitlab.actions.mergeRequestClose.confirm.body',
          fallback: 'It stays on GitLab and can be reopened there.',
        },
        confirmLabel: {
          key: 'plugins.gitlab.actions.mergeRequestClose.confirm.label',
          fallback: 'Close',
        },
      },
      inputSchema: GitlabMergeRequestCloseInputV1Schema.jsonSchema,
      resultSchema: GitlabMergeRequestCloseResultV1Schema.jsonSchema,
    },
    {
      id: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReopen,
      title: 'Reopen a GitLab merge request',
      description: 'Reopens one closed merge request through GitLab\u2019s own state transition'
        + ' and proves the new state with a fresh read.',
      dangerLevel: 'writesRemote' as const,
      confirmation: {
        title: {
          key: 'plugins.gitlab.actions.mergeRequestReopen.confirm.title',
          fallback: 'Reopen this merge request?',
        },
        body: {
          key: 'plugins.gitlab.actions.mergeRequestReopen.confirm.body',
          fallback: 'GitLab puts it back in review and notifies the people watching it.',
        },
        confirmLabel: {
          key: 'plugins.gitlab.actions.mergeRequestReopen.confirm.label',
          fallback: 'Reopen',
        },
      },
      inputSchema: GitlabMergeRequestReopenInputV1Schema.jsonSchema,
      resultSchema: GitlabMergeRequestReopenResultV1Schema.jsonSchema,
    },
    {
      id: GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueClose,
      title: 'Close a GitLab issue',
      description: 'Closes one open issue through GitLab\u2019s own state transition, sending'
        + ' nothing that could overwrite a concurrent edit, and proves the new state with a'
        + ' fresh read.',
      dangerLevel: 'writesRemote' as const,
      confirmation: {
        title: {
          key: 'plugins.gitlab.actions.issueClose.confirm.title',
          fallback: 'Close this issue?',
        },
        body: {
          key: 'plugins.gitlab.actions.issueClose.confirm.body',
          fallback: 'It stays on GitLab and can be reopened there.',
        },
        confirmLabel: {
          key: 'plugins.gitlab.actions.issueClose.confirm.label',
          fallback: 'Close',
        },
      },
      inputSchema: GitlabIssueCloseInputV1Schema.jsonSchema,
      resultSchema: GitlabIssueCloseResultV1Schema.jsonSchema,
    },
    {
      id: GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueReopen,
      title: 'Reopen a GitLab issue',
      description: 'Reopens one closed issue through GitLab\u2019s own state transition and'
        + ' proves the new state with a fresh read.',
      dangerLevel: 'writesRemote' as const,
      confirmation: {
        title: {
          key: 'plugins.gitlab.actions.issueReopen.confirm.title',
          fallback: 'Reopen this issue?',
        },
        body: {
          key: 'plugins.gitlab.actions.issueReopen.confirm.body',
          fallback: 'GitLab reopens it and notifies the people watching it.',
        },
        confirmLabel: {
          key: 'plugins.gitlab.actions.issueReopen.confirm.label',
          fallback: 'Reopen',
        },
      },
      inputSchema: GitlabIssueReopenInputV1Schema.jsonSchema,
      resultSchema: GitlabIssueReopenResultV1Schema.jsonSchema,
    },
    {
      id: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReviewerChange,
      title: 'Change GitLab merge request reviewers',
      description: 'Adds or removes only the selected reviewers through GitLab’s native delta operation.',
      dangerLevel: 'writesRemote' as const,
      confirmation: {
        title: { key: 'plugins.gitlab.actions.reviewerChange.confirm.title', fallback: 'Change reviewers?' },
        body: { key: 'plugins.gitlab.actions.reviewerChange.confirm.body', fallback: 'GitLab adds or removes only the selected reviewers.' },
        confirmLabel: { key: 'plugins.gitlab.actions.reviewerChange.confirm.label', fallback: 'Change reviewers' },
      },
      inputSchema: GitlabMergeRequestReviewerChangeInputV1Schema.jsonSchema,
      resultSchema: GitlabMergeRequestReviewerChangeResultV1Schema.jsonSchema,
    },
    {
      id: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestDiscussionResolution,
      title: 'Resolve or reopen a GitLab discussion',
      description: 'Changes the resolved state of one exact merge request discussion.',
      dangerLevel: 'writesRemote' as const,
      confirmation: {
        title: { key: 'plugins.gitlab.actions.discussionResolution.confirm.title', fallback: 'Change discussion state?' },
        body: { key: 'plugins.gitlab.actions.discussionResolution.confirm.body', fallback: 'GitLab changes this discussion’s resolved state.' },
        confirmLabel: { key: 'plugins.gitlab.actions.discussionResolution.confirm.label', fallback: 'Change state' },
      },
      inputSchema: GitlabMergeRequestDiscussionResolutionInputV1Schema.jsonSchema,
      resultSchema: GitlabMergeRequestDiscussionResolutionResultV1Schema.jsonSchema,
    },
    {
      id: GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueAssign,
      title: 'Change GitLab issue assignees',
      description: 'Adds or removes only the selected assignees through GitLab’s native delta operation.',
      dangerLevel: 'writesRemote' as const,
      confirmation: {
        title: { key: 'plugins.gitlab.actions.issueAssign.confirm.title', fallback: 'Change assignees?' },
        body: { key: 'plugins.gitlab.actions.issueAssign.confirm.body', fallback: 'GitLab adds or removes only the selected assignees.' },
        confirmLabel: { key: 'plugins.gitlab.actions.issueAssign.confirm.label', fallback: 'Change assignees' },
      },
      inputSchema: GitlabIssueAssignInputV1Schema.jsonSchema,
      resultSchema: GitlabIssueAssignResultV1Schema.jsonSchema,
    },
    {
      id: GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueLabel,
      title: 'Change GitLab issue labels',
      description: 'Adds or removes only the selected labels through GitLab’s native delta fields.',
      dangerLevel: 'writesRemote' as const,
      confirmation: {
        title: { key: 'plugins.gitlab.actions.issueLabel.confirm.title', fallback: 'Change labels?' },
        body: { key: 'plugins.gitlab.actions.issueLabel.confirm.body', fallback: 'GitLab adds or removes only the selected labels.' },
        confirmLabel: { key: 'plugins.gitlab.actions.issueLabel.confirm.label', fallback: 'Change labels' },
      },
      inputSchema: GitlabIssueLabelInputV1Schema.jsonSchema,
      resultSchema: GitlabIssueLabelResultV1Schema.jsonSchema,
    },
    {
      id: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestSubmitReview,
      title: 'Publish a GitLab merge request review',
      description: 'Publishes the selected review comments in order, then the selected review summary and approval.',
      dangerLevel: 'externalSideEffect' as const,
      confirmation: {
        title: { key: 'plugins.gitlab.actions.submitReview.confirm.title', fallback: 'Publish this review?' },
        body: { key: 'plugins.gitlab.actions.submitReview.confirm.body', fallback: 'GitLab publishes these comments and notifies review participants.' },
        confirmLabel: { key: 'plugins.gitlab.actions.submitReview.confirm.label', fallback: 'Publish review' },
      },
      inputSchema: GitlabMergeRequestReviewPublicationInputV1Schema.jsonSchema,
      resultSchema: GitlabReviewPublicationResultV1Schema.jsonSchema,
    },
    {
      id: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReviewCommentCreate,
      title: 'Publish a GitLab review comment',
      description: 'Publishes one revision-pinned inline merge request comment.',
      dangerLevel: 'externalSideEffect' as const,
      confirmation: {
        title: { key: 'plugins.gitlab.actions.reviewCommentCreate.confirm.title', fallback: 'Publish this review comment?' },
        body: { key: 'plugins.gitlab.actions.reviewCommentCreate.confirm.body', fallback: 'GitLab publishes the comment and may notify review participants.' },
        confirmLabel: { key: 'plugins.gitlab.actions.reviewCommentCreate.confirm.label', fallback: 'Publish comment' },
      },
      inputSchema: GitlabMergeRequestReviewCommentCreateInputV1Schema.jsonSchema,
      resultSchema: GitlabReviewPublicationResultV1Schema.jsonSchema,
    },
    {
      id: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestThreadReply,
      title: 'Reply to a GitLab review thread',
      description: 'Publishes one reply into the exact selected merge request discussion.',
      dangerLevel: 'writesRemote' as const,
      confirmation: {
        title: { key: 'plugins.gitlab.actions.threadReply.confirm.title', fallback: 'Publish this reply?' },
        body: { key: 'plugins.gitlab.actions.threadReply.confirm.body', fallback: 'GitLab adds the reply to this discussion.' },
        confirmLabel: { key: 'plugins.gitlab.actions.threadReply.confirm.label', fallback: 'Publish reply' },
      },
      inputSchema: GitlabMergeRequestThreadReplyInputV1Schema.jsonSchema,
      resultSchema: GitlabReviewPublicationResultV1Schema.jsonSchema,
    },
    {
      id: GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueComment,
      title: 'Comment on a GitLab issue',
      description: 'Publishes one canonical comment on the selected issue.',
      dangerLevel: 'externalSideEffect' as const,
      confirmation: {
        title: { key: 'plugins.gitlab.actions.issueComment.confirm.title', fallback: 'Publish this issue comment?' },
        body: { key: 'plugins.gitlab.actions.issueComment.confirm.body', fallback: 'GitLab publishes the comment and may notify issue participants.' },
        confirmLabel: { key: 'plugins.gitlab.actions.issueComment.confirm.label', fallback: 'Publish comment' },
      },
      inputSchema: GitlabIssueCommentInputV1Schema.jsonSchema,
      resultSchema: GitlabReviewPublicationResultV1Schema.jsonSchema,
    },
  ].map((declaration) => Object.freeze({
    ...declaration,
    scopes: ['global'] as const,
    surfaces: ['ui'] as const,
    placementBindings: ['detailsPanel'] as const,
    execution: { target: 'daemon' as const },
    hostAccess: [...GITLAB_NETWORK_HOST_ACCESS_IDS, GITLAB_CONNECTED_ACCOUNT_PURPOSE],
    connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
  })));

/**
 * The targeted contribution binds both optional review-workspace roles because
 * this provider has live handlers that reauthorize and reread the merge request
 * before generic SCM materializes or verifies the selected local checkout.
 */
export const GITLAB_TRIAGE_CONTRIBUTION_DECLARATION = TriageSourcesContributionProtocolV1.contribute({
  descriptor: GITLAB_TRIAGE_SOURCE_DESCRIPTOR_V1,
  operations: {
    listInstances: sourceOperations.listInstances.bind(GITLAB_TRIAGE_ACTION_IDS.listInstances),
    scan: sourceOperations.scan.bind(GITLAB_TRIAGE_ACTION_IDS.scan),
    get: sourceOperations.get.bind(GITLAB_TRIAGE_ACTION_IDS.get),
    prepareReviewWorkspace: sourceOperations.prepareReviewWorkspace.bind(
      GITLAB_TRIAGE_ACTION_IDS.prepareReviewWorkspace,
    ),
    verifyReviewWorkspace: sourceOperations.verifyReviewWorkspace.bind(
      GITLAB_TRIAGE_ACTION_IDS.verifyReviewWorkspace,
    ),
  },
  surfaces: {
    detail: { renderer: GITLAB_TRIAGE_DETAIL_RENDERER_ID },
  },
});
