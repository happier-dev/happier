import { describe, expect, it } from 'vitest';

import { formatAgentLikeIdForDisplay, getNeutralAgentIdentityColor, readConcreteAgentPresentation } from './presentation.js';

describe('bundled Agent presentation', () => {
    it('formats open Agent ids with the same readable fallback in every host', () => {
        expect(formatAgentLikeIdForDisplay('custom-acp')).toBe('Custom ACP Agent');
        expect(formatAgentLikeIdForDisplay('qwen')).toBe('Qwen Code');
        expect(formatAgentLikeIdForDisplay('acme.review-backend.v2')).toBe('Acme Review Backend V2');
    });

    it('reads declared catalog names and descriptor hues without guessing private definition names', () => {
        expect(readConcreteAgentPresentation('claude')).toEqual({
            name: 'Claude',
            identityColor: { light: '#eb6834', dark: '#d95926' },
        });
        expect(readConcreteAgentPresentation('codex')).toEqual({
            name: 'Codex',
            identityColor: { light: '#2a78d6', dark: '#3987e5' },
        });
        expect(readConcreteAgentPresentation('custom-acp')).toEqual({ name: 'Custom ACP Agent', identityColor: null });
        expect(readConcreteAgentPresentation('acme/assistant')).toBeNull();
        expect(readConcreteAgentPresentation('__proto__')).toBeNull();
        expect(readConcreteAgentPresentation('qwen')).toEqual({ name: 'Qwen Code', identityColor: null });
        expect(getNeutralAgentIdentityColor({ dark: false })).toBe('#A3A3A8');
        expect(getNeutralAgentIdentityColor({ dark: true })).toBe('#6C625D');
    });
});
