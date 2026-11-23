import { describe, expect, it } from 'vitest';
import { createTaskResourceClientV1, type TaskResourceClientOptionsV1 } from './taskResourceClientV1.js';
import { InternalTaskListInputSchema } from '../actions/internalTaskActions.js';
import { createTodoItemV1 } from './todoSessionLinkV1.js';
import { executeInternalTaskAction } from './todoActionOperationsV1.js';
import { TODO_LABEL_CATALOG_KEY_V1 } from './todoLabelColoursV1.js';
import { encodeBase64 } from '../crypto/base64.js';
import { SESSION_DATA_KEY_ENVELOPE_BYTES_V1 } from '../sessions/encryption/sessionDataKeyEnvelopes.js';

describe('Task resource selected reads', () => {
  it('returns only an admitted parent’s children and retains unreadable coverage for its owner', async () => {
    const parent = { ownerAccountId: 'owner', taskId: 'parent' };
    const todos = new Map<string, ReturnType<typeof createTodoItemV1>>([
      ['child', { ...createTodoItemV1({ id: 'child', title: 'Child' }, 1), parentId: parent.taskId }],
      ['others-child', { ...createTodoItemV1({ id: 'others-child', title: 'Foreign child' }, 1), parentId: parent.taskId }],
      ...Array.from({ length: 998 }, (_, index) => {
        const id = `unrelated-${index}`;
        return [id, createTodoItemV1({ id, title: 'Unrelated' }, 1)] as const;
      }),
    ]);
    const envelope = encodeBase64(new Uint8Array(SESSION_DATA_KEY_ENVELOPE_BYTES_V1));
    const tasks = Array.from(todos.keys(), taskId => ({
      ownerAccountId: taskId === 'others-child' ? 'other' : 'owner', taskId,
      content: { t: 'encrypted', k: 'task', c: taskId }, version: 1, access: 'view',
      encryptionMode: 'e2ee', encryptedDataKey: envelope,
    }));
    const unavailableTasks = ['owner', 'other'].map(ownerAccountId => ({
      ownerAccountId, taskId: 'unreadable', error: 'task_content_unavailable', reason: 'recipient_key_pending',
    }));
    const opened: string[] = [];
    const reads: string[] = [];
    const result = await executeInternalTaskAction({
      actionId: 'tasks.internal.list', input: { parent }, scope: { serverId: 'home', accountId: 'reader' },
      createId: () => 'unused', requireCurrent() {},
      port: {
        read: async key => { reads.push(key); return { value: null, version: 0 }; },
        list: async () => { throw new Error('The resource Action owns this inventory'); },
        mutate: async () => { throw new Error('A read must not write'); },
      },
      resources: {
        accountId: 'reader', requireCurrent() {},
        request: async () => ({ status: 200, body: { tasks, unavailableTasks } }),
        crypto: {
          randomBytes: () => new Uint8Array(32), openKey: async () => new Uint8Array(32),
          open: async taskId => { opened.push(taskId); return todos.get(taskId); },
          openAccount: async () => { throw new Error('The caller opens shared E2EE Tasks with a resource key'); },
          seal: async () => { throw new Error('A read must not seal'); },
          sealAccount: async () => { throw new Error('A read must not seal'); },
        },
      },
    });
    expect(result).toMatchObject({ status: 'ok', todos: [{ id: 'child', ownerAccountId: 'owner' }],
      unavailableTasks: [unavailableTasks[0]] });
    expect(opened).toHaveLength(999);
    expect(opened).not.toContain('others-child');
    expect(reads).toEqual([TODO_LABEL_CATALOG_KEY_V1]);
  });

  it('selects exact owner-qualified ids before opening bodies in a 1,000-Task Account', async () => {
    const tasks = Array.from({ length: 1_000 }, (_, index) => ({ ownerAccountId: 'owner', taskId: `task-${index}`,
      content: { t: 'encrypted', c: String(index) }, version: 1, access: 'owner', encryptionMode: 'e2ee', encryptedDataKey: null }));
    const opened: string[] = [];
    const paths: string[] = [];
    const selection = { kind: 'ids', tasks: [{ ownerAccountId: 'owner', taskId: 'task-17' }] };
    const crypto: TaskResourceClientOptionsV1['crypto'] = {
      randomBytes: () => new Uint8Array(32), openKey: async () => null,
      seal: async () => { throw new Error('Read must not seal'); }, sealAccount: async () => { throw new Error('Read must not seal'); },
      open: async () => { throw new Error('Account ciphertext uses Account crypto'); },
      openAccount: async ciphertext => { opened.push(ciphertext); return { value: createTodoItemV1({ id: `task-${ciphertext}`, title: 'Selected' }, 1), needsReseal: false }; },
    };
    const client = createTaskResourceClientV1({ accountId: 'owner', requireCurrent() {}, crypto,
      request: async request => { paths.push(request.path);
        const applied = new URL(request.path, 'http://home').searchParams.has('selection');
        return { status: 200, body: { tasks: applied ? [tasks[17]] : tasks, ...(applied ? { selectionApplied: true } : {}) } };
      },
    });
    const input = InternalTaskListInputSchema.parse({ selection });
    expect((await client.list(input)).tasks.map(task => task.todo.id)).toEqual(['task-17']);
    expect(paths).toHaveLength(1);
    expect(opened).toEqual(['17']);
    // The supported old-server shape contains no selection acknowledgement.
    // It must fail before any unrelated ciphertext can be opened.
    const oldServer = createTaskResourceClientV1({ accountId: 'owner', requireCurrent() {}, crypto,
      request: async () => ({ status: 200, body: { tasks } }),
    });
    await expect(oldServer.list(input)).rejects.toMatchObject({ code: 'task_selection_unsupported', outcome: 'failed' });
    expect(opened).toEqual(['17']);
    // Omission preserves the incumbent list contract with older servers.
    expect((await oldServer.list()).tasks).toHaveLength(1_000);
    expect(opened).toHaveLength(1_001);
  });
});
