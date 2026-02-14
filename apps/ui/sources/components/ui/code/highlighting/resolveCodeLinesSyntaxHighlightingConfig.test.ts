import { describe, expect, it } from 'vitest';

import { resolveCodeLinesSyntaxHighlightingMode } from './resolveCodeLinesSyntaxHighlightingConfig';

describe('resolveCodeLinesSyntaxHighlightingMode', () => {
    it('returns off when feature is disabled', () => {
        expect(resolveCodeLinesSyntaxHighlightingMode({
            featureEnabled: false,
            requestedMode: 'simple',
            advancedFeatureEnabled: true,
            platformOS: 'web',
        })).toBe('off');
    });

    it('falls back advanced -> simple when advanced feature is disabled', () => {
        expect(resolveCodeLinesSyntaxHighlightingMode({
            featureEnabled: true,
            requestedMode: 'advanced',
            advancedFeatureEnabled: false,
            platformOS: 'web',
        })).toBe('simple');
    });

    it('falls back advanced -> simple on native platforms', () => {
        expect(resolveCodeLinesSyntaxHighlightingMode({
            featureEnabled: true,
            requestedMode: 'advanced',
            advancedFeatureEnabled: true,
            platformOS: 'ios',
        })).toBe('simple');
    });

    it('returns requested simple mode when enabled', () => {
        expect(resolveCodeLinesSyntaxHighlightingMode({
            featureEnabled: true,
            requestedMode: 'simple',
            advancedFeatureEnabled: true,
            platformOS: 'web',
        })).toBe('simple');
    });
});

