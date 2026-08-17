import { definePlugin } from '@happier-dev/plugin-sdk';
import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';
import {
  TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
  TriageReadConfiguredSourceInstancesInputV1JsonSchema,
  TriageReadConfiguredSourceInstancesResultV1JsonSchema,
  TriageSourceAdministrationActionInputV1JsonSchema,
  TriageSourceAdministrationActionResultV1JsonSchema,
  TriageSourcesContributionPointV1,
} from '@happier-dev/triage-protocol/v1';

import {
  TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1,
  TriageReadEntryDetailInputV1JsonSchema,
  TriageReadEntryDetailResultV1JsonSchema,
} from './actions/entryDetailProtocol.js';

import {
  TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
  TriageListEntriesInputV1JsonSchema,
  TriageListEntriesResultV1JsonSchema,
} from './actions/listEntriesProtocol.js';
import {
  TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
  TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
  TriageListPinnedEntriesInputV1JsonSchema,
  TriageListPinnedEntriesResultV1JsonSchema,
  TriageSetEntryPinnedInputV1JsonSchema,
  TriageSetEntryPinnedResultV1JsonSchema,
} from './actions/userMarksProtocol.js';
import {
  TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1,
  TriageLinkEntryToSessionActionResultV1JsonSchema,
  TriageLinkEntryToSessionInputV1JsonSchema,
} from './actions/sessionLinksProtocol.js';
import {
  TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1,
  TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1,
  TriageAdministerSavedViewInputV1JsonSchema,
  TriageAdministerSavedViewResultV1JsonSchema,
  TriageReadSavedViewsInputV1JsonSchema,
  TriageReadSavedViewsResultV1JsonSchema,
} from './actions/savedViewsProtocol.js';
import {
  TRIAGE_ENTRIES_CONTROL_LOCAL_ID_V1,
  TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1,
  TriageComposerEntryAttachmentValueV1Schema,
} from './composer/attachmentValue.js';
import { TRIAGE_APP_PAGE_LOCAL_ID_V1 } from './composer/openEntryDetails.js';
import { CORPUS_ACCOUNT_COLLECTIONS } from './corpus/collections/definitions.js';
import { TRIAGE_SAVED_VIEWS_SETTINGS_CONTRIBUTION_V1 } from './settings/savedViewsContribution.js';
import {
  TRIAGE_ENTRIES_COMPACT_ARTIFACT_ID_V1,
  TRIAGE_ENTRIES_COMPACT_RENDERER_ID_V1,
  TRIAGE_ENTRIES_CONTROL_ICON_V1,
  TRIAGE_ENTRY_PICKER_ARTIFACT_ID_V1,
  TRIAGE_ENTRY_PICKER_RENDERER_ID_V1,
  TRIAGE_LIST_PAGE_ARTIFACT_ID_V1,
  TRIAGE_LIST_PAGE_RENDERER_ID_V1,
  TRIAGE_SESSION_ENTRIES_ARTIFACT_ID_V1,
  TRIAGE_SESSION_ENTRIES_RENDERER_ID_V1,
  TRIAGE_SESSION_ENTRIES_VIEW_ID_V1,
} from './ui/contributions.js';

/**
 * Customer-facing name for the aggregate surface. `Triage` names the program,
 * never the product: manifest, page header and Settings all read `PRs & Issues`.
 */
export const TRIAGE_DISPLAY_NAME = 'PRs & Issues';

