import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key });
});

const { resolveSessionVoiceLine } = await import('./sessionVoiceLine');

const idle = { saving: false, unavailable: null, providerLabel: 'OpenAI', inUseName: null, inUseId: null, desiredId: 'sage', desiredName: 'Sage' } as const;

describe('Work › Voice line', () => {
    it('names the voice the running attempt applied, and a different saved choice only as the next one', () => {
        expect(resolveSessionVoiceLine({ ...idle, inUseName: 'Sage', inUseId: 'sage' }))
            .toBe('sessionVoice.workCurrentVoice:{"voice":"Sage"}');
        expect(resolveSessionVoiceLine({ ...idle, inUseName: 'Sage', inUseId: 'sage', desiredId: 'cedar', desiredName: 'Cedar' }))
            .toBe('sessionVoice.workNextVoice:{"next":"Cedar","voice":"Sage"}');
    });

    it('never claims a saved choice is speaking without an applied attempt, and says why a choice cannot apply', () => {
        expect(resolveSessionVoiceLine(idle)).toBe('sessionVoice.preferenceHint');
        expect(resolveSessionVoiceLine({ ...idle, unavailable: 'voice_missing', inUseName: 'Sage', inUseId: 'sage' }))
            .toBe('sessionVoice.unavailablePreference');
        expect(resolveSessionVoiceLine({ ...idle, unavailable: 'provider_mismatch' }))
            .toBe('sessionVoice.providerMismatch:{"provider":"OpenAI"}');
        expect(resolveSessionVoiceLine({ ...idle, saving: true, inUseName: 'Sage', inUseId: 'sage' })).toBe('sessionVoice.pending');
    });
});
