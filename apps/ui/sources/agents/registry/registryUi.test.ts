import { describe, expect, it } from 'vitest';

import { AGENT_IDS as SHARED_AGENT_IDS } from '@happier-dev/agents';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';

import { AGENTS_UI } from './registryUi';
import { getAgentIconSvgXml } from './registryUi';

function sortedKeys(value: Record<string, unknown>): string[] {
    return Object.keys(value).sort();
}

describe('agents/registryUi', () => {
    it('covers the full canonical provider universe (no UI-only drift)', () => {
        expect(sortedKeys(AGENTS_UI)).toEqual([...SHARED_AGENT_IDS].sort());
    });

    it('uses the Agent Client Protocol logo for custom ACP providers', () => {
        const theme = createThemeFixture({
            colors: {
                text: '#123456',
            },
        }) as Parameters<typeof getAgentIconSvgXml>[1];
        const svgXml = getAgentIconSvgXml('customAcp', theme) ?? '';
        expect(svgXml).toContain('agent-client-protocol-logo');
        expect(svgXml).toContain('fill="#123456"');
        expect(svgXml).not.toContain('fill="#000000"');
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
});
