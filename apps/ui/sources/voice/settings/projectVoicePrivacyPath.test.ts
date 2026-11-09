import { describe, expect, it } from 'vitest';

import { readLocalConversationVoiceSettings, voiceSettingsDefaults, voiceSettingsParse, writeLocalConversationVoiceSettings, writeVoiceDiagnosticsSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { OPENAI_REALTIME_DEFAULT_SETTINGS } from '../../../../../packages/plugins/openai/src/protocol/voice/settings';
import { projectVoicePrivacyPath, type VoicePrivacyRow } from './projectVoicePrivacyPath';

const MACHINE = { machineId: 'm1', machineLabel: 'devbox' };

function row(rows: readonly VoicePrivacyRow[], key: VoicePrivacyRow['key']) {
  return rows.find((entry) => entry.key === key);
}

function stops(entry: VoicePrivacyRow | undefined) {
  return entry?.stops.map((stop) => stop.label);
}

function localVoice(stt: Record<string, unknown>, tts: Record<string, unknown>, conversation?: Record<string, unknown>) {
  const config = readLocalConversationVoiceSettings(voiceSettingsDefaults);
  return writeLocalConversationVoiceSettings({ ...voiceSettingsDefaults, providerId: 'local_conversation' }, {
    ...config, ...conversation, stt: { ...config.stt, ...stt }, tts: { ...config.tts, ...tts },
  } as typeof config);
}

describe('projectVoicePrivacyPath', () => {
  it('names the actual path for local speech on the Voice computer, and only says so once', () => {
    const base = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const voice = localVoice(
      { provider: 'local_neural', localNeural: { ...base.stt.localNeural, execution: 'daemon' } },
      { provider: 'local_neural', localNeural: { ...base.tts.localNeural, execution: 'daemon' } },
    );
    const path = projectVoicePrivacyPath({ voice, machine: MACHINE });
    const audio = row(path.rows, 'audio');
    expect(stops(audio)).toEqual([t('settingsVoice.pages.privacy.pathThisDevice'), 'devbox']);
    expect(audio?.note).toContain(t('settingsVoice.pages.privacy.staysLocal'));
    expect(row(path.rows, 'replies')).toBeUndefined();
    expect(row(path.rows, 'recordings')?.stops[0]?.label).toBe(t('settingsVoice.pages.privacy.recordingOff'));
  });

  it('keeps local speech on the device when it runs there', () => {
    const base = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const voice = localVoice(
      { provider: 'local_neural', localNeural: { ...base.stt.localNeural, execution: 'device' } },
      { provider: 'local_neural', localNeural: { ...base.tts.localNeural, execution: 'device' } },
    );
    expect(stops(row(projectVoicePrivacyPath({ voice, machine: MACHINE }).rows, 'audio'))).toEqual([t('settingsVoice.pages.privacy.pathThisDevice')]);
  });

  it('routes a hosted service through its name, with its terms, and has no separate replies', () => {
    const path = projectVoicePrivacyPath({
      voice: voiceSettingsParse({
        providerId: 'happier.voice.openai/realtime-openai',
        providers: { 'happier.voice.openai/realtime-openai': { schemaVersion: 1, config: OPENAI_REALTIME_DEFAULT_SETTINGS } },
      }),
      machine: MACHINE,
    });
    expect(stops(row(path.rows, 'audio'))).toEqual([t('settingsVoice.pages.privacy.pathThisDevice'), 'OpenAI']);
    expect(row(path.rows, 'audio')?.note).toBe(t('settingsVoice.pages.privacy.servicePolicy'));
    expect(stops(row(path.rows, 'reads'))).toEqual(['OpenAI Realtime']);
    expect(row(path.rows, 'replies')).toBeUndefined();
  });

  it('says separately where reply text goes when speech leaves differently from audio', () => {
    const base = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const voice = localVoice({ provider: 'local_neural', localNeural: { ...base.stt.localNeural, execution: 'daemon' } }, { provider: 'device' });
    const path = projectVoicePrivacyPath({ voice, machine: MACHINE });
    expect(stops(row(path.rows, 'audio'))).toEqual([t('settingsVoice.pages.privacy.pathThisDevice'), 'devbox']);
    expect(row(path.rows, 'replies')?.stops[0]?.label).toBe(t('settingsVoice.pages.privacy.pathReplyText'));
  });

  it('leaves Dictation out when it hears in the same place as the conversation', () => {
    const sameDevice = localVoice({ provider: 'device' }, { provider: 'device' });
    expect(row(projectVoicePrivacyPath({ voice: sameDevice, machine: MACHINE }).rows, 'dictation')).toBeUndefined();
  });

  it('reflects diagnostic recording from the settings owner', () => {
    const on = writeVoiceDiagnosticsSettings(voiceSettingsDefaults, { ...voiceSettingsParse(voiceSettingsDefaults).diagnostics, enabled: true, consentVersion: 1, captureSttInput: true } as never);
    expect(row(projectVoicePrivacyPath({ voice: on, machine: MACHINE }).rows, 'recordings')?.stops[0]?.label).toBe(t('settingsVoice.pages.privacy.recordingOn'));
  });
});
