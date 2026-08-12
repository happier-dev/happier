import { describe, expect, it } from 'vitest';

import { parseProviderCatalogResponse } from './parsers';

describe('parseProviderCatalogResponse', () => {
  it('parses only the declared OpenAI models discriminant', () => {
    expect(parseProviderCatalogResponse('openai-models', {
      data: [{ id: 'gpt-a' }, { id: 'gpt-b', name: 'GPT B' }],
    })).toEqual({
      models: [{ id: 'gpt-a' }, { id: 'gpt-b', name: 'GPT B' }],
      loadStates: [],
    });
    expect(() => parseProviderCatalogResponse('openai-models', { models: [{ id: 'wrong' }] }))
      .toThrow('missing data');
  });

  it('parses bounded Anthropic model rows through the declared Anthropic discriminant', () => {
    expect(parseProviderCatalogResponse('anthropic-models', {
      data: [
        {
          id: 'claude-future-6',
          display_name: 'Claude Future 6',
          type: 'model',
          max_input_tokens: 1_000_000,
          capabilities: {
            effort: {
              supported: true,
              low: { supported: true },
              medium: { supported: true },
              high: { supported: true },
              xhigh: { supported: true },
              max: { supported: true },
            },
          },
        },
        { id: 'claude-sonnet-4-6', type: 'model' },
      ],
      has_more: false,
    })).toEqual({
      models: [
        {
          id: 'claude-future-6',
          name: 'Claude Future 6',
          contextWindowTokens: 1_000_000,
          capabilities: { reasoningControls: 'supported' },
          modelOptions: [{
            id: 'reasoning_effort',
            name: 'Thinking',
            type: 'select',
            currentValue: 'high',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'medium', name: 'Medium' },
              { value: 'high', name: 'High' },
              { value: 'xhigh', name: 'XHigh' },
              { value: 'max', name: 'Max' },
            ],
          }, {
            id: 'ultracode',
            name: 'Ultracode',
            description: 'Maximum coding effort. Forces XHigh Thinking effort while enabled.',
            type: 'boolean',
            currentValue: 'false',
            overridesWhenOn: {
              optionIds: ['reasoning_effort'],
              forcedValue: 'xhigh',
            },
          }],
        },
        { id: 'claude-sonnet-4-6' },
      ],
      loadStates: [],
    });

    expect(() => parseProviderCatalogResponse('anthropic-models', {
      data: [{ id: 'same' }, { id: 'same' }],
    })).toThrow('Duplicate');
    expect(() => parseProviderCatalogResponse('anthropic-models', {
      data: [{ id: 'claude-opus-4-6', display_name: 42 }],
    })).toThrow('display_name');
    expect(() => parseProviderCatalogResponse('anthropic-models', {
      models: [{ id: 'wrong-envelope' }],
    })).toThrow('missing data');
  });

  it('rejects malformed Anthropic context and effort capability facts', () => {
    const parseRow = (row: unknown) => parseProviderCatalogResponse('anthropic-models', { data: [row] });

    expect(() => parseRow({ id: 'bad-context', max_input_tokens: 0 }))
      .toThrow('max_input_tokens');
    expect(() => parseRow({ id: 'bad-context', max_input_tokens: 100_000_001 }))
      .toThrow('max_input_tokens');
    expect(() => parseRow({ id: 'bad-effort', capabilities: { effort: { supported: 'yes' } } }))
      .toThrow('effort');
    expect(() => parseRow({
      id: 'bad-tier',
      capabilities: { effort: { supported: true, low: { supported: 'yes' } } },
    })).toThrow('low');
    expect(() => parseRow({
      id: 'empty-effort',
      capabilities: { effort: { supported: true, low: { supported: false } } },
    })).toThrow('supported tier');

    expect(parseRow({
      id: 'no-effort',
      capabilities: { effort: { supported: false } },
    }).models).toEqual([{
      id: 'no-effort',
      capabilities: { reasoningControls: 'unsupported' },
    }]);
  });

  it('preserves exact Ollama model capabilities and excludes explicitly non-completion models', () => {
    expect(parseProviderCatalogResponse('ollama-tags', {
      models: [
        { name: 'legacy-without-capabilities:latest' },
        {
          model: 'thinking-tools:latest',
          name: 'ignored-alias',
          capabilities: ['completion', 'tools', 'thinking'],
        },
        {
          model: 'completion-tools:latest',
          capabilities: ['completion', 'tools', 'insert'],
        },
        { model: 'qwen3-embedding:8b', capabilities: ['embedding'] },
      ],
    })).toEqual({
      models: [
        { id: 'legacy-without-capabilities:latest' },
        {
          id: 'thinking-tools:latest',
          capabilities: {
            toolRoundTrips: 'supported',
            reasoningControls: 'supported',
          },
        },
        {
          id: 'completion-tools:latest',
          capabilities: {
            toolRoundTrips: 'supported',
            reasoningControls: 'unsupported',
          },
        },
      ],
      loadStates: [],
    });
  });

  it('rejects malformed Ollama capability metadata instead of guessing model usability', () => {
    expect(() => parseProviderCatalogResponse('ollama-tags', {
      models: [{ model: 'malformed', capabilities: 'completion' }],
    })).toThrow('capabilities');
  });

  it('parses LM Studio native ids and only explicit loaded_instances state', () => {
    expect(parseProviderCatalogResponse('lmstudio-native-models', {
      models: [
        { key: 'publisher/model-a', display_name: 'Model A', type: 'llm', loaded_instances: [] },
        { key: 'publisher/model-b', type: 'llm', loaded_instances: [{ id: 'instance-1' }] },
        { key: 'publisher/embed-only', type: 'embedding', loaded_instances: [] },
      ],
    })).toEqual({
      models: [{ id: 'publisher/model-a', name: 'Model A' }, { id: 'publisher/model-b' }],
      loadStates: [
        { modelId: 'publisher/model-a', loadState: 'unloaded' },
        { modelId: 'publisher/model-b', loadState: 'loaded' },
      ],
    });
  });

  it('keeps legacy LM Studio rows without type metadata and rejects malformed explicit types', () => {
    expect(parseProviderCatalogResponse('lmstudio-native-models', {
      models: [{ key: 'legacy/model', loaded_instances: [] }],
    }).models).toEqual([{ id: 'legacy/model' }]);
    expect(() => parseProviderCatalogResponse('lmstudio-native-models', {
      models: [{ key: 'malformed', type: 42 }],
    })).toThrow('type');
  });

  it('rejects duplicates, over-limit lists, and accessor-bearing input before value access', () => {
    expect(() => parseProviderCatalogResponse('openai-models', { data: [{ id: 'same' }, { id: 'same' }] }))
      .toThrow('Duplicate');

    const data: unknown[] = [];
    Object.defineProperty(data, '0', { enumerable: true, get: () => { throw new Error('accessed'); } });
    Object.defineProperty(data, 'length', { value: 5_001 });
    expect(() => parseProviderCatalogResponse('openai-models', { data })).toThrow('limit');
  });
});
