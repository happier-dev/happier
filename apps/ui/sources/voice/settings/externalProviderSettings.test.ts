import { describe, expect, it } from 'vitest';
import { VoiceProviderSettingsSchema } from '@happier-dev/protocol';

import {
  createExternalVoiceProviderSettingsDescriptor,
  isExternalVoiceProviderConnectedServicesBindingReady,
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

  it('checks Voice Connected Services binding from the exact declared config field without whole-config parsing', () => {
    const descriptor = createExternalVoiceProviderSettingsDescriptor(VoiceProviderSettingsSchema.parse({
      schemaVersion: 2,
      fields: [{
        id: 'requiredMode',
        title: 'Required mode',
        schema: { type: 'string', enum: ['strict'] },
        default: 'strict',
        presentation: { control: 'text' },
      }],
      connectedServicesBinding: {
        id: 'globalConnectedServices',
        title: 'Codex account',
        agent: 'codex',
        serviceIds: ['openai-codex'],
      },
    }));
    const selectedBinding = {
      v: 1,
      bindingsByServiceId: {
        'happier.agent.codex/openai-codex': {
          source: 'connected',
          selection: 'profile',
          profileId: 'codex-profile',
        },
      },
    };

    expect(isExternalVoiceProviderConnectedServicesBindingReady({
      schemaVersion: 2,
      config: {
        requiredMode: 'wrong-decoy-that-would-fail-parseConfig',
        decoyConnectedServices: {
          v: 1,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'decoy-profile',
            },
          },
        },
        globalConnectedServices: selectedBinding,
      },
    }, descriptor)).toBe(true);

    expect(isExternalVoiceProviderConnectedServicesBindingReady({
      schemaVersion: 2,
      config: {
        requiredMode: 'strict',
        decoyConnectedServices: selectedBinding,
      },
    }, descriptor)).toBe(false);
  });
});
