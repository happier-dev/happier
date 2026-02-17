import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('shouldRunPostinstall', () => {
    it('runs by default when scope is unset', () => {
        const mod = require('../../../../../scripts/postinstall/shouldRunPostinstall.cjs') as any;
        expect(typeof mod.shouldRunPostinstall).toBe('function');

        expect(mod.shouldRunPostinstall({ workspace: 'server', scope: '' })).toBe(true);
    });

    it('skips when scope is set and workspace is not included', () => {
        const mod = require('../../../../../scripts/postinstall/shouldRunPostinstall.cjs') as any;
        expect(mod.shouldRunPostinstall({ workspace: 'server', scope: 'ui,protocol' })).toBe(false);
    });

    it('runs when scope includes workspace', () => {
        const mod = require('../../../../../scripts/postinstall/shouldRunPostinstall.cjs') as any;
        expect(mod.shouldRunPostinstall({ workspace: 'server', scope: 'ui,server' })).toBe(true);
    });

    it('treats scope=all as allowing everything', () => {
        const mod = require('../../../../../scripts/postinstall/shouldRunPostinstall.cjs') as any;
        expect(mod.shouldRunPostinstall({ workspace: 'server', scope: 'all' })).toBe(true);
    });
});
