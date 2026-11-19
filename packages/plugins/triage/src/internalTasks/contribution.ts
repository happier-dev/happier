import { TRIAGE_DATA_ACTION_EXECUTION_V1 } from '../accountExecution.js';
import { type TriageSourceDescriptorV1, TriageSourcesContributionProtocolV1, TriageSourceAdministrationActionResultV1Schema, TRIAGE_NATIVE_INVESTIGATION_KINDS_V1 } from '@happier-dev/triage-protocol/v1';
import { defineProtocolLiteral, defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import {
  INTERNAL_TASK_DRAFT_V1, INTERNAL_TASK_STATES_V1, internalTaskStateV1,
  INTERNAL_TASK_EDIT_FIELDS_V1, INTERNAL_TASK_SORT_FIELDS_V1,
  scanInternalTasks, getInternalTask, createInternalTask, editInternalTask, transitionInternalTask,
  linkInternalTaskSession, readInternalTaskSessionLinks,
} from './source.js';
import { INTERNAL_TASK_ACCOUNT_DATA_INSTANCE_V1, INTERNAL_TASK_SOURCE_RECORD_V1 } from './configuration.js';
import { INTERNAL_TASK_CONFIGURE_ACTION_ID_V1, INTERNAL_TASK_SOURCE_LABEL_V1 } from './identity.js';

const INTERNAL_TASK_LIST_INSTANCES_ACTION_ID_V1 = 'internal/tasks/list-instances-v1';
const INTERNAL_TASK_SCAN_ACTION_ID_V1 = 'internal/tasks/scan-v1';
const INTERNAL_TASK_GET_ACTION_ID_V1 = 'internal/tasks/get-v1';
const INTERNAL_TASK_CREATE_ACTION_ID_V1 = 'internal/tasks/create-v1';
const INTERNAL_TASK_EDIT_ACTION_ID_V1 = 'internal/tasks/edit-v1';
const INTERNAL_TASK_TRANSITION_ACTION_ID_V1 = 'internal/tasks/transition-v1';
const INTERNAL_TASK_LINK_SESSION_ACTION_ID_V1 = 'internal/tasks/link-session-v1';
const INTERNAL_TASK_READ_SESSION_LINKS_ACTION_ID_V1 = 'internal/tasks/read-session-links-v1';

const protocol = TriageSourcesContributionProtocolV1;
const fields = INTERNAL_TASK_EDIT_FIELDS_V1;
const statuses = INTERNAL_TASK_STATES_V1.map(id => ({ id, label: internalTaskStateV1(id).nativeLabel, state: internalTaskStateV1(id) }));
export const INTERNAL_TASK_DESCRIPTOR_V1: TriageSourceDescriptorV1 = {
  v: 1, purpose: 'tasks', displayName: INTERNAL_TASK_SOURCE_LABEL_V1, settingsPageId: 'internal-tasks',
  accountDataInstance: INTERNAL_TASK_ACCOUNT_DATA_INSTANCE_V1,
  kinds: [{ id: 'task', workflowSubject: 'issue', displayName: 'Task', pluralDisplayName: 'Tasks', task: true,
    taskCapabilities: { completedScan: true, createFields: fields, editFields: fields, completingTransitionId: 'completed',
      initialStatuses: statuses.map(status => ({ ...status, ...(status.id === 'unstarted' ? { isDefault: true } : {}) })),
      transitions: statuses } }, ...TRIAGE_NATIVE_INVESTIGATION_KINDS_V1],
  sortFields: INTERNAL_TASK_SORT_FIELDS_V1,
  sessionRelations: { kindIds: ['task'] },
};
const surfaces = ['plugin', 'ui', 'agent', 'mcp', 'cli'] as const;
const write = { surfaces, placementBindings: [], execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
  dangerLevel: 'safe' } as const;
const read = { surfaces, placementBindings: [], execution: { ...TRIAGE_DATA_ACTION_EXECUTION_V1, invokingUi: true },
  dangerLevel: 'safe' } as const;
// Account-data edits retain their direct default; explicit Ask still wins at the approval owner.
const taskWrite = { ...write, confirmationWhen: {
  op: 'not', predicate: { op: 'eq', path: 'instance.binding.source', value: 'accountData' },
} } as const;

/** The built-in Account-data source is always available; old setup requests reuse it. */
export const INTERNAL_TASK_ACTIONS_V1 = {
  [INTERNAL_TASK_CONFIGURE_ACTION_ID_V1]: {
    ...write, title: 'Use Happier tasks',
    description: 'Return the existing built-in Happier task source instance; no additional source is created.',
    inputSchema: defineProtocolObject({ v: defineProtocolLiteral(1) }, { policy: 'closed' }),
    resultSchema: TriageSourceAdministrationActionResultV1Schema,
    run: async () => ({ kind: 'reused' as const, sourceInstanceId: INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.sourceInstanceId }),
  },
  [INTERNAL_TASK_LIST_INSTANCES_ACTION_ID_V1]: {
    ...read, title: 'Discover Happier tasks', inputSchema: protocol.operations.listInstances.declaration.input.schema,
    description: 'Discover the built-in Happier task source candidate for Triage source setup.',
    resultSchema: protocol.operations.listInstances.declaration.resultSchema,
    run: async () => ({ kind: 'complete' as const, candidates: [INTERNAL_TASK_DRAFT_V1], failures: [] }),
  },
  [INTERNAL_TASK_SCAN_ACTION_ID_V1]: { ...read, title: 'Read Happier tasks', inputSchema: protocol.operations.scan.declaration.input.schema,
    description: 'Read a page of accessible Happier task observations from the configured source, preserving continuation and incomplete coverage.',
    resultSchema: protocol.operations.scan.declaration.resultSchema, run: scanInternalTasks },
  [INTERNAL_TASK_GET_ACTION_ID_V1]: { ...read, title: 'Read a Happier task', inputSchema: protocol.operations.get.declaration.input.schema,
    description: 'Read one exact Happier task, including editable fields and task relationships, using its source-local reference.',
    resultSchema: protocol.operations.get.declaration.resultSchema, run: getInternalTask },
  [INTERNAL_TASK_CREATE_ACTION_ID_V1]: { ...taskWrite, dangerLevel: protocol.operations.create.declaration.dangerLevel, title: 'Create a Happier task',
    confirmation: {
      title: 'Create this task?',
      body: 'This adds a task to this Happier Account.',
      confirmLabel: 'Create task',
      inputFields: [
        { path: 'kindId', title: 'Type' },
        { path: 'fields.title', title: 'Title' },
        { path: 'fields.body', title: 'Description' },
        { path: 'fields.assigneeIds', title: 'Assignees' },
        { path: 'fields.labelIds', title: 'Labels' },
        { path: 'fields.dueDate', title: 'Due date' },
        { path: 'fields.parent', title: 'Parent' },
        { path: 'fields.blockedBy', title: 'Blocked by' },
        { path: 'placeId', title: 'Place' },
        { path: 'initialStatusId', title: 'Initial status' },
      ],
    },
    description: 'Create a task in the built-in Happier source with its supported task fields and optional initial status.',
    inputSchema: protocol.operations.create.declaration.input.schema, resultSchema: protocol.operations.create.declaration.resultSchema, run: createInternalTask },
  [INTERNAL_TASK_EDIT_ACTION_ID_V1]: { ...taskWrite, dangerLevel: protocol.operations.edit.declaration.dangerLevel, title: 'Edit a Happier task',
    confirmation: {
      title: 'Save these task changes?',
      body: 'This updates the task in this Happier Account.',
      confirmLabel: 'Save changes',
      inputFields: [
        { path: 'lastKnownLocator.routingToken', title: 'Location' },
        { path: 'localRef.entryId', title: 'Item' },
        { path: 'fields.title', title: 'Title' },
        { path: 'fields.body', title: 'Description' },
        { path: 'fields.assigneeIds', title: 'Assignees' },
        { path: 'fields.labelIds', title: 'Labels' },
        { path: 'fields.dueDate', title: 'Due date' },
        { path: 'fields.parent', title: 'Parent' },
        { path: 'fields.blockedBy', title: 'Blocked by' },
      ],
    },
    description: 'Apply the supplied supported fields to an exact Happier task; omitted fields remain unchanged.',
    inputSchema: protocol.operations.edit.declaration.input.schema, resultSchema: protocol.operations.edit.declaration.resultSchema, run: editInternalTask },
  [INTERNAL_TASK_TRANSITION_ACTION_ID_V1]: { ...taskWrite, dangerLevel: protocol.operations.transition.declaration.dangerLevel, title: 'Change a Happier task’s status',
    confirmation: {
      title: 'Change this task’s status?',
      body: 'This updates the task status in this Happier Account.',
      confirmLabel: 'Change status',
      inputFields: [
        { path: 'lastKnownLocator.routingToken', title: 'Location' },
        { path: 'localRef.entryId', title: 'Item' },
        { path: 'transitionId', title: 'New status' },
        { path: 'fieldValues', title: 'Transition fields' },
      ],
    },
    description: 'Apply a declared status transition to an exact Happier task through its existing task Action.',
    inputSchema: protocol.operations.transition.declaration.input.schema, resultSchema: protocol.operations.transition.declaration.resultSchema, run: transitionInternalTask },
  [INTERNAL_TASK_LINK_SESSION_ACTION_ID_V1]: { ...write, title: 'Link or unlink a Happier task',
    description: 'Link or unlink the specified Session on an exact Happier task without starting or sending to that Session.',
    inputSchema: protocol.operations.linkSession.declaration.input.schema, resultSchema: protocol.operations.linkSession.declaration.resultSchema, run: linkInternalTaskSession },
  [INTERNAL_TASK_READ_SESSION_LINKS_ACTION_ID_V1]: { ...read, title: 'Read Happier task work',
    description: 'Read accessible Happier task-to-Session links, optionally filtered by task or Session, preserving unavailable task coverage.',
    readOnly: true,
    inputSchema: protocol.operations.readSessionLinks.declaration.input.schema, resultSchema: protocol.operations.readSessionLinks.declaration.resultSchema, run: readInternalTaskSessionLinks },
};

export function createInternalTaskSourceContributionV1() {
  return protocol.contribute({ descriptor: INTERNAL_TASK_DESCRIPTOR_V1,
    operations: {
      listInstances: protocol.operations.listInstances.bind(INTERNAL_TASK_LIST_INSTANCES_ACTION_ID_V1),
      scan: protocol.operations.scan.bind(INTERNAL_TASK_SCAN_ACTION_ID_V1), get: protocol.operations.get.bind(INTERNAL_TASK_GET_ACTION_ID_V1),
      create: protocol.operations.create.bind(INTERNAL_TASK_CREATE_ACTION_ID_V1), edit: protocol.operations.edit.bind(INTERNAL_TASK_EDIT_ACTION_ID_V1),
      transition: protocol.operations.transition.bind(INTERNAL_TASK_TRANSITION_ACTION_ID_V1),
      linkSession: protocol.operations.linkSession.bind(INTERNAL_TASK_LINK_SESSION_ACTION_ID_V1),
      readSessionLinks: protocol.operations.readSessionLinks.bind(INTERNAL_TASK_READ_SESSION_LINKS_ACTION_ID_V1),
    }, surfaces: { detail: { renderer: 'internal-task-detail' } },
  });
}
