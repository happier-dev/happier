import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultProjectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * One physical input list owns font staging and source-bundle capture: the esbuild runtime,
 * the source runtime and the Bun-compiled executable payload all stage from it. Dependency-free
 * so artifact builders can read it without loading the renderer build toolchain.
 */
export async function readPublicProfileAssetFiles({ projectDir = defaultProjectDir } = {}) {
    const appFonts = resolve(projectDir, '../ui/sources/assets/fonts');
    const source = resolve(projectDir, 'assets/public-profile');
    return [
        ...['Inter-Regular.ttf', 'Inter-Medium.ttf', 'Inter-SemiBold.ttf', 'IBMPlexMono-Regular.ttf']
            .map(filename => ({ filename, sourcePath: resolve(appFonts, filename) })),
        ...(await readdir(source)).map(filename => ({ filename, sourcePath: resolve(source, filename) })),
    ];
}
