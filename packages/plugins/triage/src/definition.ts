import { TRIAGE_ACCOUNT_ACTIONS, TRIAGE_ACCOUNT_RESOURCES, TRIAGE_ACCOUNT_DEFINITION, type TriageAccountActionSchemas } from './accountDefinition.js';
import { TRIAGE_DATA_ACTION_EXECUTION_V1 } from './accountExecution.js';
import { TRIAGE_ISSUE_INPUT_TYPES } from './actions/issueOptions.js';
import { REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/plugin-sdk/reviews';

import {
  SessionPullRequestLinkCompletionsContributionProtocolV1,
  SESSION_PULL_REQUEST_LINK_COMPLETIONS_CONTRIBUTION_POINT_ID_V1,
  SessionPullRequestLinkCompletionInputV1Schema,
  SessionPullRequestLinkCompletionResultV1Schema,
} from '@happier-dev/channels-protocol/v1';
import { createTriageCompletePullRequestLinkActionHandler,
  TRIAGE_COMPLETE_PULL_REQUEST_LINK_ACTION_LOCAL_ID_V1 } from './actions/completePullRequestLink.js';
import {
  definePlugin,
  type DefinedPlugin,
  type DefinedPluginActionContracts,
  PluginSearchQueryV1Schema,
  PluginSearchResultV1Schema,
  PluginWorkItemTransitionInputV1Schema,
} from '@happier-dev/plugin-sdk';
import type { DefinedContributionPointProtocolMap } from '@happier-dev/plugin-sdk/contributions';
import { TRIAGE_WORK_ITEMS_TRANSITION_ACTION_LOCAL_ID_V1 } from './workItems/runtime.js';
import { TRIAGE_LEGACY_TASK_ROUTE_ALIASES } from './ui/navigation/legacyTaskRoutes.js';
import { TRIAGE_DECLARED_FAILURE_ACTIONS } from './ui/inbox/declaredActions.js';
import { TRIAGE_NATIVE_FAILURE_ACTION_LOCAL_ID_V1, TriageNativeFailureInputV1Schema, TriageNativeFailureResultV1Schema } from './actions/nativeFailureProtocol.js';
import {
  TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1,
  TRIAGE_REVIEW_WORKSPACE_OPERATION_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
  TriageReadConfiguredSourceInstancesInputV1Schema,
  TriageReadConfiguredSourceInstancesResultV1Schema,
  TriageSourceAdministrationActionInputV1Schema,
  TriageSourceAdministrationActionResultV1Schema,
  TriagePullRequestStatusResultV1Schema,
  TriageTaskWriteResultV1Schema,
} from '@happier-dev/triage-protocol/v1';

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

import {
  TRIAGE_TASKS_READ_ORIGIN_ERROR_ACTION_LOCAL_ID_V1, TRIAGE_TASKS_SET_ORIGIN_ERROR_ACTION_LOCAL_ID_V1,
  TriageReadTaskOriginErrorInputV1Schema, TriageReadTaskOriginErrorResultV1Schema,
  TriageSetTaskOriginErrorInputV1Schema, TriageSetTaskOriginErrorResultV1Schema,
} from './actions/taskOriginProtocol.js';
import {
  TRIAGE_TASKS_LIST_ACTION_LOCAL_ID_V1, TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1,
  TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1, TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1,
  TRIAGE_TASKS_LINK_ACTION_LOCAL_ID_V1,
  TRIAGE_TASKS_OPEN_CREATE_ACTION_LOCAL_ID_V1, TriageTaskDraftV1Schema,
  TRIAGE_TASKS_CHECK_WRITE_ACTION_LOCAL_ID_V1, TriageCheckTaskWriteInputV1Schema,
  TriageCreateTaskActionInputV1Schema, TriageCreateTaskActionResultV1Schema, TriageEditTaskActionInputV1Schema,
  TriageTransitionTaskActionInputV1Schema,
} from './actions/tasksProtocol.js';
import { TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, TriageMountedUiInputV1Schema, TriageMountedUiResultV1Schema, TriageMountedSourceRevealInputV1Schema, TriageMountedSourceInsertInputV1Schema } from './actions/mountedUiProtocol.js';
import { TRIAGE_SOURCE_PANEL_REVEAL_ACTION_V1, TRIAGE_SOURCE_PANEL_INSERT_ACTION_V1 } from '@happier-dev/triage-sources/runtime';
import {
  TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
  TriageListEntriesInputV1Schema,
  TriageListEntriesResultV1Schema,
} from './actions/listEntriesProtocol.js';

import {
  TRIAGE_SEARCH_ENTRIES_ACTION_LOCAL_ID_V1,
  TRIAGE_SEARCH_PROVIDER_LOCAL_ID_V1,
} from './actions/searchEntriesProtocol.js';

import {
  TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1,
  TriageResolveResourceActionInputV1Schema,
  TriageResolveResourceActionResultV1Schema,
} from './actions/resolveResourceProtocol.js';

import { TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_LOCAL_ID_V1 } from './sessions/sessionPullRequestResource.js';

import {
  TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1,
  TriageReobserveEntryInputV1Schema,
  TriageReobserveEntryResultV1Schema,
} from './actions/reobserveEntryProtocol.js';

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
import { createTriageStartEntrySessionActionHandler, createTriageStartPullRequestReviewActionHandler } from './actions/entrySession.js';
import { createTriagePreparePullRequestReviewActionHandler } from './actions/entryReviewWorkspace.js';
import {
  TRIAGE_PREPARE_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1,
  TriagePreparePullRequestReviewInputV1Schema,
  TriagePreparePullRequestReviewResultV1Schema,
  TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
  TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1,
  TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1,
  TRIAGE_VERIFY_EXISTING_REVIEW_WORKSPACE_ACTION_LOCAL_ID_V1,
  TriageStartEntrySessionInputV1Schema,
  TriageStartEntrySessionResultV1Schema,
  TriageStartPullRequestReviewInputV1Schema,
  TriageStartPullRequestReviewResultV1Schema,
  TriageUnlinkEntryFromSessionActionInputV1Schema,
  TriageUnlinkEntryFromSessionActionResultV1Schema,
  TriageVerifyExistingReviewWorkspaceInputV1Schema,
  TriageVerifyExistingReviewWorkspaceResultV1Schema,
} from './actions/entrySessionProtocol.js';

import {
  TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1,
  TriageLinkEntryToSessionActionResultV1Schema,
  TriageLinkEntryToSessionInputV1Schema,
  TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1,
  TriageReadSourceSessionLinksInputV1Schema,
  TriageReadSourceSessionLinksActionResultV1Schema,
} from './actions/sessionLinksProtocol.js';

import {
  TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1,
  TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
  TriageAdministerActionInputV1Schema,
  TriageAdministerActionResultV1Schema,
  TriageReadActionsActionInputV1Schema,
  TriageReadActionsActionResultV1Schema,
} from './actions/actionsCatalogProtocol.js';

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
import { TRIAGE_APP_PAGE_LOCAL_ID_V1, TRIAGE_ENTRY_SESSION_COMPANION_V1, TRIAGE_TASKS_PAGE_LOCAL_ID_V1 } from './composer/openEntryDetails.js';
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
import { TRIAGE_RESOURCE_DETAILS_LOCAL_ID_V1, triageResourceLinks } from './ui/contributions.js';

import { TRIAGE_ENTRIES_CONTROL_ICON_V1 } from './ui/contributions.js';
import {
  TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1,
  TRIAGE_ENTRY_DRAG_SOURCE_ID_V1,
  TRIAGE_ENTRY_SESSION_DROP_TARGET_ID_V1,
  TRIAGE_PERSONAL_TASK_ORDER_TARGET_ID_V1,
  TriageEntryDragReferenceV1Schema, TRIAGE_TASK_STATUS_DROP_TARGET_ID_V1,
} from './ui/list/entryDragDropProtocol.js';

import { PLUGIN_TARGETED_CONTRIBUTION_POINT_DEFINITIONS } from './targetedContributions.js';
import { createInternalTaskSourceContributionV1, INTERNAL_TASK_ACTIONS_V1 } from './internalTasks/contribution.js';
import { createReviewSourceContributionV1, REVIEW_ACTIONS_V1 } from './reviews/contribution.js';
import { ScmComparisonSourceProtocolSchema } from '@happier-dev/plugin-sdk/scm';

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
/** Named schema references keep declaration emit from expanding every Action payload. */
type TriageActionSchemas = TriageAccountActionSchemas & {
  readonly [TRIAGE_PREPARE_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1]: readonly [typeof TriagePreparePullRequestReviewInputV1Schema, typeof TriagePreparePullRequestReviewResultV1Schema];
  readonly [TRIAGE_NATIVE_FAILURE_ACTION_LOCAL_ID_V1]: readonly [typeof TriageNativeFailureInputV1Schema, typeof TriageNativeFailureResultV1Schema];
  readonly [TRIAGE_PUBLISH_ATTENTION_ACTION_REF_V1.localId]: readonly [typeof TriagePublishAttentionInputV1Schema.jsonSchema, typeof TriagePublishAttentionResultV1Schema.jsonSchema];
  readonly [TRIAGE_COMPLETE_PULL_REQUEST_LINK_ACTION_LOCAL_ID_V1]: readonly [typeof SessionPullRequestLinkCompletionInputV1Schema, typeof SessionPullRequestLinkCompletionResultV1Schema];
  readonly [TRIAGE_TASKS_OPEN_CREATE_ACTION_LOCAL_ID_V1]: readonly [typeof TriageTaskDraftV1Schema, typeof TriageMountedUiResultV1Schema];
  readonly [TRIAGE_TASKS_CHECK_WRITE_ACTION_LOCAL_ID_V1]: readonly [typeof TriageCheckTaskWriteInputV1Schema, typeof TriageMountedUiResultV1Schema];
  readonly [TRIAGE_SOURCE_PANEL_REVEAL_ACTION_V1]: readonly [typeof TriageMountedSourceRevealInputV1Schema, typeof TriageMountedUiResultV1Schema];
  readonly [TRIAGE_SOURCE_PANEL_INSERT_ACTION_V1]: readonly [typeof TriageMountedSourceInsertInputV1Schema, typeof TriageMountedUiResultV1Schema];
  readonly [TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1]: readonly [typeof TriageMountedUiInputV1Schema, typeof TriageMountedUiResultV1Schema];
  readonly [TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1]: readonly [typeof TriageStartEntrySessionInputV1Schema, typeof TriageStartEntrySessionResultV1Schema];
  readonly [TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1]: readonly [typeof TriageStartPullRequestReviewInputV1Schema, typeof TriageStartPullRequestReviewResultV1Schema];
};

type TriageActionDeclarations = {
  readonly [TLocalId in keyof TriageActionSchemas]: {
    readonly title: string;
    readonly inputSchema: TriageActionSchemas[TLocalId][0];
    readonly resultSchema: TriageActionSchemas[TLocalId][1];
  };
} & typeof INTERNAL_TASK_ACTIONS_V1 & typeof REVIEW_ACTIONS_V1;

type TriagePlugin = DefinedPlugin<
  typeof TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
  DefinedPluginActionContracts<typeof TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, TriageActionDeclarations>,
  DefinedContributionPointProtocolMap<typeof PLUGIN_TARGETED_CONTRIBUTION_POINT_DEFINITIONS>
>;

function createTriagePlugin(): TriagePlugin {
  const plugin = definePlugin({
    ...TRIAGE_ACCOUNT_DEFINITION,
    description: 'Aggregates pull requests, issues and error groups from configured sources into one reviewable surface.',
    brand: { iconResourceId: 'brand-icon', monochrome: true },
    resources: {
      ...TRIAGE_ACCOUNT_RESOURCES,
      'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },

      "i18n-en": { kind: 'asset', path: "assets/i18n/en.json", contentType: 'application/json' },
      "i18n-de": { kind: 'asset', path: "assets/i18n/de.json", contentType: 'application/json' },
      "i18n-ru": { kind: 'asset', path: "assets/i18n/ru.json", contentType: 'application/json' },
      "i18n-pl": { kind: 'asset', path: "assets/i18n/pl.json", contentType: 'application/json' },
      "i18n-es": { kind: 'asset', path: "assets/i18n/es.json", contentType: 'application/json' },
      "i18n-fr": { kind: 'asset', path: "assets/i18n/fr.json", contentType: 'application/json' },
      "i18n-it": { kind: 'asset', path: "assets/i18n/it.json", contentType: 'application/json' },
      "i18n-pt": { kind: 'asset', path: "assets/i18n/pt.json", contentType: 'application/json' },
      "i18n-ca": { kind: 'asset', path: "assets/i18n/ca.json", contentType: 'application/json' },
      "i18n-zh-hans": { kind: 'asset', path: "assets/i18n/zh-Hans.json", contentType: 'application/json' },
      "i18n-zh-hant": { kind: 'asset', path: "assets/i18n/zh-Hant.json", contentType: 'application/json' },
      "i18n-ja": { kind: 'asset', path: "assets/i18n/ja.json", contentType: 'application/json' },
    },
    inputTypes: {
      ...TRIAGE_ISSUE_INPUT_TYPES,
      'pull-request-comparison': {
        title: { key: 'plugins.triage.comparison.title', fallback: 'Pull request' },
        semantic: 'scmPullRequestComparison',
        valueSchema: { allOf: [ScmComparisonSourceProtocolSchema.jsonSchema,
          { type: 'object', properties: { kind: { const: 'pullRequest' } }, required: ['kind'] }] },
        picker: 'comparison-picker',
      },
    },
    entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
    // Built-in Reviews have no persisted source row; their Artifact presence is demand.
    activation: { events: [], configuration: { artifactKinds: [REVIEW_ARTIFACT_KIND_V1], accountCollections: [
      { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, collectionId: CORPUS_SOURCE_INSTANCES_COLLECTION_ID },
    ] } },
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
    notifications: { 'source-attention': { kind: 'plugin', title: 'Source attention', eventIds: [] } },
    backgroundServices: [{ declaration: { id: 'attention', title: 'Triage source attention' }, runner: runTriageAttention }],
    contributesTo: {
      'happier.triage': { sources: { internal: createInternalTaskSourceContributionV1(), reviews: createReviewSourceContributionV1() } },
      'happier.channels': { [SESSION_PULL_REQUEST_LINK_COMPLETIONS_CONTRIBUTION_POINT_ID_V1]: {
        'session-pull-request-companion': SessionPullRequestLinkCompletionsContributionProtocolV1.contribute({
          descriptor: {}, operations: { complete: SessionPullRequestLinkCompletionsContributionProtocolV1.operations.complete.bind(
            TRIAGE_COMPLETE_PULL_REQUEST_LINK_ACTION_LOCAL_ID_V1) },
        }),
      } },
    },
    accountCollections: {
      [CORPUS_SOURCE_INSTANCES_COLLECTION_ID]: CORPUS_SOURCE_INSTANCES_COLLECTION,
      [CORPUS_SESSION_LINKS_COLLECTION_ID]: CORPUS_SESSION_LINKS_COLLECTION,
      [CORPUS_USER_MARKS_COLLECTION_ID]: CORPUS_USER_MARKS_COLLECTION,
    },
    workItems: { 'work-items': {
      client: { artifactId: TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1, exportName: 'activate' },
      platforms: ['web', 'ios', 'android'],
      transitionAction: TRIAGE_WORK_ITEMS_TRANSITION_ACTION_LOCAL_ID_V1,
    } },
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
      [TRIAGE_TASK_STATUS_DROP_TARGET_ID_V1]: {
        title: { key: 'plugins.triage.tasks.changeStatus', fallback: 'Change task status' },
        acceptedKinds: [`plugin:${TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1}/${TRIAGE_ENTRY_DRAG_SOURCE_ID_V1}`],
        actions: [{ kind: 'plugin', action: TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1 }],
        client: { artifactId: TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1, exportName: 'activate' },
        platforms: ['web', 'ios', 'android'],
      },
      [TRIAGE_PERSONAL_TASK_ORDER_TARGET_ID_V1]: {
        title: { key: 'plugins.triage.tasks.reorder', fallback: 'Move task' },
        acceptedKinds: [`plugin:${TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1}/${TRIAGE_ENTRY_DRAG_SOURCE_ID_V1}`],
        actions: [{ kind: 'host', actionId: 'tasks.internal.reorder' }, { kind: 'plugin', action: TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1 }],
        client: { artifactId: TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1, exportName: 'activate' },
        platforms: ['web', 'ios', 'android'],
      },
      [TRIAGE_ENTRY_SESSION_DROP_TARGET_ID_V1]: {
        title: { key: 'plugins.triage.surface.drop.linkSession', fallback: 'Link Session' },
        acceptedKinds: ['session'],
        actions: [{ kind: 'plugin', action: TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1 }],
        client: { artifactId: TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1, exportName: 'activate' },
        platforms: ['web', 'ios', 'android'],
      },
    },
    actions: {
      ...TRIAGE_ACCOUNT_ACTIONS,

      [TRIAGE_PUBLISH_ATTENTION_ACTION_REF_V1.localId]: {
        title: 'Publish source attention', description: 'Updates one source-owned attention item with its exact Triage detail destination.',
        surfaces: ['plugin'], dangerLevel: 'safe', hostAccess: ['account-storage'],
        inputSchema: TriagePublishAttentionInputV1Schema.jsonSchema, resultSchema: TriagePublishAttentionResultV1Schema.jsonSchema,
        run: publishSourceAttention,
      },
      [TRIAGE_COMPLETE_PULL_REQUEST_LINK_ACTION_LOCAL_ID_V1]: {
        title: 'Complete a linked pull request Companion',
        description: 'Adds the existing pull request glance after an acknowledged Session link, when its Widget receiver is available.',
        surfaces: ['plugin'], placementBindings: [], dangerLevel: 'safe',
        inputSchema: SessionPullRequestLinkCompletionInputV1Schema,
        resultSchema: SessionPullRequestLinkCompletionResultV1Schema,
        run: createTriageCompletePullRequestLinkActionHandler(),
      },

      [TRIAGE_TASKS_OPEN_CREATE_ACTION_LOCAL_ID_V1]: {
        title: { key: 'plugins.triage.tasks.create', fallback: 'Create task' },
        description: 'Choose where the task belongs, then review and create it.',
        slash: { tokens: ['/task'] }, surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'],
        scopes: ['global', 'session', 'message'],
        placementBindings: ['composer.slash', 'commandPalette', 'message.menu'],
        execution: { target: 'client', client: { artifactId: 'triage-mounted-ui-action-native', exportName: 'activate' }, platforms: ['web', 'ios', 'android'] },
        inputSchema: TriageTaskDraftV1Schema, resultSchema: TriageMountedUiResultV1Schema,
        inputHints: { fields: [] },
      },
      [TRIAGE_TASKS_CHECK_WRITE_ACTION_LOCAL_ID_V1]: {
        title: 'Check an uncertain task write',
        description: 'Rereads the exact task without retrying the write. A matching source answer releases the mounted hold.',
        dangerLevel: 'safe', readOnly: true,
        surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'], placementBindings: [],
        execution: { target: 'client', client: { artifactId: 'triage-mounted-ui-action-native', exportName: 'activate' }, platforms: ['web', 'ios', 'android'] },
        inputSchema: TriageCheckTaskWriteInputV1Schema, resultSchema: TriageMountedUiResultV1Schema,
      },

      [TRIAGE_SOURCE_PANEL_REVEAL_ACTION_V1]: {
        title: 'Reveal selected occurrence user details',
        description: 'Reveals user details already read by the addressed active source panel. Concealment uses the ordinary mounted Action.',
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'], placementBindings: [], dangerLevel: 'safe',
        confirmation: {
          title: { key: 'plugins.triage.sourcePanel.revealTitle', fallback: 'Show event user details' },
          body: { key: 'plugins.triage.sourcePanel.revealConfirmation', fallback: 'Event user details may include names, email addresses and IP addresses.' },
        },
        execution: { target: 'client', client: { artifactId: 'triage-mounted-ui-action-native', exportName: 'activate' }, platforms: ['web', 'ios', 'android'] },
        inputSchema: TriageMountedSourceRevealInputV1Schema, resultSchema: TriageMountedUiResultV1Schema,
      },
      [TRIAGE_SOURCE_PANEL_INSERT_ACTION_V1]: {
        title: 'Add selected occurrence to message',
        description: 'Inserts the active source panel’s selected evidence reference into the bound draft through its existing Composer transaction.',
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'], placementBindings: [], dangerLevel: 'safe',
        confirmation: {
          title: { key: 'plugins.triage.sourcePanel.insertTitle', fallback: 'Add selected occurrence to message' },
          body: { key: 'plugins.triage.sourcePanel.insertConfirmation', fallback: 'The selected occurrence will be attached to this message. Its title, stack frames, source context, breadcrumbs and allowed tags may be sent to the agent when you send the message. User fields, frame local variables and raw request data are excluded.' },
        },
        execution: { target: 'client', client: { artifactId: 'triage-mounted-ui-action-native', exportName: 'activate' }, platforms: ['web', 'ios', 'android'] },
        inputSchema: TriageMountedSourceInsertInputV1Schema, resultSchema: TriageMountedUiResultV1Schema,
      },
      [TRIAGE_NATIVE_FAILURE_ACTION_LOCAL_ID_V1]: {
        title: 'Investigate a native failure', dangerLevel: 'safe',
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'], placementBindings: [],
        execution: { target: 'client', client: { artifactId: 'triage-mounted-ui-action-native', exportName: 'activate' }, platforms: ['web', 'ios', 'android'] },
        inputSchema: TriageNativeFailureInputV1Schema, resultSchema: TriageNativeFailureResultV1Schema,
      },
      [TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1]: {
        title: 'Control the mounted PRs & Issues view',
        dangerLevel: 'safe',
        description: 'Control the addressed mounted page, including detail, tabs, linked-session selection/paging, views, lenses, bulk selection, refresh, entry/pin paging and active source selection/ordering, item expansion and paging. Source item operations use the source-declared list key advertised in current UI commands. On Tasks, setGroupExpanded with group completed and expanded true/false shows or hides the Done group on that page. On an addressed entry picker, attach or remove an entry from its exact Composer draft without sending. Read current UI context for its mountId and available commands. Sensitive reveal and insertion use their separate named Actions.',
        surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: [],
        execution: { target: 'client', client: { artifactId: 'triage-mounted-ui-action-native', exportName: 'activate' }, platforms: ['web', 'ios', 'android'] },
        inputSchema: TriageMountedUiInputV1Schema,
        resultSchema: TriageMountedUiResultV1Schema,
      },

      [TRIAGE_PREPARE_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1]: {
        title: 'Prepare a pull request review',
        description: 'Prepares the selected source workspace and captures the pinned pull request comparison without creating a session or starting reviewers.',
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: [],
        operation: TRIAGE_REVIEW_WORKSPACE_OPERATION_V1,
        dangerLevel: 'writesLocal',
        confirmationWhen: { presentUserUi: false },
        confirmation: { title: 'Prepare this pull request review?', body: 'This prepares the selected workspace and captures the selected pull request comparison.', confirmLabel: 'Prepare review' },
        inputSchema: TriagePreparePullRequestReviewInputV1Schema,
        resultSchema: TriagePreparePullRequestReviewResultV1Schema,
        hostAccess: ['account-storage'],
        run: createTriagePreparePullRequestReviewActionHandler(),
      },
      [TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1]: {
        title: 'Start a session on an entry',
        description: 'Creates or rejoins one session for a pull request, issue or error group, records the link, and opens it.',
        // The UI press supplies intent; explicit Ask remains with the shared gate.
        surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: [],
        // Selected review-workspace preparation remains in this invocation
        // while its native child waits for approval.
        operation: TRIAGE_REVIEW_WORKSPACE_OPERATION_V1,
        dangerLevel: 'writesLocal',
        confirmationWhen: { presentUserUi: false },
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
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: [],
        operation: TRIAGE_REVIEW_WORKSPACE_OPERATION_V1,
        dangerLevel: 'writesLocal',
        confirmationWhen: { presentUserUi: false },
        confirmation: {
          title: 'Start this pull request review?',
          body: 'This rereads the selected pull request and starts the chosen review engine.',
          confirmLabel: 'Start review',
        },
        inputSchema: TriageStartPullRequestReviewInputV1Schema,
        resultSchema: TriageStartPullRequestReviewResultV1Schema,
        run: createTriageStartPullRequestReviewActionHandler(),
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
      translations: [
        { locale: "en", resourceId: "i18n-en" },
        { locale: "de", resourceId: "i18n-de" },
        { locale: "ru", resourceId: "i18n-ru" },
        { locale: "pl", resourceId: "i18n-pl" },
        { locale: "es", resourceId: "i18n-es" },
        { locale: "fr", resourceId: "i18n-fr" },
        { locale: "it", resourceId: "i18n-it" },
        { locale: "pt", resourceId: "i18n-pt" },
        { locale: "ca", resourceId: "i18n-ca" },
        { locale: "zh-Hans", resourceId: "i18n-zh-hans" },
        { locale: "zh-Hant", resourceId: "i18n-zh-hant" },
        { locale: "ja", resourceId: "i18n-ja" },
      ],
      settingsGroups: [{ id: 'internal-tasks-group', title: 'Tasks', icon: 'settings', defaultRank: 40 }],
      settingsPages: [{ id: 'internal-tasks', group: { kind: 'plugin', localId: 'internal-tasks-group' }, title: 'Happier tasks',
        subtitle: 'Keep personal work in your Happier Account.', keywords: ['tasks', 'personal'], icon: 'settings', defaultRank: 10, renderer: 'internal-task-settings' }],
      views: [{
        // The one full-page destination. `View details` in the Composer picker
        // opens exactly this local id, which is why the constant is imported
        // from the navigation owner rather than spelled twice.
        id: TRIAGE_APP_PAGE_LOCAL_ID_V1,
        failureActions: { action: TRIAGE_NATIVE_FAILURE_ACTION_LOCAL_ID_V1, declaredActions: TRIAGE_DECLARED_FAILURE_ACTIONS },
        container: 'appPage',
        target: { kind: 'app' },
        renderer: 'list-page',
        // The list page's Collection toolbar leads with the page's name; the host's loading identity says it the same way.
        headerStyle: 'toolbar',
        title: TRIAGE_DISPLAY_NAME,
        icon: 'change-open',
        placement: { kind: 'rail' },
      }, {
        // Retained URL/Action entrance, not another rail destination (Q1/Q3).
        // Both entrances consume the same list, lens, selection and detail owners.
        id: TRIAGE_TASKS_PAGE_LOCAL_ID_V1,
        container: 'appPage', target: { kind: 'app' }, renderer: 'tasks-page', headerStyle: 'toolbar',
        routeAliases: TRIAGE_LEGACY_TASK_ROUTE_ALIASES,
        title: { key: 'plugins.triage.tasks.title', fallback: 'Tasks' },
        description: { key: 'plugins.triage.tasks.description', fallback: 'Your work, and the agents working with you.' },
        icon: 'list',
      }, { sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' },
        id: 'latest',
        container: 'widget',
        target: { kind: 'app' },
        renderer: 'latest-widget',
        title: { key: 'plugins.triage.widget.latest', fallback: 'New for you' },
        icon: 'change-open',
        home: { default: 'shown' },
      }, {
        id: 'my-tasks', container: 'widget', target: { kind: 'app' }, renderer: 'tasks-widget',
        title: { key: 'plugins.triage.tasks.myTasks', fallback: 'My tasks' }, icon: 'task',
        sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' },
        home: { default: 'available' },
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
      }, {
        // The entry's linked Session beside its story: opened only from the detail's Session item (`both`), never
        // listed App-wide; it reads the opening page's selected entry from `openedFrom`.
        id: TRIAGE_ENTRY_SESSION_COMPANION_V1.localId,
        container: 'rightSidebarTab',
        target: { kind: 'app' },
        reach: 'pageItems',
        renderer: 'entry-session-companion',
        title: { key: 'plugins.triage.surface.detail.tab.session', fallback: 'Session' },
        icon: 'conversations',
      }, {
        // The Session PR glance (plan 05 §6, lab c6). Added to the Companion on a successful link
        // (`sessions/sessionPullRequestPlacement.ts`); personal and removable, Add restores it. It reads
        // the one shared Session PR Resource, so it adds no read, watch or timer of its own.
        id: 'session-pull-request',
        container: 'widget',
        target: { kind: 'session' },
        sizeDeclaration: { sizes: ['medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' },
        resources: [{ pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_LOCAL_ID_V1 }],
        inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json', required: true, optionsSourceId: 'sessions' }] },
        inputSchema: {
          type: 'object',
          properties: { session: {
            type: 'object',
            properties: { serverId: { type: 'string', minLength: 1 }, sessionId: { type: 'string', minLength: 1 } },
            required: ['serverId', 'sessionId'], additionalProperties: false,
          } },
          required: ['session'], additionalProperties: false,
        },
        sessionInputPath: 'session',
        renderer: 'session-pull-request-widget',
        title: { key: 'plugins.triage.prCard.title', fallback: 'Pull request' },
        icon: 'change-open',
      }, {
        // SCM's pull request slot (Git pane, plan 05 §6.3, lab c7): branch discovery comes in as launch input;
        // a matching Session binding draws the shared status, anything else stays a labelled branch hint.
        id: 'scm-pull-request',
        container: 'scmPullRequest',
        target: { kind: 'session' },
        renderer: 'scm-pull-request-card',
        resourceLinks: triageResourceLinks(TRIAGE_RESOURCE_DETAILS_LOCAL_ID_V1),
      }, {
        // The Project's source-control card: no implicit Session, so it is always a hint whose Link picks one.
        id: 'scm-pull-request-project',
        container: 'scmPullRequest',
        target: { kind: 'app' },
        renderer: 'scm-pull-request-card',
        resourceLinks: triageResourceLinks(TRIAGE_APP_PAGE_LOCAL_ID_V1),
      }, {
        id: TRIAGE_RESOURCE_DETAILS_LOCAL_ID_V1,
        container: 'detailsTab', target: { kind: 'session' }, renderer: 'list-page',
        instancePolicy: 'multiple', title: TRIAGE_DISPLAY_NAME, icon: 'change-open',
      }],
      renderers: [{
        id: 'review-detail', kind: 'reactNative', artifact: 'triage-list-page-native', requiredHostMethods: ['openResource'],
      }, {
        id: 'internal-task-detail', kind: 'reactNative', artifact: 'triage-internal-task-detail-native', requiredHostMethods: ['executeAction'],
      }, {
        id: 'internal-task-settings', kind: 'reactNative', artifact: 'triage-internal-task-settings-native', requiredHostMethods: ['executeAction'],
      }, {
        id: 'tasks-page', kind: 'reactNative', artifact: 'triage-list-page-native',
        requiredHostMethods: ['executeAction', 'publishCurrentUiContext'],
      }, {
        id: 'tasks-widget', kind: 'reactNative', artifact: 'triage-tasks-widget-native',
        requiredHostMethods: ['executeAction', 'openSurface'],
      }, {
        id: 'list-page',
        kind: 'reactNative',
        artifact: 'triage-list-page-native',
        // The page's rows come from this plugin's own list Action; a host that
        // cannot dispatch one would mount an empty shell.
        requiredHostMethods: ['executeAction', 'publishCurrentUiContext'],
      }, {
        id: 'latest-widget',
        kind: 'reactNative',
        artifact: 'triage-latest-widget-native',
        requiredHostMethods: ['executeAction', 'openSurface'],
      }, {
        id: 'comparison-picker',
        kind: 'reactNative',
        artifact: 'triage-comparison-picker-native',
        requiredHostMethods: ['executeAction', 'settleEphemeralInput'],
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
          'openResource',
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
        id: 'session-pull-request-widget',
        kind: 'reactNative',
        artifact: 'triage-session-pull-request-native',
        // The Watch mode is changed through Channels' Watch Action; the rest is the shared Resource read.
        requiredHostMethods: ['executeAction', 'openResource'],
      }, {
        id: 'scm-pull-request-card',
        kind: 'reactNative',
        artifact: 'triage-scm-pull-request-native',
        // Link this PR selects a Session (Project) or attaches through Channels' binding Action.
        requiredHostMethods: ['executeAction', 'openResource'],
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
      }, {
        id: 'entry-session-companion',
        kind: 'reactNative',
        artifact: 'triage-entry-session-native',
        // The entry's detail read, the shared window it joins, Open session and Unlink are all own Actions.
        requiredHostMethods: ['executeAction'],
      }],
    },
    composer: {
      regions: {
        'session-pull-request-status': {
          placement: 'statusStrip',
          emphasis: 'prominent',
          scopes: ['session'],
          renderer: { renderer: 'session-pull-request-widget' },
        },
      },
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
            // The picker owns its search and its List, so the host gives it a
            // bounded body rather than a one-row list shell that repeats the title.
            layout: 'content',
          },
          compactRenderer: { renderer: 'entries-compact' },
          // Required whenever a compact renderer is declared: a narrow composer
          // must still be able to reach the control from the overflow.
          overflow: {
            label: TRIAGE_DISPLAY_NAME,
            icon: TRIAGE_ENTRIES_CONTROL_ICON_V1,
            presentation: { presentation: 'dialog', layout: 'content' },
          },
        },
      },
    },
  });
  const declaredPlugin: TriagePlugin = plugin;
  return declaredPlugin satisfies typeof plugin;
}

/** The one Triage plugin value: manifest, activation and contribution points. */
export const TRIAGE_PLUGIN: TriagePlugin = createTriagePlugin();

export { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, TRIAGE_AGENT_ACTIONS_CONTRIBUTION_POINT_REF_V1 } from './targetedContributions.js';
import { runTriageAttention } from './attention/runtime.js';
import { publishSourceAttention } from './attention/publish.js';
import { TRIAGE_PUBLISH_ATTENTION_ACTION_REF_V1, TriagePublishAttentionInputV1Schema, TriagePublishAttentionResultV1Schema } from '@happier-dev/triage-protocol/v1';
