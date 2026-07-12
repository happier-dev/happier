import { describe, expect, it } from 'vitest';

import { AGENT_IDS as SHARED_AGENT_IDS } from '@happier-dev/agents';

import { AGENTS_UI } from './registryUi';
import { getAgentPickerIconScale } from './registryUi';

function sortedKeys(value: Record<string, unknown>): string[] {
    return Object.keys(value).sort();
}

describe('agents/registryUi', () => {
    it('covers the full canonical provider universe (no UI-only drift)', () => {
        expect(sortedKeys(AGENTS_UI)).toEqual([...SHARED_AGENT_IDS].sort());
    });

    it('renders Cursor with a provider logo instead of a text glyph fallback', () => {
        const theme = {
            colors: {
                text: {
                    primary: '#111111',
                },
            },
        } as never;

        const xml = AGENTS_UI.cursor.svgIconXml?.(theme);

        expect(xml).toContain('<svg');
        expect(xml).toContain('viewBox="0 0 466.73 532.09"');
    });

    it('keeps the Pi picker icon optically scaled for compact picker surfaces', () => {
        expect(getAgentPickerIconScale('pi')).toBe(0.9);
    });

    it('does not substitute an altered or third-party Grok mark while official asset provenance is blocked', () => {
        expect(AGENTS_UI.grok.svgIconXml).toBeNull();
        expect(AGENTS_UI.grok.cliGlyph).toBe('GX');
        expect(getAgentPickerIconScale('grok')).toBeGreaterThan(0);
    });

    it('slightly enlarges the Claude picker icon to compensate for the logo silhouette', () => {
        expect(getAgentPickerIconScale('claude')).toBe(1.1);
    });

});
