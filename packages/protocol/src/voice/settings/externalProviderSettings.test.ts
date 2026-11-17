import { Ajv } from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VoiceProviderSettingsSchema } from '../../plugins/contributions/voiceProviders.js';
import { createExternalVoiceProviderSettingsDescriptor } from './externalProviderSettings.js';

describe('createExternalVoiceProviderSettingsDescriptor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Every bundled Voice provider gets a descriptor while the first Account settings
  // parse runs at startup; only providers with a stored config ever parse one.
  it('compiles the declared config schema when a config is first parsed, not when the descriptor is created', () => {
    const settings = VoiceProviderSettingsSchema.parse({
      schemaVersion: 1,
      fields: [
        { id: 'descriptorLazyMode', title: 'Mode', schema: { type: 'string', maxLength: 17, enum: ['fast', 'slow'] },
          default: 'fast', presentation: { control: 'select', options: [
            { value: 'fast', title: 'Fast' }, { value: 'slow', title: 'Slow' },
          ] } },
        { id: 'descriptorLazyLabel', title: 'Label', schema: { type: 'string', maxLength: 19 }, default: '',
          presentation: { control: 'text' } },
      ],
    });
    const compile = vi.spyOn(Ajv.prototype, 'compile');

    const descriptor = createExternalVoiceProviderSettingsDescriptor(settings);
    expect(compile).not.toHaveBeenCalled();
    expect(descriptor.defaultConfig).toEqual({ descriptorLazyMode: 'fast', descriptorLazyLabel: '' });

    expect(descriptor.parseStoredConfig({ descriptorLazyMode: 'slow', descriptorLazyLabel: 'a' }))
      .toEqual({ descriptorLazyMode: 'slow', descriptorLazyLabel: 'a' });
    expect(descriptor.parseConfig({ descriptorLazyMode: 'other', descriptorLazyLabel: '' })).toBeNull();
    expect(descriptor.parseConfig({ descriptorLazyMode: 'fast' })).toBeNull();
    const compiledByFirstParses = compile.mock.calls.length;
    expect(compiledByFirstParses).toBeGreaterThan(0);

    expect(descriptor.parseConfig({ descriptorLazyMode: 'slow', descriptorLazyLabel: 'b' }))
      .toEqual({ descriptorLazyMode: 'slow', descriptorLazyLabel: 'b' });
    expect(compile).toHaveBeenCalledTimes(compiledByFirstParses);
  });
});
