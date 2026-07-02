import { describe, expect, it } from 'vitest';

import {
  buildCursorParameterizedModelId,
  parseCursorParameterizedModelId,
  repairCursorModelSelection,
  resolveCursorModelPickerGate,
} from './modelConfig.js';

describe('cursor model config', () => {
  it('round-trips parameterized model slugs', () => {
    const parsed = parseCursorParameterizedModelId('composer-2.5[fast=true,thinking=high]');

    expect(parsed).toEqual({
      baseModelId: 'composer-2.5',
      options: { fast: 'true', thinking: 'high' },
    });
    expect(buildCursorParameterizedModelId(parsed)).toBe('composer-2.5[fast=true,thinking=high]');
  });

  it('repairs stale model selections to the default live model', () => {
    expect(repairCursorModelSelection({
      selectedModelId: 'missing-model',
      availableModelIds: ['composer-2.5', 'composer-2'],
      defaultModelId: 'composer-2.5',
    })).toEqual({
      modelId: 'composer-2.5',
      repaired: true,
    });
  });

  it('gates the picker on the minimum version and lab channel when channel is known', () => {
    expect(resolveCursorModelPickerGate({
      cliVersion: '2026.05.24-dda726e',
      channel: 'lab',
    })).toEqual({ state: 'enabled' });
    expect(resolveCursorModelPickerGate({
      cliVersion: '2026.05.24-dda726e',
      channel: 'stable',
    })).toEqual({
      state: 'diagnostic',
      reason: 'channel_not_verified',
    });
  });
});
