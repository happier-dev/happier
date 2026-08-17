/**
 * Builds `dist` before any case runs.
 *
 * `src/sdkSchemaClosure.test.ts` and `src/packagePublicationBoundary.test.ts`
 * decide what an installed consumer of this package sees, so they must read the
 * built artifact rather than source. Without a build dependency a stale `dist`
 * makes both of them silently certify bytes nobody is shipping. One build here
 * is the whole dependency: neither gate owns a private copy of it.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const buildScript = join(packageRoot, '..', '..', 'scripts', 'workspaces', 'buildTypeScriptPackageDist.mjs');

export function setup() {
    const built = spawnSync(process.execPath, [buildScript, '-p', 'tsconfig.json'], {
        cwd: packageRoot,
        stdio: 'inherit',
        windowsHide: true,
    });
    if (built.status !== 0) {
        throw new Error(`@happier-dev/triage-protocol dist build failed with status ${String(built.status)}.`);
    }
}