const TRIAGE_SOURCES_POINT_DEFINITION = definePlugin({
  id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
  version: '0.0.0',
  contributionPoints: {
    [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: TriageSourcesContributionPointV1,
  },
});

/** The exact target-owned point used to observe admitted V1 source contributions. */
export const TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 =
  TRIAGE_SOURCES_POINT_DEFINITION.contributionPoints[TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1];

/**
 * The sole Triage plugin manifest.
 *
 * The plugin id is not restated here. `@happier-dev/triage-protocol` publishes
 * it as the target of every source contribution, and it is also the persisted
 * connected-account, contribution and Collection-row key — so a second literal
 * could drift into source contributions aimed at a plugin that does not exist.
 *
 * Contribution declarations are composed into `contributes` by their owning
 * lanes through the manifest integrator; no Triage contribution is declared
 * from a second manifest, package or host branch.
 */
export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
  version: '0.0.0',
  displayName: TRIAGE_DISPLAY_NAME,
  description: 'Aggregates pull requests, issues and error groups from configured sources into one reviewable surface.',
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [{
      id: 'account-storage',
      capability: 'storage.account',
      reason: 'Read and write the source instances the user configured, read the list window assembled from them, and read and write the pins the user placed on entries.',
      scope: { enabled: true },
    }],
    optional: [],
  },
  contributes: {
    pluginContributionPoints:
      TRIAGE_SOURCES_POINT_DEFINITION.manifest.contributes.pluginContributionPoints,
    accountCollections: [...CORPUS_ACCOUNT_COLLECTIONS],
    actions: [{
      id: TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
      title: 'Read the current list window',
      description: 'Reads one bounded ordered window of pull requests, issues and error groups from the configured sources.',
      scopes: ['global'],
      // The `plugin` surface, exactly as the published source roles declare:
      // the aggregate's own mounted surfaces invoke it through the incumbent
      // dispatcher, and it is a view read rather than a placed affordance, an
      // agent tool or an MCP tool. Declaring `ui` here would require a
      // placement binding and put a "read the list" button in the product.
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      inputSchema: TriageListEntriesInputV1JsonSchema,
      resultSchema: TriageListEntriesResultV1JsonSchema,
      // The one Collection it touches is `source-instances`, read-only.
      hostAccess: ['account-storage'],
    }, {
      id: TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
      title: 'Pin or unpin an entry',
      description: 'Keeps one pull request, issue or error group at the top of the list, or removes that mark again.',
      scopes: ['global'],
      // Same `plugin` surface as the list read, and for the same reason: the
      // caller is this plugin's own mounted row affordance, not a placed
      // command, an agent tool or an MCP tool.
      surfaces: ['plugin'],
      // A pin is durable user state, but the exact inverse is one press away
      // and nothing outside Happier is touched.
      dangerLevel: 'safe',
      inputSchema: TriageSetEntryPinnedInputV1JsonSchema,
      resultSchema: TriageSetEntryPinnedResultV1JsonSchema,
      hostAccess: ['account-storage'],
    }, {
      id: TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
      title: 'Read the pinned entries',
      description: 'Reads one bounded page of the entries the user pinned, newest first.',
      scopes: ['global'],
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      inputSchema: TriageListPinnedEntriesInputV1JsonSchema,
      resultSchema: TriageListPinnedEntriesResultV1JsonSchema,
      // The one Collection it touches is `user-marks`, read-only.
      hostAccess: ['account-storage'],
    }, {
      id: TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1,
      title: 'Link an entry to a session',
      description: 'Records that a pull request, issue or error group is being worked on in one session.',
      scopes: ['global'],
      // The same `plugin` surface as the list read and the pin: the caller is
      // this plugin's own mounted affordance, not a placed command, an agent
      // tool or an MCP tool. A link is routing state a person established, and
      // an agent must not be able to claim an entry for a Session on its own.
      surfaces: ['plugin'],
      // It writes durable Account state — the connection between a Session and
      // the entry it was started from — and nothing outside Happier.
      dangerLevel: 'writesLocal',
      inputSchema: TriageLinkEntryToSessionInputV1JsonSchema,
      resultSchema: TriageLinkEntryToSessionActionResultV1JsonSchema,
      // The one Collection it touches is `session-links`, and it is the sole
      // writer of it.
      hostAccess: ['account-storage'],
    }, {
      id: TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
      title: 'Configure a source',
      description: 'Creates, reconfigures, removes or restores one configured pull-request, issue or error-group source.',
      scopes: ['global'],
      // A source Settings surface reaches this through the incumbent plugin
      // dispatcher, which authorizes every plugin caller on the target `plugin`
      // surface. It is deliberately not an agent, MCP or CLI capability: only a
      // person choosing a source in Settings may change what is configured.
      surfaces: ['plugin'],
      // It writes durable Account state — the record of which sources the user
      // configured — and nothing outside Happier.
      dangerLevel: 'writesLocal',
      inputSchema: TriageSourceAdministrationActionInputV1JsonSchema,
      resultSchema: TriageSourceAdministrationActionResultV1JsonSchema,
      // The one Collection it touches is `source-instances`, and it is the sole
      // writer of it.
      hostAccess: ['account-storage'],
    }, {
      id: TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1,
      title: 'Read the sources you configured',
      description: 'Reads the pull-request, issue and error-group sources the calling source has configured, so it can change or remove one.',
      scopes: ['global'],
      // The same `plugin` surface as the administration Action it completes: a
      // source Settings surface reaches it through the incumbent dispatcher.
      // Which rows it may see is not decided here — the handler resolves the
      // caller's own admitted contribution and returns nothing else's.
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      inputSchema: TriageReadConfiguredSourceInstancesInputV1JsonSchema,
      resultSchema: TriageReadConfiguredSourceInstancesResultV1JsonSchema,
      // The one Collection it touches is `source-instances`, read-only.
      hostAccess: ['account-storage'],
    }, {
      id: TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1,
      title: 'Read the durable facts of one entry',
      description: 'Reads the configured connection one entry was observed through, and the sessions it is linked to.',
      scopes: ['global'],
      // The aggregate's own mounted detail region is the only caller, and the
      // handler refuses every other plugin: the value carries the owning
      // source's account binding and its private configuration.
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      inputSchema: TriageReadEntryDetailInputV1JsonSchema,
      resultSchema: TriageReadEntryDetailResultV1JsonSchema,
      // `source-instances` and `session-links`, both read-only.
      hostAccess: ['account-storage'],
    }, {
      id: TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1,
      title: 'Read the saved views',
      description: 'Reads the saved filter and order views, and which one is selected.',
      scopes: ['global'],
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      inputSchema: TriageReadSavedViewsInputV1JsonSchema,
      resultSchema: TriageReadSavedViewsResultV1JsonSchema,
      // No `hostAccess` entry: saved views are Account Settings, which the
      // declared Settings contribution authorizes. Naming `account-storage`
      // here would claim Collection access this Action never uses.
    }, {
      id: TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1,
      title: 'Save, update, delete or select a view',
      description: 'Creates, renames, removes or selects one saved filter and order view.',
      scopes: ['global'],
      // The same `plugin` surface as the list read: the caller is this plugin's
      // own mounted lens control, which holds no Settings member of its own.
      surfaces: ['plugin'],
      // It writes durable Account state, and the exact inverse is one press
      // away; nothing outside Happier is touched.
      dangerLevel: 'writesLocal',
      inputSchema: TriageAdministerSavedViewInputV1JsonSchema,
      resultSchema: TriageAdministerSavedViewResultV1JsonSchema,
    }],
    settings: [TRIAGE_SAVED_VIEWS_SETTINGS_CONTRIBUTION_V1],
    /**
     * The four mounted surfaces this package actually ships.
     *
     * Every renderer names an artifact `happier-plugin-ui.config.mjs` produces
     * and every view names a renderer declared here. A view without a renderer,
     * or a renderer without an artifact, is admitted by contribution
     * conformance and then mounts nothing — which is the exact way this
     * plugin's whole UI was unreachable while its source and tests were green.
     */
    ui: {
      views: [{
        // The one full-page destination. `View details` in the Composer picker
        // opens exactly this local id, which is why the constant is imported
        // from the navigation owner rather than spelled twice.
        id: TRIAGE_APP_PAGE_LOCAL_ID_V1,
        container: 'appPage',
        target: { kind: 'app' },
        renderer: TRIAGE_LIST_PAGE_RENDERER_ID_V1,
        title: TRIAGE_DISPLAY_NAME,
        icon: 'action',
        groupHint: 'navigation',
      }, {
        // One Session-targeted contribution, mounted by the incumbent
        // right-sidebar Registry entry. Triage declares no mobile view, cockpit
        // destination or platform branch: the same entry serves desktop, the
        // classic mobile panel and the mobile cockpit.
        id: TRIAGE_SESSION_ENTRIES_VIEW_ID_V1,
        container: 'rightSidebarTab',
        target: { kind: 'session' },
        renderer: TRIAGE_SESSION_ENTRIES_RENDERER_ID_V1,
        title: TRIAGE_DISPLAY_NAME,
        icon: 'action',
      }],
      renderers: [{
        id: TRIAGE_LIST_PAGE_RENDERER_ID_V1,
        kind: 'reactNative',
        artifact: TRIAGE_LIST_PAGE_ARTIFACT_ID_V1,
        // The page's rows come from this plugin's own list Action; a host that
        // cannot dispatch one would mount an empty shell.
        requiredHostMethods: ['executeAction'],
      }, {
        id: TRIAGE_ENTRY_PICKER_RENDERER_ID_V1,
        kind: 'reactNative',
        artifact: TRIAGE_ENTRY_PICKER_ARTIFACT_ID_V1,
        requiredHostMethods: ['executeAction'],
      }, {
        // Presentation only: the compact label derives zero/one/many from the
        // canonical composer snapshot and has nothing of its own to require.
        id: TRIAGE_ENTRIES_COMPACT_RENDERER_ID_V1,
        kind: 'reactNative',
        artifact: TRIAGE_ENTRIES_COMPACT_ARTIFACT_ID_V1,
      }, {
        // Its links are read through the Data-owned Collection pager, which
        // reports a typed failure rather than needing a declared method gate.
        id: TRIAGE_SESSION_ENTRIES_RENDERER_ID_V1,
        kind: 'reactNative',
        artifact: TRIAGE_SESSION_ENTRIES_ARTIFACT_ID_V1,
      }],
    },
    composerAttachments: [{
      id: TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1,
      title: TRIAGE_DISPLAY_NAME,
      description: 'Attach a pull request, issue or error group to this message.',
      icon: TRIAGE_ENTRIES_CONTROL_ICON_V1,
      // A draft may reference several entries; the picker is a multi-select.
      cardinality: 'many',
      // The private value carries identity only. It is the published composed
      // schema rather than a restatement, so the attachment and the resolver
      // cannot disagree about what a persisted attachment is.
      valueSchema: TriageComposerEntryAttachmentValueV1Schema.jsonSchema,
      picker: { renderer: TRIAGE_ENTRY_PICKER_RENDERER_ID_V1 },
      // The attached record is identity only, so the entry is read fresh under
      // the user's own connection immediately before every dispatch. Without
      // this role the draft would carry an id the model cannot read.
      runtime: { resolveForDispatch: true },
    }],
    composerControls: [{
      id: TRIAGE_ENTRIES_CONTROL_LOCAL_ID_V1,
      label: TRIAGE_DISPLAY_NAME,
      icon: TRIAGE_ENTRIES_CONTROL_ICON_V1,
      // The control is the affordance that opens the picker; the attachment is
      // what the draft carries. They are deliberately different local ids.
      interaction: {
        kind: 'attachmentPicker',
        attachment: TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1,
        presentation: 'popover',
        layout: 'list',
      },
      compactRenderer: { renderer: TRIAGE_ENTRIES_COMPACT_RENDERER_ID_V1 },
      // Required whenever a compact renderer is declared: a narrow composer
      // must still be able to reach the control from the overflow.
      overflow: {
        label: TRIAGE_DISPLAY_NAME,
        icon: TRIAGE_ENTRIES_CONTROL_ICON_V1,
        presentation: { presentation: 'dialog', layout: 'list' },
      },
    }],
  },
} satisfies PluginManifest;
