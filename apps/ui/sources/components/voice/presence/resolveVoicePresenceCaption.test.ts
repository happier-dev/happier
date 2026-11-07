import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPreferredLanguage, preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';

const previousLanguage = getPreferredLanguage();
beforeEach(async () => {
  await preloadTranslations('en');
  setPreferredLanguageFromSettings('en');
});
afterEach(() => setPreferredLanguageFromSettings(previousLanguage));

const { resolveVoiceCompactLine, resolveVoicePresenceCaption } =
  await import('./resolveVoicePresenceCaption');

const base = { live: true, muted: false, captionLabel: '' } as const;

describe('Voice presence captions for a bound Session target', () => {
  it('keeps a connected call phase-neutral and captions the actual microphone state', () => {
    const voice = { ...base, surfaceState: 'live', captionLabel: t('voiceSurface.a11y.microphoneInactive') } as const;
    expect(resolveVoicePresenceCaption(voice)).toBe(voice.captionLabel);
    expect(resolveVoicePresenceCaption({ ...voice, muted: true })).toBe(t('voicePresence.captions.muted'));
  });

  it.each(['error', 'permission_required'] as const)('keeps %s recovery ahead of the saved mute preference', (surfaceState) => {
    const voice = { ...base, muted: true, surfaceState, captionLabel: 'Playback failed. Try again.' };
    expect(resolveVoicePresenceCaption(voice)).toBe(voice.captionLabel);
    expect(resolveVoiceCompactLine(voice, 'Earlier reply', 'Release captain'))
      .toEqual({ kind: 'caption', text: voice.captionLabel });
  });

  it('captions connecting to a Session as reading its instructions, and global connecting unchanged', () => {
    expect(
      resolveVoicePresenceCaption(
        { ...base, surfaceState: 'connecting' },
        'Release captain',
      ),
    ).toBe(t('sessionVoice.preparing', { name: 'Release captain' }));
    expect(
      resolveVoicePresenceCaption(
        { ...base, surfaceState: 'connecting' },
        null,
      ),
    ).toBe(t('voicePresence.captions.connecting'));
    // Muted still wins over the target's preparation line.
    expect(
      resolveVoicePresenceCaption(
        { ...base, muted: true, surfaceState: 'connecting' },
        'Release captain',
      ),
    ).toBe(t('voicePresence.captions.muted'));
  });

  it('names the target as the compact line while nothing has been said, and keeps the last words once spoken', () => {
    expect(
      resolveVoiceCompactLine(
        { ...base, surfaceState: 'speaking' },
        null,
        'Release captain',
      ),
    ).toEqual({
      kind: 'caption',
      text: t('sessionVoice.talkingTo', { name: 'Release captain' }),
    });
    expect(
      resolveVoiceCompactLine(
        { ...base, surfaceState: 'speaking' },
        'Almost ready.',
        'Release captain',
      ),
    ).toEqual({ kind: 'transcript', text: 'Almost ready.' });
    // Global mode keeps the state's own caption; no target chip, no "Global" label.
    expect(
      resolveVoiceCompactLine(
        { ...base, surfaceState: 'speaking' },
        null,
        null,
      ),
    ).toEqual({ kind: 'caption', text: t('voicePresence.captions.speaking') });
  });

  it('captions a call that needs you with the decision it waits on, not the phase it is in', () => {
    // A request arrives while Voice is still thinking: the word says Needs you, so the caption
    // cannot say "Working out an answer" beneath it.
    const voice = { ...base, surfaceState: 'thinking', statusCell: 'needs_you' } as const;
    expect(resolveVoicePresenceCaption(voice)).toBe(t('voicePresence.captions.needsYou'));
    expect(resolveVoiceCompactLine(voice, null, null)).toEqual({ kind: 'caption', text: t('voicePresence.captions.needsYou') });
    // A muted call still says so first.
    expect(resolveVoicePresenceCaption({ ...voice, muted: true })).toBe(t('voicePresence.captions.muted'));
  });

  it('names an ended call\'s target plainly instead of saying Voice is still talking to it', () => {
    expect(
      resolveVoiceCompactLine(
        { ...base, live: false, surfaceState: 'idle' },
        null,
        'Release captain',
      ),
    ).toEqual({ kind: 'caption', text: 'Release captain' });
  });
  it('keeps unavailable-input guidance visible while Thinking instead of the previous transcript', () => {
    expect(resolveVoiceCompactLine({ ...base, surfaceState: 'thinking', canCommitInput: false }, 'Previous reply.', 'Release captain'))
      .toEqual({ kind: 'caption', text: t('voicePresence.captions.thinkingInputUnavailable') });
    expect(resolveVoiceCompactLine({ ...base, surfaceState: 'thinking', canCommitInput: true }, 'Previous reply.'))
      .toEqual({ kind: 'transcript', text: 'Previous reply.' });
  });

});
