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
const testkitMocksDir = path.join(testkitRuntimeDir, '..', 'mocks');

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

    it('keeps canonical mock factories wired to the runtime implementations', () => {
        const mockFilesToRuntimeImports = [
            ['reactNative.ts', '../runtime/reactNativeRuntime'],
            ['unistyles.ts', '../runtime/unistylesRuntime'],
            ['router.ts', '../runtime/routerRuntime'],
            ['modal.ts', '../runtime/modalRuntime'],
            ['text.ts', '../runtime/textRuntime'],
            ['storage.ts', '../runtime/storageRuntime'],
        ] as const;

        for (const [fileName, importPath] of mockFilesToRuntimeImports) {
            const source = fs.readFileSync(path.join(testkitMocksDir, fileName), 'utf8');
            expect(source, `${fileName} should delegate to ${importPath}`).toContain(importPath);
        }
    });
});
