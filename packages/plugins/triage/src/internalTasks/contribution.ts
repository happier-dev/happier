import { TRIAGE_DATA_ACTION_EXECUTION_V1 } from '../accountExecution.js';
import { TriageSourceDescriptorV1Schema, TriageSourcesContributionProtocolV1, TriageSourceAdministrationActionResultV1Schema, TRIAGE_NATIVE_INVESTIGATION_KINDS_V1 } from '@happier-dev/triage-protocol/v1';
import { defineProtocolLiteral, defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import {
  INTERNAL_TASK_DRAFT_V1, INTERNAL_TASK_STATES_V1, internalTaskStateV1,
  INTERNAL_TASK_EDIT_FIELDS_V1,
  scanInternalTasks, getInternalTask, createInternalTask, editInternalTask, transitionInternalTask,
  linkInternalTaskSession, readInternalTaskSessionLinks,
} from './source.js';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from './configuration.js';
import { INTERNAL_TASK_SOURCE_LABEL_V1 } from './identity.js';

const protocol = TriageSourcesContributionProtocolV1;
const fields = INTERNAL_TASK_EDIT_FIELDS_V1;
const statuses = INTERNAL_TASK_STATES_V1.map(id => ({ id, label: internalTaskStateV1(id).nativeLabel, state: internalTaskStateV1(id) }));
export const INTERNAL_TASK_DESCRIPTOR_V1 = TriageSourceDescriptorV1Schema.parse({
  v: 1, purpose: 'tasks', displayName: INTERNAL_TASK_SOURCE_LABEL_V1, settingsPageId: 'internal-tasks',
  kinds: [{ id: 'task', workflowSubject: 'issue', displayName: 'Task', pluralDisplayName: 'Tasks', task: true,
    taskCapabilities: { completedScan: true, createFields: fields, editFields: fields, completingTransitionId: 'completed',
      initialStatuses: statuses.map(status => ({ ...status, ...(status.id === 'unstarted' ? { isDefault: true } : {}) })),
      transitions: statuses } }, ...TRIAGE_NATIVE_INVESTIGATION_KINDS_V1],
  sessionRelations: { kindIds: ['task'] },
});
const surfaces = ['plugin', 'ui', 'agent', 'mcp', 'cli'] as const;
const write = { surfaces, placementBindings: [], execution: TRIAGE_DATA_ACTION_EXECUTION_V1,
  dangerLevel: 'safe' } as const;
const read = { surfaces, placementBindings: [], execution: TRIAGE_DATA_ACTION_EXECUTION_V1, dangerLevel: 'safe' } as const;

/** The built-in Account-data source is always available; old setup requests reuse it. */
export const INTERNAL_TASK_ACTIONS_V1 = {
  'internal/tasks/configure-v1': {
    ...write, title: 'Use Happier tasks',
    description: 'Return the existing built-in Happier task source instance; no additional source is created.',
    inputSchema: defineProtocolObject({ v: defineProtocolLiteral(1) }, { policy: 'closed' }),
    resultSchema: TriageSourceAdministrationActionResultV1Schema,
    run: async () => ({ kind: 'reused' as const, sourceInstanceId: INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.sourceInstanceId }),
  },
  'internal/tasks/list-instances-v1': {
    ...read, title: 'Discover Happier tasks', inputSchema: protocol.operations.listInstances.declaration.input.schema,
    description: 'Discover the built-in Happier task source candidate for Triage source setup.',
    resultSchema: protocol.operations.listInstances.declaration.resultSchema,
    run: async () => ({ kind: 'complete' as const, candidates: [INTERNAL_TASK_DRAFT_V1], failures: [] }),
  },
  'internal/tasks/scan-v1': { ...read, title: 'Read Happier tasks', inputSchema: protocol.operations.scan.declaration.input.schema,
    description: 'Read a page of accessible Happier task observations from the configured source, preserving continuation and incomplete coverage.',
    resultSchema: protocol.operations.scan.declaration.resultSchema, run: scanInternalTasks },
  'internal/tasks/get-v1': { ...read, title: 'Read a Happier task', inputSchema: protocol.operations.get.declaration.input.schema,
    description: 'Read one exact Happier task, including editable fields and task relationships, using its source-local reference.',
    resultSchema: protocol.operations.get.declaration.resultSchema, run: getInternalTask },
  'internal/tasks/create-v1': { ...write, title: 'Create a Happier task',
    description: 'Create a task in the built-in Happier source with its supported task fields and optional initial status.',
    inputSchema: protocol.operations.create.declaration.input.schema, resultSchema: protocol.operations.create.declaration.resultSchema, run: createInternalTask },
  'internal/tasks/edit-v1': { ...write, title: 'Edit a Happier task',
    description: 'Apply the supplied supported fields to an exact Happier task; omitted fields remain unchanged.',
    inputSchema: protocol.operations.edit.declaration.input.schema, resultSchema: protocol.operations.edit.declaration.resultSchema, run: editInternalTask },
  'internal/tasks/transition-v1': { ...write, title: 'Change a Happier task’s status',
    description: 'Apply a declared status transition to an exact Happier task through its existing task Action.',
    inputSchema: protocol.operations.transition.declaration.input.schema, resultSchema: protocol.operations.transition.declaration.resultSchema, run: transitionInternalTask },
  'internal/tasks/link-session-v1': { ...write, title: 'Link or unlink a Happier task',
    description: 'Link or unlink the specified Session on an exact Happier task without starting or sending to that Session.',
    inputSchema: protocol.operations.linkSession.declaration.input.schema, resultSchema: protocol.operations.linkSession.declaration.resultSchema, run: linkInternalTaskSession },
  'internal/tasks/read-session-links-v1': { ...read, title: 'Read Happier task work',
    description: 'Read accessible Happier task-to-Session links, optionally filtered by task or Session, preserving unavailable task coverage.',
    readOnly: true,
    inputSchema: protocol.operations.readSessionLinks.declaration.input.schema, resultSchema: protocol.operations.readSessionLinks.declaration.resultSchema, run: readInternalTaskSessionLinks },
};

export const INTERNAL_TASK_CONTRIBUTION_V1 = protocol.contribute({ descriptor: INTERNAL_TASK_DESCRIPTOR_V1,
  operations: {
    listInstances: protocol.operations.listInstances.bind('internal/tasks/list-instances-v1'),
    scan: protocol.operations.scan.bind('internal/tasks/scan-v1'), get: protocol.operations.get.bind('internal/tasks/get-v1'),
    create: protocol.operations.create.bind('internal/tasks/create-v1'), edit: protocol.operations.edit.bind('internal/tasks/edit-v1'),
    transition: protocol.operations.transition.bind('internal/tasks/transition-v1'),
    linkSession: protocol.operations.linkSession.bind('internal/tasks/link-session-v1'),
    readSessionLinks: protocol.operations.readSessionLinks.bind('internal/tasks/read-session-links-v1'),
  }, surfaces: { detail: { renderer: 'internal-task-detail' } },
});
