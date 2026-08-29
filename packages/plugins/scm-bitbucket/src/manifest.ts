/**
 * The sole Bitbucket plugin manifest and registration spine.
 *
 * It is authored through `definePlugin` and, for the Triage source, through the protocol's own
 * `sources.contribute(...)`. That is not a style choice. The raw contribution literal this file
 * used to build could omit the required `detail` surface and still typecheck: the manifest shipped,
 * host admission then rejected the whole contribution with `required_surface_missing`, and the
 * plugin contributed nothing at all. `contribute` types the required surface roles, so the same
 * omission is now a compile error in this file rather than a silent runtime non-contribution.
 *
 * Every Action's input and result schema is the exact published Triage schema read from the role
 * declaration rather than a local restatement, so a drift between this manifest and the shared
 * contract fails conformance instead of admitting a source that speaks a private dialect.
 */

import { definePlugin } from '@happier-dev/plugin-sdk';
import { withTriageSourceSettingsTranslationsV1 } from '@happier-dev/triage-sources/translations';
import { BITBUCKET_RENDER_UI_TRANSLATIONS } from './ui/renderTranslations.js';
import { BITBUCKET_ADDITIONAL_UI_TRANSLATIONS } from './ui/additionalTranslations.js';
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
  TriageSourcesContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';

import { bitbucketConnectedAccountRuntime } from './auth/connectedAccountRuntime.js';
import {
  BITBUCKET_PLUGIN_ID,
  BITBUCKET_SCM_HOSTING_PROVIDER_LOCAL_ID,
} from './bitbucketContracts.js';
import { bitbucketApiAdapter } from './operations/bitbucketApiAdapter.js';
import {
  BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
  BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID,
  BITBUCKET_TRIAGE_DESCRIPTOR,
  BITBUCKET_TRIAGE_DETAIL_ARTIFACT_ID,
  BITBUCKET_TRIAGE_DETAIL_RENDERER_ID,
  BITBUCKET_TRIAGE_SETTINGS_ARTIFACT_ID,
  BITBUCKET_TRIAGE_SETTINGS_GROUP_ID,
  BITBUCKET_TRIAGE_SETTINGS_PAGE_ID,
  BITBUCKET_TRIAGE_SETTINGS_RENDERER_ID,
} from './triage/source/descriptor.js';
import {
  BITBUCKET_TRIAGE_ACTION_IDS,
  getBitbucketSourceEntryAction,
  listBitbucketInstancesAction,
  prepareBitbucketReviewWorkspaceAction,
  scanBitbucketSourceAction,
  verifyBitbucketReviewWorkspaceAction,
} from './triage/source/actions.js';
import {
  BITBUCKET_TRIAGE_DETAIL_ACTION_IDS,
  listBitbucketActivity,
  listBitbucketBuilds,
  listBitbucketComments,
  readBitbucketDiff,
  readBitbucketOverview,
} from './triage/source/detailActions.js';
import {
  BitbucketActivityInputV1Schema,
  BitbucketActivityResultV1Schema,
  BitbucketBuildsInputV1Schema,
  BitbucketBuildsResultV1Schema,
  BitbucketCommentsInputV1Schema,
  BitbucketCommentsResultV1Schema,
  BitbucketDiffInputV1Schema,
  BitbucketDiffResultV1Schema,
  BitbucketOverviewInputV1Schema,
  BitbucketOverviewResultV1Schema,
} from './triage/source/detailContracts.js';
import {
  BITBUCKET_TRIAGE_MUTATION_ACTION_IDS,
  createBitbucketPullRequestReviewCommentAction,
  declineBitbucketPullRequestAction,
  mergeBitbucketPullRequestAction,
  resolveBitbucketCommentAction,
  publishBitbucketPullRequestReviewAction,
  replyToBitbucketPullRequestReviewCommentAction,
  unresolveBitbucketCommentAction,
} from './triage/source/mutationActions.js';
import {
  BitbucketCommentResolutionInputV1Schema,
  BitbucketCommentResolutionResultV1Schema,
  BitbucketDeclineInputV1Schema,
  BitbucketMergeInputV1Schema,
  BitbucketMutationResultV1Schema,
  BitbucketReviewPublicationInputV1Schema,
  BitbucketReviewPublicationResultV1Schema,
  BitbucketReviewCommentCreateInputV1Schema,
  BitbucketReviewCommentReplyInputV1Schema,
} from './triage/source/mutationContracts.js';

