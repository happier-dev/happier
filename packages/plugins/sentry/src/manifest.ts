import { sentryDetailTabDeclaration } from './ui/detail/tabDeclarations.js';
import { SENTRY_ACCOUNT_ACTIONS, READ_HOST_ACCESS } from './accountActions.js';
import { defineComposerReference, definePlugin } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { createPluginEventAutomationSetupResultV1JsonSchema, PluginEventAutomationHistoryGapResetActionInputV1JsonSchema, PluginEventAutomationHistoryGapResetActionResultV1JsonSchema } from '@happier-dev/plugin-sdk/events';
import { createTriageIssueEventSourceSetupV1, TriageIssueEventSetupInputV1Schema, TriageIssueEventSourceConfigV1Schema, TriageIssueTransitionV1Schema, TRIAGE_ISSUE_EVENT_SETUP_INPUT_HINTS_V1, TRIAGE_ISSUE_CHECKPOINT_COLLECTION_V1 } from '@happier-dev/triage-sources/runtime';
import { runSentryIssueObserver, resetSentryIssueHistoryGap } from './source/issueObserver.js';

import { TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, TriageSourcesContributionProtocolV1 } from '@happier-dev/triage-protocol/v1';

import { SENTRY_ACCOUNT_NETWORK_HOST_ACCESS_ID, SENTRY_ACTION_IDS, SENTRY_CLOUD_NETWORK_HOST_ACCESS_ID, SENTRY_CLOUD_REGIONS, SENTRY_CLOUD_REGION_ORIGINS, SENTRY_CONNECTED_ACCOUNT_ID, SENTRY_CONNECTED_ACCOUNT_PURPOSE, SENTRY_CONTRIBUTION_ID, SENTRY_ENTRY_KIND_ID, SENTRY_EVIDENCE_REFERENCE_ID, SENTRY_SOURCE_DISPLAY_NAME, SENTRY_TRIAGE_SETTINGS_ARTIFACT_ID, SENTRY_TRIAGE_SETTINGS_GROUP_ID, SENTRY_TRIAGE_SETTINGS_PAGE_ID, SENTRY_TRIAGE_SETTINGS_RENDERER_ID, SENTRY_PLUGIN_ID } from './sentryContracts.js';
import { SENTRY_CLOUD_MODE_ID, SENTRY_ORIGIN_CONFIGURATION_FIELD, SENTRY_REGION_CONFIGURATION_FIELD, SENTRY_SELF_HOSTED_MODE_ID, sentryConnectedAccountRuntime, sentryPortableAccountRuntime } from './auth/connectedAccountRuntime.js';

import { resolveSentryEvidenceReference, searchSentryEvidenceReferences } from './composer/reference.js';

/** The detail surface's declared renderer and the UI artifact it mounts. */
export const SENTRY_DETAIL_RENDERER_ID = 'sentry-detail';
export const SENTRY_DETAIL_ARTIFACT_ID = 'sentry-detail-native';
/**
 * The declarative fallback in the detail renderer chain (`SENTRY.md` §7.2).
 *
 * A host that cannot mount the React Native artifact must still be told what it
 * is looking at. The declarative node vocabulary carries no binding to the
 * launched entry, so this renderer states only what it can honestly state — an
 * empty region and a fabricated summary are both worse than one true sentence.
 */
export const SENTRY_DETAIL_FALLBACK_RENDERER_ID = 'sentry-detail-fallback';

const sources = TriageSourcesContributionProtocolV1;

/**
 * The bound source Action ids are re-exported from the stable contracts module
 * rather than restated: the Action id is the identity the contribution, the
 * activation spine and every conformance check must agree on.
 */
export { SENTRY_ACTION_IDS };

/**
 * The `sentry-account` deployment fields (`SENTRY.md` §2.3).
 *
 * Both are explicit non-secret Connected Account configuration, so the host —
 * not this source — resolves them, admits them at HostAccess, and republishes
 * the result as the account's `connectedAccountOrigins`. That published value is
 * this vertical's only routing authority: nothing here guesses, probes,
 * defaults, or fans out across deployments.
 *
 * The two families differ in what the user is asked for, which is the whole
 * product point. Cloud is a **closed named region**: the descriptor declares
 * which origin each choice routes to, so the persisted value is the choice and
 * no typed text can ever widen where a Cloud token is sent. Self-hosted has no
 * closed set, so it stays the exact configured origin.
 */
