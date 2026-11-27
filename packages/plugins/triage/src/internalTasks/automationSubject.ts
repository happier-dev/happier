import type { PluginAccountActionContext, PluginActionInputById } from '@happier-dev/plugin-sdk/actions';
import {
  PluginSubjectKindListInputV1Schema,
  PluginSubjectKindListResultV1Schema,
} from '@happier-dev/plugin-sdk/automations';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { TRIAGE_DATA_ACTION_EXECUTION_V1 } from '../accountExecution.js';
import type { TaskList } from './source.js';

export const TASK_SUBJECT_KIND = 'task';
export const LIST_TASK_SUBJECTS_ACTION = 'internal/tasks/list-subjects-v1';
const identifier = defineProtocolString({ minLength: 1 });
export const TaskSubjectIdentityV1Schema = defineProtocolObject({
  ownerAccountId: identifier,
  taskId: identifier,
}, { policy: 'closed' });

export const taskSubjectKinds = {
  [TASK_SUBJECT_KIND]: {
    label: 'Task',
    icon: 'task',
    identitySchema: TaskSubjectIdentityV1Schema.jsonSchema,
    listAction: LIST_TASK_SUBJECTS_ACTION,
  },
} as const;

type OwnedTaskAutomationInventory = Pick<TaskList, 'scope' | 'todos'> & Readonly<{
  unavailableTasks: NonNullable<TaskList['unavailableTasks']>;
}>;

type TaskInventoryContext = Pick<PluginAccountActionContext, 'signal'> & Readonly<{
  services: Pick<PluginAccountActionContext['services'], 'actions'>;
}>;

export async function readOwnedTaskAutomationInventory(
  context: TaskInventoryContext,
  input: PluginActionInputById['tasks.internal.list'] = {},
): Promise<OwnedTaskAutomationInventory> {
  const list = await context.services.actions.execute('tasks.internal.list', input, { signal: context.signal });
  if (!('status' in list) || list.status !== 'ok') throw new PluginError({
    code: 'reason' in list ? list.reason : 'task_storage_unavailable',
  });
  const { scope } = list;
  return {
    scope,
    todos: list.todos.filter(task => (task.ownerAccountId ?? scope.accountId) === scope.accountId),
    unavailableTasks: list.unavailableTasks?.filter(task => task.ownerAccountId === scope.accountId) ?? [],
  };
}

export const taskSubjectListAction = {
  title: 'List Task automation subjects',
  surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'],
  placementBindings: [],
  execution: { ...TRIAGE_DATA_ACTION_EXECUTION_V1, invokingUi: true },
  dangerLevel: 'safe',
  readOnly: true,
  inputSchema: PluginSubjectKindListInputV1Schema,
  resultSchema: PluginSubjectKindListResultV1Schema,
  async run(input: unknown, context: PluginAccountActionContext) {
    const { query, limit, cursor } = PluginSubjectKindListInputV1Schema.parse(input);
    const list = await readOwnedTaskAutomationInventory(context);

    const needle = query?.trim().toLowerCase() ?? '';
    const matching = list.todos.flatMap(task => {
      const label = task.title.trim() ? task.title : task.id;
      if (!label.toLowerCase().includes(needle)) return [];
      const identity = { ownerAccountId: list.scope.accountId, taskId: task.id };
      const key = JSON.stringify([label, identity.ownerAccountId, identity.taskId]);
      return cursor === undefined || key > cursor ? [{ key, item: { identity, label } }] : [];
    }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    const page = limit === undefined ? matching : matching.slice(0, limit);
    return { items: page.map(({ item }) => item),
      nextCursor: page.length < matching.length ? page.at(-1)!.key : null };
  },
} as const;
