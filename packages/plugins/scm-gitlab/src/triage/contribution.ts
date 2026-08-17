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
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
  TriageSourceDescriptorV1Schema,
  TriageSourcesContributionProtocolV1,
  type TriageSourceDescriptorV1,
} from '@happier-dev/triage-protocol/v1';

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
} from './detail/contracts.js';
import type { GitlabKindId } from './types.js';

/** The Connected Account descriptor this source authorizes against. */
export const GITLAB_CONNECTED_ACCOUNT_ID = 'gitlab-account';
/** The declared host-access purpose used to list and materialize that account. */
export const GITLAB_CONNECTED_ACCOUNT_PURPOSE = 'gitlab-connected-account';
/** The network host-access request that already owns this plugin's GitLab origin. */
export const GITLAB_NETWORK_HOST_ACCESS_ID = 'gitlab-api';

/** `pullRequest` is schema-illegal as a local id; `merge-request` is GitLab's word anyway. */
export const GITLAB_TRIAGE_CONTRIBUTION_LOCAL_ID = 'gitlab-forge';

export const GITLAB_TRIAGE_ACTION_IDS = Object.freeze({
  listInstances: 'triage/list-gitlab-instances',
  scan: 'triage/scan-gitlab',
  get: 'triage/get-gitlab-entry',
});

/**
 * The source-native detail planes.
 *
 * They carry no Triage role: a note, a resource event, a discussion, an approval
 * state, a pipeline and a changed file are GitLab-native content this source's
 * own mounted detail body reads. Their published surface is `plugin`, so the
 * only caller that can reach them is this plugin's own detail artifact.
 */
export const GITLAB_TRIAGE_DETAIL_ACTION_IDS = Object.freeze({
  listNotes: 'triage/list-gitlab-notes',
  listActivityEvents: 'triage/list-gitlab-activity-events',
  listDiscussions: 'triage/list-gitlab-discussions',
  readApprovals: 'triage/read-gitlab-approvals',
  listPipelines: 'triage/list-gitlab-pipelines',
  listChanges: 'triage/list-gitlab-changes',
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
  surfaces: readonly string[];
  dangerLevel: 'safe';
  inputSchema: PluginJsonSchema;
  resultSchema: PluginJsonSchema;
  hostAccess: readonly string[];
  connectedAccountPurposeBindings?: readonly Readonly<{ path: string; purpose: string }>[];
}>;

function declareOperationAction(input: Readonly<{
  id: string;
  title: string;
  description: string;
  scopes: readonly ['settings'] | readonly ['global'];
  role: 'listInstances' | 'scan' | 'get';
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
    surfaces: [...declaration.surfaces],
    dangerLevel: declaration.dangerLevel as 'safe',
    inputSchema: declaration.input.schema.jsonSchema,
    resultSchema: declaration.resultSchema.jsonSchema,
    hostAccess: [GITLAB_NETWORK_HOST_ACCESS_ID, GITLAB_CONNECTED_ACCOUNT_PURPOSE],
    ...(input.connectedAccountPurposeBindings === undefined
      ? {}
      : { connectedAccountPurposeBindings: input.connectedAccountPurposeBindings }),
  };
}

/** The three Action declarations the contribution's operation roles bind to. */
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
    id: GITLAB_TRIAGE_ACTION_IDS.get,
    title: 'Read one GitLab merge request or issue',
    description: 'Authoritatively reads one GitLab merge request or issue for a configured deployment.',
    scopes: ['global'],
    role: 'get',
    connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
  }),
]);

/**
 * The six source-native detail plane declarations.
 *
 * Unlike the three operation roles above, these publish this source's OWN
 * schemas: there is no protocol-defined role for "one page of GitLab
 * discussions", and inventing one would put GitLab vocabulary into the shared
 * contract. They stay `plugin`-surfaced and account-bound so the same exact
 * configured account gates them as gates `scan` and `get`.
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
  ].map((declaration) => Object.freeze({
    ...declaration,
    scopes: ['global'] as const,
    surfaces: ['plugin'] as const,
    dangerLevel: 'safe' as const,
    hostAccess: [GITLAB_NETWORK_HOST_ACCESS_ID, GITLAB_CONNECTED_ACCOUNT_PURPOSE],
    connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
  })));

/**
 * The targeted contribution itself. `prepareReviewWorkspace` is deliberately
 * unbound: it is an optional role, and binding it would claim a worktree
 * materialization contract this provider has not implemented.
 */
export const GITLAB_TRIAGE_CONTRIBUTION_DECLARATION = Object.freeze({
  id: GITLAB_TRIAGE_CONTRIBUTION_LOCAL_ID,
  target: Object.freeze({
    pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  }),
  protocol: Object.freeze({
    id: TriageSourcesContributionProtocolV1.id,
    version: TriageSourcesContributionProtocolV1.version,
  }),
  descriptor: GITLAB_TRIAGE_SOURCE_DESCRIPTOR_V1,
  operations: Object.freeze({
    listInstances: sourceOperations.listInstances.bind(GITLAB_TRIAGE_ACTION_IDS.listInstances),
    scan: sourceOperations.scan.bind(GITLAB_TRIAGE_ACTION_IDS.scan),
    get: sourceOperations.get.bind(GITLAB_TRIAGE_ACTION_IDS.get),
  }),
  surfaces: Object.freeze({
    detail: Object.freeze({ renderer: GITLAB_TRIAGE_DETAIL_RENDERER_ID }),
  }),
});
