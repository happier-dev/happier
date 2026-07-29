import { describe, expect, it, vi } from 'vitest';

import { createCursorTodoWorkStateUpdater } from './projection.js';

describe('createCursorTodoWorkStateUpdater', () => {
  it('publishes replacement and merge snapshots through the declared todos source', async () => {
    const publish = vi.fn(async () => ({
      status: 'applied' as const,
      revision: 'revision',
      sourceSequence: publish.mock.calls.length,
    }));
    const publisher = vi.fn(() => ({ publish }));
    const update = createCursorTodoWorkStateUpdater({ workState: { publisher } });

    await update({
      todos: [{ id: 'a', content: 'First', status: 'pending' }],
      merge: false,
    });
    await update({
      todos: [
        { id: 'a', content: 'First complete', status: 'completed' },
        { id: 'b', content: 'Second', status: 'in_progress' },
      ],
      merge: true,
    });

    expect(publisher).toHaveBeenCalledOnce();
    expect(publisher).toHaveBeenCalledWith('todos');
    expect(publish).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sourceSequence: 1,
      primaryLocalId: 'todo:cursor:a',
      items: [expect.objectContaining({
        localId: 'todo:cursor:a',
        status: 'pending',
        title: 'First',
      })],
    }), undefined);
    expect(publish).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sourceSequence: 2,
      primaryLocalId: 'todo:cursor:b',
      items: [
        expect.objectContaining({ localId: 'todo:cursor:b', status: 'active' }),
        expect.objectContaining({ localId: 'todo:cursor:a', status: 'complete' }),
      ],
    }), undefined);
  });

  it('does not merge against a todo snapshot that the host rejected', async () => {
    const publish = vi.fn()
      .mockResolvedValueOnce({
        status: 'unavailable',
        diagnostic: { code: 'retired', message: 'Retired' },
      })
      .mockResolvedValueOnce({
        status: 'applied',
        revision: 'revision',
        sourceSequence: 1,
      });
    const update = createCursorTodoWorkStateUpdater({
      workState: { publisher: () => ({ publish }) },
    });

    await expect(update({
      todos: [{ id: 'rejected', content: 'Rejected', status: 'pending' }],
      merge: false,
    })).rejects.toMatchObject({ code: 'cursor_work_state_publish_unavailable' });
    await expect(update({
      todos: [{ id: 'accepted', content: 'Accepted', status: 'pending' }],
      merge: true,
    })).resolves.toBeUndefined();

    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceSequence: 1,
      items: [expect.objectContaining({ localId: 'todo:cursor:accepted' })],
    }), undefined);
  });
});
