import { describe, expect, it } from 'vitest';

import {
  projectGrokModelOptions,
  projectGrokSetModelResponse,
  resolveGrokReasoningEffortUpdate,
} from './modelControls.js';

describe('Grok model controls', () => {
  const rawModel = {
    id: 'grok-4',
    _meta: {
      supportsReasoningEffort: true,
      reasoningEffort: 'medium',
      reasoningEfforts: [
        { value: 'low', label: 'Low effort' },
        { value: 'medium', label: 'Medium effort' },
        { value: 'high', label: 'High effort' },
      ],
    },
  };

  it('projects strict provider effort metadata without suffixes or fallback models', () => {
    expect(projectGrokModelOptions(rawModel, [{ id: 'existing' }])).toEqual([
      { id: 'existing' },
      {
        id: 'reasoning_effort', name: 'Reasoning effort', type: 'select', currentValue: 'medium',
        options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }],
      },
    ]);
    expect(projectGrokModelOptions({ id: 'unknown' }, [])).toEqual([]);
  });

  it('rejects malformed metadata and unadvertised updates', () => {
    expect(projectGrokModelOptions({ ...rawModel, _meta: { ...rawModel._meta, reasoningEfforts: [{ value: 'high' }, { value: 'high' }] } }, [])).toEqual([]);
    expect(() => resolveGrokReasoningEffortUpdate({
      configId: 'reasoning_effort', value: 'xhigh', currentModel: { id: 'grok-4', modelOptions: projectGrokModelOptions(rawModel, []) },
    })).toThrow('not advertised');
    expect(resolveGrokReasoningEffortUpdate({
      configId: 'reasoning_effort', value: 'high', currentModel: { id: 'grok-4', modelOptions: projectGrokModelOptions(rawModel, []) },
    })).toEqual({ modelId: 'grok-4', requestMeta: { reasoningEffort: 'high' } });
  });

  it('projects Grok exact-model acknowledgement into the acknowledged effort state', () => {
    expect(projectGrokSetModelResponse({
      response: { _meta: { model: { Ok: 'grok-4' } } },
      requestedModelId: 'grok-4',
      requestMeta: { reasoningEffort: 'high' },
      targetModel: {
        id: 'grok-4',
        name: 'Grok 4',
        modelOptions: projectGrokModelOptions(rawModel, []),
      },
    })).toEqual({
      id: 'grok-4',
      name: 'Grok 4',
      modelOptions: [{
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      }],
    });
  });

  it('does not project missing, mismatched, or unadvertised Grok acknowledgements', () => {
    const targetModel = {
      id: 'grok-4',
      name: 'Grok 4',
      modelOptions: projectGrokModelOptions(rawModel, []),
    };
    expect(projectGrokSetModelResponse({
      response: {},
      requestedModelId: 'grok-4',
      requestMeta: null,
      targetModel,
    })).toBeNull();
    expect(projectGrokSetModelResponse({
      response: { _meta: { model: { Ok: 'other-model' } } },
      requestedModelId: 'grok-4',
      requestMeta: null,
      targetModel,
    })).toBeNull();
    expect(projectGrokSetModelResponse({
      response: { _meta: { model: { Ok: 'grok-4' } } },
      requestedModelId: 'grok-4',
      requestMeta: { reasoningEffort: 'xhigh' },
      targetModel,
    })).toBeNull();
  });
});
