import { describe, expect, it } from 'vitest';
import { VoiceProviderContributionSchema, VoiceProviderSettingsSchema } from '@happier-dev/protocol/plugins/contributions/voice';
import { createDeclaredSettingsProjector } from '@happier-dev/protocol/voice/settings/providerRegistry';

import {
  createExternalVoiceProviderSettingsDescriptor,
  isExternalVoiceProviderConnectedServicesBindingReady,
  projectExternalVoiceProviderSettings,
} from './externalProviderSettings';

describe('externalProviderSettings', () => {
  it('admits each declared config once for status, mode, conditional credentials and readiness', () => {
    const declaration = VoiceProviderContributionSchema.parse({
      id: 'voice', title: 'Voice', kind: 'conversation', roles: ['realtime_conversation'], platforms: ['web'],
      capabilities: { turn: { cancelResponse: false, bargeIn: false },  },
      client: { artifactId: 'voice', exportName: 'activate' },
      credentials: {
        slot: { id: 'api_key', purpose: 'voice.client-auth', title: 'Credential' },
        requirement: { kind: 'when_setting_equals', settingId: 'billingMode', value: 'byo' },
        sources: [{ kind: 'savedSecret', secretKinds: ['apiKey'], rawGrants: [{
          realm: 'web', phase: 'connection', request: { kind: 'httpHeaders',
            origin: 'https://voice.example.test', headerNames: ['authorization'] },
        }] }],
      },
      settings: {
        schemaVersion: 2,
        fields: [{ id: 'billingMode', title: 'Billing', schema: { type: 'string', maxLength: 32, enum: ['hosted', 'byo'] },
          default: 'hosted', presentation: { control: 'select', options: [
            { value: 'hosted', title: 'Hosted' }, { value: 'byo', title: 'BYO' },
          ] } },
        { id: 'agentId', title: 'Agent', schema: { type: 'string', maxLength: 128 }, default: '', presentation: { control: 'text' } }],
        readiness: [{ kind: 'setting_nonempty', settingId: 'agentId', when: { settingId: 'billingMode', equals: 'byo' } }],
      },
    });
    const descriptor = createExternalVoiceProviderSettingsDescriptor(declaration.settings);
    let admissions = 0;
    const project = createDeclaredSettingsProjector(declaration, {
      ...descriptor,
      parseStoredConfig(value: unknown) {
        admissions += 1;
        return descriptor.parseStoredConfig(value);
      },
    }, ['hosted', 'byo'].map((modeId, order) => ({ id: modeId, modeId, order,
      titleKey: modeId, subtitleKey: '', configPatch: { billingMode: modeId } })));
    const cases = [
      { envelope: { schemaVersion: 2, config: { billingMode: 'hosted', agentId: '', retired: true } },
        projection: { status: 'ready', modeId: 'hosted', requirements: [] }, admissions: 1 },
      { envelope: { schemaVersion: 2, config: { billingMode: 'byo', agentId: '' } },
        projection: { status: 'missing_required_setting', modeId: 'byo', requirements: ['credential'] }, admissions: 1 },
      { envelope: { schemaVersion: 2, config: { billingMode: 'byo', agentId: 'agent_1' } },
        projection: { status: 'ready', modeId: 'byo', requirements: ['credential'] }, admissions: 1 },
      { envelope: { schemaVersion: 2, config: { billingMode: 'hosted', agentId: 42 } },
        projection: { status: 'invalid', modeId: null }, admissions: 1 },
      { envelope: { schemaVersion: 1, config: descriptor.defaultConfig },
        projection: { status: 'unsupported_version', modeId: null }, admissions: 0 },
      { envelope: null, projection: { status: 'needs_migration', modeId: null }, admissions: 0 },
    ];
    for (const entry of cases) {
      admissions = 0;
      expect(project(entry.envelope)).toEqual(entry.projection);
      expect(admissions).toBe(entry.admissions);
    }
    expect(descriptor.parseConfig({ billingMode: 'hosted', agentId: '', retired: true })).toBeNull();
  });

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
        schema: { type: 'string', maxLength: 32 },
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
    const declaration = VoiceProviderContributionSchema.parse({
      id: 'voice', title: 'Voice', kind: 'conversation', roles: ['realtime_conversation'], platforms: ['web'],
      capabilities: { turn: { cancelResponse: false, bargeIn: false },  },
      client: { artifactId: 'voice', exportName: 'activate' },
    });
    const project = createDeclaredSettingsProjector(declaration, descriptor, []);
    expect(project({ schemaVersion: 2, config: { requiredMode: 'strict', globalConnectedServices: null } }))
      .toEqual({ status: 'missing_required_setting', modeId: 'default' });
    expect(project({ schemaVersion: 2, config: { requiredMode: 'strict', globalConnectedServices: selectedBinding } }))
      .toEqual({ status: 'ready', modeId: 'default' });
    expect(project({ schemaVersion: 2, config: { requiredMode: 'strict', globalConnectedServices: { v: 1 } } }))
      .toEqual({ status: 'invalid', modeId: null });

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
