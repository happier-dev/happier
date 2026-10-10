import { describe, expect, it } from 'vitest';
import { applyVoiceWelcomeSelection, resolveVoiceWelcomeSelection, VoiceWelcomeSchema } from './welcome.js';

describe('canonical Voice greeting choice', () => {
    it('sets greeting mode and enablement together while preserving the selected template', () => {
        const voice = { welcome: VoiceWelcomeSchema.parse({ enabled: true, mode: 'on_first_turn', templateId: 'saved-template' }), providers: { existing: { schemaVersion: 2 } } };
        const off = applyVoiceWelcomeSelection(voice, 'off');
        expect(resolveVoiceWelcomeSelection(off.welcome)).toBe('off');
        expect(off.welcome).toEqual({ enabled: false, mode: 'immediate', templateId: 'saved-template' });
        const next = applyVoiceWelcomeSelection(off, 'on_first_turn');
        expect(resolveVoiceWelcomeSelection(next.welcome)).toBe('on_first_turn');
        expect(next.providers).toBe(voice.providers);
        expect(next.welcome.templateId).toBe('saved-template');
    });
});
