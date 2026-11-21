import type { definePlugin, DefinePluginInput } from '@happier-dev/plugin-sdk';
import { createTriageRunConfiguredActionHandler } from './actions/configuredActionRun.js';
import { TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1, TriageRunConfiguredActionInputV1Schema, TriageRunConfiguredActionResultV1Schema } from './actions/configuredActionRunProtocol.js';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';
import { TRIAGE_DATA_ACTION_EXECUTION_V1 } from './accountExecution.js';
import { PluginSearchQueryV1Schema, PluginSearchResultV1Schema, PluginWorkItemTransitionInputV1Schema } from '@happier-dev/plugin-sdk';
import { TRIAGE_WORK_ITEMS_TRANSITION_ACTION_LOCAL_ID_V1, transitionTriageWorkItem } from './workItems/runtime.js';
import { TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1, TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1, TriageReadConfiguredSourceInstancesInputV1Schema, TriageReadConfiguredSourceInstancesResultV1Schema, TriageSourceAdministrationActionInputV1Schema, TriageSourceAdministrationActionResultV1Schema, TriagePullRequestStatusResultV1Schema, TriageTaskWriteResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { createTriageAdministerSourceInstanceActionHandler } from './actions/administerSourceInstanceAction.js';
import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, TRIAGE_READ_PULL_REQUEST_STATUS_ACTION_LOCAL_ID_V1, TriageReadEntryDetailInputV1Schema, TriageReadEntryDetailResultV1Schema } from './actions/entryDetailProtocol.js';
import { createTriageListEntriesActionHandler } from './actions/listEntries.js';
import { createTriageSearchEntriesActionHandler } from './actions/searchEntries.js';
import { createTriageCreateTaskActionHandler, createTriageEditTaskActionHandler, createTriageTransitionTaskActionHandler } from './actions/tasks.js';
import { createTriageReadTaskOriginReviewActionHandler, createTriageSetTaskOriginReviewActionHandler } from './actions/taskReview.js';
import { TRIAGE_TASKS_READ_ORIGIN_REVIEW_ACTION_LOCAL_ID_V1, TRIAGE_TASKS_SET_ORIGIN_REVIEW_ACTION_LOCAL_ID_V1, TriageReadTaskOriginReviewInputV1Schema, TriageReadTaskOriginReviewResultV1Schema, TriageSetTaskOriginReviewInputV1Schema, TriageSetTaskOriginReviewResultV1Schema } from './actions/taskReviewProtocol.js';
import { createTriageReadTaskOriginErrorActionHandler, createTriageSetTaskOriginErrorActionHandler } from './actions/taskOrigin.js';
import { TRIAGE_TASK_ORIGIN_RESOURCE_LOCAL_ID_V1 } from './actions/taskOriginProtocol.js';
import { TRIAGE_TASK_ORIGIN_RESOURCE_RUNTIME } from './actions/taskOriginResource.js';
import { TRIAGE_TASKS_READ_ORIGIN_ERROR_ACTION_LOCAL_ID_V1, TRIAGE_TASKS_SET_ORIGIN_ERROR_ACTION_LOCAL_ID_V1, TriageReadTaskOriginErrorInputV1Schema, TriageReadTaskOriginErrorResultV1Schema, TriageSetTaskOriginErrorInputV1Schema, TriageSetTaskOriginErrorResultV1Schema } from './actions/taskOriginProtocol.js';
import { TRIAGE_TASKS_LIST_ACTION_LOCAL_ID_V1, TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1, TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1, TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1, TRIAGE_TASKS_LINK_ACTION_LOCAL_ID_V1, TriageCreateTaskActionInputV1Schema, TriageCreateTaskActionResultV1Schema, TriageEditTaskActionInputV1Schema, TriageTransitionTaskActionInputV1Schema } from './actions/tasksProtocol.js';
import { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, TriageListEntriesInputV1Schema, TriageListEntriesResultV1Schema } from './actions/listEntriesProtocol.js';
import { createTriageReadConfiguredSourceInstancesActionHandler } from './actions/readConfiguredSourceInstances.js';
import { TRIAGE_SEARCH_ENTRIES_ACTION_LOCAL_ID_V1 } from './actions/searchEntriesProtocol.js';
import { createTriageReadEntryDetailActionHandler } from './actions/readEntryDetail.js';
import { createTriageReobserveEntryActionHandler } from './actions/reobserveEntry.js';
import { createTriageResolveResourceActionHandler } from './actions/resolveResource.js';
import { TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1, TriageResolveResourceActionInputV1Schema, TriageResolveResourceActionResultV1Schema } from './actions/resolveResourceProtocol.js';
import { createTriageReadPullRequestStatusActionHandler, createTriageReadPullRequestStatusObserver } from './actions/readPullRequestStatus.js';
import { TRIAGE_SESSION_LINKS_RESOURCE_LOCAL_ID_V1, TRIAGE_SESSION_LINKS_RESOURCE_RUNTIME } from './sessions/sessionLinksResource.js';
import { TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_LOCAL_ID_V1, TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_RUNTIME } from './sessions/sessionPullRequestResource.js';
import { TRIAGE_SESSION_PULL_REQUEST_INBOX_RESOURCE_LOCAL_ID_V1, TRIAGE_SESSION_PULL_REQUEST_INBOX_RESOURCE_RUNTIME } from './sessions/sessionPullRequestInbox.js';
import { observeTriageSourceSessionLinks } from './sessions/sessionLinksObservation.js';
import { TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1, TriageReadPullRequestStatusInputV1Schema, TriageReobserveEntryInputV1Schema, TriageReobserveEntryResultV1Schema } from './actions/reobserveEntryProtocol.js';
import { createTriageListPinnedEntriesActionHandler, createTriageSetEntryPinnedActionHandler } from './actions/userMarks.js';
import { createTriageReadFixPullRequestsActionHandler, createTriageSetFixPullRequestActionHandler } from './actions/fixPullRequests.js';
import { TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1, TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1, TriageReadFixPullRequestsInputV1Schema, TriageReadFixPullRequestsResultV1Schema, TriageSetFixPullRequestInputV1Schema, TriageSetFixPullRequestResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1, TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1, TriageListPinnedEntriesInputV1Schema, TriageListPinnedEntriesResultV1Schema, TriageSetEntryPinnedInputV1Schema, TriageSetEntryPinnedResultV1Schema } from './actions/userMarksProtocol.js';
import { createTriageUnlinkEntryFromSessionActionHandler, createTriageVerifyExistingReviewWorkspaceActionHandler } from './actions/entrySession.js';
import { TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1, TRIAGE_VERIFY_EXISTING_REVIEW_WORKSPACE_ACTION_LOCAL_ID_V1, TriageUnlinkEntryFromSessionActionInputV1Schema, TriageUnlinkEntryFromSessionActionResultV1Schema, TriageVerifyExistingReviewWorkspaceInputV1Schema, TriageVerifyExistingReviewWorkspaceResultV1Schema } from './actions/entrySessionProtocol.js';
import { createTriageLinkEntryToSessionActionHandler, createTriageReadSourceSessionLinksActionHandler } from './actions/sessionLinks.js';
import { TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1, TriageLinkEntryToSessionActionResultV1Schema, TriageLinkEntryToSessionInputV1Schema, TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1, TriageReadSourceSessionLinksInputV1Schema, TriageReadSourceSessionLinksActionResultV1Schema } from './actions/sessionLinksProtocol.js';
import { createTriageAdministerActionActionHandler, createTriageReadActionsActionHandler } from './actions/actionsCatalog.js';
import { TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1, TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1, TriageAdministerActionInputV1Schema, TriageAdministerActionResultV1Schema, TriageReadActionsActionInputV1Schema, TriageReadActionsActionResultV1Schema } from './actions/actionsCatalogProtocol.js';
import { createTriageAdministerSavedViewActionHandler, createTriageReadSavedViewsActionHandler } from './actions/savedViews.js';
import { TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1, TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1, TriageAdministerSavedViewInputV1Schema, TriageAdministerSavedViewResultV1Schema, TriageReadSavedViewsInputV1Schema, TriageReadSavedViewsResultV1Schema } from './actions/savedViewsProtocol.js';
import { TRIAGE_DISPLAY_NAME } from './displayName.js';
import { mintTriageOpaqueIdV1 } from './opaqueId.js';
import { INTERNAL_TASK_ACTIONS_V1 } from './internalTasks/contribution.js';
import { REVIEW_ACTIONS_V1 } from './reviews/contribution.js';

