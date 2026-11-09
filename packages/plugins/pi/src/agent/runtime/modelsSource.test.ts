import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPiSessionModelsSource } from './modelsSource.js';

describe('createPiSessionModelsSource', () => {
  afterEach(() => vi.restoreAllMocks());
  it('normalizes each observation once and publishes only changed facts while retaining unchanged model identities', async () => {
    let now = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let nameReads = 0;
    let state = { model: { provider: 'example', id: 'a' }, thinkingLevel: 'medium' };
    const source = createPiSessionModelsSource({ readState: async () => state, onError: () => undefined });
    const first: unknown[] = [];
    const second: unknown[] = [];
    source.subscribe((value) => first.push(value));
    source.subscribe((value) => second.push(value));
    const catalog = (name = 'A') => ({ models: [
      { provider: 'example', id: 'a', get name() { nameReads += 1; return name; }, reasoning: true },
      { provider: 'example', id: 'b', name: 'B' },
    ] });

    source.observeCatalog(catalog());
    expect(nameReads).toBe(1);
    const original = source.read();
    source.observeCatalog(catalog());
    expect(source.read()).toBe(original);
    expect(first).toHaveLength(2);
    await source.refresh();
    const withCurrentModel = source.read();
    await source.refresh();
    expect(source.read()).toBe(withCurrentModel);
    expect(nameReads).toBe(2);
    expect(first).toHaveLength(3);

    now = 200;
    source.observeCatalog(catalog());
    expect(source.read().observedAt).toBe(200);
    expect(source.read().models).toBe(original.models);
    expect(first).toHaveLength(4);
    source.observeCatalog(catalog('Renamed A'));
    expect(source.read().models?.[0]?.name).toBe('Renamed A');
    expect(source.read().models?.[0]).not.toBe(original.models?.[0]);
    expect(source.read().models?.[1]).toBe(original.models?.[1]);

    const beforeThinkingChange = source.read();
    state = { ...state, thinkingLevel: 'high' };
    await source.refresh();
    expect(source.read().models?.[0]?.modelOptions?.[0]?.currentValue).toBe('high');
    expect(source.read().models?.[1]).toBe(beforeThinkingChange.models?.[1]);
    expect(source.read().observedAt).toBe(200);
    expect(second).toEqual(first);
    source.dispose();
  });
  it('decodes the bound native Provider model to the canonical source identity', async () => {
    const source = createPiSessionModelsSource({
      providerModelId: 'vendor/selected-model',
      readState: async () => ({ model: { provider: 'happier-provider', id: 'vendor/selected-model' } }),
      onError: () => undefined,
    });
    source.observeCatalog({ models: [{ provider: 'happier-provider', id: 'vendor/selected-model', name: 'Selected' }, { provider: 'openai', id: 'native' }] });
    await source.refresh();
    expect(source.read()).toMatchObject({ currentModelId: 'vendor/selected-model', models: [
      { id: 'vendor/selected-model' }, { id: 'openai/native' },
    ] });
    source.dispose();
  });
  it('does not publish a startup snapshot as a discovered catalog while refreshing current state', async () => {
    const source = createPiSessionModelsSource({
      readState: async () => ({ model: { provider: 'openai', id: 'current' }, thinkingLevel: 'high' }),
      onError: () => undefined,
    });
    await source.refresh();
    expect(source.read()).toEqual({ models: null, currentModelId: 'openai/current', catalogConfidence: 'account_unverified' });
    source.dispose();
  });

  it('replaces a successful catalog with empty membership but retains it on malformed observation', async () => {
    const errors: unknown[] = [];
    const source = createPiSessionModelsSource({
      readState: async () => ({ model: { provider: 'example', id: 'current' } }),
      onError: (error) => { errors.push(error); },
    });
    expect(source.read().models).toBeNull();
    await source.refresh();
    source.observeCatalog({ models: [{ provider: 'example', id: 'old' }] });
    const previous = source.read();
    source.observeCatalog({ models: [{}] });
    expect(source.read()).toEqual(previous);
    expect.soft(errors).toHaveLength(1);
    source.observeCatalog({ models: [] });
    expect(source.read()).toMatchObject({ models: [], currentModelId: 'example/current', observedAt: expect.any(Number) });
    source.dispose();
  });

  it('publishes refreshed runtime model state and retains the last good snapshot on failure', async () => {
    let now = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const readState = vi.fn(async () => ({
      model: { provider: 'openai', id: 'gpt-4o-mini' },
      thinkingLevel: 'high',
    }));
    const onError = vi.fn();
    const source = createPiSessionModelsSource({ readState, onError });
    const observed: unknown[] = [];
    source.subscribe((snapshot) => observed.push(snapshot));

    source.observeCatalog({ models: [{ provider: 'openai', id: 'gpt-4o-mini', reasoning: true }] });
    const observedAt = source.read().observedAt;
    now = 200;
    await source.refresh();
    expect(source.read().observedAt).toBe(100);
    expect(source.read()).toMatchObject({
      currentModelId: 'openai/gpt-4o-mini',
      models: [{ id: 'openai/gpt-4o-mini' }],
    });
    expect(observed).toHaveLength(3);

    source.observeCatalog({ error: 'refresh-failed' });
    expect(source.read().observedAt).toBe(observedAt);
    readState.mockRejectedValueOnce(new Error('Pi unavailable'));
    await expect(source.refresh()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Pi unavailable' }));
    expect(source.read()).toMatchObject({ currentModelId: 'openai/gpt-4o-mini' });
    expect(observed).toHaveLength(3);
  });
});
