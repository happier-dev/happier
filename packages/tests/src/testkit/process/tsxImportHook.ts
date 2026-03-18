import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export function resolveTsxImportHookPath(): string | null {
    try {
        const req = createRequire(import.meta.url);
        const pkgJsonPath = req.resolve('tsx/package.json');
        const pkgDir = dirname(pkgJsonPath);
        const hookPath = join(pkgDir, 'dist', 'esm', 'index.mjs');
        return existsSync(hookPath) ? hookPath : null;
    } catch {
        return null;
    }
}
