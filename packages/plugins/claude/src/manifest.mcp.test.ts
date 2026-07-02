import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('PLUGIN_MANIFEST MCP contribution', () => {
    it('declares Claude config discovery through the manifest MCP family', () => {
        expect(PLUGIN_MANIFEST.runtime.capabilities).toContain('mcp');
        expect(PLUGIN_MANIFEST.contributes?.mcp?.discoveryProviders).toEqual([
            expect.objectContaining({
                id: 'claude.config',
                kind: 'mcp.discoveryProvider',
                providerId: 'claude',
            }),
        ]);
    });
});
