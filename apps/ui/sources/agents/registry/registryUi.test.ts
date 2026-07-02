import { describe, expect, it } from 'vitest';

import { AGENT_PROVIDER_IDS as SHARED_AGENT_PROVIDER_IDS } from '@happier-dev/agents';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';

import { AGENTS_UI, CANONICAL_AGENTS_UI } from './registryUi';
import { getAgentCliGlyph, getAgentIconSvgXml, getAgentPickerIconScale } from './registryUi';

function sortedKeys(value: Record<string, unknown>): string[] {
    return Object.keys(value).sort();
}

describe('agents/registryUi', () => {
    it('covers the full canonical provider universe (no UI-only drift)', () => {
        expect(sortedKeys(CANONICAL_AGENTS_UI)).toEqual([...SHARED_AGENT_PROVIDER_IDS].sort());
        expect(CANONICAL_AGENTS_UI).not.toHaveProperty('customAcp');
        expect(AGENTS_UI).not.toHaveProperty('customAcp');
    });

    it('uses a dedicated oh-my-pi logo instead of reusing the plain pi mark', () => {
        const theme = createThemeFixture({
            colors: {
                text: '#123456',
                accent: {
                    orange: '#f97316',
                },
            },
        }) as Parameters<typeof getAgentIconSvgXml>[1];
        const svgXml = getAgentIconSvgXml('ohMyPi', theme) ?? '';
        expect(svgXml).toContain('oh-my-pi-logo');
        expect(svgXml).toContain(`fill="${theme.colors.accent.orange}"`);
    });

    it('resolves the plugin-projected OpenCode logo as descriptor-owned SVG data', () => {
        const theme = createThemeFixture({
            colors: {
                text: {
                    primary: '#123456',
                },
            },
        }) as Parameters<typeof getAgentIconSvgXml>[1];

        const svgXml = getAgentIconSvgXml('opencode', theme) ?? '';

        expect(svgXml).toContain('viewBox="0 0 240 300"');
        expect(svgXml).toContain(`fill="${theme.colors.text.primary}"`);
        expect(svgXml).toContain('fill-rule="evenodd"');
    });

    it('uses a neutral fallback for unknown backend/provider ids instead of the custom ACP UI treatment', () => {
        expect(getAgentCliGlyph('acme.review.backend')).toBe('?');
        expect(getAgentPickerIconScale('acme.review.backend')).toBe(1);
    });

    it('resolves icon metadata for every shared canonical agent id', () => {
        const theme = createThemeFixture() as Parameters<typeof getAgentIconSvgXml>[1];

        for (const agentId of SHARED_AGENT_PROVIDER_IDS) {
            expect(() => getAgentIconSvgXml(agentId, theme)).not.toThrow();
            expect(getAgentCliGlyph(agentId)).not.toBe('');
        }
    });
});
