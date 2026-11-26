import { expect, it } from 'vitest';
import type { AgentAcpModelState } from '@happier-dev/plugin-sdk/agents/runtime';

import { antigravityModelControls } from './modelControls.js';

// Family catalog as the host projects it from agy 1.5.18 `configOptions` (model + thought_level).
const effort = (values: readonly string[]) => ({
  id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: 'medium',
  options: values.map(value => ({ value, name: value })),
});
const state = (values: readonly string[]): AgentAcpModelState => ({
  currentModelId: 'gemini-4-neon',
  availableModels: [
    { id: 'gemini-4-neon', name: 'Gemini 4 Neon', modelOptions: [effort(values)] },
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
  ],
});
const resolve = (modelId: string, modelState: AgentAcpModelState | null) =>
  antigravityModelControls.resolveModelUpdate!({ modelId, modelState });

it('maps saved effort-suffixed ids onto the advertised family and its effort', () => {
  const full = state(['low', 'medium', 'high', 'xhigh']);
  expect(resolve('gemini-4-neon-xhigh', full)).toEqual({ modelId: 'gemini-4-neon', configOptions: { thought_level: 'xhigh' } });
  expect(resolve('gemini-3.8-flash-low', full)).toEqual({ modelId: 'gemini-3.8-flash', configOptions: { thought_level: 'low' } });
  // An account catalog without that level keeps its current effort.
  expect(resolve('gemini-4-neon-medium', state(['low', 'high']))).toEqual({ modelId: 'gemini-4-neon', configOptions: { thought_level: 'medium' } });
});

it('leaves advertised and unknown ids to the host catalog admission', () => {
  const full = state(['low', 'medium', 'high']);
  expect(resolve('gemini-4-neon', full)).toBeNull();
  expect(resolve('gpt-oss-120b-medium', full)).toBeNull();
  expect(resolve('gemini-9-medium', full)).toBeNull();
  expect(resolve('gemini-4-neon-medium', null)).toBeNull();
});
