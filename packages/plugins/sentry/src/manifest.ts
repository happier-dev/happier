import { definePlugin } from '@happier-dev/plugin-sdk';
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
  TriageSourcesContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';

import {
  SENTRY_ACCOUNT_NETWORK_HOST_ACCESS_ID,
  SENTRY_ACTION_IDS,
  SENTRY_CLOUD_NETWORK_HOST_ACCESS_ID,
  SENTRY_CLOUD_REGIONS,
  SENTRY_CLOUD_REGION_ORIGINS,
  SENTRY_CONNECTED_ACCOUNT_ID,
  SENTRY_CONNECTED_ACCOUNT_PURPOSE,
  SENTRY_CONTRIBUTION_ID,
  SENTRY_ENTRY_KIND_ID,
  SENTRY_SOURCE_DISPLAY_NAME,
  SENTRY_TRIAGE_SETTINGS_ARTIFACT_ID,
  SENTRY_TRIAGE_SETTINGS_GROUP_ID,
  SENTRY_TRIAGE_SETTINGS_PAGE_ID,
  SENTRY_TRIAGE_SETTINGS_RENDERER_ID,
  SENTRY_PLUGIN_ID,
} from './sentryContracts.js';
import {
  SENTRY_CLOUD_MODE_ID,
  SENTRY_ORIGIN_CONFIGURATION_FIELD,
  SENTRY_REGION_CONFIGURATION_FIELD,
  SENTRY_SELF_HOSTED_MODE_ID,
  sentryConnectedAccountRuntime,
} from './auth/connectedAccountRuntime.js';
import { SENTRY_UI_TRANSLATIONS } from './ui/translations.js';
import {
  SentryIssueEventsInputV1Schema,
  SentryIssueEventsResultV1Schema,
  SentryReadEventInputV1Schema,
  SentryReadEventResultV1Schema,
  SentryReadIssueInputV1Schema,
  SentryReadIssueResultV1Schema,
  SentryTagValuesInputV1Schema,
  SentryTagValuesResultV1Schema,
} from './detail/detailContracts.js';
import {
  listSentryIssueEvents,
  listSentryTagValues,
  readSentryEvent,
  readSentryIssue,
} from './source/detailOperations.js';
import {
  getSentrySourceEntry,
  listSentryInstances,
  scanSentrySource,
} from './source/operations.js';

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
    fallback: 'An internal-integration or personal token with org:read and event:read.',
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
  kinds: [{
    id: SENTRY_ENTRY_KIND_ID,
    workflowSubject: 'errorIssue' as const,
    displayName: 'Error issue',
    pluralDisplayName: 'Error issues',
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
const READ_HOST_ACCESS = [
  SENTRY_CONNECTED_ACCOUNT_PURPOSE,
  SENTRY_CLOUD_NETWORK_HOST_ACCESS_ID,
  SENTRY_ACCOUNT_NETWORK_HOST_ACCESS_ID,
];
const INSTANCE_ACCOUNT_BINDINGS = [{
  path: 'instance.binding.account',
  purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
}];

export const SENTRY_PLUGIN = definePlugin({
  id: SENTRY_PLUGIN_ID,
  version: '0.0.0',
  displayName: 'Sentry',
  description: 'Brings Sentry error issues into PRs & Issues with their own detail body.',
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: SENTRY_CLOUD_NETWORK_HOST_ACCESS_ID,
      capability: 'network',
      reason: 'Read Sentry organizations, issues, events and tags on the two Sentry Cloud regions.',
      scope: {
        targets: [
          { kind: 'fixedOrigin', origin: SENTRY_CLOUD_REGION_ORIGINS.us },
          { kind: 'fixedOrigin', origin: SENTRY_CLOUD_REGION_ORIGINS.de },
        ],
        // V1 is read-only. `event:admin` is never requested and no mutation
        // route exists, so no other method is admitted.
        methods: ['GET'],
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
      reason: 'Read Sentry organizations, issues, events and tags on the exact deployment the'
        + ' selected Connected Account is configured for, which for a self-hosted Sentry may be'
        + ' on a private network.',
      scope: {
        targets: [{ kind: 'connectedAccountOrigin', service: SENTRY_CONNECTED_ACCOUNT_ID }],
        methods: ['GET'],
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
      requiredHostMethods: ['executeAction'],
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
      { locale: 'en', messages: { ...SENTRY_UI_TRANSLATIONS.en, 'plugins.sentry.settings.group': 'Sentry', 'plugins.sentry.settings.sources': 'PRs & Issues', 'plugins.sentry.settings.sources.subtitle': 'Choose which Sentry organizations appear in PRs & Issues.' } },
      { locale: 'ru', messages: { ...SENTRY_UI_TRANSLATIONS.ru, 'plugins.sentry.settings.group': 'Sentry', 'plugins.sentry.settings.sources': 'PR и задачи', 'plugins.sentry.settings.sources.subtitle': 'Выберите организации Sentry, которые будут отображаться в разделе PR и задач.' } },
      { locale: 'pl', messages: { ...SENTRY_UI_TRANSLATIONS.pl, 'plugins.sentry.settings.group': 'Sentry', 'plugins.sentry.settings.sources': 'PR-y i zgłoszenia', 'plugins.sentry.settings.sources.subtitle': 'Wybierz organizacje Sentry wyświetlane w sekcji PR-ów i zgłoszeń.' } },
      { locale: 'es', messages: { ...SENTRY_UI_TRANSLATIONS.es, 'plugins.sentry.settings.group': 'Sentry', 'plugins.sentry.settings.sources': 'PR e incidencias', 'plugins.sentry.settings.sources.subtitle': 'Elige qué organizaciones de Sentry aparecen en PR e incidencias.' } },
      { locale: 'fr', messages: { ...SENTRY_UI_TRANSLATIONS.fr, 'plugins.sentry.settings.group': 'Sentry', 'plugins.sentry.settings.sources': 'PR et tickets', 'plugins.sentry.settings.sources.subtitle': 'Choisissez les organisations Sentry affichées dans PR et tickets.' } },
      { locale: 'it', messages: { ...SENTRY_UI_TRANSLATIONS.it, 'plugins.sentry.settings.group': 'Sentry', 'plugins.sentry.settings.sources': 'PR e segnalazioni', 'plugins.sentry.settings.sources.subtitle': 'Scegli le organizzazioni Sentry da mostrare in PR e segnalazioni.' } },
      { locale: 'pt', messages: { ...SENTRY_UI_TRANSLATIONS.pt, 'plugins.sentry.settings.group': 'Sentry', 'plugins.sentry.settings.sources': 'PRs e problemas', 'plugins.sentry.settings.sources.subtitle': 'Escolha as organizações Sentry apresentadas em PRs e problemas.' } },
      { locale: 'ca', messages: { ...SENTRY_UI_TRANSLATIONS.ca, 'plugins.sentry.settings.group': 'Sentry', 'plugins.sentry.settings.sources': 'PR i incidències', 'plugins.sentry.settings.sources.subtitle': 'Tria les organitzacions de Sentry que es mostren a PR i incidències.' } },
      { locale: 'zh-Hans', messages: { ...SENTRY_UI_TRANSLATIONS['zh-Hans'], 'plugins.sentry.settings.group': 'Sentry', 'plugins.sentry.settings.sources': 'PR 和问题', 'plugins.sentry.settings.sources.subtitle': '选择要在 PR 和问题中显示的 Sentry 组织。' } },
      { locale: 'zh-Hant', messages: { ...SENTRY_UI_TRANSLATIONS['zh-Hant'], 'plugins.sentry.settings.group': 'Sentry', 'plugins.sentry.settings.sources': 'PR 與問題', 'plugins.sentry.settings.sources.subtitle': '選擇要在 PR 與問題中顯示的 Sentry 組織。' } },
      { locale: 'ja', messages: { ...SENTRY_UI_TRANSLATIONS.ja, 'plugins.sentry.settings.group': 'Sentry', 'plugins.sentry.settings.sources': 'PR と課題', 'plugins.sentry.settings.sources.subtitle': 'PR と課題に表示する Sentry 組織を選択します。' } },
    ],
  },
  actions: {
    [SENTRY_ACTION_IDS.listInstances]: {
      title: 'Discover Sentry organizations',
      description: 'Lists the Sentry organizations each connected Sentry account can reach.',
      scopes: ['global'],
      surfaces: sources.operations.listInstances.declaration.surfaces,
      execution: { target: 'daemon' },
      dangerLevel: sources.operations.listInstances.declaration.dangerLevel,
      inputSchema: sources.operations.listInstances.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.listInstances.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      run: listSentryInstances,
    },
    [SENTRY_ACTION_IDS.scan]: {
      title: 'Scan Sentry issues',
      description: 'Reads one page of the configured Sentry organization issue walk.',
      scopes: ['global'],
      surfaces: sources.operations.scan.declaration.surfaces,
      execution: { target: 'daemon' },
      dangerLevel: sources.operations.scan.declaration.dangerLevel,
      inputSchema: sources.operations.scan.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.scan.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: scanSentrySource,
    },
    [SENTRY_ACTION_IDS.readIssue]: {
      title: 'Read one Sentry issue projection',
      description: 'Reads the live summary, the tag distribution, or the recorded activity of'
        + ' one Sentry issue.',
      scopes: ['global'],
      // The published Triage roles declare the `plugin` surface; these
      // source-native reads are invoked the same way, by this source's own
      // mounted detail body.
      surfaces: ['plugin'],
      execution: { target: 'daemon' },
      dangerLevel: 'safe',
      inputSchema: SentryReadIssueInputV1Schema.jsonSchema,
      resultSchema: SentryReadIssueResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: readSentryIssue,
    },
    [SENTRY_ACTION_IDS.listIssueEvents]: {
      title: 'Read retained Sentry occurrences',
      description: 'Reads one page of the events Sentry retained for one issue in the queried'
        + ' window.',
      scopes: ['global'],
      surfaces: ['plugin'],
      execution: { target: 'daemon' },
      dangerLevel: 'safe',
      inputSchema: SentryIssueEventsInputV1Schema.jsonSchema,
      resultSchema: SentryIssueEventsResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: listSentryIssueEvents,
    },
    [SENTRY_ACTION_IDS.readEvent]: {
      title: 'Read one Sentry occurrence',
      description: 'Reads the representative or one selected occurrence of a Sentry issue as a'
        + ' redacted projection.',
      scopes: ['global'],
      surfaces: ['plugin'],
      execution: { target: 'daemon' },
      dangerLevel: 'safe',
      inputSchema: SentryReadEventInputV1Schema.jsonSchema,
      resultSchema: SentryReadEventResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: readSentryEvent,
    },
    [SENTRY_ACTION_IDS.listTagValues]: {
      title: 'Read one Sentry tag distribution',
      description: 'Reads one page of the value distribution of a single tag key on one issue.',
      scopes: ['global'],
      surfaces: ['plugin'],
      execution: { target: 'daemon' },
      dangerLevel: 'safe',
      inputSchema: SentryTagValuesInputV1Schema.jsonSchema,
      resultSchema: SentryTagValuesResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: listSentryTagValues,
    },
    [SENTRY_ACTION_IDS.get]: {
      title: 'Read a Sentry issue',
      description: 'Reads one Sentry issue authoritatively through its configured organization.',
      scopes: ['global'],
      surfaces: sources.operations.get.declaration.surfaces,
      execution: { target: 'daemon' },
      dangerLevel: sources.operations.get.declaration.dangerLevel,
      inputSchema: sources.operations.get.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.get.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: getSentrySourceEntry,
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
          defaultModeId: SENTRY_CLOUD_MODE_ID,
          modes: [{
            id: SENTRY_CLOUD_MODE_ID,
            kind: 'manual',
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
      runtime: sentryConnectedAccountRuntime,
    },
  },
  contributesTo: {
    [TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1]: {
      [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: {
        [SENTRY_CONTRIBUTION_ID]: sources.contribute({
          descriptor: SENTRY_SOURCE_DESCRIPTOR,
          operations: {
            listInstances: sources.operations.listInstances.bind(SENTRY_ACTION_IDS.listInstances),
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