/** Named canonical schemas keep portable declaration emission finite. */
export type TriageAccountActionSchemas = {
  readonly [TRIAGE_WORK_ITEMS_TRANSITION_ACTION_LOCAL_ID_V1]: readonly [typeof PluginWorkItemTransitionInputV1Schema, typeof TriageTaskWriteResultV1Schema];
  readonly [TRIAGE_TASKS_LIST_ACTION_LOCAL_ID_V1]: readonly [typeof TriageListEntriesInputV1Schema, typeof TriageListEntriesResultV1Schema];
  readonly [TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1]: readonly [typeof TriageCreateTaskActionInputV1Schema, typeof TriageCreateTaskActionResultV1Schema];
  readonly [TRIAGE_TASKS_SET_ORIGIN_REVIEW_ACTION_LOCAL_ID_V1]: readonly [typeof TriageSetTaskOriginReviewInputV1Schema, typeof TriageSetTaskOriginReviewResultV1Schema];
  readonly [TRIAGE_TASKS_READ_ORIGIN_REVIEW_ACTION_LOCAL_ID_V1]: readonly [typeof TriageReadTaskOriginReviewInputV1Schema, typeof TriageReadTaskOriginReviewResultV1Schema];
  readonly [TRIAGE_TASKS_SET_ORIGIN_ERROR_ACTION_LOCAL_ID_V1]: readonly [typeof TriageSetTaskOriginErrorInputV1Schema, typeof TriageSetTaskOriginErrorResultV1Schema];
  readonly [TRIAGE_TASKS_READ_ORIGIN_ERROR_ACTION_LOCAL_ID_V1]: readonly [typeof TriageReadTaskOriginErrorInputV1Schema, typeof TriageReadTaskOriginErrorResultV1Schema];
  readonly [TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1]: readonly [typeof TriageEditTaskActionInputV1Schema, typeof TriageTaskWriteResultV1Schema];
  readonly [TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1]: readonly [typeof TriageTransitionTaskActionInputV1Schema, typeof TriageTaskWriteResultV1Schema];
  readonly [TRIAGE_TASKS_LINK_ACTION_LOCAL_ID_V1]: readonly [typeof TriageLinkEntryToSessionInputV1Schema, typeof TriageLinkEntryToSessionActionResultV1Schema];
  readonly [TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1]: readonly [typeof TriageListEntriesInputV1Schema, typeof TriageListEntriesResultV1Schema];
  readonly [TRIAGE_SEARCH_ENTRIES_ACTION_LOCAL_ID_V1]: readonly [typeof PluginSearchQueryV1Schema, typeof PluginSearchResultV1Schema];
  readonly [TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1]: readonly [typeof TriageSetEntryPinnedInputV1Schema, typeof TriageSetEntryPinnedResultV1Schema];
  readonly [TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1]: readonly [typeof TriageSetFixPullRequestInputV1Schema, typeof TriageSetFixPullRequestResultV1Schema];
  readonly [TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1]: readonly [typeof TriageReadFixPullRequestsInputV1Schema, typeof TriageReadFixPullRequestsResultV1Schema];
  readonly [TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1]: readonly [typeof TriageListPinnedEntriesInputV1Schema, typeof TriageListPinnedEntriesResultV1Schema];
  readonly [TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1]: readonly [typeof TriageLinkEntryToSessionInputV1Schema, typeof TriageLinkEntryToSessionActionResultV1Schema];
  readonly [TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1]: readonly [typeof TriageReadSourceSessionLinksInputV1Schema, typeof TriageReadSourceSessionLinksActionResultV1Schema];
  readonly [TRIAGE_VERIFY_EXISTING_REVIEW_WORKSPACE_ACTION_LOCAL_ID_V1]: readonly [typeof TriageVerifyExistingReviewWorkspaceInputV1Schema, typeof TriageVerifyExistingReviewWorkspaceResultV1Schema];
  readonly [TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1]: readonly [typeof TriageRunConfiguredActionInputV1Schema, typeof TriageRunConfiguredActionResultV1Schema];
  readonly [TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1]: readonly [typeof TriageUnlinkEntryFromSessionActionInputV1Schema, typeof TriageUnlinkEntryFromSessionActionResultV1Schema];
  readonly [TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1]: readonly [typeof TriageSourceAdministrationActionInputV1Schema, typeof TriageSourceAdministrationActionResultV1Schema];
  readonly [TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1]: readonly [typeof TriageReadConfiguredSourceInstancesInputV1Schema, typeof TriageReadConfiguredSourceInstancesResultV1Schema];
  readonly [TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1]: readonly [typeof TriageReadEntryDetailInputV1Schema, typeof TriageReadEntryDetailResultV1Schema];
  readonly [TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1]: readonly [typeof TriageResolveResourceActionInputV1Schema, typeof TriageResolveResourceActionResultV1Schema];
  readonly [TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1]: readonly [typeof TriageReobserveEntryInputV1Schema, typeof TriageReobserveEntryResultV1Schema];
  readonly [TRIAGE_READ_PULL_REQUEST_STATUS_ACTION_LOCAL_ID_V1]: readonly [typeof TriageReadPullRequestStatusInputV1Schema, typeof TriagePullRequestStatusResultV1Schema];
  readonly [TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1]: readonly [typeof TriageReadSavedViewsInputV1Schema, typeof TriageReadSavedViewsResultV1Schema];
  readonly [TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1]: readonly [typeof TriageAdministerSavedViewInputV1Schema, typeof TriageAdministerSavedViewResultV1Schema];
  readonly [TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1]: readonly [typeof TriageReadActionsActionInputV1Schema, typeof TriageReadActionsActionResultV1Schema];
  readonly [TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1]: readonly [typeof TriageAdministerActionInputV1Schema, typeof TriageAdministerActionResultV1Schema];
};

