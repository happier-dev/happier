import { describe, expect, it, vi } from 'vitest';

import { listCursorAvailableModels } from './listAvailableModels.js';

describe('listCursorAvailableModels', () => {
  it('uses the provider-neutral request seam with timeout and cancellation', async () => {
    const request = vi.fn(async () => ({ models: [{ value: 'a', name: 'A' }] }));
    const controller = new AbortController();
    await expect(listCursorAvailableModels({
      request,
      timeoutMs: 321,
      signal: controller.signal,
    })).resolves.toEqual([{ value: 'a', name: 'A' }]);
    expect(request).toHaveBeenCalledWith('cursor/list_available_models', {}, {
      signal: controller.signal,
      timeoutMs: 321,
    });
  });
});
