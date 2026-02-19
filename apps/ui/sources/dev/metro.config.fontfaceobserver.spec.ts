import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('apps/ui/metro.config.js', () => {
    it('resolves `fontfaceobserver` to a web-safe shim on web', () => {
        // CommonJS config (Metro expects it).
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const config = require('../../metro.config.js');

        const expectedShimPath = path.resolve(__dirname, '../platform/shims/fontFaceObserverWebShim.ts');

        const result = config.resolver.resolveRequest(
            {
                resolveRequest() {
                    return { type: 'sourceFile', filePath: '/sentinel' };
                },
            },
            'fontfaceobserver',
            'web'
        );

        expect(result).toEqual({ type: 'sourceFile', filePath: expectedShimPath });
        expect(fs.existsSync(expectedShimPath)).toBe(true);
    });
});
