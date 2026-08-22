import { randomUUID } from 'node:crypto';

import { definePlugin } from '@happier-dev/plugin-sdk';
import {
  TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
  TriageReadConfiguredSourceInstancesInputV1Schema,
  TriageReadConfiguredSourceInstancesResultV1Schema,
  TriageSourceAdministrationActionInputV1Schema,
  TriageSourceAdministrationActionResultV1Schema,
  TriageSourcesContributionPointV1,
} from '@happier-dev/triage-protocol/v1';

import { createTriageAdministerSourceInstanceActionHandler } from './actions/administerSourceInstanceAction.js';
import {
  TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1,
  TriageReadEntryDetailInputV1Schema,
  TriageReadEntryDetailResultV1Schema,
} from './actions/entryDetailProtocol.js';

import { createTriageListEntriesActionHandler } from './actions/listEntries.js';
import {
  TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
  TriageListEntriesInputV1Schema,
  TriageListEntriesResultV1Schema,
} from './actions/listEntriesProtocol.js';
import { createTriageReadConfiguredSourceInstancesActionHandler } from './actions/readConfiguredSourceInstances.js';
import { createTriageReadEntryDetailActionHandler } from './actions/readEntryDetail.js';
import {
  createTriageListPinnedEntriesActionHandler,
  createTriageSetEntryPinnedActionHandler,
} from './actions/userMarks.js';
import {
  TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
  TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
  TriageListPinnedEntriesInputV1Schema,
  TriageListPinnedEntriesResultV1Schema,
  TriageSetEntryPinnedInputV1Schema,
  TriageSetEntryPinnedResultV1Schema,
} from './actions/userMarksProtocol.js';
import { createTriageLinkEntryToSessionActionHandler } from './actions/sessionLinks.js';
import {
  TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1,
  TriageLinkEntryToSessionActionResultV1Schema,
  TriageLinkEntryToSessionInputV1Schema,
} from './actions/sessionLinksProtocol.js';
import {
  createTriageAdministerSavedViewActionHandler,
  createTriageReadSavedViewsActionHandler,
} from './actions/savedViews.js';
import {
  TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1,
  TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1,
  TriageAdministerSavedViewInputV1Schema,
  TriageAdministerSavedViewResultV1Schema,
  TriageReadSavedViewsInputV1Schema,
  TriageReadSavedViewsResultV1Schema,
} from './actions/savedViewsProtocol.js';
import { createTriageEntryAttachmentRuntime } from './composer/attachmentRuntime.js';
import {
  TRIAGE_ENTRIES_CONTROL_LOCAL_ID_V1,
  TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1,
  TriageComposerEntryAttachmentValueV1Schema,
} from './composer/attachmentValue.js';
import { TRIAGE_APP_PAGE_LOCAL_ID_V1 } from './composer/openEntryDetails.js';
import {
  CORPUS_SESSION_LINKS_COLLECTION,
  CORPUS_SOURCE_INSTANCES_COLLECTION,
  CORPUS_USER_MARKS_COLLECTION,
} from './corpus/collections/definitions.js';
import {
  CORPUS_SESSION_LINKS_COLLECTION_ID,
  CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
  CORPUS_USER_MARKS_COLLECTION_ID,
} from './corpus/collections/ids.js';
import { TRIAGE_DISPLAY_NAME } from './displayName.js';
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
import { TRIAGE_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

export { TRIAGE_DISPLAY_NAME };

/**
 * The sole Triage plugin definition.
 *
 * The plugin id is not restated here. `@happier-dev/triage-protocol` publishes
 * it as the target of every source contribution, and it is also the persisted
 * connected-account, contribution and Collection-row key — so a second literal
 * could drift into source contributions aimed at a plugin that does not exist.
 *
 * `definePlugin` is the one author path: it projects the cold manifest, the
 * generated activation, the target-owned contribution point reference and the
 * executable Collection-migration half from these same declarations. No Triage
 * contribution is declared from a second manifest, package or host branch, and
 * no Triage registration is written by hand.
 */
function createTriagePlugin() {
  return definePlugin({
    id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    version: '0.0.0',
    displayName: TRIAGE_DISPLAY_NAME,
    description: 'Aggregates pull requests, issues and error groups from configured sources into one reviewable surface.',
    engines: { happier: '^0.0.0' },
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './.happier-plugin/daemon.js' },
    hostAccess: {
      required: [{
        id: 'account-storage',
        capability: 'storage.account',
        reason: 'Read and write the source instances the user configured, read the list window assembled from them, and read and write the pins the user placed on entries.',
        scope: { enabled: true },
      }],
      optional: [],
    },
    contributionPoints: {
      [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: TriageSourcesContributionPointV1,
    },
    accountCollections: {
      [CORPUS_SOURCE_INSTANCES_COLLECTION_ID]: CORPUS_SOURCE_INSTANCES_COLLECTION,
      [CORPUS_SESSION_LINKS_COLLECTION_ID]: CORPUS_SESSION_LINKS_COLLECTION,
      [CORPUS_USER_MARKS_COLLECTION_ID]: CORPUS_USER_MARKS_COLLECTION,
    },
    actions: {
      [TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1]: {
        title: {
          key: 'plugins.triage.action.listEntries.title',
          fallback: 'Read the current list window',
        },
        description: {
          key: 'plugins.triage.action.listEntries.description',
          fallback: 'Reads one bounded ordered window of pull requests, issues and error groups from the configured sources.',
        },
        scopes: ['global'],
        // The aggregate's own mounted surfaces invoke this bounded read through
        // `plugin`, and Voice discovers that same declaration through `voice`.
        // It remains neither a placed affordance nor an agent/MCP tool. Declaring
        // `ui` here would require a placement binding and put a "read the list"
        // button in the product.
        surfaces: ['plugin', 'voice'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        inputSchema: TriageListEntriesInputV1Schema,
        resultSchema: TriageListEntriesResultV1Schema,
        // The one Collection it touches is `source-instances`, read-only.
        hostAccess: ['account-storage'],
        run: createTriageListEntriesActionHandler(),
      },
      [TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1]: {
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
        execution: { target: 'daemon' },
        inputSchema: TriageSetEntryPinnedInputV1Schema,
        resultSchema: TriageSetEntryPinnedResultV1Schema,
        hostAccess: ['account-storage'],
        run: createTriageSetEntryPinnedActionHandler(),
      },
      [TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1]: {
        title: 'Read the pinned entries',
        description: 'Reads one bounded page of the entries the user pinned, newest first.',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        inputSchema: TriageListPinnedEntriesInputV1Schema,
        resultSchema: TriageListPinnedEntriesResultV1Schema,
        // The one Collection it touches is `user-marks`, read-only.
        hostAccess: ['account-storage'],
        run: createTriageListPinnedEntriesActionHandler(),
      },
      [TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1]: {
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
        execution: { target: 'daemon' },
        inputSchema: TriageLinkEntryToSessionInputV1Schema,
        resultSchema: TriageLinkEntryToSessionActionResultV1Schema,
        // The one Collection it touches is `session-links`, and it is the sole
        // writer of it.
        hostAccess: ['account-storage'],
        run: createTriageLinkEntryToSessionActionHandler(),
      },
      [TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1]: {
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
        execution: { target: 'daemon' },
        inputSchema: TriageSourceAdministrationActionInputV1Schema,
        resultSchema: TriageSourceAdministrationActionResultV1Schema,
        // The one Collection it touches is `source-instances`, and it is the sole
        // writer of it.
        hostAccess: ['account-storage'],
        run: createTriageAdministerSourceInstanceActionHandler({
          mintSourceInstanceId: () => randomUUID(),
          nowMs: () => Date.now(),
        }),
      },
      [TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1]: {
        title: 'Read the sources you configured',
        description: 'Reads the pull-request, issue and error-group sources the calling source has configured, so it can change or remove one.',
        scopes: ['global'],
        // The same `plugin` surface as the administration Action it completes: a
        // source Settings surface reaches it through the incumbent dispatcher.
        // Which rows it may see is not decided here — the handler resolves the
        // caller's own admitted contribution and returns nothing else's.
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        inputSchema: TriageReadConfiguredSourceInstancesInputV1Schema,
        resultSchema: TriageReadConfiguredSourceInstancesResultV1Schema,
        // The one Collection it touches is `source-instances`, read-only.
        hostAccess: ['account-storage'],
        run: createTriageReadConfiguredSourceInstancesActionHandler(),
      },
      [TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1]: {
        title: 'Read the durable facts of one entry',
        description: 'Reads the configured connection one entry was observed through, and the sessions it is linked to.',
        scopes: ['global'],
        // The aggregate's own mounted detail region is the only caller, and the
        // handler refuses every other plugin: the value carries the owning
        // source's account binding and its private configuration.
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        inputSchema: TriageReadEntryDetailInputV1Schema,
        resultSchema: TriageReadEntryDetailResultV1Schema,
        // `source-instances` and `session-links`, both read-only.
        hostAccess: ['account-storage'],
        run: createTriageReadEntryDetailActionHandler(),
      },
      [TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1]: {
        title: 'Read the saved views',
        description: 'Reads the saved filter and order views, and which one is selected.',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        inputSchema: TriageReadSavedViewsInputV1Schema,
        resultSchema: TriageReadSavedViewsResultV1Schema,
        // No `hostAccess` entry: saved views are Account Settings, which the
        // declared Settings contribution authorizes. Naming `account-storage`
        // here would claim Collection access this Action never uses.
        run: createTriageReadSavedViewsActionHandler(),
      },
      [TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1]: {
        title: 'Save, update, delete or select a view',
        description: 'Creates, renames, removes or selects one saved filter and order view.',
        scopes: ['global'],
        // The same `plugin` surface as the list read: the caller is this plugin's
        // own mounted lens control, which holds no Settings member of its own.
        surfaces: ['plugin'],
        // It writes durable Account state, and the exact inverse is one press
        // away; nothing outside Happier is touched.
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        inputSchema: TriageAdministerSavedViewInputV1Schema,
        resultSchema: TriageAdministerSavedViewResultV1Schema,
        run: createTriageAdministerSavedViewActionHandler(),
      },
    },
    settings: {
      [TRIAGE_SAVED_VIEWS_SETTINGS_CONTRIBUTION_V1.id]: TRIAGE_SAVED_VIEWS_SETTINGS_CONTRIBUTION_V1,
    },
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
      translations: TRIAGE_UI_TRANSLATION_BUNDLES,
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
        requiredHostMethods: ['executeAction', 'publishCurrentUiContext'],
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
    composer: {
      attachments: {
        [TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1]: {
          title: TRIAGE_DISPLAY_NAME,
          description: 'Attach a pull request, issue or error group to this message.',
          icon: TRIAGE_ENTRIES_CONTROL_ICON_V1,
          // A draft may reference several entries; the picker is a multi-select.
          cardinality: 'many',
          // The private value carries identity only. It is the published composed
          // schema rather than a restatement, so the attachment and the resolver
          // cannot disagree about what a persisted attachment is.
          value: TriageComposerEntryAttachmentValueV1Schema,
          picker: { renderer: TRIAGE_ENTRY_PICKER_RENDERER_ID_V1 },
          // The attached record is identity only, so the entry is read fresh under
          // the user's own connection immediately before every dispatch. Without
          // this role the draft would carry an id the model cannot read, so the
          // declared `resolveForDispatch` descriptor is projected from the exact
          // runtime registered here.
          runtime: createTriageEntryAttachmentRuntime(),
        },
      },
      controls: {
        [TRIAGE_ENTRIES_CONTROL_LOCAL_ID_V1]: {
          label: TRIAGE_DISPLAY_NAME,
          icon: TRIAGE_ENTRIES_CONTROL_ICON_V1,
          // `core/COMPOSER.md` §1. The three scopes that compose a Message this
          // attachment can ride on. The host reads an ABSENT `scopes` as EVERY
          // scope, so omitting the key is the widest policy rather than none:
          // `automationAuthoring` has no Message-attachment capability, so the
          // control would open a picker whose attachment nothing can hold, and
          // `participantMessage` has no approved V1 journey.
          scopes: ['session', 'newSession', 'pendingMessage'],
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
        },
      },
    },
  });
}

/** The one Triage plugin value: manifest, activation and contribution points. */
export const TRIAGE_PLUGIN = createTriagePlugin();

/** The sole Triage plugin manifest, projected from the definition above. */
export const PLUGIN_MANIFEST = TRIAGE_PLUGIN.manifest;

/**
 * The executable half of `contributes.accountCollections`.
 *
 * The host projects this against the parsed manifest declarations before a
 * candidate may load, so it must travel with the manifest. It comes from the
 * same `definePlugin` owner as the declarations, which is what makes a future
 * schema-version bump add the callback beside its static identity instead of
 * leaving the two halves to a second hand-maintained map.
 */
export const collectionMigrations = TRIAGE_PLUGIN.collectionMigrations;

/**
 * The exact target-owned point used to observe admitted V1 source
 * contributions.
 *
 * It is the reference `definePlugin` attached to the declaration in
 * `PLUGIN_MANIFEST`, so the observed point and the declared point can never be
 * two different values. Every consumer dereferences it inside a handler body,
 * never at module evaluation, which is what keeps the deliberate
 * manifest ↔ handler import cycle initialization-safe.
 */
export const TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 =
  TRIAGE_PLUGIN.contributionPoints[TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1];
