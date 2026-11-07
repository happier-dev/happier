import { describe, expect, it } from 'vitest';
import { createTaskResourceClientV1, type TaskResourceClientOptionsV1 } from './taskResourceClientV1.js';
import { InternalTaskListInputSchema } from '../actions/internalTaskActions.js';
import { createTodoItemV1 } from './todoSessionLinkV1.js';

describe('Task resource selected reads', () => {
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
