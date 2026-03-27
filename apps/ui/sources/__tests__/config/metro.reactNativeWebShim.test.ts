import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

function getUiDir(): string {
    return join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
}

describe('metro.config.js (web)', () => {
    it('shims react-native to provide unstable_batchedUpdates (LegendList compatibility)', () => {
        const uiDir = getUiDir();
        const require = createRequire(import.meta.url);
        const config = require(join(uiDir, 'metro.config.js'));

        const resolved = config.resolver.resolveRequest(
            { originModulePath: join(uiDir, 'index.ts') },
            'react-native',
            'web',
        );

        expect(resolved).toEqual({
            type: 'sourceFile',
            filePath: join(uiDir, 'sources/platform/shims/reactNativeWebShim.ts'),
        });
    });
});
