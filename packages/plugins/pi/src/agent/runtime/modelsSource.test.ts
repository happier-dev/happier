import { describe, expect, it, vi } from 'vitest';

import { createPiSessionModelsSource } from './modelsSource.js';

describe('createPiSessionModelsSource', () => {
  it('publishes refreshed runtime model state and retains the last good snapshot on failure', async () => {
    const readState = vi.fn(async () => ({
      model: { provider: 'openai', id: 'gpt-4o-mini' },
      thinkingLevel: 'high',
    }));
    const readAvailableModels = vi.fn(async () => ({
      models: [{ provider: 'openai', id: 'gpt-4o-mini', name: 'GPT-4o mini', reasoning: true }],
    }));
    const onError = vi.fn();
    const source = createPiSessionModelsSource({ readState, readAvailableModels, onError });
    const observed: unknown[] = [];
    source.subscribe((snapshot) => observed.push(snapshot));

    await source.refresh();
    expect(source.read()).toMatchObject({
      currentModelId: 'openai/gpt-4o-mini',
      models: [{ id: 'openai/gpt-4o-mini' }],
    });
    expect(observed).toHaveLength(2);

    readState.mockRejectedValueOnce(new Error('Pi unavailable'));
    await expect(source.refresh()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Pi unavailable' }));
    expect(source.read()).toMatchObject({ currentModelId: 'openai/gpt-4o-mini' });
    expect(observed).toHaveLength(2);
  });
});