/** The local id of this plugin's one Triage source contribution. */
export const BITBUCKET_TRIAGE_CONTRIBUTION_ID = 'bitbucket-forge';

/** The network host-access request that owns this plugin's Bitbucket origins. */
export const BITBUCKET_NETWORK_HOST_ACCESS_ID = 'bitbucket-api';

export {
  BITBUCKET_TRIAGE_DETAIL_ARTIFACT_ID,
  BITBUCKET_TRIAGE_DETAIL_RENDERER_ID,
};

const sources = TriageSourcesContributionProtocolV1;

/**
 * Every source Action that reaches the provider uses the exact account, so both grants are declared
 * on all four roles.
 *
 * `scan`, `get`, and selected-PR preparation additionally declare the exact account path their
 * configured instance carries, so the host cross-checks at declaration time that the credential
 * each one asks for is the one this purpose was granted. `scan`'s published input is a two-arm
 * union — the deliberate shape that makes a mid-scan limit change unrepresentable — and the
 * canonical Action validator resolves a bound path through every arm, requiring the same exact
 * qualified credential ref in each; a path either arm narrowed differently, or omitted, is refused.
 * `listInstances` carries no account at all, because producing account references is what it does,
 * so it has no path to bind.
 */
const READ_HOST_ACCESS = [BITBUCKET_NETWORK_HOST_ACCESS_ID, BITBUCKET_CONNECTED_ACCOUNT_PURPOSE];
const INSTANCE_ACCOUNT_BINDINGS = [{
  path: 'instance.binding.account',
  purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
}];

