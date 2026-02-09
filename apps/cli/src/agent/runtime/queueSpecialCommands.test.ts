import { describe, expect, it, vi } from 'vitest';

import { pushTextToMessageQueueWithSpecialCommands } from './queueSpecialCommands';

describe('pushTextToMessageQueueWithSpecialCommands', () => {
  it('pushes clear commands via isolate+clear', () => {
    const queue = {
      push: vi.fn(),
      pushIsolateAndClear: vi.fn(),
    };

    pushTextToMessageQueueWithSpecialCommands({
      queue,
      text: '/clear',
      mode: { permissionMode: 'default' },
    });

    expect(queue.push).not.toHaveBeenCalled();
    expect(queue.pushIsolateAndClear).toHaveBeenCalledWith('/clear', { permissionMode: 'default' });
  });

  it('pushes non-special text normally', () => {
    const queue = {
      push: vi.fn(),
      pushIsolateAndClear: vi.fn(),
    };

    pushTextToMessageQueueWithSpecialCommands({
      queue,
      text: 'hello',
      mode: { permissionMode: 'default' },
    });

    expect(queue.pushIsolateAndClear).not.toHaveBeenCalled();
    expect(queue.push).toHaveBeenCalledWith('hello', { permissionMode: 'default' });
  });
});
