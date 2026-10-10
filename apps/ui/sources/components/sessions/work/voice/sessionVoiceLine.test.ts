import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key });
});

const { resolveSessionVoiceLine } = await import('./sessionVoiceLine');

const address = { serverId: 'home-a', sessionId: 'session' } as const;
const idle = { saving: false, unavailable: null, providerLabel: 'OpenAI', inUseName: null, inUseId: null, desiredId: 'sage', desiredName: 'Sage',
    sessionAddress: address, attemptTargetSessionAddress: address, catalogLoaded: true,
    providerId: 'happier.voice.openai/realtime', inUseProviderId: 'happier.voice.openai/realtime' } as const;

describe('Work › Voice line', () => {
    it('does not call a saved voice removed before its catalog has loaded', () => {
        const loading = { ...idle, unavailable: 'voice_missing' as const, catalogLoaded: false };
        expect(resolveSessionVoiceLine(loading)).toBe('sessionVoice.idleVoice:{"voice":"Sage"}');
        expect(resolveSessionVoiceLine({ ...loading, catalogLoaded: true })).toBe('sessionVoice.unavailablePreference');
    });
    it('keeps a different provider voice pending even if its raw id matches current audio', () => {
        const pending = { ...idle, inUseName: 'Sage', inUseId: 'sage', inUseProviderId: 'other.voice/realtime' };
        expect(resolveSessionVoiceLine(pending)).toBe('sessionVoice.workNextVoice:{"next":"Sage","voice":"Sage"}');
    });
    it('only reports current audio for the viewed Home and Session, even when another Home has the same Session id', () => {
        const running = { ...idle, inUseName: 'Sage', inUseId: 'sage' };
        expect(resolveSessionVoiceLine({ ...running, attemptTargetSessionAddress: { ...address, serverId: 'home-b' } }))
            .toBe('sessionVoice.idleVoice:{"voice":"Sage"}');
        expect(resolveSessionVoiceLine({ ...running, attemptTargetSessionAddress: null }))
            .toBe('sessionVoice.idleVoice:{"voice":"Sage"}');
        expect(resolveSessionVoiceLine(running)).toBe('sessionVoice.workCurrentVoice:{"voice":"Sage"}');
    });
    it('names the voice the running attempt applied, and a different saved choice only as the next one', () => {
        expect(resolveSessionVoiceLine({ ...idle, inUseName: 'Sage', inUseId: 'sage' }))
            .toBe('sessionVoice.workCurrentVoice:{"voice":"Sage"}');
        expect(resolveSessionVoiceLine({ ...idle, inUseName: 'Sage', inUseId: 'sage', desiredId: 'cedar', desiredName: 'Cedar' }))
            .toBe('sessionVoice.workNextVoice:{"next":"Cedar","voice":"Sage"}');
    });

    it('never claims a saved choice is speaking without an applied attempt, and says why a choice cannot apply', () => {
        // Idle, the line names the voice it will speak with; when a choice applies is the picker's footer, not this line.
        expect(resolveSessionVoiceLine(idle)).toBe('sessionVoice.idleVoice:{"voice":"Sage"}');
        expect(resolveSessionVoiceLine({ ...idle, desiredId: null, desiredName: null })).toBe('sessionVoice.idleAccount');
        expect(resolveSessionVoiceLine({ ...idle, refused: true })).toBe('sessionVoice.refused');
        expect(resolveSessionVoiceLine({ ...idle, unavailable: 'voice_missing', inUseName: 'Sage', inUseId: 'sage' }))
            .toBe('sessionVoice.unavailablePreference');
        expect(resolveSessionVoiceLine({ ...idle, unavailable: 'provider_mismatch' }))
            .toBe('sessionVoice.providerMismatch:{"provider":"OpenAI"}');
        expect(resolveSessionVoiceLine({ ...idle, saving: true, inUseName: 'Sage', inUseId: 'sage' })).toBe('sessionVoice.pending');
    });
});
