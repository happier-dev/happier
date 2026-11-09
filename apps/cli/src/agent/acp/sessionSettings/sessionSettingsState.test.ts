import { describe, expect, it } from 'vitest';
import { AgentSessionRuntimeEventV1Schema } from '@happier-dev/protocol/runtime';

import {
  normalizeSessionConfigOptions,
  readSessionModelStateFromConfigOptions,
  readSessionModelStateFromSessionResponse,
  readSessionModelStateFromSessionResponseAwaitable,
} from './sessionSettingsState';
import { createFxConfigOptionsFixture } from '../testkit/fxConfigOptionsFixture';

describe('normalizeSessionConfigOptions', () => {
  it('admits nonblank catalog fields byte-for-byte before publishing the strict runtime event', () => {
    const choices = [{ value: '', name: ' Default ' }, { value: ' ', name: ' Space ' }];
    const option = { id: ' control ', name: ' Control ', type: 'select', currentValue: ' ', options: choices };
    const groups = [{ id: ' group ', name: ' Group ', options: choices }];
    const configOptions = normalizeSessionConfigOptions([
      { ...option, id: ' \n' }, { ...option, name: ' ' }, { ...option, type: '\t' },
      { ...option, options: [...choices, { value: 'invalid', name: ' ' }], groups: [
        ...groups, { id: ' ', name: 'Invalid id', options: choices }, { id: 'invalid-name', name: ' ', options: choices },
      ] },
    ]);
    const event = { kind: 'config-options', sessionId: 'session', sequence: 1, emittedAtMs: 1, configOptions };
    expect(AgentSessionRuntimeEventV1Schema.safeParse(event).success).toBe(true);
    expect(configOptions).toEqual([{ ...option, groups }]);
  });
});

