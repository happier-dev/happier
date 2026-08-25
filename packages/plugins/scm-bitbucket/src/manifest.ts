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
  scanBitbucketSourceAction,
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
  declineBitbucketPullRequestAction,
  mergeBitbucketPullRequestAction,
  resolveBitbucketCommentAction,
  unresolveBitbucketCommentAction,
} from './triage/source/mutationActions.js';
import {
  BitbucketCommentResolutionInputV1Schema,
  BitbucketCommentResolutionResultV1Schema,
  BitbucketDeclineInputV1Schema,
  BitbucketMergeInputV1Schema,
  BitbucketMutationResultV1Schema,
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
 * Every read Action reaches the provider and the exact account, so both grants are declared on all
 * three.
 *
 * `scan` and `get` additionally declare the exact account path their configured instance carries, so
 * the host cross-checks at declaration time that the credential each one asks for is the one this
 * purpose was granted. `scan`'s published input is a two-arm union — the deliberate shape that makes
 * a mid-scan limit change unrepresentable — and the canonical Action validator resolves a bound path
 * through every arm, requiring the same exact qualified credential ref in each; a path either arm
 * narrowed differently, or omitted, is refused. `listInstances` carries no account at all, because
 * producing account references is what it does, so it has no path to bind.
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
      requiredHostMethods: ['executeAction'],
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
    translations: [
      { locale: 'en', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["en"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["en"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PRs & Issues', 'plugins.bitbucket.settings.sources.subtitle': 'Choose which Bitbucket Cloud accounts and workspaces appear in PRs & Issues.' } },
      { locale: 'ru', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["ru"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["ru"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PR и задачи', 'plugins.bitbucket.settings.sources.subtitle': 'Выберите учетные записи и рабочие пространства Bitbucket Cloud, которые будут отображаться в разделе PR и задач.' } },
      { locale: 'pl', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["pl"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["pl"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PR-y i zgłoszenia', 'plugins.bitbucket.settings.sources.subtitle': 'Wybierz konta i obszary robocze Bitbucket Cloud wyświetlane w sekcji PR-ów i zgłoszeń.' } },
      { locale: 'es', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["es"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["es"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PR e incidencias', 'plugins.bitbucket.settings.sources.subtitle': 'Elige qué cuentas y espacios de trabajo de Bitbucket Cloud aparecen en PR e incidencias.' } },
      { locale: 'fr', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["fr"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["fr"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PR et tickets', 'plugins.bitbucket.settings.sources.subtitle': 'Choisissez les comptes et espaces de travail Bitbucket Cloud affichés dans PR et tickets.' } },
      { locale: 'it', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["it"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["it"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PR e segnalazioni', 'plugins.bitbucket.settings.sources.subtitle': 'Scegli gli account e gli spazi di lavoro Bitbucket Cloud da mostrare in PR e segnalazioni.' } },
      { locale: 'pt', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["pt"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["pt"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PRs e problemas', 'plugins.bitbucket.settings.sources.subtitle': 'Escolha as contas e os espaços de trabalho Bitbucket Cloud apresentados em PRs e problemas.' } },
      { locale: 'ca', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["ca"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["ca"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PR i incidències', 'plugins.bitbucket.settings.sources.subtitle': 'Tria els comptes i espais de treball de Bitbucket Cloud que es mostren a PR i incidències.' } },
      { locale: 'zh-Hans', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["zh-Hans"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["zh-Hans"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PR 和问题', 'plugins.bitbucket.settings.sources.subtitle': '选择要在 PR 和问题中显示的 Bitbucket Cloud 帐户和工作区。' } },
      { locale: 'zh-Hant', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["zh-Hant"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["zh-Hant"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PR 與問題', 'plugins.bitbucket.settings.sources.subtitle': '選擇要在 PR 與問題中顯示的 Bitbucket Cloud 帳戶和工作區。' } },
      { locale: 'ja', messages: { ...BITBUCKET_RENDER_UI_TRANSLATIONS["ja"], ...BITBUCKET_ADDITIONAL_UI_TRANSLATIONS["ja"], 'plugins.bitbucket.settings.group': 'Bitbucket Cloud', 'plugins.bitbucket.settings.sources': 'PR と課題', 'plugins.bitbucket.settings.sources.subtitle': 'PR と課題に表示する Bitbucket Cloud アカウントとワークスペースを選択します。' } },
    ],
  },
  actions: {
    [BITBUCKET_TRIAGE_ACTION_IDS.listInstances]: {
      title: 'Discover Bitbucket Cloud workspaces',
      description: 'Enumerates the workspaces reachable by each authorized Bitbucket Cloud account.',
      scopes: ['global'],
      surfaces: sources.operations.listInstances.declaration.surfaces,
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
      execution: { target: 'daemon' },
      dangerLevel: sources.operations.get.declaration.dangerLevel,
      inputSchema: sources.operations.get.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.get.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: getBitbucketSourceEntryAction,
    },
    // The three source-native detail planes. Their published surface is
    // `plugin`, so the only caller that reaches them is this plugin's own
    // mounted detail artifact.
    [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listActivity]: {
      title: 'Read a Bitbucket activity page',
      description: 'Reads one bounded page of the combined approval, update and comment activity'
        + ' of one pull request.',
      scopes: ['global'],
      surfaces: ['plugin'],
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
      surfaces: ['plugin'],
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
      surfaces: ['plugin'],
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
      surfaces: ['plugin'],
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
      surfaces: ['plugin'],
      execution: { target: 'daemon' },
      dangerLevel: 'safe',
      inputSchema: BitbucketCommentsInputV1Schema.jsonSchema,
      resultSchema: BitbucketCommentsResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: listBitbucketComments,
    },
    // The four enabled Bitbucket pull-request writes.
    //
    // `surfaces: ['ui', 'plugin']` is the human gate, and the gate is reachability rather than a
    // prompt: with no `agent` and no `mcp` surface not one of them is agent-reachable at all. A
    // `danger` level plus `agent: true` would only floor an agent invocation to an approval
    // prompt, which is a weaker guarantee — so there is no list of exempt callers here, and none
    // may be added. `plugin` is the other half of that same reachability fact, and it is required
    // rather than optional: this plugin's own mounted detail artifact dispatches as a plugin
    // caller, so a write missing it is refused before it runs and no user can reach it either.
    //
    // Every one reaches the provider and the exact configured account, and every one binds the
    // account path its configured instance carries, exactly as `scan` and `get` do. A write Action
    // declaring neither grant would be a manifest defect rather than a runtime one.
    [BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.merge]: {
      title: 'Merge a Bitbucket pull request',
      description: 'Merges one pull request with the exact strategy and source-branch decision the'
        + ' user chose, only while its head is still the commit they saw.',
      scopes: ['global'],
      surfaces: ['ui', 'plugin'],
      placementBindings: ['detailsPanel'],
      execution: { target: 'daemon' },
      // Irreversible on the forge, and it may delete the source branch.
      dangerLevel: 'destructive',
      // The host-owned confirmation a `destructive` UI Action must declare. The body names the two
      // consequences a user cannot take back — the merge itself, and the branch decision they made
      // — rather than asking "are you sure" about an unnamed effect.
      confirmation: {
        title: 'Merge this pull request?',
        body: 'Merging is permanent on Bitbucket. The source branch is deleted only if you chose'
          + ' that, and the merge runs against the commit shown here — if new commits arrive first,'
          + ' nothing is merged and you are asked again.',
        confirmLabel: 'Merge',
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
      surfaces: ['ui', 'plugin'],
      placementBindings: ['detailsPanel'],
      execution: { target: 'daemon' },
      dangerLevel: 'writesRemote',
      // Bitbucket has no reopen: the state enum is OPEN | MERGED | DECLINED | SUPERSEDED and no
      // `/reopen` path exists. The confirmation says exactly that, because a user who expects the
      // GitHub or GitLab affordance would otherwise assume they can undo this.
      confirmation: {
        title: 'Decline this pull request?',
        body: 'Bitbucket cannot reopen a declined pull request through its API. To bring this work'
          + ' back you would have to open a new pull request.',
        confirmLabel: 'Decline',
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
      surfaces: ['ui', 'plugin'],
      placementBindings: ['detailsPanel'],
      execution: { target: 'daemon' },
      dangerLevel: 'writesRemote',
      confirmation: {
        title: 'Resolve this comment thread?',
        body: 'Everyone on the pull request sees it as resolved. Nothing in the conversation is'
          + ' changed, and it can be reopened afterwards.',
        confirmLabel: 'Resolve',
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
      surfaces: ['ui', 'plugin'],
      placementBindings: ['detailsPanel'],
      execution: { target: 'daemon' },
      dangerLevel: 'writesRemote',
      confirmation: {
        title: 'Reopen this comment thread?',
        body: 'Everyone on the pull request sees it as open again. Nothing in the conversation is'
          + ' changed, and it can be resolved again afterwards.',
        confirmLabel: 'Reopen',
      },
      inputSchema: BitbucketCommentResolutionInputV1Schema.jsonSchema,
      resultSchema: BitbucketCommentResolutionResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: unresolveBitbucketCommentAction,
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
      runtime: { adapter: bitbucketApiAdapter },
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
                id: 'identity',
                title: 'Email or username',
                description: 'The email address or username associated with the Bitbucket API token.',
                schema: { type: 'string', minLength: 1 },
                secret: false,
              },
              {
                id: 'token',
                title: 'API token',
                // App passwords reached end of life on 2026-07-28 and no longer work, so there is
                // nothing to fall back to and nothing to name but an API token.
                description: 'A Bitbucket API token with repository access.',
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
          },
          // `prepareReviewWorkspace` is deliberately unbound: it is an optional role, and binding
          // it would claim a worktree materialization contract this provider has not implemented.
          surfaces: { detail: { renderer: BITBUCKET_TRIAGE_DETAIL_RENDERER_ID } },
        }),
      },
    },
  },
});

/** The sole Bitbucket plugin manifest. */
export const PLUGIN_MANIFEST = BITBUCKET_PLUGIN.manifest;
