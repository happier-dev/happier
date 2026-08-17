import { describe, expect, it } from 'vitest';
import { VoiceProviderSettingsSchema } from '@happier-dev/protocol';

import {
  createExternalVoiceProviderSettingsDescriptor,
  projectExternalVoiceProviderSettings,
} from './externalProviderSettings';

describe('externalProviderSettings', () => {
  it('derives the complete default config from manifest-declared fields only', () => {
    const settings = VoiceProviderSettingsSchema.parse({
      schemaVersion: 2,
      fields: [{
        id: 'profile',
        title: 'Voice profile',
        schema: { type: 'string', enum: ['balanced', 'expressive'] },
        default: 'balanced',
        presentation: {
          control: 'select',
          options: [
            { value: 'balanced', title: 'Balanced' },
            { value: 'expressive', title: 'Expressive' },
          ],
        },
      }, {
        id: 'enableProvisioning',
        title: 'Enable provisioning',
        schema: { type: 'boolean' },
        default: true,
        presentation: { control: 'switch' },
      }],
    });

    const descriptor = createExternalVoiceProviderSettingsDescriptor(settings);

    expect(descriptor.defaultConfig).toEqual({
      profile: 'balanced',
      enableProvisioning: true,
    });
    expect(projectExternalVoiceProviderSettings({
      schemaVersion: 2,
      config: descriptor.defaultConfig,
    }, descriptor)).toEqual({ status: 'ready', modeId: 'default' });
    expect(descriptor.parseConfig({
      mode: 'default',
      profile: 'balanced',
      enableProvisioning: true,
    })).toBeNull();
  });
});
