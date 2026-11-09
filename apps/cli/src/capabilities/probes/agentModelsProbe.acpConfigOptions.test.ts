import { describe, expect, it } from 'vitest';

import { createFxConfigOptionsFixture } from '@/agent/acp/testkit/fxConfigOptionsFixture';
import { normalizeAcpModelsSnapshot } from './agentModelsProbe';

describe('ACP model preflight projection', () => {
  it('uses the runtime ACP projection for the captured FX model and its observed controls', () => {
    const models = normalizeAcpModelsSnapshot(null, createFxConfigOptionsFixture());
    expect(models?.map((model) => model.id)).toEqual([
      'default', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol',
      'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
    ]);
    expect(models?.find((model) => model.id === 'gpt-6.1-sol')?.modelOptions).toMatchObject([
      { id: 'effort', category: 'thought_level', currentValue: 'auto' },
      { id: 'fast', category: 'model', currentValue: 'false' },
    ]);
    expect(models?.find((model) => model.id === 'gpt-6-astra')?.modelOptions).toBeUndefined();
  });

  it('uses a declared grouped selector and preserves opaque model values in preflight', () => {
    const models = normalizeAcpModelsSnapshot(null, [{
      id: 'native-choice', name: 'Engine', category: 'model', type: 'select',
      currentValue: ' model-a ', options: [{ group: ' native ', name: 'Native', options: [
        { value: ' model-a ', name: 'Model A' }, { value: 'model-b', name: 'Model B' },
      ] }],
    }], 'native-choice');
    expect(models?.map((model) => model.id)).toEqual(['default', ' model-a ', 'model-b']);
    expect(normalizeAcpModelsSnapshot(null, [{
      id: 'other', name: 'Other', category: 'model', type: 'select', currentValue: 'other',
      options: [{ value: 'other', name: 'Other' }],
    }], 'missing-declared-selector')).toBeNull();
  });
});
