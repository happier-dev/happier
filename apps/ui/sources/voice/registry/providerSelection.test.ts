import { describe, expect, it } from 'vitest';
import { PluginContributesV2Schema } from '@happier-dev/protocol';

import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { createDefaultVoiceProviderRegistry } from './defaultRegistry';
import { createVoiceProviderRegistry } from './providerRegistry';
import {
  projectVoiceProviderSelectionRows,
  resolveSelectedVoiceProviderTitleKey,
  selectVoiceProviderOption,
} from './providerSelection';

describe('voice registry provider selection', () => {
  it('projects deterministic provider-owned selection rows', () => {
    const settings = voiceSettingsParse({ providerId: null });
    const rows = projectVoiceProviderSelectionRows(settings, createDefaultVoiceProviderRegistry());
    expect(rows.map((row) => `${row.providerId}:${row.optionId}`)).toEqual([
      'realtime_elevenlabs:happier',
      'realtime_elevenlabs:byo',
      'realtime_openai:byo',
      'realtime_grok:byo',
      'realtime_codex:experimental',
      'local_conversation:local',
    ]);
    expect(rows.map((row) => row.titleKey)).toEqual([
      'settingsVoice.mode.happier',
      'settingsVoice.mode.byo',
      'settingsVoice.mode.openaiRealtime',
      'settingsVoice.mode.grokRealtime',
      'settingsVoice.mode.codexRealtime',
      'settingsVoice.mode.local',
    ]);
  });

  it('selects a mode through a bounded config patch and provider-owned validator', () => {
    const settings = voiceSettingsParse({ providerId: null });
    const registry = createDefaultVoiceProviderRegistry();
    const selected = selectVoiceProviderOption(settings, registry, 'realtime_elevenlabs', 'byo');
    expect(selected).toMatchObject({
      providerId: 'realtime_elevenlabs',
      providers: { realtime_elevenlabs: { schemaVersion: 2, config: { billingMode: 'byo' } } },
    });
    expect(projectVoiceProviderSelectionRows(selected!, registry).find((row) => row.optionId === 'byo')?.selected).toBe(true);
  });

  it('uses the provider-owned schema version when selecting a provider without a saved envelope', () => {
    const declaration = PluginContributesV2Schema.parse({
      voiceProviders: [{
        id: 'conversation',
        title: 'External Voice',
        kind: 'conversation',
        roles: ['realtime_conversation'],
        platforms: ['web'],
        capabilities: {
          readiness: { requirements: [] },
          turn: { cancelResponse: true, bargeIn: false },
        },
        settings: {
          schemaVersion: 2,
          fields: [{
            id: 'profile',
            title: 'Profile',
            schema: { type: 'string', enum: ['balanced'] },
            default: 'balanced',
            presentation: {
              control: 'select',
              options: [{ value: 'balanced', title: 'Balanced' }],
            },
          }],
        },
        client: {
          artifactId: 'voice-runtime-web',
          modulePath: './voiceRuntime',
          exportName: 'activate',
        },
      }],
    }).voiceProviders[0]!;
    if (declaration.kind !== 'conversation') {
      throw new Error('expected conversation declaration');
    }
    const registry = createVoiceProviderRegistry({
      bundled: [{
        kind: 'voice.conversation-provider.v1',
        pluginId: 'acme.external-voice',
        providerId: 'acme.external-voice/conversation',
        settingsSectionId: 'acme.external-voice/conversation',
        roles: ['realtime_conversation'],
        requirements: [],
        selectionOptions: [{
          id: 'default',
          modeId: 'default',
          order: 10,
          titleKey: 'External Voice',
          subtitleKey: 'acme.external-voice',
          configPatch: { mode: 'default', profile: 'balanced' },
        }],
        declaration,
      }],
    });

    const selected = selectVoiceProviderOption(
      voiceSettingsParse({ providerId: null }),
      registry,
      'acme.external-voice/conversation',
      'default',
    );

    expect(selected).toMatchObject({
      providerId: 'acme.external-voice/conversation',
      providers: {
        'acme.external-voice/conversation': {
          schemaVersion: 2,
          config: {
            mode: 'default',
            profile: 'balanced',
          },
        },
      },
    });
  });

  it('repairs invalid current-version bundled settings from the provider defaults when selected', () => {
    const settings = voiceSettingsParse({
      providerId: null,
      providers: {
        realtime_codex: {
          schemaVersion: 2,
          config: {
            globalConnectedServices: null,
            staleInvalidField: 'preserved-until-explicit-repair',
          },
        },
      },
    });
    const registry = createDefaultVoiceProviderRegistry();

    const selected = selectVoiceProviderOption(
      settings,
      registry,
      'realtime_codex',
      'experimental',
    );

    expect(selected?.providerId).toBe('realtime_codex');
    expect(selected?.providers.realtime_codex).toEqual({
      schemaVersion: 2,
      config: {
        globalConnectedServices: null,
      },
    });
  });

  it('does not rewrite an unsupported future provider settings envelope when selected', () => {
    const settings = voiceSettingsParse({
      providerId: null,
      providers: {
        realtime_codex: {
          schemaVersion: 3,
          config: {
            globalConnectedServices: null,
            futureField: 'preserved',
          },
        },
      },
    });
    const before = JSON.stringify(settings);

    expect(selectVoiceProviderOption(
      settings,
      createDefaultVoiceProviderRegistry(),
      'realtime_codex',
      'experimental',
    )).toBeNull();
    expect(JSON.stringify(settings)).toBe(before);
  });

  it('removes disabled-package rows while preserving the inert settings envelope', () => {
    const settings = voiceSettingsParse({
      providerId: 'realtime_elevenlabs',
      providers: { realtime_elevenlabs: { schemaVersion: 1, config: { billingMode: 'byo', future: 'preserved' } } },
    });
    const before = JSON.stringify(settings);
    const registry = createDefaultVoiceProviderRegistry({ enabledPluginIds: new Set(['happier.voice.google']) });
    expect(projectVoiceProviderSelectionRows(settings, registry).some((row) => row.providerId === 'realtime_elevenlabs')).toBe(false);
    expect(JSON.stringify(settings)).toBe(before);
    expect(selectVoiceProviderOption(settings, registry, 'realtime_elevenlabs', 'byo')).toBeNull();
  });

  it('resolves descriptor-owned display metadata for a fake second provider without host edits', () => {
    const settings = voiceSettingsParse({
      providerId: 'realtime_second_provider',
      providers: {
        realtime_second_provider: { schemaVersion: 1, config: { mode: 'live' } },
      },
    });
    const registry = createVoiceProviderRegistry({
      bundled: [{
        kind: 'voice.conversation-provider.v1',
        pluginId: 'happier.voice.second',
        providerId: 'realtime_second_provider',
        settingsSectionId: 'voice.provider.realtime_second_provider',
        roles: ['realtime_conversation'],
        requirements: [],
        selectionOptions: [{
          id: 'live',
          modeId: 'live',
          order: 10,
          titleKey: 'settingsVoice.second.live',
          subtitleKey: 'settingsVoice.second.liveSubtitle',
        }],
        projectSettings: () => ({ status: 'ready', modeId: 'live' }),
      }],
    });

    expect(resolveSelectedVoiceProviderTitleKey(settings, registry)).toBe('settingsVoice.second.live');
  });

  it('returns null display metadata for a disabled or unready contribution', () => {
    const settings = voiceSettingsParse({
      providerId: 'realtime_elevenlabs',
      providers: { realtime_elevenlabs: { schemaVersion: 1, config: { billingMode: 'byo' } } },
    });
    const disabled = createDefaultVoiceProviderRegistry({ enabledPluginIds: new Set(['happier.voice.google']) });
    expect(resolveSelectedVoiceProviderTitleKey(settings, disabled)).toBeNull();
  });
});
