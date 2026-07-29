import { describe, expect, it, vi } from 'vitest';

import { CursorAvailableModelsContribution } from './contribution.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe('CursorAvailableModelsContribution', () => {
  it('clears on a new authenticated generation, aborts the old request, and ignores stale completion', async () => {
    const changes: unknown[] = [];
    const first = deferred<unknown>();
    let firstSignal: AbortSignal | undefined;
    const contribution = new CursorAvailableModelsContribution({ onChange: (models) => changes.push(models) });
    const generation1 = contribution.beginAuthenticatedGeneration();
    const discovery1 = contribution.discover(generation1, async (_method, _params, options) => {
      firstSignal = options?.signal;
      return first.promise;
    });
    const generation2 = contribution.beginAuthenticatedGeneration();
    expect(firstSignal?.aborted).toBe(true);
    await contribution.discover(generation2, async () => ({ models: [{ value: 'new', name: 'New' }] }));
    first.resolve({ models: [{ value: 'old', name: 'Old' }] });
    await discovery1;
    expect(contribution.current()).toEqual([{ value: 'new', name: 'New' }]);
    expect(changes.at(-1)).toEqual([{ value: 'new', name: 'New' }]);
  });

  it.each([
    ['empty', { models: [] }],
    ['malformed', { models: [{ value: '', name: 'Bad' }] }],
  ])('clears only proprietary evidence on current-generation %s response', async (_label, response) => {
    const contribution = new CursorAvailableModelsContribution({ onChange: () => undefined });
    const generation = contribution.beginAuthenticatedGeneration();
    await contribution.discover(generation, async () => ({ models: [{ value: 'a', name: 'A' }] }));
    const failedGeneration = contribution.beginAuthenticatedGeneration();
    await contribution.discover(failedGeneration, async () => response);
    expect(contribution.current()).toBeNull();
  });

  it('runs discovery once per authenticated generation and clears on auth invalidation or dispose', async () => {
    const request = vi.fn(async () => ({ models: [{ value: 'a', name: 'A' }] }));
    const contribution = new CursorAvailableModelsContribution({ onChange: () => undefined });
    const generation = contribution.beginAuthenticatedGeneration();
    await contribution.discover(generation, request);
    await contribution.discover(generation, request);
    expect(request).toHaveBeenCalledTimes(1);
    contribution.invalidate();
    expect(contribution.current()).toBeNull();
    const nextGeneration = contribution.beginAuthenticatedGeneration();
    await contribution.discover(nextGeneration, request);
    expect(request).toHaveBeenCalledTimes(2);
    contribution.dispose();
    expect(contribution.current()).toBeNull();
  });
});