export const BITBUCKET_PLUGIN = definePlugin({
  id: BITBUCKET_PLUGIN_ID,
  version: '0.0.0',
  displayName: 'Bitbucket SCM hosting provider',
  description: 'Detects Bitbucket Cloud remotes, provides repository operations, and brings its pull requests into PRs & Issues.',
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: BITBUCKET_NETWORK_HOST_ACCESS_ID,
      capability: 'network',
      reason: 'Access the Bitbucket origin selected from the SCM provider and connected account.',
      scope: {
        targets: [
          { kind: 'fixedOrigin', origin: 'https://api.bitbucket.org' },
          { kind: 'scmProviderOrigin', provider: 'bitbucket' },
          { kind: 'connectedAccountOrigin', service: BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID },
        ],
        // `GET` serves every read and every confirming re-read. `POST` serves merge, decline and
        // resolving a comment thread. `DELETE` serves exactly one Action: Bitbucket documents
        // reopening a comment thread as `DELETE` on the resolve path, so the verb IS the write.
        // The host revalidates origin AND method at dispatch, so an Action whose verb is missing
        // here is rejected before it ever reaches Bitbucket. `PUT` stays absent: no declared
        // Action uses it, and a verb granted for symmetry is authority the user approved for
        // nothing.
        methods: ['GET', 'POST', 'DELETE'],
      },
    }, {
      id: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
      capability: 'connectedAccounts',
      reason: 'Materialize only the exact selected Bitbucket Cloud account for Bitbucket API requests.',
      scope: {
        serviceRefs: [BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID],
        operations: ['select', 'use'],
        materializationKinds: ['httpHeaders'],
      },
    }],
    optional: [],
  },
  ui: {
    views: [],
    renderers: [{
      id: BITBUCKET_TRIAGE_DETAIL_RENDERER_ID,
      kind: 'reactNative',
      artifact: BITBUCKET_TRIAGE_DETAIL_ARTIFACT_ID,
      // The detail body reads through this plugin's own Actions, so a mount without them would
      // render an empty shell rather than a useful surface.
      requiredHostMethods: ['executeAction'],
    }, {
      id: BITBUCKET_TRIAGE_SETTINGS_RENDERER_ID,
      kind: 'reactNative',
      artifact: BITBUCKET_TRIAGE_SETTINGS_ARTIFACT_ID,
      // The page's whole purpose is two Action invocations — this source's own
      // discovery read and the target-owned administration write.
      requiredHostMethods: ['executeAction', 'openConnectedAccounts'],
    }],
    settingsGroups: [{
      id: BITBUCKET_TRIAGE_SETTINGS_GROUP_ID,
      title: { key: 'plugins.bitbucket.settings.group', fallback: 'Bitbucket Cloud' },
      icon: 'settings',
      defaultRank: 40,
    }],
    settingsPages: [{
      id: BITBUCKET_TRIAGE_SETTINGS_PAGE_ID,
      group: { kind: 'plugin', localId: BITBUCKET_TRIAGE_SETTINGS_GROUP_ID },
      title: { key: 'plugins.bitbucket.settings.sources', fallback: 'PRs & Issues' },
      subtitle: {
        key: 'plugins.bitbucket.settings.sources.subtitle',
        fallback: 'Choose which Bitbucket Cloud accounts and workspaces appear in PRs & Issues.',
      },
      keywords: ['bitbucket', 'pull requests', 'triage'],
      icon: 'settings',
      defaultRank: 10,
      renderer: BITBUCKET_TRIAGE_SETTINGS_RENDERER_ID,
    }],
    translations: withTriageSourceSettingsTranslationsV1([
      { locale: 'en', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["en"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["en"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PRs & Issues', 'plugins.bitbucket.settings.sources.subtitle': 'Choose which Bitbucket Cloud accounts and workspaces appear in PRs & Issues.' } },
      { locale: 'ru', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["ru"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["ru"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PR и задачи', 'plugins.bitbucket.settings.sources.subtitle': 'Выберите учетные записи и рабочие пространства Bitbucket Cloud, которые будут отображаться в разделе PR и задач.' } },
      { locale: 'pl', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["pl"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["pl"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PR-y i zgłoszenia', 'plugins.bitbucket.settings.sources.subtitle': 'Wybierz konta i obszary robocze Bitbucket Cloud wyświetlane w sekcji PR-ów i zgłoszeń.' } },
      { locale: 'es', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["es"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["es"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PR e incidencias', 'plugins.bitbucket.settings.sources.subtitle': 'Elige qué cuentas y espacios de trabajo de Bitbucket Cloud aparecen en PR e incidencias.' } },
      { locale: 'fr', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["fr"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["fr"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PR et tickets', 'plugins.bitbucket.settings.sources.subtitle': 'Choisissez les comptes et espaces de travail Bitbucket Cloud affichés dans PR et tickets.' } },
      { locale: 'it', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["it"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["it"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PR e segnalazioni', 'plugins.bitbucket.settings.sources.subtitle': 'Scegli gli account e gli spazi di lavoro Bitbucket Cloud da mostrare in PR e segnalazioni.' } },
      { locale: 'pt', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["pt"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["pt"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PRs e problemas', 'plugins.bitbucket.settings.sources.subtitle': 'Escolha as contas e os espaços de trabalho Bitbucket Cloud apresentados em PRs e problemas.' } },
      { locale: 'de', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["de"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["de"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PRs & Tickets', 'plugins.bitbucket.settings.sources.subtitle': 'Wähle aus, welche Bitbucket-Cloud-Konten und -Workspaces unter PRs & Tickets angezeigt werden.' } },
      { locale: 'ca', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["ca"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["ca"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PR i incidències', 'plugins.bitbucket.settings.sources.subtitle': 'Tria els comptes i espais de treball de Bitbucket Cloud que es mostren a PR i incidències.' } },
      { locale: 'zh-Hans', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["zh-Hans"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["zh-Hans"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PR 和问题', 'plugins.bitbucket.settings.sources.subtitle': '选择要在 PR 和问题中显示的 Bitbucket Cloud 帐户和工作区。' } },
      { locale: 'zh-Hant', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["zh-Hant"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["zh-Hant"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PR 與問題', 'plugins.bitbucket.settings.sources.subtitle': '選擇要在 PR 與問題中顯示的 Bitbucket Cloud 帳戶和工作區。' } },
      { locale: 'ja', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["ja"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["ja"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PR と課題', 'plugins.bitbucket.settings.sources.subtitle': 'PR と課題に表示する Bitbucket Cloud アカウントとワークスペースを選択します。' } },
    ]),
  },
  actions: {
    [BITBUCKET_TRIAGE_ACTION_IDS.listInstances]: {
      title: 'Discover Bitbucket Cloud workspaces',
      description: 'Enumerates the workspaces reachable by each authorized Bitbucket Cloud account.',
      scopes: ['global'],
      surfaces: sources.operations.listInstances.declaration.surfaces,
      // Mounted-only placement. `plugin` stays because the Triage daemon
      // consumes it and `ui` because this source's own mounted surfaces hold
      // present-user authority; the explicit empty list only withdraws the
      // Action from global placement discovery — it disables no invocation.
      placementBindings: [],
      execution: { target: 'daemon' },
      dangerLevel: sources.operations.listInstances.declaration.dangerLevel,
      inputSchema: sources.operations.listInstances.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.listInstances.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      run: listBitbucketInstancesAction,
    },
    [BITBUCKET_TRIAGE_ACTION_IDS.scan]: {
      title: 'Scan Bitbucket Cloud pull requests',
      description: 'Reads one bounded page of pull requests for one configured Bitbucket Cloud workspace.',
      scopes: ['global'],
      surfaces: sources.operations.scan.declaration.surfaces,
      execution: { target: 'daemon' },
      dangerLevel: sources.operations.scan.declaration.dangerLevel,
      inputSchema: sources.operations.scan.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.scan.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: scanBitbucketSourceAction,
    },
    [BITBUCKET_TRIAGE_ACTION_IDS.get]: {
      title: 'Read one Bitbucket Cloud pull request',
      description: 'Reads one pull request authoritatively through one exact configured Bitbucket Cloud instance.',
      scopes: ['global'],
      surfaces: sources.operations.get.declaration.surfaces,
      // Mounted-only placement. `plugin` stays because the Triage daemon
      // consumes it and `ui` because this source's own mounted surfaces hold
      // present-user authority; the explicit empty list only withdraws the
      // Action from global placement discovery — it disables no invocation.
      placementBindings: [],
      execution: { target: 'daemon' },
      dangerLevel: sources.operations.get.declaration.dangerLevel,
      inputSchema: sources.operations.get.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.get.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: getBitbucketSourceEntryAction,
    },
    [BITBUCKET_TRIAGE_ACTION_IDS.prepareReviewWorkspace]: {
      title: 'Prepare a Bitbucket Cloud pull-request review workspace',
      description: 'Reauthorizes and rereads one Bitbucket Cloud pull request before preparing its selected local workspace.',
      scopes: ['global'],
      surfaces: sources.operations.prepareReviewWorkspace.declaration.surfaces,
      execution: { target: 'daemon' },
      dangerLevel: sources.operations.prepareReviewWorkspace.declaration.dangerLevel,
      inputSchema: sources.operations.prepareReviewWorkspace.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.prepareReviewWorkspace.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: prepareBitbucketReviewWorkspaceAction,
    },
    [BITBUCKET_TRIAGE_ACTION_IDS.verifyReviewWorkspace]: {
      title: 'Verify a Bitbucket Cloud pull-request review workspace',
      description: 'Rereads one Bitbucket Cloud pull request and verifies the already prepared local workspace before review starts.',
      scopes: ['global'],
      surfaces: sources.operations.verifyReviewWorkspace.declaration.surfaces,
      execution: { target: 'daemon' },
      dangerLevel: sources.operations.verifyReviewWorkspace.declaration.dangerLevel,
      inputSchema: sources.operations.verifyReviewWorkspace.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.verifyReviewWorkspace.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: verifyBitbucketReviewWorkspaceAction,
    },
    // The source-native detail planes. Only this plugin's own mounted
    // detail artifact invokes them, through the mounted Plugin UI host —
    // present-user authority — so they declare `ui` and nothing else.
    [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listActivity]: {
      title: 'Read a Bitbucket activity page',
      description: 'Reads one bounded page of the combined approval, update and comment activity'
        + ' of one pull request.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: [],
      execution: { target: 'daemon' },
      dangerLevel: 'safe',
      inputSchema: BitbucketActivityInputV1Schema.jsonSchema,
      resultSchema: BitbucketActivityResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: listBitbucketActivity,
    },
    [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readOverview]: {
      title: 'Refresh a Bitbucket pull-request overview',
      description: 'Reads the pull request authoritatively from Bitbucket for the mounted Overview.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: [],
      execution: { target: 'daemon' },
      dangerLevel: 'safe',
      inputSchema: BitbucketOverviewInputV1Schema.jsonSchema,
      resultSchema: BitbucketOverviewResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: readBitbucketOverview,
    },
    [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readDiff]: {
      title: 'Read a Bitbucket pull-request diff',
      description: 'Reads the raw diff and its bounded diffstat projection without dropping the pull request.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: [],
      execution: { target: 'daemon' },
      dangerLevel: 'safe',
      inputSchema: BitbucketDiffInputV1Schema.jsonSchema,
      resultSchema: BitbucketDiffResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: readBitbucketDiff,
    },
    [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listBuilds]: {
      title: 'Read a Bitbucket build-status page',
      description: 'Reads one bounded page of the build statuses reported against one pull'
        + ' request, with a rollup only when that page is the whole collection.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: [],
      execution: { target: 'daemon' },
      dangerLevel: 'safe',
      inputSchema: BitbucketBuildsInputV1Schema.jsonSchema,
      resultSchema: BitbucketBuildsResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: listBitbucketBuilds,
    },
    [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listComments]: {
      title: 'Read a Bitbucket comment page',
      description: 'Reads one bounded page of the comments on one pull request, in provider'
        + ' order, with their real resolution tri-state.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: [],
      execution: { target: 'daemon' },
      dangerLevel: 'safe',
      inputSchema: BitbucketCommentsInputV1Schema.jsonSchema,
      resultSchema: BitbucketCommentsResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: listBitbucketComments,
    },
    // The enabled Bitbucket pull-request writes.
    //
    // `surfaces: ['ui']` is the human gate, and the gate is reachability rather than a
    // prompt: with no `agent` and no `mcp` surface not one of them is agent-reachable at all. A
    // `danger` level plus `agent: true` would only floor an agent invocation to an approval
    // prompt, which is a weaker guarantee — so there is no list of exempt callers here, and none
    // may be added. `ui` is the write's whole product reach: the daemon derives the invoking
    // surface from the authenticated mounted-UI provenance, so this plugin's own mounted detail
    // artifact reaches the write as present-user authority while direct plugin code —
    // ActionsService — checks only the `plugin` surface and is refused here.
    //
    // Every one reaches the provider and the exact configured account, and every one binds the
    // account path its configured instance carries, exactly as `scan` and `get` do. A write Action
    // declaring neither grant would be a manifest defect rather than a runtime one.
    [BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.merge]: {
      title: 'Merge a Bitbucket pull request',
      description: 'Merges one pull request with the exact strategy and source-branch decision the'
        + ' user chose, only while its head is still the commit they saw.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      execution: { target: 'daemon' },
      // Irreversible on the forge, and it may delete the source branch.
      dangerLevel: 'destructive',
      // The host-owned confirmation a `destructive` UI Action must declare. The body names the two
      // consequences a user cannot take back — the merge itself, and the branch decision they made
      // — rather than asking "are you sure" about an unnamed effect.
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
      },
      inputSchema: BitbucketMergeInputV1Schema.jsonSchema,
      resultSchema: BitbucketMutationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: mergeBitbucketPullRequestAction,
    },
    [BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.decline]: {
      title: 'Decline a Bitbucket pull request',
      description: 'Declines one open pull request. Bitbucket has no reopen, so this cannot be'
        + ' undone through its API.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      execution: { target: 'daemon' },
      dangerLevel: 'writesRemote',
      // Bitbucket has no reopen: the state enum is OPEN | MERGED | DECLINED | SUPERSEDED and no
      // `/reopen` path exists. The confirmation says exactly that, because a user who expects the
      // GitHub or GitLab affordance would otherwise assume they can undo this.
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
      },
      inputSchema: BitbucketDeclineInputV1Schema.jsonSchema,
      resultSchema: BitbucketMutationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: declineBitbucketPullRequestAction,
    },
    [BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.resolveComment]: {
      title: 'Resolve a Bitbucket comment thread',
      description: 'Marks one comment thread on this pull request resolved, and confirms it from'
        + ' the comment itself.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      execution: { target: 'daemon' },
      dangerLevel: 'writesRemote',
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
      },
      // One input for both directions: the entry, and the comment. What separates resolve from
      // reopen is the verb the handler sends, which is not a value a caller supplies.
      inputSchema: BitbucketCommentResolutionInputV1Schema.jsonSchema,
      // A comment write settles into the comment's own vocabulary, not the pull request's: what it
      // changed is the thread, and returning an entry observation would answer a question the
      // caller did not ask.
      resultSchema: BitbucketCommentResolutionResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: resolveBitbucketCommentAction,
    },
    [BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.unresolveComment]: {
      title: 'Reopen a Bitbucket comment thread',
      description: 'Reopens one resolved comment thread on this pull request, and confirms it from'
        + ' the comment itself.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      execution: { target: 'daemon' },
      dangerLevel: 'writesRemote',
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
      },
      inputSchema: BitbucketCommentResolutionInputV1Schema.jsonSchema,
      resultSchema: BitbucketCommentResolutionResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: unresolveBitbucketCommentAction,
    },
    [BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.submitReview]: {
      title: 'Submit this Bitbucket pull-request review',
      description: 'Publishes the selected canonical Happier review comments in order, then applies the requested Bitbucket verdict against the exact base and head revisions shown.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      execution: { target: 'daemon' },
      dangerLevel: 'externalSideEffect',
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
      },
      inputSchema: BitbucketReviewPublicationInputV1Schema.jsonSchema,
      resultSchema: BitbucketReviewPublicationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: publishBitbucketPullRequestReviewAction,
    },
    [BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.createReviewComment]: {
      title: 'Publish this Bitbucket review comment',
      description: 'Publishes one canonical Happier proposal at its exact pinned Bitbucket diff anchor.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      execution: { target: 'daemon' },
      dangerLevel: 'externalSideEffect',
      confirmation: {
        title: { key: 'plugins.bitbucket.ui.mutations.reviewComment.confirmation.title', fallback: 'Publish this review comment?' },
        body: { key: 'plugins.bitbucket.ui.mutations.reviewComment.confirmation.body', fallback: 'This posts the selected comment on Bitbucket at the exact pull request comparison you reviewed.' },
        confirmLabel: { key: 'plugins.bitbucket.ui.mutations.reviewComment.publish', fallback: 'Publish comment' },
      },
      inputSchema: BitbucketReviewCommentCreateInputV1Schema.jsonSchema,
      resultSchema: BitbucketReviewPublicationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: createBitbucketPullRequestReviewCommentAction,
    },
    [BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.replyToReviewComment]: {
      title: 'Reply to this Bitbucket review comment',
      description: 'Publishes one canonical Happier proposal beneath one exact Bitbucket pull-request comment.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      execution: { target: 'daemon' },
      dangerLevel: 'writesRemote',
      confirmation: {
        title: { key: 'plugins.bitbucket.ui.mutations.reviewReply.confirmation.title', fallback: 'Post this reply?' },
        body: { key: 'plugins.bitbucket.ui.mutations.reviewReply.confirmation.body', fallback: 'This reply becomes visible beneath the selected Bitbucket pull-request comment.' },
        confirmLabel: { key: 'plugins.bitbucket.ui.mutations.reviewReply.publish', fallback: 'Post reply' },
      },
      inputSchema: BitbucketReviewCommentReplyInputV1Schema.jsonSchema,
      resultSchema: BitbucketReviewPublicationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: replyToBitbucketPullRequestReviewCommentAction,
    },
  },
  scmHostingProviders: {
    [BITBUCKET_SCM_HOSTING_PROVIDER_LOCAL_ID]: {
      declaration: {
        title: 'Bitbucket',
        description: 'Bitbucket Cloud repositories.',
        kind: 'bitbucket',
        capabilities: ['detect', 'clone', 'fetch', 'push', 'pullRequest'],
        authService: BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID,
      },
      runtime: {
        adapter: {
          routing: bitbucketApiAdapter,
          pullRequests: bitbucketApiAdapter,
          pullRequestCheckout: bitbucketApiAdapter,
          repositoryPublishing: bitbucketApiAdapter,
        },
      },
    },
  },
  connectedAccountDescriptors: {
    [BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID]: {
      declaration: {
        title: 'Bitbucket account',
        description: 'Bitbucket account used for repository and pull-request operations.',
        authentication: {
          defaultModeId: 'manual',
          modes: [{
            id: 'manual',
            kind: 'manual',
            outcomeReconciliation: 'none',
            fields: [
              {
                // Bitbucket Cloud API tokens authenticate with the Atlassian account EMAIL and the
                // token as the password. A username, workspace slug or nickname is not a Basic-auth
                // identity substitute, and inviting one here is how a reader ends up with a 401 on
                // every call (sources/SCM.md §5.1).
                id: 'identity',
                title: 'Atlassian account email',
                description: 'The email address of the Atlassian account this API token belongs to.',
                schema: { type: 'string', minLength: 1 },
                secret: false,
              },
              {
                id: 'token',
                title: 'API token',
                // App passwords were disabled on 2026-06-09 and no longer work, so there is
                // nothing to fall back to and nothing to name but an API token.
                description: 'A Bitbucket API token with read:user:bitbucket, read:workspace:bitbucket, '
                  + 'read:repository:bitbucket, read:pullrequest:bitbucket, and write:pullrequest:bitbucket '
                  + 'scopes. Add write:repository:bitbucket when Sessions will push changes.',
                schema: { type: 'string', minLength: 1 },
                secret: true,
              },
            ],
          }],
        },
        capabilities: ['scmHostingBasicAuth'],
      },
      runtime: bitbucketConnectedAccountRuntime,
    },
  },
  contributesTo: {
    [TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1]: {
      [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: {
        [BITBUCKET_TRIAGE_CONTRIBUTION_ID]: sources.contribute({
          descriptor: BITBUCKET_TRIAGE_DESCRIPTOR,
          operations: {
            listInstances: sources.operations.listInstances
              .bind(BITBUCKET_TRIAGE_ACTION_IDS.listInstances),
            scan: sources.operations.scan.bind(BITBUCKET_TRIAGE_ACTION_IDS.scan),
            get: sources.operations.get.bind(BITBUCKET_TRIAGE_ACTION_IDS.get),
            prepareReviewWorkspace: sources.operations.prepareReviewWorkspace
              .bind(BITBUCKET_TRIAGE_ACTION_IDS.prepareReviewWorkspace),
            verifyReviewWorkspace: sources.operations.verifyReviewWorkspace
              .bind(BITBUCKET_TRIAGE_ACTION_IDS.verifyReviewWorkspace),
          },
          surfaces: { detail: { renderer: BITBUCKET_TRIAGE_DETAIL_RENDERER_ID } },
        }),
      },
    },
  },
});

/** The sole Bitbucket plugin manifest. */
export const PLUGIN_MANIFEST = BITBUCKET_PLUGIN.manifest;
