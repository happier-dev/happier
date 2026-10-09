import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    translate: (key, params) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  });
});

const { resolveVoiceCompactLine, resolveVoicePresenceCaption } =
  await import('./resolveVoicePresenceCaption');

const base = { live: true, muted: false, captionLabel: '' } as const;

describe('Voice presence captions for a bound Session target', () => {
  it('captions connecting to a Session as reading its instructions, and global connecting unchanged', () => {
    expect(
      resolveVoicePresenceCaption(
        { ...base, surfaceState: 'connecting' },
        'Release captain',
      ),
    ).toBe('sessionVoice.preparing:{"name":"Release captain"}');
    expect(
      resolveVoicePresenceCaption(
        { ...base, surfaceState: 'connecting' },
        null,
      ),
    ).toBe('voicePresence.captions.connecting');
    // Muted still wins over the target's preparation line.
    expect(
      resolveVoicePresenceCaption(
        { ...base, muted: true, surfaceState: 'connecting' },
        'Release captain',
      ),
    ).toBe('voicePresence.captions.muted');
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
      text: 'sessionVoice.talkingTo:{"name":"Release captain"}',
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
    ).toEqual({ kind: 'caption', text: 'voicePresence.captions.speaking' });
  });
});
