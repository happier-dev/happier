import { describe, it, expect } from 'vitest';

import { CLAUDE_CORE } from './core';

describe('CLAUDE_CORE install banner', () => {
    it('does not suggest npm installation (deprecated upstream)', () => {
        expect(CLAUDE_CORE.cli.installBanner.installKind).toBe('ifAvailable');
        expect(CLAUDE_CORE.cli.installBanner.installCommand).toBeUndefined();
        expect(CLAUDE_CORE.cli.installBanner.guideUrl).toMatch(/docs\.anthropic\.com\/en\/docs\/claude-code\/getting-started/);
    });

    it('keeps core identity and resume contracts stable', () => {
        expect(CLAUDE_CORE.id).toBe('claude');
        expect(CLAUDE_CORE.flavorAliases).toEqual(['claude']);
        expect(CLAUDE_CORE.resume.supportsVendorResume).toBe(true);
        expect(CLAUDE_CORE.resume.experimental).toBe(false);
        expect(CLAUDE_CORE.resume.vendorResumeIdField).toBe('claudeSessionId');
        expect(CLAUDE_CORE.connectedService.id).toBe('anthropic');
    });
});
