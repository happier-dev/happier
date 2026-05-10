import { describe, expect, it, vi } from 'vitest';

import { createCodexAppServerDisplayTitleHandler } from './displayTitle';

describe('createCodexAppServerDisplayTitleHandler', () => {
  it('mirrors canonical display.title updates to the active Codex thread name', async () => {
    const request = vi.fn().mockResolvedValue({});
    const handler = createCodexAppServerDisplayTitleHandler({
      client: { request },
      getThreadId: () => 'thread-1',
    });

    await handler.applyHappierField?.(
      { sessionId: 'sess-1' },
      'Updated title',
      { reason: 'user-mutation' },
    );

    expect(request).toHaveBeenCalledWith('thread/name/set', {
      threadId: 'thread-1',
      name: 'Updated title',
    });
  });

  it('treats provider title mirror failures as best effort', async () => {
    const request = vi.fn().mockRejectedValue(new Error('unsupported'));
    const handler = createCodexAppServerDisplayTitleHandler({
      client: { request },
      getThreadId: () => 'thread-1',
    });

    await expect(handler.applyHappierField?.(
      { sessionId: 'sess-1' },
      'Updated title',
      { reason: 'user-mutation' },
    )).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not call provider title mirror without an active thread id or non-empty title', async () => {
    const request = vi.fn().mockResolvedValue({});
    const handler = createCodexAppServerDisplayTitleHandler({
      client: { request },
      getThreadId: () => '',
    });

    await handler.applyHappierField?.(
      { sessionId: 'sess-1' },
      '  ',
      { reason: 'user-mutation' },
    );

    expect(request).not.toHaveBeenCalled();
  });
});