describe('readSessionModelStateFromSessionResponse', () => {
  it('shares legacy normalization while keeping synchronous and awaited projection contracts', async () => {
    const modelOptions = [{ id: 'effort', name: 'Effort', type: 'select', currentValue: 'high', options: [] }];
    const response = { models: {
      currentModelId: ' custom/current\n',
      availableModels: [null, {}, { modelId: ' opaque/model\n', name: ' Model ', contextWindowTokens: 128,
        model_options: modelOptions }],
    } };
    const project = (raw: Readonly<Record<string, unknown>>, model: { id: string; name: string }) => ({
      ...model, description: raw.modelId === model.id ? 'Projected' : 'Invalid source',
    });
    const expected = { currentModelId: response.models.currentModelId, availableModels: [{
      id: ' opaque/model\n', name: ' Model ', description: 'Projected', contextWindowTokens: 128, modelOptions,
    }] };
    const normalized = { currentModelId: response.models.currentModelId, availableModels: [{
      id: ' opaque/model\n', name: ' Model ', contextWindowTokens: 128,
      modelOptions,
    }] };
    expect(readSessionModelStateFromSessionResponse(response)).toEqual(normalized);
    expect(await readSessionModelStateFromSessionResponseAwaitable(response)).toEqual(normalized);
    const synchronous = readSessionModelStateFromSessionResponse(response, project);
    expect(synchronous).toEqual(expected);
    let releaseProjection: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { releaseProjection = resolve; });
    let settled = false;
    const pending = readSessionModelStateFromSessionResponseAwaitable(response, async (raw, model) => {
      await held;
      return project(raw, model);
    }).then((state) => { settled = true; return state; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseProjection?.();
    expect(await pending).toEqual(expected);
    for (const invalid of [null, {}, { models: { currentModelId: '', availableModels: [] } },
      { models: { currentModelId: 'current', availableModels: [null, {}] } }]) {
      expect(readSessionModelStateFromSessionResponse(invalid)).toBeNull();
      expect(await readSessionModelStateFromSessionResponseAwaitable(invalid)).toBeNull();
    }
  });

  it.each([
    { id: 'changed-id', name: 'Model' },
    { id: 'model', name: '' },
  ])('rejects an invalid projected legacy model through both caller forms: %j', async (projected) => {
    const response = { models: { currentModelId: 'model', availableModels: [{ id: 'model', name: 'Model' }] } };
    expect(() => readSessionModelStateFromSessionResponse(response, () => projected)).toThrow(/invalid model/);
    await expect(readSessionModelStateFromSessionResponseAwaitable(response, async () => projected))
      .rejects.toThrow(/invalid model/);
  });

  it('preserves explicit empty membership in both synchronous and awaitable projections', async () => {
    const empty = { models: { currentModelId: 'current', availableModels: [] } };
    const expected = { currentModelId: 'current', availableModels: [] };
    expect(readSessionModelStateFromSessionResponse(empty)).toEqual(expected);
    expect(await readSessionModelStateFromSessionResponseAwaitable(empty)).toEqual(expected);
    expect(await readSessionModelStateFromSessionResponseAwaitable({ models: { currentModelId: 'current', availableModels: [{}] } })).toBeNull();
  });

  it('preserves an observed current model outside the native catalog without inventing membership', async () => {
    // Gemini buildAvailableModels reports its configured arbitrary model as
    // current while its availableModels contains only native built-in choices.
    const response = {
      models: {
        currentModelId: 'custom/current-model',
        availableModels: [
          { modelId: 'advertised-model', name: 'Advertised model' },
        ],
      },
    };
    const expected = { currentModelId: 'custom/current-model', availableModels: [{ id: 'advertised-model', name: 'Advertised model' }] };
    expect(readSessionModelStateFromSessionResponse(response)).toEqual(expected);
    expect(await readSessionModelStateFromSessionResponseAwaitable(response)).toEqual(expected);
  });
});

describe('readSessionModelStateFromConfigOptions', () => {
  it('preserves empty and whitespace string values while keeping option ids opaque', () => {
    const configOptions = [{ id: 'model', name: 'Model', type: 'select', currentValue: '', options: [
      { value: '', name: 'Default' }, { value: ' ', name: 'Space' },
    ] }];
    expect(normalizeSessionConfigOptions(configOptions)).toEqual(configOptions);
    expect(readSessionModelStateFromConfigOptions({ configOptions })).toBeNull();
    expect(readSessionModelStateFromConfigOptions({ configOptions }, 'model')).toBeNull();
  });
  it('uses category hints for unknown model controls without requiring hints for known controls', () => {
    const configOptions = createFxConfigOptionsFixture().map(({ category, ...option }) => option);
    // Synthetic ACP Agent variation; the captured FX Codex catalog has no ultrafast option.
    const ultrafast = { id: 'ultrafast', name: 'Ultrafast', type: 'select', currentValue: 'false', options: [
      { value: 'false', name: 'Off' }, { value: 'true', name: 'On' },
    ] };
    const hinted = [
      { id: 'opaque-depth', name: ' Depth ', description: '', category: 'thought_level', type: 'select', currentValue: 'a', options: [{ value: 'a', name: ' A ', description: '' }] },
      { id: 'opaque-context', name: 'Context', category: 'model_config', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }] },
    ];
    const state = readSessionModelStateFromConfigOptions({ configOptions: [...configOptions, ultrafast, ...hinted] });
    expect(state?.availableModels[0].modelOptions).toEqual([
      expect.objectContaining({ id: 'effort' }), expect.objectContaining({ id: 'fast' }), ultrafast, ...hinted,
    ]);
    expect(state?.availableModels.slice(1).every(model => model.modelOptions === undefined)).toBe(true);
  });
  it('selects actual models regardless of option order and scopes observed controls to the current model', () => {
    const configOptions = createFxConfigOptionsFixture();
    for (const options of [configOptions, [...configOptions].reverse()]) {
      const state = readSessionModelStateFromConfigOptions({ configOptions: options });
      expect(state?.currentModelId).toBe('gpt-6.1-sol');
      expect(state?.availableModels.map((model) => model.id)).toEqual(configOptions[1].options.map((choice) => choice.value));
      expect(state?.availableModels[0].modelOptions?.map((option) => option.id)).toEqual(options.filter((option) => option.id === 'effort' || option.id === 'fast').map((option) => option.id));
      expect(state?.availableModels.slice(1).every((model) => !model.modelOptions)).toBe(true);
    }
  });

  it('fails closed for an absent declared selector and ambiguous fallback selectors', () => {
    const configOptions = createFxConfigOptionsFixture();
    expect(readSessionModelStateFromConfigOptions({ configOptions }, 'missing')).toBeNull();
    expect(readSessionModelStateFromConfigOptions({ configOptions: configOptions.filter((option) => option.id !== 'model') })).toBeNull();
    const custom = { ...configOptions[1], id: 'opaque-selector', name: 'Engine' };
    expect(readSessionModelStateFromConfigOptions({ configOptions: [custom] })?.currentModelId).toBe('gpt-6.1-sol');
    expect(readSessionModelStateFromConfigOptions({ configOptions: [...configOptions, custom] }, 'opaque-selector')?.currentModelId).toBe('gpt-6.1-sol');
    expect(readSessionModelStateFromConfigOptions({ configOptions: [configOptions[1], { ...custom, name: 'Model' }] })).toBeNull();
  });

  it('preserves category, grouped choices and opaque values through normalization', () => {
    const choices = [{ value: '  model/opaque  ', name: 'Opaque model' }];
    const configOptions = [{ id: 'custom', name: 'Engine', category: 'model', type: 'select', currentValue: '  model/opaque  ', options: [
      { group: 'provider/opaque', name: 'Provider group', options: choices },
    ] }];
    expect(normalizeSessionConfigOptions(configOptions)).toEqual([{
      ...configOptions[0], options: choices, groups: [{ id: 'provider/opaque', name: 'Provider group', options: choices }],
    }]);
    expect(readSessionModelStateFromConfigOptions({ configOptions }, 'custom')?.availableModels).toEqual([
      { id: '  model/opaque  ', name: 'Opaque model' },
    ]);
  });
  it('preserves empty model choices without treating missing or invalid options as empty', () => {
    const option = { id: 'model', name: 'Model', type: 'select', currentValue: 'current' };
    expect(readSessionModelStateFromConfigOptions({ configOptions: [option] }, 'model')).toBeNull();
    expect(readSessionModelStateFromConfigOptions({ configOptions: [{ ...option, options: [{}] }] }, 'model')).toBeNull();
    expect(readSessionModelStateFromConfigOptions({ configOptions: [{ ...option, options: [] }] }, 'model')).toEqual({
      currentModelId: 'current', availableModels: [],
    });
  });

  it.each(['select', 'enum'])('projects an ACP %s config option into canonical model state', (type) => {
    expect(readSessionModelStateFromConfigOptions({
      configOptions: [{
        id: 'model',
        name: 'Model',
        type,
        currentValue: 'model-b',
        options: [
          { value: 'model-a', name: 'Model A' },
          { value: 'model-b', name: 'Model B', description: 'Accurate' },
        ],
      }],
    }, 'model')).toEqual({
      currentModelId: 'model-b',
      availableModels: [
        { id: 'model-a', name: 'Model A' },
        { id: 'model-b', name: 'Model B', description: 'Accurate' },
      ],
    });
  });
});