type TriageActionMetadata = Omit<
  NonNullable<Parameters<typeof definePlugin>[0]['actions']>[string],
  'inputSchema' | 'resultSchema' | 'execution' | 'run' | 'observeRead' | 'operation'
>;
export type TriageAccountActionDeclarations = {
  readonly [TLocalId in keyof TriageAccountActionSchemas]: TriageActionMetadata & {
    readonly execution: typeof TRIAGE_DATA_ACTION_EXECUTION_V1;
    readonly inputSchema: TriageAccountActionSchemas[TLocalId][0];
    readonly resultSchema: TriageAccountActionSchemas[TLocalId][1];
  };
} & typeof INTERNAL_TASK_ACTIONS_V1 & typeof REVIEW_ACTIONS_V1;
export type TriageAccountActions = NonNullable<DefinePluginInput<TriageAccountActionDeclarations>['actions']>;

// The catalog uses the invoking UI's Account storage, including in a browser with no Machine.
const TRIAGE_ACTION_CATALOG_EXECUTION_V1 = { ...TRIAGE_DATA_ACTION_EXECUTION_V1, invokingUi: true } as const;

/** Account registrations shared by the full declaration and portable activation. */
export const TRIAGE_ACCOUNT_ACTIONS: TriageAccountActions = {
[TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1]: {
        title: 'Run a configured entry action',
        description: 'Runs the selected Ask, Fix, Review or custom action for one or many entries at the chosen destination.',
        surfaces: ['ui', 'plugin', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        dangerLevel: 'writesLocal',
        confirmationWhen: { presentUserUi: false },
        sessionTarget: { field: 'handoff.sessionChoice.session', cardinality: 'one' },
        confirmation: {
          title: 'Run this configured action?',
          body: 'This starts the configured work for the selected entries at the chosen session destination.',
          confirmLabel: 'Run action',
        },
        inputSchema: TriageRunConfiguredActionInputV1Schema,
        resultSchema: TriageRunConfiguredActionResultV1Schema,
        execution: { ...TRIAGE_DATA_ACTION_EXECUTION_V1, invokingUi: true },
        run: createTriageRunConfiguredActionHandler(),
      },
[TRIAGE_WORK_ITEMS_TRANSITION_ACTION_LOCAL_ID_V1]: {
        title: 'Change Work Item status', description: 'Changes the selected item to the target state.',
        inputHints: { fields: [
          { path: 'itemId', title: 'Item', widget: 'text' },
          { path: 'transitionId', title: 'Target state', widget: 'text' },
        ] },
        surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'], placementBindings: [], dangerLevel: 'writesRemote', hostAccess: ['account-storage'],
        confirmation: {
          title: 'Change this task’s status?',
          body: 'This applies the selected status transition in its source.',
          confirmLabel: 'Change status',
          inputFields: [
            { path: 'itemId', title: 'Item' },
            { path: 'transitionId', title: 'New status' },
          ],
        },
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        inputSchema: PluginWorkItemTransitionInputV1Schema, resultSchema: TriageTaskWriteResultV1Schema,
        run: transitionTriageWorkItem,
      },
...INTERNAL_TASK_ACTIONS_V1,
...REVIEW_ACTIONS_V1,
[TRIAGE_TASKS_LIST_ACTION_LOCAL_ID_V1]: {
        readOnly: true,
        title: 'List tasks',
        description: 'Reads the current task kinds from configured sources through the shared list window.',
        surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'], placementBindings: [],
        inputSchema: TriageListEntriesInputV1Schema,
        resultSchema: TriageListEntriesResultV1Schema,
        hostAccess: ['account-storage'],
        execution: { ...TRIAGE_DATA_ACTION_EXECUTION_V1, invokingUi: true },
        run: createTriageListEntriesActionHandler({ taskOnly: true }),
      },
[TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1]: {
        title: 'Create a task',
        description: 'Creates a task in the selected place with the supplied details.',
        inputHints: { fields: [
          { path: 'fields.title', title: 'Title', widget: 'text' },
          { path: 'fields.body', title: 'Description', widget: 'textarea' },
          { path: 'placeId', title: 'Place', widget: 'text' },
          { path: 'initialStatusId', title: 'Initial state', widget: 'text' },
        ] },
        surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'], placementBindings: [],
        // The selected source Action owns the effect and its approval default.
        inputSchema: TriageCreateTaskActionInputV1Schema,
        resultSchema: TriageCreateTaskActionResultV1Schema,
        hostAccess: ['account-storage'],
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageCreateTaskActionHandler(),
      },
      [TRIAGE_TASKS_SET_ORIGIN_REVIEW_ACTION_LOCAL_ID_V1]: {
        title: 'Link or unlink selected Review findings',
        description: 'Repairs the Review relationship on an existing task without creating another task or copying findings.',
        surfaces: ['ui', 'voice', 'plugin', 'agent', 'mcp', 'cli'], placementBindings: [],
        inputSchema: TriageSetTaskOriginReviewInputV1Schema,
        resultSchema: TriageSetTaskOriginReviewResultV1Schema,
        hostAccess: ['account-storage'], execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageSetTaskOriginReviewActionHandler(),
      },
      [TRIAGE_TASKS_READ_ORIGIN_REVIEW_ACTION_LOCAL_ID_V1]: {
        title: 'Read a task Review relationship',
        description: 'Reads selected Review and finding identities; opening the Review requires its own access.',
        surfaces: ['ui', 'voice', 'plugin', 'agent', 'mcp', 'cli'], placementBindings: [],
        dangerLevel: 'safe', readOnly: true,
        inputSchema: TriageReadTaskOriginReviewInputV1Schema,
        resultSchema: TriageReadTaskOriginReviewResultV1Schema,
        hostAccess: ['account-storage'], execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageReadTaskOriginReviewActionHandler(),
      },
[TRIAGE_TASKS_SET_ORIGIN_ERROR_ACTION_LOCAL_ID_V1]: {
        title: 'Link or unlink a task origin error',
        description: 'Records the selected origin error on an existing task without creating another task.',
        inputHints: { fields: [
          { path: 'entryRef.entryId', title: 'Item', widget: 'text' },
          { path: 'originError', title: 'Origin error', widget: 'json' },
        ] },
        surfaces: ['ui', 'voice', 'plugin', 'agent', 'mcp', 'cli'], placementBindings: [],
        inputSchema: TriageSetTaskOriginErrorInputV1Schema,
        resultSchema: TriageSetTaskOriginErrorResultV1Schema,
        hostAccess: ['account-storage'], execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageSetTaskOriginErrorActionHandler(),
      },
[TRIAGE_TASKS_READ_ORIGIN_ERROR_ACTION_LOCAL_ID_V1]: {
        title: 'Read a task origin error',
        description: 'Reads the exact origin error selected for this task.',
        surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'], placementBindings: [],
        dangerLevel: 'safe', readOnly: true,
        inputSchema: TriageReadTaskOriginErrorInputV1Schema,
        resultSchema: TriageReadTaskOriginErrorResultV1Schema,
        hostAccess: ['account-storage'], execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageReadTaskOriginErrorActionHandler(),
      },
[TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1]: {
        title: 'Edit a task',
        description: 'Updates the selected task with the supplied changes.',
        inputHints: { fields: [
          { path: 'entryRef.entryId', title: 'Item', widget: 'text' },
          { path: 'fields', title: 'Changes', widget: 'json' },
        ] },
        surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'], placementBindings: [],
        inputSchema: TriageEditTaskActionInputV1Schema,
        resultSchema: TriageTaskWriteResultV1Schema,
        hostAccess: ['account-storage'],
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageEditTaskActionHandler(),
      },
[TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1]: {
        title: 'Change a task’s status',
        description: 'Changes the selected task to the target state.',
        inputHints: { fields: [
          { path: 'entryRef.entryId', title: 'Item', widget: 'text' },
          { path: 'transitionId', title: 'Target state', widget: 'text' },
          { path: 'fieldValues', title: 'Transition fields', widget: 'json' },
        ] },
        surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'], placementBindings: [],
        inputSchema: TriageTransitionTaskActionInputV1Schema,
        resultSchema: TriageTaskWriteResultV1Schema,
        hostAccess: ['account-storage'],
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageTransitionTaskActionHandler(),
      },
[TRIAGE_TASKS_LINK_ACTION_LOCAL_ID_V1]: {
        title: 'Link a task to a session',
        description: 'Links the selected task to the session.',
        inputHints: { fields: [
          { path: 'entryRef.entryId', title: 'Item', widget: 'text' },
          { path: 'sessionId', title: 'Session', widget: 'json' },
        ] },
        surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'], placementBindings: [],
        dangerLevel: 'writesLocal',
        confirmationWhen: { presentUserUi: false },
        sessionTarget: { field: 'sessionId', cardinality: 'one' },
        confirmation: {
          title: 'Link this task to the session?',
          body: 'This records the task as work for the selected session in this Happier Account.',
          confirmLabel: 'Link task',
          inputFields: [
            { path: 'entryRef.entryId', title: 'Item' },
            { path: 'sessionId', title: 'Session' },
            { path: 'display.locator.displayPath', title: 'Location' },
          ],
        },
        inputSchema: TriageLinkEntryToSessionInputV1Schema,
        resultSchema: TriageLinkEntryToSessionActionResultV1Schema,
        hostAccess: ['account-storage'],
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageLinkEntryToSessionActionHandler(),
      },
[TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1]: {
        readOnly: true,
        title: {
          key: 'plugins.triage.action.listEntries.title',
          fallback: 'Read the current list window',
        },
        description: {
          key: 'plugins.triage.action.listEntries.description',
          fallback: 'Reads one bounded ordered window of pull requests, issues and error groups from the configured sources. For source Actions, use the matching row’s entryRef, selected sourceInstanceId and its observation.outcome.locator. Read entries/read-detail-v1 for the full configured instance.',
        },
        // UI, Voice and automated callers share the same bounded read owner.
        surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: [],
        inputSchema: TriageListEntriesInputV1Schema,
        resultSchema: TriageListEntriesResultV1Schema,
        // The one Collection it touches is `source-instances`, read-only.
        hostAccess: ['account-storage'],
        execution: { ...TRIAGE_DATA_ACTION_EXECUTION_V1, invokingUi: true },
        run: createTriageListEntriesActionHandler(),
      },
[TRIAGE_SEARCH_ENTRIES_ACTION_LOCAL_ID_V1]: {
        readOnly: true,
        // The Universal Search section header. It is the product name the
        // views already carry, which is a proper noun rather than translated
        // copy — the same reason `ui.views` declares it directly.
        title: TRIAGE_DISPLAY_NAME,
        description: 'Search configured GitHub issues, pull requests and error groups by title or repository text. Each result.command.input contains entryRef and sourceInstance. For an exact GitHub issue URL, including before pin issue, unpin or subscribe, use entries/resolve-resource-v1 instead; it explains how to obtain instance, localRef and routingToken for source Actions. For a text-search result, call entries/read-detail-v1 for instance and get the matching entry locator from entries/list-v1. Pass it as lastKnownLocator to entries/reobserve-v1 to refresh the observation.',
        // Search and automated callers share the Account scan/fold owner.
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        // The provider section IS the affordance. A query Action is not also a
        // command-palette entry, and the manifest owner refuses one that is.
        placementBindings: [],
        hostAccess: ['account-storage'],
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        // The one canonical search contract, imported rather than restated, so
        // the declaration and the host's parse cannot describe two shapes.
        inputSchema: PluginSearchQueryV1Schema,
        resultSchema: PluginSearchResultV1Schema,
        run: createTriageSearchEntriesActionHandler(),
      },
[TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1]: {
        title: 'Pin or unpin an entry',
        description: 'Keeps one pull request, issue or error group at the top of the list, or removes that mark again.',
        // Every caller reaches the same reversible user-mark writer.
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: [],
        // Pins stay direct for agents too; session starts and configuration
        // writes keep Ask for agents while a present-user UI press is sufficient.
        inputSchema: TriageSetEntryPinnedInputV1Schema,
        resultSchema: TriageSetEntryPinnedResultV1Schema,
        hostAccess: ['account-storage'],
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageSetEntryPinnedActionHandler(),
      },
[TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1]: {
        title: 'Link or unlink a fix pull request',
        description: 'Records, or removes, the pull request that fixes one issue or error group.',
        // The caller is this plugin's own mounted detail affordance, like Pin.
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: [],
        // Default `safe`: durable user state whose exact inverse is one press
        // away, touching nothing outside Happier. It writes only `user-marks`.
        inputSchema: TriageSetFixPullRequestInputV1Schema,
        resultSchema: TriageSetFixPullRequestResultV1Schema,
        hostAccess: ['account-storage'],
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageSetFixPullRequestActionHandler(),
      },
[TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1]: {
        readOnly: true,
        title: 'Read the fix pull requests',
        description: 'Reads the pull requests linked as fixes for one issue or error group.',
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: [],
        inputSchema: TriageReadFixPullRequestsInputV1Schema,
        resultSchema: TriageReadFixPullRequestsResultV1Schema,
        // Reads `user-marks` and `session-links`; writes nothing.
        hostAccess: ['account-storage'],
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageReadFixPullRequestsActionHandler(),
      },
[TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1]: {
        readOnly: true,
        title: 'Read the pinned entries',
        description: 'Reads one bounded page of the entries the user pinned, newest first.',
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: [],
        inputSchema: TriageListPinnedEntriesInputV1Schema,
        resultSchema: TriageListPinnedEntriesResultV1Schema,
        // The one Collection it touches is `user-marks`, read-only.
        hostAccess: ['account-storage'],
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageListPinnedEntriesActionHandler(),
      },
[TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1]: {
        title: 'Link an entry to a session',
        description: 'Records that a pull request, issue or error group is being worked on in one session.',
        // Reversible relationship writes are Direct on every surface.
        surfaces: ['ui', 'plugin', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        // It writes durable Account state — the connection between a Session and
        // the entry it was started from — and nothing outside Happier.
        dangerLevel: 'safe',
        sessionTarget: { field: 'sessionId', cardinality: 'one' },
        inputSchema: TriageLinkEntryToSessionInputV1Schema,
        resultSchema: TriageLinkEntryToSessionActionResultV1Schema,
        // The one Collection it touches is `session-links`, and it is the sole
        // writer of it.
        hostAccess: ['account-storage'],
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageLinkEntryToSessionActionHandler(),
      },
[TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1]: {
        title: 'Read source session links',
        description: 'Reads relationships owned by configured sources for the selected session.',
        surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], placementBindings: [],
        readOnly: true,
        sessionTarget: { field: 'sessionId', cardinality: 'one' },
        inputSchema: TriageReadSourceSessionLinksInputV1Schema,
        resultSchema: TriageReadSourceSessionLinksActionResultV1Schema,
        hostAccess: ['account-storage'],
        // The mounted Resource reads the same Account relation owner without
        // requiring a browser's own Machine relay. Source roles retain theirs.
        execution: { ...TRIAGE_DATA_ACTION_EXECUTION_V1, invokingUi: true },
        run: createTriageReadSourceSessionLinksActionHandler(),
        observeRead: observeTriageSourceSessionLinks,
      },
[TRIAGE_VERIFY_EXISTING_REVIEW_WORKSPACE_ACTION_LOCAL_ID_V1]: {
        title: 'Verify an existing review workspace',
        description: 'Checks the accepted Session checkout against the currently authorized pull request without preparing or changing it.',
        surfaces: ['ui', 'plugin', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        readOnly: true,
        sessionTarget: { field: 'session.sessionId', cardinality: 'one' },
        inputSchema: TriageVerifyExistingReviewWorkspaceInputV1Schema,
        resultSchema: TriageVerifyExistingReviewWorkspaceResultV1Schema,
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        hostAccess: ['account-storage'],
        run: createTriageVerifyExistingReviewWorkspaceActionHandler(),
      },
[TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1]: {
        title: 'Unlink an entry from a session',
        description: 'Removes the record that a pull request, issue or error group is being worked on in one session.',
        // Every admitted caller uses the same reversible relationship default.
        surfaces: ['ui', 'plugin', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        dangerLevel: 'safe',
        sessionTarget: { field: 'sessionId', cardinality: 'one' },
        inputSchema: TriageUnlinkEntryFromSessionActionInputV1Schema,
        resultSchema: TriageUnlinkEntryFromSessionActionResultV1Schema,
        hostAccess: ['account-storage'],
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageUnlinkEntryFromSessionActionHandler(),
      },
[TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1]: {
        title: 'Configure a source',
        description: 'Creates, reconfigures, removes or restores one configured pull-request, issue or error-group source.',
        // Settings and automated invocations share the configured-instance writer.
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: [],
        // It writes durable Account state — the record of which sources the user
        // configured — and nothing outside Happier.
        dangerLevel: 'writesLocal',
        confirmationWhen: { presentUserUi: false },
        confirmation: {
          title: 'Apply this source change?',
          body: 'This creates, reconfigures, removes, or restores the selected source in this Happier Account. Removing a source takes its entries out of the list; your pins and Session links stay.',
          confirmLabel: 'Apply change',
        },
        inputSchema: TriageSourceAdministrationActionInputV1Schema,
        resultSchema: TriageSourceAdministrationActionResultV1Schema,
        // The one Collection it touches is `source-instances`, and it is the sole
        // writer of it.
        hostAccess: ['account-storage'],
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageAdministerSourceInstanceActionHandler({
          mintSourceInstanceId: mintTriageOpaqueIdV1,
          nowMs: () => Date.now(),
        }),
      },
[TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1]: {
        readOnly: true,
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
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageReadConfiguredSourceInstancesActionHandler(),
      },
[TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1]: {
        readOnly: true,
        title: 'Read the durable facts of one entry',
        description: 'Reads the configured connection and linked Sessions for an exact entry. First resolve a GitHub issue or pull request URL with entries/resolve-resource-v1, or search entries/search-v1. Pass v:1, its entryRef and sourceInstanceId from sourceInstance.sourceInstanceId. On kind read, result.instance is the configured instance required by source read and mutation Actions. The localRef uses kindId, collisionScope and entryId from entryRef; routingToken comes from the resolved locator. Non-secret configuration: instance.configuration.token contains source-selection data, not a credential. Copy the entire returned instance unchanged into source read and mutation Action inputs; never replace its configuration with [REDACTED]. Credentials are acquired internally through the account binding. Keep configuration contents out of user-facing prose. No mounted UI is required.',
        // Explicit reads select any admitted source in the invoking Account,
        // including nested configured runs; callerSource owns source admission.
        surfaces: ['ui', 'plugin', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        inputSchema: TriageReadEntryDetailInputV1Schema,
        resultSchema: TriageReadEntryDetailResultV1Schema,
        // `source-instances` and `session-links`, both read-only.
        hostAccess: ['account-storage'],
        execution: { ...TRIAGE_DATA_ACTION_EXECUTION_V1, invokingUi: true },
        run: createTriageReadEntryDetailActionHandler(),
      },
[TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1]: {
        title: 'Resolve a GitHub issue or other resource URL',
        description: 'Resolve a GitHub issue or pull request URL before pin issue, unpin, subscribe or other source Actions, without scanning the list. Pass v:1 and resource:{kind:"issue",url:"https://github.com/OWNER/REPO/issues/NUMBER"}; pull requests use kind:"pullRequest" and /pull/NUMBER. The resolved result contains entryRef, sourceInstance and locator.routingToken. Next call happier.triage/actions/entries/read-detail-v1 with v:1, entryRef and sourceInstanceId:sourceInstance.sourceInstanceId to obtain result.instance. For source Actions, use that instance, localRef:{kindId,collisionScope,entryId} from entryRef, and routingToken from locator.routingToken. Keep these returned values unchanged; do not invent routing fields. The returned instance.configuration.token is non-secret source-selection data required by source Actions; pass it unchanged rather than substituting [REDACTED], while keeping its contents out of user-facing prose. A missing route or unavailable result cannot be used for a write.',
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: [],
        dangerLevel: 'safe',
        readOnly: true,
        inputSchema: TriageResolveResourceActionInputV1Schema,
        resultSchema: TriageResolveResourceActionResultV1Schema,
        hostAccess: ['account-storage'],
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageResolveResourceActionHandler(),
      },
[TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1]: {
        readOnly: true,
        title: 'Re-read an entry after a provider change',
        description: 'Reads the exact selected entry through its configured source. Pass lastKnownLocator from the selected list observation or resolved resource. For source Actions, use the current observation.outcome.locator on a present result. For a pull request Review, pass includeComparisonSource:true and use the returned comparisonSource as singleIntent.comparison in sessions/run-configured-v1.',
        surfaces: ['ui', 'plugin', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        inputSchema: TriageReobserveEntryInputV1Schema,
        resultSchema: TriageReobserveEntryResultV1Schema,
        hostAccess: ['account-storage'],
        execution: { ...TRIAGE_DATA_ACTION_EXECUTION_V1, invokingUi: true },
        run: createTriageReobserveEntryActionHandler(),
      },
[TRIAGE_READ_PULL_REQUEST_STATUS_ACTION_LOCAL_ID_V1]: {
        title: 'Read pull request status',
        description: 'Reads checks, reviews, mergeability and branches for the exact selected pull request.',
        surfaces: ['ui', 'plugin', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        dangerLevel: 'safe',
        readOnly: true,
        inputSchema: TriageReadPullRequestStatusInputV1Schema,
        resultSchema: TriagePullRequestStatusResultV1Schema,
        hostAccess: ['account-storage'],
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageReadPullRequestStatusActionHandler(),
        observeRead: createTriageReadPullRequestStatusObserver(),
      },
[TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1]: {
        readOnly: true,
        title: 'Read the saved views',
        description: 'Reads the saved filter and order views. Select one on this device with ui/mounted-v1 selectSavedView.',
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: [],
        inputSchema: TriageReadSavedViewsInputV1Schema,
        resultSchema: TriageReadSavedViewsResultV1Schema,
        hostAccess: ['account-storage'],
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageReadSavedViewsActionHandler(),
      },
[TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1]: {
        title: 'Save, update or delete a view',
        description: 'Creates, renames, updates or removes one saved filter and order view. Selection uses ui/mounted-v1 selectSavedView on the addressed client.',
        // The same mounted UI surface as the list read: the caller is this plugin's
        // own mounted lens control, which holds no Settings member of its own.
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: [],
        // It writes durable Account state, and the exact inverse is one press
        // away; nothing outside Happier is touched.
        dangerLevel: 'writesLocal',
        confirmationWhen: { presentUserUi: false },
        confirmation: {
          title: 'Apply this saved-view change?',
          body: 'This creates, renames, updates, or removes a saved PRs & Issues view in this Happier Account.',
          confirmLabel: 'Apply change',
        },
        inputSchema: TriageAdministerSavedViewInputV1Schema,
        resultSchema: TriageAdministerSavedViewResultV1Schema,
        hostAccess: ['account-storage'],
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        run: createTriageAdministerSavedViewActionHandler(),
      },
[TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1]: {
        readOnly: true,
        title: 'Read the configured actions',
        description: 'Reads the configured set of things a reader can start from a pull request, issue or error group.',
        // The editor and external handoff surfaces read this same Account owner.
        surfaces: ['ui', 'plugin', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        inputSchema: TriageReadActionsActionInputV1Schema,
        resultSchema: TriageReadActionsActionResultV1Schema,
        hostAccess: ['account-storage'],
        execution: TRIAGE_ACTION_CATALOG_EXECUTION_V1,
        run: createTriageReadActionsActionHandler(),
      },
[TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1]: {
        title: 'Add, change, remove, reorder or restore actions',
        description: 'Creates, renames, disables, reconfigures, removes or reorders one configured action, or restores the shipped defaults.',
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: [],
        // It writes durable Account state, and the exact inverse is one press
        // away; nothing outside Happier is touched.
        dangerLevel: 'writesLocal',
        confirmationWhen: { presentUserUi: false },
        confirmation: {
          title: 'Apply this configured-action change?',
          body: 'This adds, changes, removes, enables, disables, reorders, or restores the default entry actions in this Happier Account.',
          confirmLabel: 'Apply change',
        },
        inputSchema: TriageAdministerActionInputV1Schema,
        resultSchema: TriageAdministerActionResultV1Schema,
        hostAccess: ['account-storage'],
        execution: TRIAGE_ACTION_CATALOG_EXECUTION_V1,
        run: createTriageAdministerActionActionHandler(),
      }
} as const;
export const TRIAGE_ACCOUNT_RESOURCES = {
[TRIAGE_TASK_ORIGIN_RESOURCE_LOCAL_ID_V1]: {
        source: 'dynamic', kind: 'config', scope: 'surface', contentType: 'application/json',
        hostAccess: ['account-storage'], execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        runtime: TRIAGE_TASK_ORIGIN_RESOURCE_RUNTIME,
      },
[TRIAGE_SESSION_LINKS_RESOURCE_LOCAL_ID_V1]: {
        source: 'dynamic',
        kind: 'config',
        scope: 'session',
        contentType: 'application/json',
        hostAccess: ['account-storage'],
        execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        runtime: TRIAGE_SESSION_LINKS_RESOURCE_RUNTIME,
      },
[TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_LOCAL_ID_V1]: {
        source: 'dynamic', kind: 'config', scope: 'session', contentType: 'application/json',
        hostAccess: ['account-storage'], execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        runtime: TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_RUNTIME,
      },
[TRIAGE_SESSION_PULL_REQUEST_INBOX_RESOURCE_LOCAL_ID_V1]: {
        source: 'dynamic', kind: 'config', scope: 'surface', contentType: 'application/json',
        sessionInbox: { detailResourceId: TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_LOCAL_ID_V1 },
        hostAccess: ['account-storage'], execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
        runtime: TRIAGE_SESSION_PULL_REQUEST_INBOX_RESOURCE_RUNTIME,
      }
} as const;

export type TriageAccountDefinition = Pick<DefinePluginInput<TriageAccountActionDeclarations>, 'version' | 'displayName'> & Readonly<{
  id: typeof TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1;
  actions: TriageAccountActions;
  resources: typeof TRIAGE_ACCOUNT_RESOURCES;
}>;

export const TRIAGE_ACCOUNT_DEFINITION: TriageAccountDefinition = {
  id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, version: '0.0.0', displayName: TRIAGE_DISPLAY_NAME,
  actions: TRIAGE_ACCOUNT_ACTIONS, resources: TRIAGE_ACCOUNT_RESOURCES,
} as const;
