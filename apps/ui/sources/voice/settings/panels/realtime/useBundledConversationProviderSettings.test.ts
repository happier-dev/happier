import { describe, expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { voiceSettingsParse, readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { useBundledConversationProviderSettings } from './useBundledConversationProviderSettings';

describe('Work conversation voice source', () => {
  it('offers the selected local model voice field while retaining the account agent and model settings', async () => {
    const base = voiceSettingsParse({ providerId: 'local_conversation' });
    const cfg = readLocalConversationVoiceSettings(base);
    const voice = writeLocalConversationVoiceSettings(base, { ...cfg, tts: { ...cfg.tts, provider: 'local_neural',
      localNeural: { ...cfg.tts.localNeural, voiceId: 'af_heart', speed: 1.2 } } });
    const hook = await renderHook(() => useBundledConversationProviderSettings(voice));
    const choice = hook.getCurrent().sessionChoice;
    expect(choice).toMatchObject({ providerId: 'happier.voice.builtin/local-neural', config: { voiceId: 'af_heart' },
      declaration: { kind: 'speech', catalogs: [{ kind: 'voices', settingFieldId: 'voiceId' }] } });
    expect(readLocalConversationVoiceSettings(voice)).toEqual({ ...cfg, tts: { ...cfg.tts, provider: 'local_neural',
      localNeural: { ...cfg.tts.localNeural, voiceId: 'af_heart', speed: 1.2 } } });
  });

  it('keeps device speech visible as an honest no-choice source', async () => {
    const voice = voiceSettingsParse({ providerId: 'local_conversation' });
    const hook = await renderHook(() => useBundledConversationProviderSettings(voice));
    expect(hook.getCurrent().sessionChoice).toMatchObject({ providerId: 'device', declaration: null });
  });

  it('uses Google speech voiceName from the current speech declaration, with custom names', async () => {
    const base = voiceSettingsParse({ providerId: 'local_conversation' });
    const cfg = readLocalConversationVoiceSettings(base);
    const voice = writeLocalConversationVoiceSettings(base, { ...cfg, tts: { ...cfg.tts, provider: 'happier.voice.google/google-cloud-tts' } });
    const hook = await renderHook(() => useBundledConversationProviderSettings(voice));
    expect(hook.getCurrent().sessionChoice).toMatchObject({ providerId: 'happier.voice.google/google-cloud-tts',
      declaration: { kind: 'speech', catalogs: [{ kind: 'voices', settingFieldId: 'voiceName', allowCustom: true }] } });
  });

  it('invalidates the local catalog on pack/execution changes, not on voice or speed changes', async () => {
    const base = voiceSettingsParse({ providerId: 'local_conversation' });
    const cfg = readLocalConversationVoiceSettings(base);
    const withLocal = (patch: Partial<typeof cfg.tts.localNeural>) => writeLocalConversationVoiceSettings(base, {
      ...cfg, tts: { ...cfg.tts, provider: 'local_neural', localNeural: { ...cfg.tts.localNeural, ...patch } },
    });
    const hook = await renderHook(voice => useBundledConversationProviderSettings(voice), { initialProps: withLocal({}) });
    const original = hook.getCurrent().sessionChoice?.targetKey;
    await hook.rerender(withLocal({ voiceId: 'af_heart', speed: 1.2 }));
    expect(hook.getCurrent().sessionChoice?.targetKey).toBe(original);
    await hook.rerender(withLocal({ assetId: 'different-installed-pack' }));
    expect(hook.getCurrent().sessionChoice?.targetKey).not.toBe(original);
    await hook.rerender(withLocal({ execution: 'device' }));
    expect(hook.getCurrent().sessionChoice?.targetKey).not.toBe(original);
  });
});
