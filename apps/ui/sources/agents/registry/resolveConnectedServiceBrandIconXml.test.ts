import { describe, expect, it } from 'vitest';

import { lightTheme, type Theme } from '@/theme';
import { resolveConnectedServiceBrandIconXml } from './resolveConnectedServiceBrandIconXml';

const theme = lightTheme as Theme;

describe('resolveConnectedServiceBrandIconXml', () => {
    it('resolves a themed monochrome mark for every connected service id', () => {
        const serviceIds = [
            'claude-subscription',
            'openai-codex',
            'openai',
            'anthropic',
            'gemini',
            'github',
        ] as const;

        for (const serviceId of serviceIds) {
            const xml = resolveConnectedServiceBrandIconXml(serviceId, theme);
            expect(xml, serviceId).toBeTypeOf('string');
            expect(xml).toContain('<svg');
            // Marks render in the registry's monochrome treatment (text.primary fill).
            expect(xml).toContain(theme.colors.text.primary);
        }
    });

    it('special-cases github onto the dedicated github mark', () => {
        const xml = resolveConnectedServiceBrandIconXml('github', theme);
        // The github mark uses the GitHub octicon viewBox (0 0 16 16).
        expect(xml).toContain('viewBox="0 0 16 16"');
    });

    it('is case- and whitespace-insensitive', () => {
        expect(resolveConnectedServiceBrandIconXml('  GitHub  ', theme)).not.toBeNull();
        expect(resolveConnectedServiceBrandIconXml('Claude-Subscription', theme)).not.toBeNull();
    });

    it('returns null for unknown or empty service ids', () => {
        expect(resolveConnectedServiceBrandIconXml('not-a-service', theme)).toBeNull();
        expect(resolveConnectedServiceBrandIconXml('', theme)).toBeNull();
        expect(resolveConnectedServiceBrandIconXml(null, theme)).toBeNull();
        expect(resolveConnectedServiceBrandIconXml(undefined, theme)).toBeNull();
    });
});