const CLOUD_REGION_FIELD = {
  id: SENTRY_REGION_CONFIGURATION_FIELD,
  title: {
    key: 'plugins.sentry.auth.region.title',
    fallback: 'Sentry Cloud region',
  },
  description: {
    key: 'plugins.sentry.auth.region.description',
    fallback: 'Choose the region that stores this organization’s data.'
      + ' A connection serves one region; add a second connection for the other.',
  },
  semantic: 'connectedAccountFixedOrigin' as const,
  schema: { type: 'string' as const, enum: [...SENTRY_CLOUD_REGIONS] },
  originByValue: { ...SENTRY_CLOUD_REGION_ORIGINS },
  required: true as const,
  secret: false as const,
};

const SELF_HOSTED_ORIGIN_FIELD = {
  id: SENTRY_ORIGIN_CONFIGURATION_FIELD,
  title: { key: 'plugins.sentry.auth.origin.title', fallback: 'Sentry URL' },
  description: {
    key: 'plugins.sentry.auth.origin.description',
    fallback: 'The origin of your self-hosted Sentry, for example https://sentry.example.com.',
  },
  semantic: 'connectedAccountOrigin' as const,
  // Canonical origin parsing/admission is host-owned. Do not add a second URL
  // length policy at the provider declaration.
  schema: { type: 'string' as const, minLength: 1 },
  required: true as const,
  secret: false as const,
};

const TOKEN_FIELD = {
  id: 'token',
  title: { key: 'plugins.sentry.auth.token.title', fallback: 'Sentry auth token' },
  description: {
    key: 'plugins.sentry.auth.token.description',
    fallback: 'An internal-integration or personal token with org:read and event:read. Issue writes additionally need event:write.',
  },
  schema: { type: 'string' as const, minLength: 1 },
  secret: true as const,
};

/**
 * The source descriptor.
 *
 * Sentry contributes one kind. An error group is not a pull request or a code
 * issue, and flattening it into either would make the aggregate lie about what
 * the row is.
 */
const SENTRY_SOURCE_DESCRIPTOR = {
  v: 1 as const,
  purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
  // The page this source's own Settings contribution ships, so the PRs & Issues
  // surface can offer a working Configure action. A BARE local id — the target
  // qualifies it with the contributor identity the host already admitted.
  settingsPageId: SENTRY_TRIAGE_SETTINGS_PAGE_ID,
  displayName: SENTRY_SOURCE_DISPLAY_NAME,
  scopeUnit: { singularLabel: 'Project', pluralLabel: 'Projects' },
  kinds: [{
    id: SENTRY_ENTRY_KIND_ID,
    workflowSubject: 'errorIssue' as const,
    displayName: 'Error issue',
    pluralDisplayName: 'Error issues',
    // r0.42: the Triage detail frame draws these tabs and asks this source for
    // each as a panel. Files and Checks come from the linked fix PR; this
    // source's own views follow the shared tabs.
    detailTabs: [
      { kind: 'shared' as const, id: 'overview' as const, scrollOwner: sentryDetailTabDeclaration('overview').scrollOwner },
      { kind: 'shared' as const, id: 'activity' as const, scrollOwner: sentryDetailTabDeclaration('activity').scrollOwner },
      { kind: 'source' as const, id: 'stack-trace', scrollOwner: sentryDetailTabDeclaration('stack-trace').scrollOwner, title: 'Stack trace', titleKey: 'plugins.sentry.ui.tab.stackTrace' },
      // The row's own event count is the Occurrences tab's summary.
      { kind: 'source' as const, id: 'occurrences', scrollOwner: sentryDetailTabDeclaration('occurrences').scrollOwner, title: 'Occurrences', titleKey: 'plugins.sentry.ui.tab.occurrences', summaryFact: 'events' },
      { kind: 'source' as const, id: 'release', scrollOwner: sentryDetailTabDeclaration('release').scrollOwner, title: 'Release', titleKey: 'plugins.sentry.ui.tab.release' },
    ],
    // Resolve and Archive are the issue's own actions: the frame places them in its header (its ⋯), not under
    // the story.
    detailActions: true as const,
  }],
};

/**
 * Every read Action reaches the provider and the exact account, so both grants
 * are declared on all of them.
 *
 * Each Action that *receives* an account also declares where that account is.
 * `scan` was previously the exception: its published input is a two-arm union —
 * the deliberate shape that makes a mid-scan limit change unrepresentable — and
 * the canonical Action parser used to walk only a top-level object input, so the
 * binding was structurally unavailable. The parser now walks every arm of a
 * union input and requires the bound leaf to agree across them, so `scan`
 * declares the same binding as the rest and the declaration-time credential
 * check covers the whole read surface rather than most of it.
 *
 * `listInstances` still carries no account at all, because producing account
 * references is what it performs.
 */

