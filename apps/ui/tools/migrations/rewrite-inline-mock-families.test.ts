import { describe, expect, it } from 'vitest';

import { parseRewriteInlineMockFamiliesArgs } from './rewrite-inline-mock-families';

describe('rewrite-inline-mock-families CLI parsing', () => {
    it('treats positional paths as scopes instead of falling back to the full UI source tree', () => {
        const options = parseRewriteInlineMockFamiliesArgs([
            'apps/ui/sources/components/ui/avatar',
            'apps/ui/sources/components/settings/memory/MemorySettingsView.rpc.test.tsx',
        ]);

        expect(options.scopes).toEqual([
            'apps/ui/sources/components/ui/avatar',
            'apps/ui/sources/components/settings/memory/MemorySettingsView.rpc.test.tsx',
        ]);
    });

    it('ignores the explicit dry-run flag when collecting scopes', () => {
        const options = parseRewriteInlineMockFamiliesArgs([
            '--dry-run',
            'apps/ui/sources/components/ui/avatar',
        ]);

        expect(options.write).toBe(false);
        expect(options.scopes).toEqual(['apps/ui/sources/components/ui/avatar']);
    });
});
