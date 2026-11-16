import { describe, expect, it } from 'vitest';
import { projectProviderModelReasoningForAgent, readProviderReasoningEffortOption } from './reasoningEffort.js';

describe('Agent Provider reasoning effort projection', () => {
  it('offers only effort values the selected Agent can apply without mutating source facts', () => {
    const source = { id: 'gateway-model', name: 'Gateway model', capabilities: { reasoningControls: 'supported' as const },
      modelOptions: [{ id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'minimal',
        options: ['minimal', 'low', 'high'].map(value => ({ value, name: value })) }] };
    const support = { supportsReasoningEffort: true as const, reasoningEffortValues: ['low', 'high'] };
    const projected = projectProviderModelReasoningForAgent(source, support);
    expect(readProviderReasoningEffortOption(projected)).toMatchObject({ currentValue: 'low',
      options: [{ value: 'low' }, { value: 'high' }] });
    expect(readProviderReasoningEffortOption(source)?.currentValue).toBe('minimal');
    const applicableDefault = { ...source, modelOptions: [{ ...source.modelOptions[0]!, currentValue: 'high' }] };
    expect(readProviderReasoningEffortOption(projectProviderModelReasoningForAgent(applicableDefault, support))?.currentValue)
      .toBe('high');
    expect(projectProviderModelReasoningForAgent(projected, support)).toBe(projected);
    expect(projectProviderModelReasoningForAgent(source, { supportsReasoningEffort: true })).toBe(source);

    const inapplicable = { ...source, modelOptions: [{ ...source.modelOptions[0]!,
      options: [{ value: 'minimal', name: 'Minimal' }] }] };
    expect(projectProviderModelReasoningForAgent(inapplicable, support).modelOptions).toBeUndefined();
  });
});
