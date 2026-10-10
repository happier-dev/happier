import {
  definePlugin,
  PluginSearchQueryV1Schema,
  PluginSearchResultV1Schema,
} from '@happier-dev/plugin-sdk';
import {
  TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
  TriageReadConfiguredSourceInstancesInputV1Schema,
  TriageReadConfiguredSourceInstancesResultV1Schema,
  TriageSourceAdministrationActionInputV1Schema,
  TriageSourceAdministrationActionResultV1Schema,
  TriagePullRequestStatusResultV1Schema,
} from '@happier-dev/triage-protocol/v1';

import { createTriageAdministerSourceInstanceActionHandler } from './actions/administerSourceInstanceAction.js';
import {
  TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1,
  TriageRunConfiguredActionInputV1Schema,
  TriageRunConfiguredActionResultV1Schema,
} from './actions/configuredActionRunProtocol.js';
import {
  TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1,
  TRIAGE_READ_PULL_REQUEST_STATUS_ACTION_LOCAL_ID_V1,
  TriageReadEntryDetailInputV1Schema,
  TriageReadEntryDetailResultV1Schema,
} from './actions/entryDetailProtocol.js';

import { createTriageListEntriesActionHandler } from './actions/listEntries.js';
import { TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, TriageMountedUiInputV1Schema, TriageMountedUiResultV1Schema, TriageMountedSourceRevealInputV1Schema, TriageMountedSourceInsertInputV1Schema } from './actions/mountedUiProtocol.js';
import { TRIAGE_SOURCE_PANEL_REVEAL_ACTION_V1, TRIAGE_SOURCE_PANEL_INSERT_ACTION_V1 } from '@happier-dev/triage-sources/runtime';
import {
  TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
  TriageListEntriesInputV1Schema,
  TriageListEntriesResultV1Schema,
} from './actions/listEntriesProtocol.js';
import { createTriageReadConfiguredSourceInstancesActionHandler } from './actions/readConfiguredSourceInstances.js';
import {
  TRIAGE_SEARCH_ENTRIES_ACTION_LOCAL_ID_V1,
  TRIAGE_SEARCH_PROVIDER_LOCAL_ID_V1,
} from './actions/searchEntriesProtocol.js';
import { createTriageReadEntryDetailActionHandler } from './actions/readEntryDetail.js';
import { createTriageReobserveEntryActionHandler } from './actions/reobserveEntry.js';
import { createTriageReadPullRequestStatusActionHandler } from './actions/readPullRequestStatus.js';
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
  createTriageReadFixPullRequestsActionHandler,
  createTriageSetFixPullRequestActionHandler,
} from './actions/fixPullRequests.js';
import {
  TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1,
  TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1,
  TriageReadFixPullRequestsInputV1Schema,
  TriageReadFixPullRequestsResultV1Schema,
  TriageSetFixPullRequestInputV1Schema,
  TriageSetFixPullRequestResultV1Schema,
} from '@happier-dev/triage-protocol/v1';
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
import { TRIAGE_ENTRIES_CONTROL_ICON_V1 } from './ui/contributions.js';
import {
  TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1,
  TRIAGE_ENTRY_DRAG_SOURCE_ID_V1,
  TRIAGE_ENTRY_SESSION_DROP_TARGET_ID_V1,
  TriageEntryDragReferenceV1Schema,
} from './ui/list/entryDragDrop.js';
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
        reason: 'Read and write configured sources, saved views, entry actions, Session links, and pins in this Happier Account.',
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
    dragSources: {
      [TRIAGE_ENTRY_DRAG_SOURCE_ID_V1]: {
        title: { key: 'plugins.triage.surface.column.entry', fallback: 'Entry' },
        composerAttachment: TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1,
        referenceSchema: TriageEntryDragReferenceV1Schema.jsonSchema,
        client: { artifactId: TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1, exportName: 'activate' },
        platforms: ['web', 'ios', 'android'],
      },
    },
    dropTargets: {
      [TRIAGE_ENTRY_SESSION_DROP_TARGET_ID_V1]: {
        title: { key: 'plugins.triage.surface.drop.linkSession', fallback: 'Link Session' },
        acceptedKinds: ['session'],
        actions: [{ kind: 'plugin', action: TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1 }],
        client: { artifactId: TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1, exportName: 'activate' },
        platforms: ['web', 'ios', 'android'],
      },
    },
    actions: {
      [TRIAGE_SOURCE_PANEL_REVEAL_ACTION_V1]: {
        title: 'Reveal selected occurrence user details',
        description: 'Reveals user details already read by the addressed active source panel. Concealment uses the ordinary mounted Action.',
        surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: [], dangerLevel: 'safe',
        confirmation: {
          title: { key: 'plugins.triage.sourcePanel.revealTitle', fallback: 'Show event user details' },
          body: { key: 'plugins.triage.sourcePanel.revealConfirmation', fallback: 'Event user details may include names, email addresses and IP addresses.' },
        },
        execution: { target: 'client', client: { artifactId: 'triage-mounted-ui-action-native', exportName: 'createTriageMountedSourceRevealActionHandler' }, platforms: ['web', 'ios', 'android'] },
        inputSchema: TriageMountedSourceRevealInputV1Schema, resultSchema: TriageMountedUiResultV1Schema,
      },
      [TRIAGE_SOURCE_PANEL_INSERT_ACTION_V1]: {
        title: 'Add selected occurrence to message',
        description: 'Inserts the active source panel’s selected evidence reference into the bound draft through its existing Composer transaction.',
        surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: [], dangerLevel: 'safe',
        confirmation: {
          title: { key: 'plugins.triage.sourcePanel.insertTitle', fallback: 'Add selected occurrence to message' },
          body: { key: 'plugins.triage.sourcePanel.insertConfirmation', fallback: 'The selected occurrence will be attached to this message. Its title, stack frames, source context, breadcrumbs and allowed tags may be sent to the agent when you send the message. User fields, frame local variables and raw request data are excluded.' },
        },
        execution: { target: 'client', client: { artifactId: 'triage-mounted-ui-action-native', exportName: 'createTriageMountedSourceInsertActionHandler' }, platforms: ['web', 'ios', 'android'] },
        inputSchema: TriageMountedSourceInsertInputV1Schema, resultSchema: TriageMountedUiResultV1Schema,
      },
      [TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1]: {
        title: 'Control the mounted PRs & Issues view',
        description: 'Control the addressed mounted page, including detail, tabs, linked-session selection, views, lenses, bulk selection, refresh, paging and active source occurrence selection/ordering. Read current UI context for its mountId and available commands. Sensitive reveal and insertion use their separate named Actions.',
        surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        execution: { target: 'client', client: { artifactId: 'triage-mounted-ui-action-native', exportName: 'createTriageMountedUiActionHandler' }, platforms: ['web', 'ios', 'android'] },
        inputSchema: TriageMountedUiInputV1Schema,
        resultSchema: TriageMountedUiResultV1Schema,
      },
      [TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1]: {
        title: {
          key: 'plugins.triage.action.listEntries.title',
          fallback: 'Read the current list window',
        },
        description: {
          key: 'plugins.triage.action.listEntries.description',
          fallback: 'Reads one bounded ordered window of pull requests, issues and error groups from the configured sources.',
        },
        // UI, Voice and automated callers share the same bounded read owner.
        surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        inputSchema: TriageListEntriesInputV1Schema,
        resultSchema: TriageListEntriesResultV1Schema,
        // The one Collection it touches is `source-instances`, read-only.
        hostAccess: ['account-storage'],
        run: createTriageListEntriesActionHandler(),
      },
      [TRIAGE_SEARCH_ENTRIES_ACTION_LOCAL_ID_V1]: {
        // The Universal Search section header. It is the product name the
        // views already carry, which is a proper noun rather than translated
        // copy — the same reason `ui.views` declares it directly.
        title: TRIAGE_DISPLAY_NAME,
        description: 'Finds pull requests, issues and error groups matching what the reader typed.',
        // Search and automated callers acquire the same host-scoped projection.
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        // The provider section IS the affordance. A query Action is not also a
        // command-palette entry, and the manifest owner refuses one that is.
        placementBindings: [],
        execution: {
          target: 'client',
          client: {
            artifactId: 'triage-search-action-native',
            exportName: 'createTriageSearchEntriesActionHandler',
          },
          platforms: ['web', 'ios', 'android'],
        },
        // The one canonical search contract, imported rather than restated, so
        // the declaration and the host's parse cannot describe two shapes.
        inputSchema: PluginSearchQueryV1Schema,
        resultSchema: PluginSearchResultV1Schema,
      },
      [TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1]: {
        title: 'Pin or unpin an entry',
        description: 'Keeps one pull request, issue or error group at the top of the list, or removes that mark again.',
        // Every caller reaches the same reversible user-mark writer.
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        // It keeps the default `safe` danger level: a pin is durable user state,
        // but the exact inverse is one press away and nothing outside Happier is
        // touched.
        inputSchema: TriageSetEntryPinnedInputV1Schema,
        resultSchema: TriageSetEntryPinnedResultV1Schema,
        hostAccess: ['account-storage'],
        run: createTriageSetEntryPinnedActionHandler(),
      },
      [TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1]: {
        title: 'Link or unlink a fix pull request',
        description: 'Records, or removes, the pull request that fixes one issue or error group.',
        // The caller is this plugin's own mounted detail affordance, like Pin.
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        // Default `safe`: durable user state whose exact inverse is one press
        // away, touching nothing outside Happier. It writes only `user-marks`.
        inputSchema: TriageSetFixPullRequestInputV1Schema,
        resultSchema: TriageSetFixPullRequestResultV1Schema,
        hostAccess: ['account-storage'],
        run: createTriageSetFixPullRequestActionHandler(),
      },
      [TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1]: {
        title: 'Read the fix pull requests',
        description: 'Reads the pull requests linked as fixes for one issue or error group.',
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        inputSchema: TriageReadFixPullRequestsInputV1Schema,
        resultSchema: TriageReadFixPullRequestsResultV1Schema,
        // Reads `user-marks` and `session-links`; writes nothing.
        hostAccess: ['account-storage'],
        run: createTriageReadFixPullRequestsActionHandler(),
      },
      [TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1]: {
        title: 'Read the pinned entries',
        description: 'Reads one bounded page of the entries the user pinned, newest first.',
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        inputSchema: TriageListPinnedEntriesInputV1Schema,
        resultSchema: TriageListPinnedEntriesResultV1Schema,
        // The one Collection it touches is `user-marks`, read-only.
        hostAccess: ['account-storage'],
        run: createTriageListPinnedEntriesActionHandler(),
      },
      [TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1]: {
        title: 'Link an entry to a session',
        description: 'Records that a pull request, issue or error group is being worked on in one session.',
        // Routing changes share the host-owned approval policy on every surface.
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        // It writes durable Account state — the connection between a Session and
        // the entry it was started from — and nothing outside Happier.
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Link this entry to the session?',
          body: 'This records the entry as work for the selected session in this Happier Account. You can unlink it later.',
          confirmLabel: 'Link entry',
        },
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
        // Session creation remains confirmed through the shared policy owner.
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
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
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Start this pull request review?',
          body: 'This rereads the selected pull request and starts the chosen review engine.',
          confirmLabel: 'Start review',
        },
        inputSchema: TriageStartPullRequestReviewInputV1Schema,
        resultSchema: TriageStartPullRequestReviewResultV1Schema,
        run: createTriageStartPullRequestReviewActionHandler(),
      },
      [TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1]: {
        title: 'Run a configured entry action',
        description: 'Runs the selected Ask, Fix, Review or custom action for one or many entries at the chosen destination.',
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Run this configured action?',
          body: 'This starts the configured work for the selected entries at the chosen session destination.',
          confirmLabel: 'Run action',
        },
        inputSchema: TriageRunConfiguredActionInputV1Schema,
        resultSchema: TriageRunConfiguredActionResultV1Schema,
        execution: {
          target: 'client',
          client: { artifactId: 'triage-configured-action-native', exportName: 'createTriageRunConfiguredActionHandler' },
          platforms: ['web', 'ios', 'android'],
        },
      },
      [TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1]: {
        title: 'Unlink an entry from a session',
        description: 'Removes the record that a pull request, issue or error group is being worked on in one session.',
        // Every admitted caller uses the same link owner and confirmation.
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Unlink this entry from the session?',
          body: 'This removes the saved relationship from this Happier Account. It does not end or delete the session.',
          confirmLabel: 'Unlink entry',
        },
        inputSchema: TriageUnlinkEntryFromSessionActionInputV1Schema,
        resultSchema: TriageUnlinkEntryFromSessionActionResultV1Schema,
        hostAccess: ['account-storage'],
        run: createTriageUnlinkEntryFromSessionActionHandler(),
      },
      [TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1]: {
        title: 'Configure a source',
        description: 'Creates, reconfigures, removes or restores one configured pull-request, issue or error-group source.',
        // Settings and automated invocations share the configured-instance writer.
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        // It writes durable Account state — the record of which sources the user
        // configured — and nothing outside Happier.
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Apply this source change?',
          body: 'This creates, reconfigures, removes, or restores the selected source in this Happier Account.',
          confirmLabel: 'Apply change',
        },
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
        // Host automated callers may discover admitted sources. Plugin callers
        // remain scoped to their own source by the canonical caller owner.
        surfaces: ['ui', 'plugin', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        inputSchema: TriageReadConfiguredSourceInstancesInputV1Schema,
        resultSchema: TriageReadConfiguredSourceInstancesResultV1Schema,
        // The one Collection it touches is `source-instances`, read-only.
        hostAccess: ['account-storage'],
        run: createTriageReadConfiguredSourceInstancesActionHandler(),
      },
      [TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1]: {
        title: 'Read the durable facts of one entry',
        description: 'Reads the configured connection one entry was observed through, and the sessions it is linked to.',
        // Mounted self and host automated callers resolve the exact connection;
        // unrelated plugins cannot borrow private source configuration.
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        inputSchema: TriageReadEntryDetailInputV1Schema,
        resultSchema: TriageReadEntryDetailResultV1Schema,
        // `source-instances` and `session-links`, both read-only.
        hostAccess: ['account-storage'],
        run: createTriageReadEntryDetailActionHandler(),
      },
      [TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1]: {
        title: 'Re-read an entry after a provider change',
        description: 'Reads the exact selected entry through its configured source after a provider Action settles.',
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        inputSchema: TriageReobserveEntryInputV1Schema,
        resultSchema: TriageReobserveEntryResultV1Schema,
        hostAccess: ['account-storage'],
        run: createTriageReobserveEntryActionHandler(),
      },
      [TRIAGE_READ_PULL_REQUEST_STATUS_ACTION_LOCAL_ID_V1]: {
        title: 'Read pull request status',
        description: 'Reads checks, reviews, mergeability and branches for the exact selected pull request.',
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        dangerLevel: 'safe',
        inputSchema: TriageReobserveEntryInputV1Schema,
        resultSchema: TriagePullRequestStatusResultV1Schema,
        hostAccess: ['account-storage'],
        run: createTriageReadPullRequestStatusActionHandler(),
      },
      [TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1]: {
        title: 'Read the saved views',
        description: 'Reads the saved filter and order views, and which one is selected.',
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        inputSchema: TriageReadSavedViewsInputV1Schema,
        resultSchema: TriageReadSavedViewsResultV1Schema,
        hostAccess: ['account-storage'],
        run: createTriageReadSavedViewsActionHandler(),
      },
      [TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1]: {
        title: 'Save, update, delete or select a view',
        description: 'Creates, renames, removes or selects one saved filter and order view.',
        // The same mounted UI surface as the list read: the caller is this plugin's
        // own mounted lens control, which holds no Settings member of its own.
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        // It writes durable Account state, and the exact inverse is one press
        // away; nothing outside Happier is touched.
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Apply this saved-view change?',
          body: 'This creates, renames, removes, or selects a saved PRs & Issues view in this Happier Account.',
          confirmLabel: 'Apply change',
        },
        inputSchema: TriageAdministerSavedViewInputV1Schema,
        resultSchema: TriageAdministerSavedViewResultV1Schema,
        hostAccess: ['account-storage'],
        run: createTriageAdministerSavedViewActionHandler(),
      },
      [TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1]: {
        title: 'Read the configured actions',
        description: 'Reads the configured set of things a reader can start from a pull request, issue or error group.',
        // The caller is this plugin's own mounted action editor, which holds a
        // Host API with actions and no Settings member of its own.
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        inputSchema: TriageReadActionsInputV1Schema,
        resultSchema: TriageReadActionsResultV1Schema,
        hostAccess: ['account-storage'],
        run: createTriageReadActionsActionHandler(),
      },
      [TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1]: {
        title: 'Add, change, remove or reorder an action',
        description: 'Creates, renames, disables, reconfigures, removes or reorders one configured action.',
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        // It writes durable Account state, and the exact inverse is one press
        // away; nothing outside Happier is touched.
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Apply this configured-action change?',
          body: 'This adds, changes, removes, enables, disables, or reorders an entry action in this Happier Account.',
          confirmLabel: 'Apply change',
        },
        inputSchema: TriageAdministerActionInputV1Schema,
        resultSchema: TriageAdministerActionResultV1Schema,
        hostAccess: ['account-storage'],
        run: createTriageAdministerActionActionHandler(),
      },
    },
    /**
     * The one Universal Search provider.
     *
     * Everything a provider could otherwise restate — title, description, icon,
     * availability, execution target, currentness — is the referenced Action's,
     * so the descriptor is identity plus that reference and nothing else.
     */
    searchProviders: {
      [TRIAGE_SEARCH_PROVIDER_LOCAL_ID_V1]: { action: TRIAGE_SEARCH_ENTRIES_ACTION_LOCAL_ID_V1 },
    },
    /**
     * The four mounted surfaces this package actually ships.
     *
     * Every renderer names an artifact with an exact package export
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
        renderer: 'list-page',
        title: TRIAGE_DISPLAY_NAME,
        icon: 'change-open',
        placement: { kind: 'rail' },
        column: { renderer: 'views-column' },
      }, { sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' },
        id: 'latest',
        container: 'widget',
        target: { kind: 'app' },
        renderer: 'latest-widget',
        title: { key: 'plugins.triage.widget.latest', fallback: 'New in PRs & Issues' },
        icon: 'change-open',
        home: { default: 'shown' },
      }, {
        // One Session-targeted contribution, mounted by the incumbent
        // right-sidebar Registry entry. Triage declares no mobile view, cockpit
        // destination or platform branch: the same entry serves desktop, the
        // classic mobile panel and the mobile cockpit.
        id: 'session-entries',
        container: 'rightSidebarTab',
        target: { kind: 'session' },
        renderer: 'session-entries-panel',
        title: TRIAGE_DISPLAY_NAME,
        icon: 'change-open',
      }],
      renderers: [{
        id: 'list-page',
        kind: 'reactNative',
        artifact: 'triage-list-page-native',
        // The page's rows come from this plugin's own list Action; a host that
        // cannot dispatch one would mount an empty shell.
        requiredHostMethods: ['executeAction', 'publishCurrentUiContext'],
      }, {
        id: 'views-column',
        kind: 'reactNative',
        artifact: 'triage-views-column-native',
        requiredHostMethods: ['openSurface'],
      }, {
        id: 'latest-widget',
        kind: 'reactNative',
        artifact: 'triage-latest-widget-native',
        requiredHostMethods: ['executeAction', 'openSurface'],
      }, {
        id: 'entry-picker',
        kind: 'reactNative',
        artifact: 'triage-entry-picker-native',
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
        id: 'entries-compact',
        kind: 'reactNative',
        artifact: 'triage-entries-compact-native',
        requiredHostMethods: ['readComposer', 'watchComposer'],
      }, {
        // Its links are read through the Data-owned Collection pager, which
        // reports a typed failure rather than needing a declared method gate.
        id: 'session-entries-panel',
        kind: 'reactNative',
        artifact: 'triage-session-entries-native',
        // A resolved linked row opens the canonical Triage destination through
        // the generic host navigation seam. `executeAction` backs the rest of the
        // tab: the shared PRs & Issues window its rows join, linking from the
        // header "+" (`sessions/link-entry-v1`) and Unlink where the Account is
        // not directly reachable.
        requiredHostMethods: ['executeAction', 'openSurface'],
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
          picker: { renderer: 'entry-picker' },
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
          compactRenderer: { renderer: 'entries-compact' },
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
