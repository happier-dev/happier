import { describe, expect, it } from 'vitest';

import { resolvePluginContributedActionIconName } from './pluginContributedActionPresentation';

describe('plugin contributed Action presentation', () => {
    it('preserves a declared renderer icon but uses the canonical generic plugin fallback for absent or unknown metadata', () => {
        expect(resolvePluginContributedActionIconName('magic-wand')).toBe('magic-wand');
        expect(resolvePluginContributedActionIconName(null)).toBe('puzzle-piece');
        expect(resolvePluginContributedActionIconName('unknown-plugin-action-icon')).toBe('puzzle-piece');
    });
});
