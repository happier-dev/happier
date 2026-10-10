import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testkitRuntimeDir = path.dirname(fileURLToPath(import.meta.url));

const runtimeFactoryFiles = [
    'storageRuntime.ts',
    'routerRuntime.ts',
    'modalRuntime.ts',
    'textRuntime.ts',
    'unistylesRuntime.ts',
    'reactNativeRuntime.ts',
] as const;

describe('UI testkit runtime factories', () => {
    it('keeps reusable runtime factories free of Vitest imports', () => {
        for (const fileName of runtimeFactoryFiles) {
            const filePath = path.join(testkitRuntimeDir, fileName);

            expect(fs.existsSync(filePath), `${fileName} should exist`).toBe(true);

            const source = fs.readFileSync(filePath, 'utf8');

            expect(source, `${fileName} should not import vitest`).not.toMatch(
                /\bfrom\s+['"]vitest['"]|\bimport\s*\(\s*['"]vitest['"]\s*\)/,
            );
        }
    });

});
