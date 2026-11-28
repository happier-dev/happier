import { describe, expect, it } from 'vitest';

import { BUNDLED_AGENT_PRESENTATION } from './generated/bundledAgentPresentation.js';
import { formatAgentLikeIdForDisplay, getNeutralAgentIdentityColor, readConcreteAgentPresentation } from './presentation.js';

function relativeLuminance(hex: string): number {
    const [red, green, blue] = [1, 3, 5].map(offset => {
        const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

describe('bundled Agent presentation', () => {
    it('keeps every declared identity hue at least 3:1 against its theme card', () => {
        const cards = { light: '#ffffff', dark: '#1c1c1e' };

        for (const agentId of Object.keys(BUNDLED_AGENT_PRESENTATION)) {
            const identityColor = readConcreteAgentPresentation(agentId)?.identityColor;
            if (!identityColor) continue;

            for (const theme of ['light', 'dark'] as const) {
                const foreground = relativeLuminance(identityColor[theme]);
                const background = relativeLuminance(cards[theme]);
                const ratio = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
                expect.soft(ratio, `${agentId} ${theme} identity hue`).toBeGreaterThanOrEqual(3);
            }
        }
    });

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