export const SENTRY_PLUGIN = definePlugin({
  id: SENTRY_PLUGIN_ID,
  version: '0.0.0',
  displayName: 'Sentry',
  description: 'Brings Sentry error issues into PRs & Issues with their own detail body.',
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: {
    'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },
    "i18n-en": { kind: 'asset', path: "assets/i18n/en.json", contentType: 'application/json' },
    "i18n-ru": { kind: 'asset', path: "assets/i18n/ru.json", contentType: 'application/json' },
    "i18n-pl": { kind: 'asset', path: "assets/i18n/pl.json", contentType: 'application/json' },
    "i18n-es": { kind: 'asset', path: "assets/i18n/es.json", contentType: 'application/json' },
    "i18n-fr": { kind: 'asset', path: "assets/i18n/fr.json", contentType: 'application/json' },
    "i18n-it": { kind: 'asset', path: "assets/i18n/it.json", contentType: 'application/json' },
    "i18n-pt": { kind: 'asset', path: "assets/i18n/pt.json", contentType: 'application/json' },
    "i18n-de": { kind: 'asset', path: "assets/i18n/de.json", contentType: 'application/json' },
    "i18n-ca": { kind: 'asset', path: "assets/i18n/ca.json", contentType: 'application/json' },
    "i18n-zh-hans": { kind: 'asset', path: "assets/i18n/zh-Hans.json", contentType: 'application/json' },
    "i18n-zh-hant": { kind: 'asset', path: "assets/i18n/zh-Hant.json", contentType: 'application/json' },
    "i18n-ja": { kind: 'asset', path: "assets/i18n/ja.json", contentType: 'application/json' },
  },
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  composer: {
    references: {
      [SENTRY_EVIDENCE_REFERENCE_ID]: defineComposerReference({
        title: 'Sentry occurrence',
        icon: 'error',
        search: searchSentryEvidenceReferences,
        resolve: resolveSentryEvidenceReference,
      }),
    },
  },
  notifications: {
    'issue-alerts': { kind: 'plugin', title: 'Issue alerts', eventIds: ['issue-transition'] },
  },
  events: {
    'issue-transition': { declaration: {
      kind: 'event', title: 'Sentry issue changed', description: 'A watched issue opened, changed, or resolved.',
      payloadSchema: TriageIssueTransitionV1Schema.jsonSchema,
      automation: { v: 1, eligible: true, source: {
        sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull'],
        sourceConfigSchema: TriageIssueEventSourceConfigV1Schema.jsonSchema,
        setupActionRef: { pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_ACTION_IDS.setupIssueEvent },
        historyGapResetActionRef: { pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_ACTION_IDS.resetIssueEvent },
        connectedAccountPurposeBindings: [{ path: 'instance.binding.account', purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE }],
      } },
    } },
  },
  accountCollections: { [TRIAGE_ISSUE_CHECKPOINT_COLLECTION_V1.id]: TRIAGE_ISSUE_CHECKPOINT_COLLECTION_V1 },
  backgroundServices: [{ declaration: { id: 'issue-observer', title: 'Sentry issue observer' }, runner: runSentryIssueObserver }],
  webhooks: { 'issue-attention': {
    title: 'Sentry assignment attention', description: 'Receives verified issue assignment and resolution deliveries.',
    verifier: { kind: 'sentry_hmac_sha256_v1', routing: 'accountEndpoint' },
    handlerAction: { localId: 'sentry/accept-attention-webhook' },
  } },
  hostAccess: {
    required: [{
      id: 'issue-checkpoint-storage', capability: 'storage.account',
      reason: 'Retain issue transition checkpoints for enabled source observers.', scope: { enabled: true },
    }, {
      id: SENTRY_CLOUD_NETWORK_HOST_ACCESS_ID,
      capability: 'network',
      reason: 'Read Sentry organizations, issues, events and tags, and update individual issues on the two Sentry Cloud regions.',
      scope: {
        targets: [
          { kind: 'fixedOrigin', origin: SENTRY_CLOUD_REGION_ORIGINS.us },
          { kind: 'fixedOrigin', origin: SENTRY_CLOUD_REGION_ORIGINS.de },
        ],
        // Exact issue writes need event:write, never event:admin or DELETE.
        methods: ['GET', 'PUT'],
        // No `privateNetwork` here, deliberately: the Cloud origins are public
        // by definition and must not widen when a self-hosted user grants their
        // own deployment private reach. The flag is scope-level, so a separate
        // grant is the only way to hold that line.
        //
        // Final HTTP admission resolves and pins the selected Cloud hostname,
        // so a private answer is refused under this non-private grant. This
        // separate scope still decides which declared origins may be private.
      },
    }, {
      id: SENTRY_ACCOUNT_NETWORK_HOST_ACCESS_ID,
      capability: 'network',
      reason: 'Read Sentry organizations, issues, events and tags, and update individual issues on the exact deployment the'
        + ' selected Connected Account is configured for, which for a self-hosted Sentry may be'
        + ' on a private network.',
      scope: {
        targets: [{ kind: 'connectedAccountOrigin', service: SENTRY_CONNECTED_ACCOUNT_ID }],
        methods: ['GET', 'PUT'],
        // The self-hosted auth mode is in V1 scope, and a self-hosted Sentry
        // may live on a private network. Removing that mode must remove this in
        // the same change.
        privateNetwork: true,
      },
    }, {
      id: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
      capability: 'connectedAccounts',
      reason: 'Materialize only the exact selected Sentry Connected Account for Sentry API requests.',
      scope: {
        serviceRefs: [SENTRY_CONNECTED_ACCOUNT_ID],
        operations: ['use'],
        materializationKinds: ['httpHeaders'],
      },
    }],
    optional: [],
  },
  ui: {
    views: [],
    renderers: [{
      id: SENTRY_DETAIL_RENDERER_ID,
      kind: 'reactNative',
      artifact: SENTRY_DETAIL_ARTIFACT_ID,
      // The detail body reads through this plugin's own Actions, so a mount
      // without them would render an empty shell rather than a useful surface.
      requiredHostMethods: ['executeAction'],
    }, {
      id: SENTRY_DETAIL_FALLBACK_RENDERER_ID,
      kind: 'declarative',
      root: {
        kind: 'text',
        text: {
          key: 'plugins.sentry.detail.fallback.body',
          fallback: 'Sentry issue details are unavailable on this surface.',
        },
      },
    }, {
      id: SENTRY_TRIAGE_SETTINGS_RENDERER_ID,
      kind: 'reactNative',
      artifact: SENTRY_TRIAGE_SETTINGS_ARTIFACT_ID,
      // The page's whole purpose is two Action invocations — this source's own
      // discovery read and the target-owned administration write.
      requiredHostMethods: ['executeAction', 'openConnectedAccounts'],
    }],
    settingsGroups: [{
      id: SENTRY_TRIAGE_SETTINGS_GROUP_ID,
      title: { key: 'plugins.sentry.settings.group', fallback: 'Sentry' },
      icon: 'settings',
      defaultRank: 40,
    }],
    settingsPages: [{
      id: SENTRY_TRIAGE_SETTINGS_PAGE_ID,
      group: { kind: 'plugin', localId: SENTRY_TRIAGE_SETTINGS_GROUP_ID },
      title: { key: 'plugins.sentry.settings.sources', fallback: 'PRs & Issues' },
      subtitle: {
        key: 'plugins.sentry.settings.sources.subtitle',
        fallback: 'Choose which Sentry organizations appear in PRs & Issues.',
      },
      keywords: ['sentry', 'errors', 'issues', 'triage'],
      icon: 'settings',
      defaultRank: 10,
      renderer: SENTRY_TRIAGE_SETTINGS_RENDERER_ID,
    }],
    translations: [
      { locale: "en", resourceId: "i18n-en" },
      { locale: "ru", resourceId: "i18n-ru" },
      { locale: "pl", resourceId: "i18n-pl" },
      { locale: "es", resourceId: "i18n-es" },
      { locale: "fr", resourceId: "i18n-fr" },
      { locale: "it", resourceId: "i18n-it" },
      { locale: "pt", resourceId: "i18n-pt" },
      { locale: "de", resourceId: "i18n-de" },
      { locale: "ca", resourceId: "i18n-ca" },
      { locale: "zh-Hans", resourceId: "i18n-zh-hans" },
      { locale: "zh-Hant", resourceId: "i18n-zh-hant" },
      { locale: "ja", resourceId: "i18n-ja" },
    ],
  },
  actions: {
    ...SENTRY_ACCOUNT_ACTIONS,
    'sentry/accept-attention-webhook': {
      title: 'Accept verified Sentry attention', description: 'Projects a verified assignment delivery into Triage attention.',
      surfaces: ['plugin'], dangerLevel: 'writesRemote',
      inputSchema: PluginWebhookActionInputSchema.jsonSchema, resultSchema: PluginWebhookActionResultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS, run: acceptSentryAttentionWebhook,
    },
    [SENTRY_ACTION_IDS.resetIssueEvent]: {
      title: 'Check Sentry issue baseline', surfaces: ['plugin'], dangerLevel: 'safe',
      inputSchema: PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
      resultSchema: PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
      run: resetSentryIssueHistoryGap,
    },
    [SENTRY_ACTION_IDS.setupIssueEvent]: {
      title: 'Watch Sentry issues',
      description: 'Prepares an existing configured source for issue alerts without changing it.',
      surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], dangerLevel: 'safe',
      inputSchema: TriageIssueEventSetupInputV1Schema.jsonSchema,
      inputHints: TRIAGE_ISSUE_EVENT_SETUP_INPUT_HINTS_V1,
      resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, TriageIssueEventSourceConfigV1Schema.jsonSchema),
      run: createTriageIssueEventSourceSetupV1({ pluginId: SENTRY_PLUGIN_ID, sourceLocalId: SENTRY_CONTRIBUTION_ID, displayName: 'Sentry' }),
    },
  },
  connectedAccountDescriptors: {
    [SENTRY_CONNECTED_ACCOUNT_ID]: {
      declaration: {
        title: { key: 'plugins.sentry.account.title', fallback: 'Sentry account' },
        description: {
          key: 'plugins.sentry.account.description',
          fallback: 'Sentry deployment and auth token used to read organizations and issues.',
        },
        authentication: {
          account: { artifactId: 'sentry-account-runtime', exportName: 'activate' },
          defaultModeId: SENTRY_CLOUD_MODE_ID,
          modes: [{
            id: SENTRY_CLOUD_MODE_ID,
            kind: 'manual',
            setup: {
              url: 'https://sentry.io',
              checklist: ['In your Sentry organization settings, create an internal integration and its auth token, or use a personal auth token.', 'Give the token org:read and event:read; issue updates also need event:write.', 'Copy the token and select the region that stores your organization data.'],
              createKeyTitle: 'Open Sentry',
            },
            credentialOrigin: 'authentication',
            directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
            title: { key: 'plugins.sentry.auth.cloud.title', fallback: 'Sentry Cloud token' },
            outcomeReconciliation: 'none',
            fields: [TOKEN_FIELD],
            configuration: {
              scope: 'account',
              // Changing the deployment is not an update of the same
              // connection: it retires the old configured instance and starts a
              // full scan for the new one.
              changeBehavior: 'reconnect',
              fields: [CLOUD_REGION_FIELD],
            },
          }, {
            id: SENTRY_SELF_HOSTED_MODE_ID,
            kind: 'manual',
            setup: {
              url: 'https://docs.sentry.io/api/auth/',
              checklist: ['Create an internal-integration or personal auth token on your own Sentry deployment.', 'Give the token org:read and event:read; issue updates also need event:write.', 'Paste the token and enter the URL of that same deployment.'],
              createKeyTitle: 'Read Sentry authentication instructions',
            },
            credentialOrigin: 'authentication',
            directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
            title: {
              key: 'plugins.sentry.auth.selfHosted.title',
              fallback: 'Self-hosted Sentry token',
            },
            outcomeReconciliation: 'none',
            fields: [TOKEN_FIELD],
            configuration: {
              scope: 'account',
              changeBehavior: 'reconnect',
              fields: [SELF_HOSTED_ORIGIN_FIELD],
            },
          }],
        },
      },
      runtime: sentryConnectedAccountRuntime, accountRuntime: sentryPortableAccountRuntime,
    },
  },
  contributesTo: {
    [TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1]: {
      [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: {
        [SENTRY_CONTRIBUTION_ID]: sources.contribute({
          descriptor: SENTRY_SOURCE_DESCRIPTOR,
          operations: {
            listInstances: sources.operations.listInstances.bind(SENTRY_ACTION_IDS.listInstances),
            listScopeUnits: sources.operations.listScopeUnits.bind(SENTRY_ACTION_IDS.listScopeUnits),
            scan: sources.operations.scan.bind(SENTRY_ACTION_IDS.scan),
            get: sources.operations.get.bind(SENTRY_ACTION_IDS.get),
          },
          surfaces: {
            detail: {
              renderer: SENTRY_DETAIL_RENDERER_ID,
              fallbackRenderers: [SENTRY_DETAIL_FALLBACK_RENDERER_ID],
            },
          },
        }),
      },
    },
  },
});

/** The sole Sentry plugin manifest. */
export const PLUGIN_MANIFEST = SENTRY_PLUGIN.manifest;
export const collectionMigrations = SENTRY_PLUGIN.collectionMigrations;
import { acceptSentryAttentionWebhook } from './source/attentionWebhook.js';
import { PluginWebhookActionInputSchema, PluginWebhookActionResultSchema } from '@happier-dev/plugin-sdk/webhooks';
