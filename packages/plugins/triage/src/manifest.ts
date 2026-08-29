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
import { createTriageReobserveEntryActionHandler } from './actions/reobserveEntry.js';
import {
  TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1,
  TriageReobserveEntryInputV1Schema,
  TriageReobserveEntryResultV1Schema,
} from './actions/reobserveEntryProtocol.js';
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
import {
  createTriageStartEntrySessionActionHandler,
  createTriageStartPullRequestReviewActionHandler,
  createTriageUnlinkEntryFromSessionActionHandler,
} from './actions/entrySession.js';
import {
  TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
  TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1,
  TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1,
  TriageStartEntrySessionInputV1Schema,
  TriageStartEntrySessionResultV1Schema,
  TriageStartPullRequestReviewInputV1Schema,
  TriageStartPullRequestReviewResultV1Schema,
  TriageUnlinkEntryFromSessionActionInputV1Schema,
  TriageUnlinkEntryFromSessionActionResultV1Schema,
} from './actions/entrySessionProtocol.js';
import { createTriageLinkEntryToSessionActionHandler } from './actions/sessionLinks.js';
import {
  TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1,
  TriageLinkEntryToSessionActionResultV1Schema,
  TriageLinkEntryToSessionInputV1Schema,
} from './actions/sessionLinksProtocol.js';
import {
  createTriageAdministerActionActionHandler,
  createTriageReadActionsActionHandler,
} from './actions/actionsCatalog.js';
import {
  TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1,
  TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
  TriageAdministerActionInputV1Schema,
  TriageAdministerActionResultV1Schema,
  TriageReadActionsInputV1Schema,
  TriageReadActionsResultV1Schema,
} from './actions/actionsCatalogProtocol.js';
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
import { mintTriageOpaqueIdV1 } from './opaqueId.js';
import { TRIAGE_ACTIONS_SETTINGS_CONTRIBUTION_V1 } from './settings/actionsContribution.js';
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
import { PLUGIN_TARGETED_CONTRIBUTION_POINT_DEFINITIONS } from './targetedContributions.js';

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
    contributionPoints: PLUGIN_TARGETED_CONTRIBUTION_POINT_DEFINITIONS,
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
        // The aggregate's own mounted list window invokes this bounded read,
        // and Voice discovers the same declaration through `voice`. It remains
        // neither a placed affordance nor an agent/MCP tool. Direct plugin
        // code is refused: the mounted UI press is present-user authority.
        surfaces: ['ui', 'voice'],
        placementBindings: [],
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
        // Same mounted UI surface as the list read, and for the same reason: the
        // caller is this plugin's own mounted row affordance, not a placed
        // command, an agent tool or an MCP tool.
        surfaces: ['ui'],
        placementBindings: [],
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
        surfaces: ['ui'],
        placementBindings: [],
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
        // The same mounted UI surface as the list read and the pin: the caller
        // is this plugin's own mounted affordance, not a placed command, an
        // agent tool or an MCP tool. A link is routing state a person
        // established, and an agent must not be able to claim an entry for a
        // Session on its own.
        surfaces: ['ui'],
        placementBindings: [],
        // It writes durable Account state — the connection between a Session and
        // the entry it was started from — and nothing outside Happier.
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Link this entry to the session?',
          body: 'This records the entry as work for the selected session in this Happier Account. You can unlink it later.',
          confirmLabel: 'Link entry',
        },
        execution: { target: 'daemon' },
        inputSchema: TriageLinkEntryToSessionInputV1Schema,
        resultSchema: TriageLinkEntryToSessionActionResultV1Schema,
        // The one Collection it touches is `session-links`, and it is the sole
        // writer of it.
        hostAccess: ['account-storage'],
        run: createTriageLinkEntryToSessionActionHandler(),
      },
      [TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1]: {
        title: 'Start a session on an entry',
        description: 'Creates or rejoins one session for a pull request, issue or error group, records the link, and opens it.',
        scopes: ['global'],
        // The same mounted UI surface as the link write beneath it, and for the
        // same reason: the caller is this plugin's own always-mounted header.
        // `plugin` is absent because direct plugin code is not the authority
        // here — starting a session on a person's machine and claiming an entry
        // for it is a decision a person makes. `agent` and `mcp` are absent for
        // the same reachability reason.
        surfaces: ['ui'],
        placementBindings: [],
        // It writes durable Account state and reaches the generic Session
        // creator. Nothing outside Happier is touched: the one materialization
        // that would enter a checkout is not reachable from this wire.
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Start a session on this entry?',
          body: 'This creates or rejoins the selected session, records this entry as its work, and opens the session.',
          confirmLabel: 'Start session',
        },
        execution: { target: 'daemon' },
        inputSchema: TriageStartEntrySessionInputV1Schema,
        resultSchema: TriageStartEntrySessionResultV1Schema,
        // The one Collection it touches is `session-links`, through the same
        // canonical writer the link Action uses.
        hostAccess: ['account-storage'],
        run: createTriageStartEntrySessionActionHandler(),
      },
      [TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1]: {
        title: 'Start a pull request review',
        description: 'Rereads the selected pull request and starts the chosen review engine.',
        scopes: ['global'],
        surfaces: ['ui'],
        placementBindings: [],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Start this pull request review?',
          body: 'This rereads the selected pull request and starts the chosen review engine.',
          confirmLabel: 'Start review',
        },
        execution: { target: 'daemon' },
        inputSchema: TriageStartPullRequestReviewInputV1Schema,
        resultSchema: TriageStartPullRequestReviewResultV1Schema,
        run: createTriageStartPullRequestReviewActionHandler(),
      },
      [TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1]: {
        title: 'Unlink an entry from a session',
        description: 'Removes the record that a pull request, issue or error group is being worked on in one session.',
        scopes: ['global'],
        // The reader who linked the wrong entry is the only caller. An agent
        // that could drop the relationship would undo a person's routing
        // decision without them.
        surfaces: ['ui'],
        placementBindings: [],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Unlink this entry from the session?',
          body: 'This removes the saved relationship from this Happier Account. It does not end or delete the session.',
          confirmLabel: 'Unlink entry',
        },
        execution: { target: 'daemon' },
        inputSchema: TriageUnlinkEntryFromSessionActionInputV1Schema,
        resultSchema: TriageUnlinkEntryFromSessionActionResultV1Schema,
        hostAccess: ['account-storage'],
        run: createTriageUnlinkEntryFromSessionActionHandler(),
      },
      [TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1]: {
        title: 'Configure a source',
        description: 'Creates, reconfigures, removes or restores one configured pull-request, issue or error-group source.',
        scopes: ['global'],
        // A source Settings surface reaches this through the mounted Plugin UI
        // dispatcher, which admits the caller as present-user UI authority. It
        // is deliberately not an agent, MCP or CLI capability: only a person
        // choosing a source in Settings may change what is configured.
        surfaces: ['ui'],
        placementBindings: [],
        // It writes durable Account state — the record of which sources the user
        // configured — and nothing outside Happier.
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Apply this source change?',
          body: 'This creates, reconfigures, removes, or restores the selected source in this Happier Account.',
          confirmLabel: 'Apply change',
        },
        execution: { target: 'daemon' },
        inputSchema: TriageSourceAdministrationActionInputV1Schema,
        resultSchema: TriageSourceAdministrationActionResultV1Schema,
        // The one Collection it touches is `source-instances`, and it is the sole
        // writer of it.
        hostAccess: ['account-storage'],
        run: createTriageAdministerSourceInstanceActionHandler({
          mintSourceInstanceId: mintTriageOpaqueIdV1,
          nowMs: () => Date.now(),
        }),
      },
      [TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1]: {
        title: 'Read the sources you configured',
        description: 'Reads the pull-request, issue and error-group sources the calling source has configured, so it can change or remove one.',
        scopes: ['global'],
        // Reached two ways: a source Settings mounted surface (present-user UI
        // authority) and another plugin's daemon code through its own
        // ActionsService — the sentry Composer reference resolver reads exactly
        // its own configured rows this way. Which rows a caller may see is not
        // decided here — the handler resolves the caller's own admitted
        // contribution and returns nothing else's.
        surfaces: ['ui', 'plugin'],
        placementBindings: [],
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
        surfaces: ['ui'],
        placementBindings: [],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        inputSchema: TriageReadEntryDetailInputV1Schema,
        resultSchema: TriageReadEntryDetailResultV1Schema,
        // `source-instances` and `session-links`, both read-only.
        hostAccess: ['account-storage'],
        run: createTriageReadEntryDetailActionHandler(),
      },
      [TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1]: {
        title: 'Re-read an entry after a provider change',
        description: 'Reads the exact selected entry through its configured source after a provider Action settles.',
        scopes: ['global'],
        surfaces: ['ui'],
        placementBindings: [],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        inputSchema: TriageReobserveEntryInputV1Schema,
        resultSchema: TriageReobserveEntryResultV1Schema,
        hostAccess: ['account-storage'],
        run: createTriageReobserveEntryActionHandler(),
      },
      [TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1]: {
        title: 'Read the saved views',
        description: 'Reads the saved filter and order views, and which one is selected.',
        scopes: ['global'],
        surfaces: ['ui'],
        placementBindings: [],
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
        // The same mounted UI surface as the list read: the caller is this plugin's
        // own mounted lens control, which holds no Settings member of its own.
        surfaces: ['ui'],
        placementBindings: [],
        // It writes durable Account state, and the exact inverse is one press
        // away; nothing outside Happier is touched.
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Apply this saved-view change?',
          body: 'This creates, renames, removes, or selects a saved PRs & Issues view in this Happier Account.',
          confirmLabel: 'Apply change',
        },
        execution: { target: 'daemon' },
        inputSchema: TriageAdministerSavedViewInputV1Schema,
        resultSchema: TriageAdministerSavedViewResultV1Schema,
        run: createTriageAdministerSavedViewActionHandler(),
      },
      [TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1]: {
        title: 'Read the configured actions',
        description: 'Reads the configured set of things a reader can start from a pull request, issue or error group.',
        scopes: ['global'],
        // The caller is this plugin's own mounted action editor, which holds a
        // Host API with actions and no Settings member of its own.
        surfaces: ['ui'],
        placementBindings: [],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        inputSchema: TriageReadActionsInputV1Schema,
        resultSchema: TriageReadActionsResultV1Schema,
        run: createTriageReadActionsActionHandler(),
      },
      [TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1]: {
        title: 'Add, change, remove or reorder an action',
        description: 'Creates, renames, disables, reconfigures, removes or reorders one configured action.',
        scopes: ['global'],
        surfaces: ['ui'],
        placementBindings: [],
        // It writes durable Account state, and the exact inverse is one press
        // away; nothing outside Happier is touched.
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Apply this configured-action change?',
          body: 'This adds, changes, removes, enables, disables, or reorders an entry action in this Happier Account.',
          confirmLabel: 'Apply change',
        },
        execution: { target: 'daemon' },
        inputSchema: TriageAdministerActionInputV1Schema,
        resultSchema: TriageAdministerActionResultV1Schema,
        run: createTriageAdministerActionActionHandler(),
      },
    },
    settings: {
      [TRIAGE_SAVED_VIEWS_SETTINGS_CONTRIBUTION_V1.id]: TRIAGE_SAVED_VIEWS_SETTINGS_CONTRIBUTION_V1,
      // Declared here or it does not exist. The retired `triage.agentSelection`
      // built a whole setting, a choices resolver and a contribution that this
      // object never named, and it was dead for weeks with every source test
      // green — so `packagedManifest.test.ts` asserts the PACKAGED bytes carry
      // this field, not that this line exists.
      [TRIAGE_ACTIONS_SETTINGS_CONTRIBUTION_V1.id]: TRIAGE_ACTIONS_SETTINGS_CONTRIBUTION_V1,
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
        // Its rows come from the list Action, and Attach/Remove is a
        // `readComposer` → plan → `applyComposer` round trip on the draft this
        // mount was stamped with; `useComposerView` also observes that draft
        // through `watchComposer` on every mount, which is what keeps a row's
        // Attached state honest about a change this picker did not make.
        // Declaring only the Action mounted a full list of controls that could
        // not write anything.
        //
        // `openSurface` is declared because **View details** unconditionally
        // calls it. A Composer scope reaches navigation through the SAME
        // enclosing qualified-destination owner every other mounted surface
        // uses, so a Composer mount inside the app shell installs the method;
        // a scope with no destination owner installs nothing, and refusing the
        // picker there is the truthful outcome rather than presenting an
        // enabled row control that resolves after doing nothing.
        requiredHostMethods: [
          'executeAction',
          'readComposer',
          'watchComposer',
          'applyComposer',
          'openSurface',
        ],
      }, {
        // Presentation, but not self-contained: the compact label holds no count
        // of its own and derives zero/one/many from the canonical composer
        // snapshot it reads. It never asks for a refresh, so `watchComposer` is
        // its only update path after mount — without it the label freezes at its
        // mount-time value and goes on claiming attachments the message will not
        // carry, which is the one thing this renderer exists to prevent.
        id: TRIAGE_ENTRIES_COMPACT_RENDERER_ID_V1,
        kind: 'reactNative',
        artifact: TRIAGE_ENTRIES_COMPACT_ARTIFACT_ID_V1,
        requiredHostMethods: ['readComposer', 'watchComposer'],
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
